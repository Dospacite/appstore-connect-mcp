/**
 * Shared helpers for tool modules.
 */
import { readFileSync, mkdirSync, writeFileSync, statSync, chmodSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { md5Hex, type JsonApiResource, type UploadOperation } from '../asc/client.js';
import { compact, rel } from '../asc/format.js';
import type { ToolContext } from './types.js';

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(homedir(), p.slice(1)) : p;
}

export function readLocalFile(p: string): { bytes: Buffer; fileName: string; fullPath: string } {
  const fullPath = path.resolve(expandHome(p));
  const st = statSync(fullPath);
  if (!st.isFile()) throw new Error(`Not a file: ${fullPath}`);
  return { bytes: readFileSync(fullPath), fileName: path.basename(fullPath), fullPath };
}

/** Save bytes under the output directory and return the absolute path. */
export function saveOutput(ctx: ToolContext, fileName: string, bytes: Buffer | string, opts: { mode?: number } = {}): string {
  mkdirSync(ctx.outputDir, { recursive: true });
  const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
  const full = path.join(ctx.outputDir, safe);
  writeFileSync(full, bytes, opts.mode !== undefined ? { mode: opts.mode } : undefined);
  if (opts.mode !== undefined) chmodSync(full, opts.mode);
  return full;
}

/** GET that returns null on 404 (for optional to-one resources). */
export async function tryGet(ctx: ToolContext, apiPath: string, query?: Record<string, any>): Promise<any | null> {
  try {
    return await ctx.client.get(apiPath, query);
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

/**
 * Resolve an app by App Store Connect id (numeric), bundle id, or exact name.
 * Returns the compact app resource.
 */
export async function resolveApp(ctx: ToolContext, app: string): Promise<{ id: string; bundleId: string; name: string; [k: string]: any }> {
  if (!app) throw new Error('app is required (App Store Connect app id, bundle id, or app name)');
  if (/^\d+$/.test(app)) {
    const doc = await ctx.client.get(`/v1/apps/${app}`, { 'fields[apps]': 'name,bundleId,sku,primaryLocale' });
    return compact(doc.data as JsonApiResource) as any;
  }
  const byBundle = await ctx.client.get('/v1/apps', { 'filter[bundleId]': app, 'fields[apps]': 'name,bundleId,sku,primaryLocale' });
  const list = (byBundle.data as JsonApiResource[]) ?? [];
  const exact = list.find(a => a.attributes?.bundleId === app);
  if (exact) return compact(exact) as any;
  const byName = await ctx.client.get('/v1/apps', { 'filter[name]': app, 'fields[apps]': 'name,bundleId,sku,primaryLocale' });
  const named = ((byName.data as JsonApiResource[]) ?? []).filter(a => a.attributes?.name?.toLowerCase() === app.toLowerCase());
  if (named.length === 1) return compact(named[0]) as any;
  throw new Error(`No app found for "${app}". Use list_apps to see app ids and bundle ids.`);
}

export type Platform = 'IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS';
export const PLATFORMS: Platform[] = ['IOS', 'MAC_OS', 'TV_OS', 'VISION_OS'];

/** States in which an App Store version's metadata can still be edited. */
export const EDITABLE_VERSION_STATES = [
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
];

/**
 * Find the App Store version to edit: a specific version string, or the
 * newest version still in an editable state.
 */
export async function resolveVersion(ctx: ToolContext, appId: string, platform: Platform = 'IOS', versionString?: string): Promise<{ id: string; versionString: string; appVersionState?: string; appStoreState?: string; [k: string]: any }> {
  const query: Record<string, any> = { 'filter[platform]': platform, limit: 50 };
  if (versionString) query['filter[versionString]'] = versionString;
  const doc = await ctx.client.get(`/v1/apps/${appId}/appStoreVersions`, query);
  const list = ((doc.data as JsonApiResource[]) ?? []).map(compact).sort((a, b) => String(b.createdDate ?? '').localeCompare(String(a.createdDate ?? '')));
  if (versionString) {
    const v = list.find(x => x.versionString === versionString);
    if (!v) throw new Error(`Version ${versionString} (${platform}) not found. Create it with create_version.`);
    return v as any;
  }
  const editable = list.find(v => EDITABLE_VERSION_STATES.includes(v.appVersionState ?? v.appStoreState));
  if (!editable) {
    throw new Error(`No editable ${platform} version found (all are live or in review). Create one with create_version. Existing: ${list.map(v => `${v.versionString}=${v.appVersionState ?? v.appStoreState}`).join(', ') || 'none'}`);
  }
  return editable as any;
}

/** The app's current editable appInfo (holds name, subtitle, categories, privacy URLs, age rating). */
export async function resolveEditableAppInfo(ctx: ToolContext, appId: string): Promise<any> {
  const doc = await ctx.client.get(`/v1/apps/${appId}/appInfos`, { limit: 10 });
  const infos = ((doc.data as JsonApiResource[]) ?? []).map(compact);
  if (!infos.length) throw new Error('App has no appInfo records');
  const editableStates = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'WAITING_FOR_EXPORT_COMPLIANCE'];
  const editable = infos.find(i => editableStates.includes(i.state ?? i.appStoreState));
  if (editable) return editable;
  // A live-only app can still edit some fields (e.g. privacy URLs) on its single record.
  if (infos.length === 1) return infos[0];
  throw new Error(`No editable app info (states: ${infos.map(i => i.state ?? i.appStoreState).join(', ')}). Create a new app version first.`);
}

export interface UploadAssetParams {
  /** Collection to POST the reservation to, e.g. "appScreenshots". */
  type: string;
  /** Relationship name on the asset pointing at its parent, e.g. "appScreenshotSet". */
  parentRelationship: string;
  /** JSON:API type of the parent, e.g. "appScreenshotSets". */
  parentType: string;
  parentId: string;
  filePath: string;
  /** Extra attributes for the reservation (e.g. previewFrameTimeCode, mimeType). */
  extraAttributes?: Record<string, any>;
  /** Send sourceFileChecksum on commit (default true; some asset types reject it). */
  sendChecksum?: boolean;
  /** Wait for Apple to finish processing the asset. Default true. */
  waitForProcessing?: boolean;
  timeoutMs?: number;
}

/**
 * Apple's 3-step asset upload: reserve -> PUT parts -> commit with MD5,
 * then optionally poll assetDeliveryState until COMPLETE or FAILED.
 */
export async function uploadAsset(ctx: ToolContext, p: UploadAssetParams): Promise<any> {
  const { bytes, fileName } = readLocalFile(p.filePath);
  const reservation = await ctx.client.post(`/v1/${p.type}`, {
    data: {
      type: p.type,
      attributes: { fileName, fileSize: bytes.length, ...(p.extraAttributes ?? {}) },
      relationships: { [p.parentRelationship]: rel(p.parentType, p.parentId) },
    },
  });
  const asset = reservation.data as JsonApiResource;
  const ops: UploadOperation[] = asset.attributes?.uploadOperations ?? [];
  await ctx.client.runUploadOperations(ops, bytes);
  const committed = await ctx.client.patch(`/v1/${p.type}/${asset.id}`, {
    data: { type: p.type, id: asset.id, attributes: p.sendChecksum === false ? { uploaded: true } : { uploaded: true, sourceFileChecksum: md5Hex(bytes) } },
  });
  if (ctx.dryRun || p.waitForProcessing === false) return compact(committed.data as JsonApiResource);
  return waitForAsset(ctx, p.type, asset.id, p.timeoutMs ?? 120_000);
}

export async function waitForAsset(ctx: ToolContext, type: string, id: string, timeoutMs = 120_000): Promise<any> {
  const start = Date.now();
  let last: any;
  while (Date.now() - start < timeoutMs) {
    const doc = await ctx.client.get(`/v1/${type}/${id}`);
    last = compact(doc.data as JsonApiResource);
    const delivery = last.videoDeliveryState ?? last.assetDeliveryState ?? last.deliveryState;
    const state = delivery?.state;
    if (state === 'COMPLETE' || state === 'FAILED' || !state) {
      if (state === 'FAILED') {
        const errs = (delivery?.errors ?? []).map((e: any) => e.description ?? e.code).join('; ');
        throw new Error(`Apple rejected the uploaded file (${type}/${id}): ${errs || 'processing failed'}`);
      }
      return last;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  return { ...last, note: `Still processing after ${Math.round(timeoutMs / 1000)}s; check again later with api_request GET /v1/${type}/${id}` };
}

/** Return list items in compact form. */
export function compactList(doc: { data?: any }): any[] {
  const d = doc.data;
  return (Array.isArray(d) ? d : d ? [d] : []).map(compact);
}

/** Common JSON schema snippets. */
export const S = {
  app: { type: 'string', description: 'App: App Store Connect app id (numeric), bundle id (com.example.app), or exact app name' },
  platform: { type: 'string', enum: PLATFORMS, description: 'Platform (default IOS)' },
  version: { type: 'string', description: 'Version string like 1.2.0. Omit to use the newest editable version.' },
  locale: { type: 'string', description: 'Locale code like en-US, de-DE, ja' },
  limit: { type: 'number', description: 'Max items to return (default 50)' },
  filePath: { type: 'string', description: 'Absolute path to a local file (~ allowed)' },
  confirm: { type: 'boolean', description: 'Must be true. Confirms you intend this irreversible/public action.' },
};

export function requireConfirm(args: any, action: string) {
  if (args.confirm !== true && !args.dry_run) {
    throw new Error(`${action} is irreversible or public. Re-run with confirm: true after the user agrees (or dry_run: true to preview).`);
  }
}
