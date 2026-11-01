/**
 * Store media and product pages: screenshots, app previews, review attachments,
 * routing app coverage, custom product pages, in-app events and product page
 * optimization (A/B) experiments.
 *
 * Screenshot and preview sets can belong to three kinds of localization:
 * App Store version localizations (the normal product page), custom product
 * page localizations, and experiment treatment localizations. The "target"
 * helpers below pick the right one, so one set of tools covers all three.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { JsonApiResource } from '../asc/client.js';
import { md5Hex } from '../asc/client.js';
import { compact, defined, rel, rels } from '../asc/format.js';
import { compactList, readLocalFile, requireConfirm, resolveApp, resolveVersion, S, uploadAsset, waitForAsset, type Platform } from './helpers.js';
import type { ToolContext, ToolDef } from './types.js';

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/** Accepted pixel sizes (portrait; landscape = swapped) per screenshot display type. */
const SCREENSHOT_TYPES: Record<string, { device: string; sizes: Array<[number, number]> }> = {
  APP_IPHONE_67: { device: 'iPhone 6.9"/6.7" (16 Pro Max, 15 Pro Max, 14 Plus...). Required for iPhone apps (or 6.5")', sizes: [[1320, 2868], [1290, 2796], [1260, 2736]] },
  APP_IPHONE_65: { device: 'iPhone 6.5" (11 Pro Max, XS Max). Required if no 6.9" set', sizes: [[1242, 2688], [1284, 2778]] },
  APP_IPHONE_61: { device: 'iPhone 6.3"/6.1" (16 Pro, 15, 14)', sizes: [[1206, 2622], [1179, 2556], [1170, 2532], [1125, 2436], [1080, 2340]] },
  APP_IPHONE_58: { device: 'iPhone 5.8" (X, XS, 11 Pro)', sizes: [[1125, 2436], [1170, 2532], [1080, 2340]] },
  APP_IPHONE_55: { device: 'iPhone 5.5" (8 Plus)', sizes: [[1242, 2208]] },
  APP_IPHONE_47: { device: 'iPhone 4.7" (SE 2/3, 8)', sizes: [[750, 1334]] },
  APP_IPHONE_40: { device: 'iPhone 4" (SE 1st gen)', sizes: [[640, 1136], [640, 1096]] },
  APP_IPHONE_35: { device: 'iPhone 3.5" (4s)', sizes: [[640, 960], [640, 920]] },
  APP_IPAD_PRO_3GEN_129: { device: 'iPad 13" / 12.9" (iPad Pro M4, Air 13"). Required for iPad apps', sizes: [[2064, 2752], [2048, 2732]] },
  APP_IPAD_PRO_3GEN_11: { device: 'iPad 11" (Pro 11", Air 11")', sizes: [[1668, 2420], [1668, 2388], [1640, 2360], [1488, 2266]] },
  APP_IPAD_PRO_129: { device: 'iPad Pro 12.9" (2nd gen, home button)', sizes: [[2048, 2732]] },
  APP_IPAD_105: { device: 'iPad 10.5"', sizes: [[1668, 2224]] },
  APP_IPAD_97: { device: 'iPad 9.7"', sizes: [[1536, 2048], [768, 1024], [1536, 2008], [768, 1004]] },
  APP_DESKTOP: { device: 'Mac (16:10)', sizes: [[800, 1280], [900, 1440], [1600, 2560], [1800, 2880]] },
  APP_APPLE_TV: { device: 'Apple TV (landscape)', sizes: [[1080, 1920], [2160, 3840]] },
  APP_APPLE_VISION_PRO: { device: 'Apple Vision Pro (landscape)', sizes: [[2160, 3840]] },
  APP_WATCH_ULTRA: { device: 'Apple Watch Ultra', sizes: [[422, 514], [410, 502]] },
  APP_WATCH_SERIES_10: { device: 'Apple Watch Series 10+', sizes: [[416, 496], [374, 446]] },
  APP_WATCH_SERIES_7: { device: 'Apple Watch Series 7-9', sizes: [[396, 484], [352, 430]] },
  APP_WATCH_SERIES_4: { device: 'Apple Watch Series 4-6, SE', sizes: [[368, 448], [324, 394]] },
  APP_WATCH_SERIES_3: { device: 'Apple Watch Series 3', sizes: [[312, 390], [272, 340]] },
};
const IMESSAGE_TYPES = ['IMESSAGE_APP_IPHONE_67', 'IMESSAGE_APP_IPHONE_61', 'IMESSAGE_APP_IPHONE_65', 'IMESSAGE_APP_IPHONE_58', 'IMESSAGE_APP_IPHONE_55', 'IMESSAGE_APP_IPHONE_47', 'IMESSAGE_APP_IPHONE_40', 'IMESSAGE_APP_IPAD_PRO_3GEN_129', 'IMESSAGE_APP_IPAD_PRO_3GEN_11', 'IMESSAGE_APP_IPAD_PRO_129', 'IMESSAGE_APP_IPAD_105', 'IMESSAGE_APP_IPAD_97'];
const DISPLAY_TYPES = [...Object.keys(SCREENSHOT_TYPES), ...IMESSAGE_TYPES];
const PREVIEW_TYPES = ['IPHONE_67', 'IPHONE_61', 'IPHONE_65', 'IPHONE_58', 'IPHONE_55', 'IPHONE_47', 'IPHONE_40', 'IPHONE_35', 'IPAD_PRO_3GEN_129', 'IPAD_PRO_3GEN_11', 'IPAD_PRO_129', 'IPAD_105', 'IPAD_97', 'DESKTOP', 'APPLE_TV', 'APPLE_VISION_PRO'];

function expectedSizes(displayType: string): Array<[number, number]> | undefined {
  const base = displayType.replace(/^IMESSAGE_/, '');
  return SCREENSHOT_TYPES[base]?.sizes;
}

const DISPLAY_TYPE_HELP =
  'Display types (portrait px; landscape also accepted): ' +
  Object.entries(SCREENSHOT_TYPES)
    .slice(0, 14)
    .map(([k, v]) => `${k} = ${v.device.split('.')[0]} ${v.sizes.map(s => s.join('x')).join('/')}`)
    .join('; ') +
  '; watch types APP_WATCH_ULTRA/SERIES_10/7/4/3; IMESSAGE_APP_* for iMessage apps. App Store needs APP_IPHONE_67 (or APP_IPHONE_65) for iPhone and APP_IPAD_PRO_3GEN_129 for iPad; smaller sizes are scaled from those.';

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const isDry = (id?: string) => !id || id.startsWith('DRY_RUN_');

/** Read width/height from PNG or JPEG bytes. */
function imageSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

function checkScreenshotSize(file: string, displayType: string): string | undefined {
  const { bytes, fileName } = readLocalFile(file);
  const ext = path.extname(fileName).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) return `${fileName}: screenshots must be .png or .jpg`;
  const size = imageSize(bytes);
  const sizes = expectedSizes(displayType);
  if (!size || !sizes) return undefined;
  const ok = sizes.some(([w, h]) => (size.width === w && size.height === h) || (size.width === h && size.height === w));
  return ok ? undefined : `${fileName} is ${size.width}x${size.height}; ${displayType} expects ${sizes.map(s => s.join('x')).join(' or ')} (or landscape). Apple will likely reject it.`;
}

const VIDEO_MIME: Record<string, string> = { '.mov': 'video/quicktime', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v' };

function stateOf(a: any): string | undefined {
  return a.videoDeliveryState?.state ?? a.assetDeliveryState?.state;
}

function mediaSummary(a: any, withUrl = false) {
  const img = a.imageAsset ?? a.previewFrameImage?.image ?? a.previewImage;
  const errs = [...(a.videoDeliveryState?.errors ?? a.assetDeliveryState?.errors ?? [])].map((e: any) => e.description ?? e.code);
  return defined({
    id: a.id,
    fileName: a.fileName,
    size: img?.width ? `${img.width}x${img.height}` : undefined,
    state: stateOf(a),
    errors: errs.length ? errs : undefined,
    previewFrameTimeCode: a.previewFrameTimeCode,
    appEventAssetType: a.appEventAssetType,
    url: withUrl ? imageUrl(img) ?? a.videoUrl : undefined,
  });
}

function imageUrl(img?: { templateUrl?: string; width?: number; height?: number }): string | undefined {
  if (!img?.templateUrl || !img.width) return undefined;
  return img.templateUrl.replace('{w}', String(img.width)).replace('{h}', String(img.height)).replace('{f}', 'png');
}

/** Wait for many assets in parallel; never throws, returns final summaries keyed by id. */
async function waitAll(ctx: ToolContext, type: string, ids: string[], timeoutMs: number, video = false): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (ctx.dryRun) return out;
  await Promise.all(
    ids.map(async id => {
      try {
        out.set(id, mediaSummary(video ? await waitForVideo(ctx, type, id, timeoutMs) : await waitForAsset(ctx, type, id, timeoutMs)));
      } catch (e: any) {
        out.set(id, { id, state: 'FAILED', errors: [e.message] });
      }
    }),
  );
  return out;
}

/** Like waitForAsset, but reads videoDeliveryState (previews / event videos keep processing after upload). */
async function waitForVideo(ctx: ToolContext, type: string, id: string, timeoutMs: number): Promise<any> {
  const start = Date.now();
  let last: any;
  while (Date.now() - start < timeoutMs) {
    last = compact((await ctx.client.get(`/v1/${type}/${id}`)).data as JsonApiResource);
    const s = stateOf(last);
    if (!s || s === 'COMPLETE' || s === 'FAILED') return last;
    await new Promise(r => setTimeout(r, 4000));
  }
  return last;
}

/**
 * Reserve -> PUT -> commit for asset types whose commit PATCH accepts only
 * `uploaded` (app event screenshots/video clips), or when the bytes are in memory.
 */
async function uploadBytes(
  ctx: ToolContext,
  p: { type: string; parentRelationship: string; parentType: string; parentId: string; bytes: Buffer; fileName: string; extraAttributes?: Record<string, any>; sendChecksum: boolean },
): Promise<any> {
  const reservation = await ctx.client.post(`/v1/${p.type}`, {
    data: {
      type: p.type,
      attributes: { fileName: p.fileName, fileSize: p.bytes.length, ...(p.extraAttributes ?? {}) },
      relationships: { [p.parentRelationship]: rel(p.parentType, p.parentId) },
    },
  });
  const asset = reservation.data as JsonApiResource;
  await ctx.client.runUploadOperations(asset.attributes?.uploadOperations ?? [], p.bytes);
  const attributes: Record<string, any> = { uploaded: true };
  if (p.sendChecksum) attributes.sourceFileChecksum = md5Hex(p.bytes);
  const committed = await ctx.client.patch(`/v1/${p.type}/${asset.id}`, { data: { type: p.type, id: asset.id, attributes } });
  return compact(committed.data as JsonApiResource);
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Editable version for writes; for reads fall back to the newest version of any state. */
async function findVersion(ctx: ToolContext, appId: string, platform: Platform = 'IOS', versionString?: string, write = true) {
  try {
    return await resolveVersion(ctx, appId, platform, versionString);
  } catch (e) {
    if (write || versionString) throw e;
    const doc = await ctx.client.get(`/v1/apps/${appId}/appStoreVersions`, { 'filter[platform]': platform, limit: 1, 'fields[appStoreVersions]': 'versionString,appVersionState,appStoreState' });
    const v = compactList(doc)[0];
    if (!v) throw new Error(`App has no ${platform} versions.`);
    return v as any;
  }
}

async function versionLocalizations(ctx: ToolContext, versionId: string): Promise<Map<string, string>> {
  const doc = await ctx.client.get(`/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`, { 'fields[appStoreVersionLocalizations]': 'locale', limit: 200 });
  return new Map(compactList(doc).map(l => [l.locale, l.id]));
}

// ---------------------------------------------------------------------------
// Targets: which localization owns the screenshot / preview sets
// ---------------------------------------------------------------------------

interface Target {
  kind: 'version' | 'custom_product_page' | 'treatment';
  /** JSON:API type of the localization, e.g. appStoreVersionLocalizations. */
  locType: string;
  /** Relationship name on appScreenshotSets/appPreviewSets pointing at the localization. */
  setRel: string;
  info: Record<string, any>;
  locales: Map<string, string>;
  /** Get (or for CPP/treatments, create) the localization id for a locale. */
  ensureLocale(locale: string, create: boolean): Promise<string>;
}

const TARGET_PROPS = {
  app: S.app,
  platform: S.platform,
  version: S.version,
  custom_product_page: { type: 'string', description: 'Work on this custom product page (id or name) instead of the version\'s default product page' },
  treatment: { type: 'string', description: 'Work on this product page optimization treatment id (from list_experiments) instead of the version\'s product page' },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

async function resolveCustomProductPage(ctx: ToolContext, appId: string, page: string): Promise<any> {
  if (UUID.test(page)) return compact((await ctx.client.get(`/v1/appCustomProductPages/${page}`)).data as JsonApiResource);
  const all = await ctx.client.getAll(`/v1/apps/${appId}/appCustomProductPages`, { 'fields[appCustomProductPages]': 'name,url,visible' }, 200);
  const hit = all.data.map(compact).filter(p => p.name?.toLowerCase() === page.toLowerCase());
  if (hit.length !== 1) throw new Error(`Custom product page "${page}" not found${hit.length ? ' (ambiguous)' : ''}. Use list_custom_product_pages.`);
  return hit[0];
}

const CPP_EDITABLE = ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'REJECTED'];

async function customPageVersions(ctx: ToolContext, pageId: string): Promise<any[]> {
  const doc = await ctx.client.get(`/v1/appCustomProductPages/${pageId}/appCustomProductPageVersions`, { limit: 50 });
  return compactList(doc).sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0));
}

async function resolveTarget(ctx: ToolContext, args: any, write: boolean): Promise<Target> {
  const app = await resolveApp(ctx, args.app);
  if (args.custom_product_page && args.treatment) throw new Error('Pass either custom_product_page or treatment, not both.');

  if (args.treatment) {
    const tId = args.treatment;
    const t = compact((await ctx.client.get(`/v1/appStoreVersionExperimentTreatments/${tId}`)).data as JsonApiResource);
    const locs = isDry(tId) ? [] : compactList(await ctx.client.get(`/v1/appStoreVersionExperimentTreatments/${tId}/appStoreVersionExperimentTreatmentLocalizations`, { limit: 200 }));
    const locales = new Map(locs.map(l => [l.locale, l.id]));
    return {
      kind: 'treatment', locType: 'appStoreVersionExperimentTreatmentLocalizations', setRel: 'appStoreVersionExperimentTreatmentLocalization',
      info: { app: app.name, treatment: t.name, treatment_id: tId }, locales,
      async ensureLocale(locale, create) {
        if (locales.has(locale)) return locales.get(locale)!;
        if (!create) throw new Error(`Treatment has no ${locale} localization.`);
        const doc = await ctx.client.post('/v1/appStoreVersionExperimentTreatmentLocalizations', {
          data: { type: 'appStoreVersionExperimentTreatmentLocalizations', attributes: { locale }, relationships: { appStoreVersionExperimentTreatment: rel('appStoreVersionExperimentTreatments', tId) } },
        });
        locales.set(locale, (doc.data as JsonApiResource).id);
        return locales.get(locale)!;
      },
    };
  }

  if (args.custom_product_page) {
    const page = await resolveCustomProductPage(ctx, app.id, args.custom_product_page);
    const versions = await customPageVersions(ctx, page.id);
    const v = versions.find(x => CPP_EDITABLE.includes(x.state)) ?? (write ? undefined : versions[0]);
    if (!v) throw new Error(`Custom product page "${page.name}" has no editable version (states: ${versions.map(x => x.state).join(', ')}). Create one with update_custom_product_page (create_new_version: true).`);
    const locs = compactList(await ctx.client.get(`/v1/appCustomProductPageVersions/${v.id}/appCustomProductPageLocalizations`, { limit: 200, 'fields[appCustomProductPageLocalizations]': 'locale' }));
    const locales = new Map(locs.map(l => [l.locale, l.id]));
    return {
      kind: 'custom_product_page', locType: 'appCustomProductPageLocalizations', setRel: 'appCustomProductPageLocalization',
      info: { app: app.name, custom_product_page: page.name, page_id: page.id, page_version: v.version, page_version_state: v.state }, locales,
      async ensureLocale(locale, create) {
        if (locales.has(locale)) return locales.get(locale)!;
        if (!create) throw new Error(`Custom product page has no ${locale} localization.`);
        const doc = await ctx.client.post('/v1/appCustomProductPageLocalizations', {
          data: { type: 'appCustomProductPageLocalizations', attributes: { locale }, relationships: { appCustomProductPageVersion: rel('appCustomProductPageVersions', v.id) } },
        });
        locales.set(locale, (doc.data as JsonApiResource).id);
        return locales.get(locale)!;
      },
    };
  }

  const version = await findVersion(ctx, app.id, args.platform ?? 'IOS', args.version, write);
  const locales = await versionLocalizations(ctx, version.id);
  return {
    kind: 'version', locType: 'appStoreVersionLocalizations', setRel: 'appStoreVersionLocalization',
    info: { app: app.name, version: version.versionString, version_state: version.appVersionState ?? version.appStoreState }, locales,
    async ensureLocale(locale) {
      const id = locales.get(locale);
      if (!id) throw new Error(`Version ${version.versionString} has no ${locale} localization (has: ${[...locales.keys()].join(', ') || 'none'}). Add the locale's metadata first (version localization), then upload.`);
      return id;
    },
  };
}

// ---------------------------------------------------------------------------
// Screenshot / preview set operations (shared)
// ---------------------------------------------------------------------------

interface MediaKind {
  setType: 'appScreenshotSets' | 'appPreviewSets';
  itemType: 'appScreenshots' | 'appPreviews';
  typeAttr: 'screenshotDisplayType' | 'previewType';
  itemRel: 'appScreenshotSet' | 'appPreviewSet';
  max: number;
  fields: string;
}
const SHOTS: MediaKind = { setType: 'appScreenshotSets', itemType: 'appScreenshots', typeAttr: 'screenshotDisplayType', itemRel: 'appScreenshotSet', max: 10, fields: 'fileName,fileSize,imageAsset,assetDeliveryState' };
const PREVIEWS: MediaKind = { setType: 'appPreviewSets', itemType: 'appPreviews', typeAttr: 'previewType', itemRel: 'appPreviewSet', max: 3, fields: 'fileName,fileSize,previewFrameTimeCode,mimeType,videoUrl,previewFrameImage,videoDeliveryState,assetDeliveryState' };

interface MediaSet {
  id: string;
  type: string;
  items: any[];
}

async function listSets(ctx: ToolContext, kind: MediaKind, locType: string, locId: string): Promise<MediaSet[]> {
  if (isDry(locId)) return [];
  const doc = await ctx.client.get(`/v1/${locType}/${locId}/${kind.setType}`, {
    include: kind.itemType,
    [`limit[${kind.itemType}]`]: 50,
    [`fields[${kind.itemType}]`]: kind.fields,
    limit: 50,
  });
  const byId = new Map((doc.included ?? []).filter(r => r.type === kind.itemType).map(r => [r.id, compact(r)]));
  return compactList(doc).map(s => ({
    id: s.id,
    type: s[kind.typeAttr],
    items: asArray<string>(s.relationships?.[kind.itemType]).map(id => byId.get(id) ?? { id }),
  }));
}

async function setOrder(ctx: ToolContext, kind: MediaKind, setId: string, ids: string[]) {
  await ctx.client.patch(`/v1/${kind.setType}/${setId}/relationships/${kind.itemType}`, rels(kind.itemType, ids));
}

interface UploadItem {
  locale: string;
  type: string;
  files: Array<{ path: string; frame_time_code?: string; label?: string }>;
}

/** Upload media into sets, creating sets as needed. Validates everything before the first write. */
async function uploadIntoSets(ctx: ToolContext, kind: MediaKind, target: Target, items: UploadItem[], args: any) {
  const mode = args.mode ?? 'append';
  if (!['append', 'replace'].includes(mode)) throw new Error('mode must be append or replace');
  const warnings: string[] = [];

  // Phase 1: read and validate.
  const plans: Array<UploadItem & { locId?: string; set?: MediaSet }> = [];
  for (const it of items) {
    if (!it.locale || !it.type || !it.files?.length) throw new Error('Each item needs locale, a display/preview type and at least one file.');
    const allowed = kind === SHOTS ? DISPLAY_TYPES : PREVIEW_TYPES;
    if (!allowed.includes(it.type)) throw new Error(`Unknown ${kind.typeAttr} "${it.type}". Allowed: ${allowed.join(', ')}`);
    for (const f of it.files) {
      readLocalFile(f.path); // throws if missing
      if (kind === SHOTS) {
        const w = checkScreenshotSize(f.path, it.type);
        if (w) warnings.push(w);
      } else if (!VIDEO_MIME[path.extname(f.path).toLowerCase()]) {
        throw new Error(`${f.path}: app previews must be .mov, .m4v or .mp4`);
      }
    }
    const locId = target.locales.get(it.locale);
    if (!locId && target.kind === 'version') await target.ensureLocale(it.locale, false); // throws a helpful error
    const set = locId ? (await listSets(ctx, kind, target.locType, locId)).find(s => s.type === it.type) : undefined;
    const keep = mode === 'replace' ? 0 : set?.items.length ?? 0;
    if (keep + it.files.length > kind.max) {
      throw new Error(`${it.locale} ${it.type}: ${keep} existing + ${it.files.length} new exceeds the limit of ${kind.max}. Use mode "replace" or delete some first.`);
    }
    plans.push({ ...it, locId, set });
  }
  const toDelete = mode === 'replace' ? plans.reduce((n, p) => n + (p.set?.items.length ?? 0), 0) : 0;
  if (toDelete) requireConfirm(args, `Replacing deletes ${toDelete} existing ${kind.itemType}`);

  // Phase 2: write.
  const results: any[] = [];
  const newIds: string[] = [];
  for (const p of plans) {
    const locId = p.locId ?? (await target.ensureLocale(p.locale, true));
    let setId = p.set?.id;
    if (!setId) {
      const doc = await ctx.client.post(`/v1/${kind.setType}`, {
        data: { type: kind.setType, attributes: { [kind.typeAttr]: p.type }, relationships: { [target.setRel]: rel(target.locType, locId) } },
      });
      setId = (doc.data as JsonApiResource).id;
    }
    let kept = p.set?.items ?? [];
    if (mode === 'replace') {
      for (const old of kept) await ctx.client.delete(`/v1/${kind.itemType}/${old.id}`);
      kept = [];
    }
    const uploaded: any[] = [];
    for (const f of p.files) {
      const ext = path.extname(f.path).toLowerCase();
      const extra = kind === PREVIEWS ? defined({ mimeType: VIDEO_MIME[ext], previewFrameTimeCode: f.frame_time_code }) : undefined;
      const a = await uploadAsset(ctx, { type: kind.itemType, parentRelationship: kind.itemRel, parentType: kind.setType, parentId: setId, filePath: f.path, extraAttributes: extra, waitForProcessing: false });
      uploaded.push({ ...mediaSummary(a), fileName: f.label ?? path.basename(f.path) });
      newIds.push(a.id);
    }
    const order = [...kept.map(k => k.id), ...uploaded.map(u => u.id)];
    await setOrder(ctx, kind, setId, order);
    results.push({ locale: p.locale, [kind.typeAttr]: p.type, set_id: setId, set_created: !p.set, deleted: mode === 'replace' ? p.set?.items.length ?? 0 : 0, kept: kept.length, uploaded });
  }

  // Phase 3: wait for processing.
  const wait = args.wait ?? kind === SHOTS;
  if (wait && !ctx.dryRun) {
    const done = await waitAll(ctx, kind.itemType, newIds, (args.timeout_seconds ?? (kind === SHOTS ? 180 : 600)) * 1000, kind === PREVIEWS);
    for (const r of results) r.uploaded = r.uploaded.map((u: any) => ({ ...u, ...(done.get(u.id) ?? {}), fileName: u.fileName }));
  }
  const failed = results.flatMap(r => r.uploaded).filter((u: any) => u.state === 'FAILED');
  return defined({
    target: target.info,
    mode,
    results,
    warnings: warnings.length ? warnings : undefined,
    failed: failed.length ? failed : undefined,
    note: !wait && !ctx.dryRun ? `Uploaded; Apple is still processing. Check state later with ${kind === SHOTS ? 'list_screenshots' : 'list_app_previews'}.` : undefined,
  });
}

async function listMedia(ctx: ToolContext, kind: MediaKind, args: any) {
  const target = await resolveTarget(ctx, args, false);
  const want = asArray<string>(args.locales);
  const locales = [...target.locales.entries()].filter(([l]) => !want.length || want.includes(l));
  const out: any[] = [];
  for (const [locale, locId] of locales) {
    const sets = await listSets(ctx, kind, target.locType, locId);
    out.push({
      locale,
      sets: sets.map(s => ({ id: s.id, [kind.typeAttr]: s.type, count: s.items.length, items: s.items.map(i => mediaSummary(i, !!args.include_urls)) })),
    });
  }
  return { target: target.info, localizations: out };
}

/** Find one set for (locale, type) or by id. */
async function findSet(ctx: ToolContext, kind: MediaKind, target: Target, locale: string, type: string): Promise<MediaSet> {
  const locId = await target.ensureLocale(locale, false);
  const set = (await listSets(ctx, kind, target.locType, locId)).find(s => s.type === type);
  if (!set) throw new Error(`No ${type} set for ${locale}.`);
  return set;
}

async function deleteMedia(ctx: ToolContext, kind: MediaKind, args: any) {
  const ids = asArray<string>(args.ids);
  const types = asArray<string>(kind === SHOTS ? args.display_types : args.preview_types);
  const deleted: any[] = [];
  if (ids.length) {
    requireConfirm(args, `Deleting ${ids.length} ${kind.itemType}`);
    for (const id of ids) {
      await ctx.client.delete(`/v1/${kind.itemType}/${id}`);
      deleted.push({ [kind.itemType]: id });
    }
    return { deleted };
  }
  const locales = asArray<string>(args.locales);
  if (!locales.length || !types.length) throw new Error(`Pass ids, or locales plus ${kind === SHOTS ? 'display_types' : 'preview_types'} (use ["ALL"] for every type) to delete whole sets.`);
  const target = await resolveTarget(ctx, args, true);
  const selected = locales[0] === 'ALL' ? [...target.locales.keys()] : locales;
  const sets: Array<{ locale: string; set: MediaSet }> = [];
  for (const locale of selected) {
    const locId = await target.ensureLocale(locale, false);
    for (const s of await listSets(ctx, kind, target.locType, locId)) if (types.includes('ALL') || types.includes(s.type)) sets.push({ locale, set: s });
  }
  if (!sets.length) return { target: target.info, deleted: [], note: 'Nothing matched.' };
  requireConfirm(args, `Deleting ${sets.length} ${kind.setType} with ${sets.reduce((n, s) => n + s.set.items.length, 0)} items`);
  for (const { locale, set } of sets) {
    await ctx.client.delete(`/v1/${kind.setType}/${set.id}`);
    deleted.push({ locale, [kind.typeAttr]: set.type, set_id: set.id, items: set.items.length });
  }
  return { target: target.info, deleted };
}

/** Normalize upload items from either `items` or top-level locale/type/files. */
function uploadItems(args: any, typeKey: 'display_type' | 'preview_type'): UploadItem[] {
  const raw = args.items?.length ? args.items : [{ locale: args.locale, [typeKey]: args[typeKey], files: args.files }];
  return raw.map((it: any) => ({
    locale: it.locale,
    type: it[typeKey],
    files: asArray<any>(it.files).map(f => (typeof f === 'string' ? { path: f } : { path: f.path, frame_time_code: f.frame_time_code })),
  }));
}

/** Download a processed screenshot from Apple's CDN (public, full resolution, PNG). */
async function downloadScreenshot(item: any, dir: string): Promise<string> {
  const url = imageUrl(item.imageAsset);
  if (!url) throw new Error(`Screenshot ${item.fileName ?? item.id} has no image yet (state ${stateOf(item)}).`);
  const host = new URL(url).hostname;
  if (!host.endsWith('.mzstatic.com')) throw new Error(`Unexpected image host ${host}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download of ${url} failed: ${res.status}`);
  const base = (item.fileName ?? item.id).replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  const file = path.join(dir, `${base}.png`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// ---------------------------------------------------------------------------
// Custom product pages
// ---------------------------------------------------------------------------

async function upsertCppLocalizations(ctx: ToolContext, versionId: string, locs: Array<{ locale: string; promotional_text?: string }>) {
  const existing = isDry(versionId)
    ? new Map<string, any>()
    : new Map(compactList(await ctx.client.get(`/v1/appCustomProductPageVersions/${versionId}/appCustomProductPageLocalizations`, { limit: 200 })).map(l => [l.locale, l]));
  const out: any[] = [];
  for (const l of locs) {
    const cur = existing.get(l.locale);
    if (cur) {
      if (l.promotional_text === undefined) { out.push({ locale: l.locale, action: 'unchanged', id: cur.id }); continue; }
      await ctx.client.patch(`/v1/appCustomProductPageLocalizations/${cur.id}`, { data: { type: 'appCustomProductPageLocalizations', id: cur.id, attributes: { promotionalText: l.promotional_text } } });
      out.push({ locale: l.locale, action: 'updated', id: cur.id });
    } else {
      const doc = await ctx.client.post('/v1/appCustomProductPageLocalizations', {
        data: { type: 'appCustomProductPageLocalizations', attributes: defined({ locale: l.locale, promotionalText: l.promotional_text }), relationships: { appCustomProductPageVersion: rel('appCustomProductPageVersions', versionId) } },
      });
      out.push({ locale: l.locale, action: 'created', id: (doc.data as JsonApiResource).id });
    }
  }
  return out;
}

const CPP_LOCS_SCHEMA = {
  type: 'array',
  description: 'Localizations: [{locale, promotional_text?}] (promotional text max 170 chars)',
  items: { type: 'object', properties: { locale: { type: 'string' }, promotional_text: { type: 'string' } }, required: ['locale'] },
};

// ---------------------------------------------------------------------------
// App events
// ---------------------------------------------------------------------------

async function resolveAppEvent(ctx: ToolContext, appId: string, event: string): Promise<any> {
  if (UUID.test(event)) return compact((await ctx.client.get(`/v1/appEvents/${event}`)).data as JsonApiResource);
  const all = await ctx.client.getAll(`/v1/apps/${appId}/appEvents`, { 'fields[appEvents]': 'referenceName,eventState,primaryLocale' }, 200);
  const hit = all.data.map(compact).filter(e => e.referenceName?.toLowerCase() === event.toLowerCase());
  if (hit.length !== 1) throw new Error(`In-app event "${event}" not found${hit.length ? ' (ambiguous)' : ''}. Use list_app_events.`);
  return hit[0];
}

function eventAttributes(args: any) {
  return defined({
    referenceName: args.reference_name,
    badge: args.badge,
    deepLink: args.deep_link,
    purchaseRequirement: args.purchase_requirement,
    primaryLocale: args.primary_locale,
    priority: args.priority,
    purpose: args.purpose,
    territorySchedules: args.territory_schedules?.map((t: any) => defined({ territories: t.territories, publishStart: t.publish_start, eventStart: t.event_start, eventEnd: t.event_end })),
  });
}

const EVENT_PROPS = {
  reference_name: { type: 'string', description: 'Internal name (not shown to users), max 64 chars' },
  badge: { type: 'string', enum: ['LIVE_EVENT', 'PREMIERE', 'CHALLENGE', 'COMPETITION', 'NEW_SEASON', 'MAJOR_UPDATE', 'SPECIAL_EVENT'] },
  deep_link: { type: 'string', description: 'Universal link or URL scheme opened from the event card' },
  purchase_requirement: { type: 'string', description: 'e.g. NO_COST_ASSOCIATED, IN_APP_PURCHASE, SUBSCRIPTION, IN_APP_PURCHASE_AND_SUBSCRIPTION, IN_APP_PURCHASE_OR_SUBSCRIPTION' },
  primary_locale: { type: 'string', description: 'Fallback locale for the event, e.g. en-US' },
  priority: { type: 'string', enum: ['HIGH', 'NORMAL'] },
  purpose: { type: 'string', enum: ['APPROPRIATE_FOR_ALL_USERS', 'ATTRACT_NEW_USERS', 'KEEP_ACTIVE_USERS_INFORMED', 'BRING_BACK_LAPSED_USERS'] },
  territory_schedules: {
    type: 'array',
    description: 'Schedules: [{territories: ["USA","GBR"...] (3-letter codes), publish_start, event_start, event_end}] as ISO 8601 date-times. Events can be published up to 14 days before start and last up to 31 days.',
    items: { type: 'object', properties: { territories: { type: 'array', items: { type: 'string' } }, publish_start: { type: 'string' }, event_start: { type: 'string' }, event_end: { type: 'string' } } },
  },
  localizations: {
    type: 'array',
    description: 'Upsert localizations: [{locale, name (max 30), short_description (max 50), long_description (max 120)}]',
    items: { type: 'object', properties: { locale: { type: 'string' }, name: { type: 'string' }, short_description: { type: 'string' }, long_description: { type: 'string' } }, required: ['locale'] },
  },
};

async function eventLocalizations(ctx: ToolContext, eventId: string, includeMedia = false): Promise<{ locs: any[]; media: Map<string, any> }> {
  if (isDry(eventId)) return { locs: [], media: new Map() };
  const doc = await ctx.client.get(`/v1/appEvents/${eventId}/localizations`, includeMedia ? { include: 'appEventScreenshots,appEventVideoClips', limit: 200 } : { limit: 200 });
  return { locs: compactList(doc), media: new Map((doc.included ?? []).map(r => [r.id, compact(r)])) };
}

async function upsertEventLocalizations(ctx: ToolContext, eventId: string, locs: any[]) {
  const existing = new Map((await eventLocalizations(ctx, eventId)).locs.map(l => [l.locale, l]));
  const out: any[] = [];
  for (const l of locs) {
    const attributes = defined({ name: l.name, shortDescription: l.short_description, longDescription: l.long_description });
    const cur = existing.get(l.locale);
    if (cur) {
      await ctx.client.patch(`/v1/appEventLocalizations/${cur.id}`, { data: { type: 'appEventLocalizations', id: cur.id, attributes } });
      out.push({ locale: l.locale, action: 'updated', id: cur.id });
    } else {
      const doc = await ctx.client.post('/v1/appEventLocalizations', {
        data: { type: 'appEventLocalizations', attributes: { locale: l.locale, ...attributes }, relationships: { appEvent: rel('appEvents', eventId) } },
      });
      out.push({ locale: l.locale, action: 'created', id: (doc.data as JsonApiResource).id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

async function treatmentsOf(ctx: ToolContext, experimentId: string): Promise<any[]> {
  if (isDry(experimentId)) return [];
  return compactList(await ctx.client.get(`/v2/appStoreVersionExperiments/${experimentId}/appStoreVersionExperimentTreatments`, { include: 'appStoreVersionExperimentTreatmentLocalizations', limit: 50 }));
}

async function addTreatmentLocales(ctx: ToolContext, treatmentId: string, locales: string[]) {
  const have = isDry(treatmentId)
    ? new Set<string>()
    : new Set(compactList(await ctx.client.get(`/v1/appStoreVersionExperimentTreatments/${treatmentId}/appStoreVersionExperimentTreatmentLocalizations`, { limit: 200 })).map(l => l.locale));
  const created: string[] = [];
  for (const locale of locales) {
    if (have.has(locale)) continue;
    await ctx.client.post('/v1/appStoreVersionExperimentTreatmentLocalizations', {
      data: { type: 'appStoreVersionExperimentTreatmentLocalizations', attributes: { locale }, relationships: { appStoreVersionExperimentTreatment: rel('appStoreVersionExperimentTreatments', treatmentId) } },
    });
    created.push(locale);
  }
  return created;
}

async function createTreatment(ctx: ToolContext, experimentId: string, t: { name: string; app_icon_name?: string }) {
  const doc = await ctx.client.post('/v1/appStoreVersionExperimentTreatments', {
    data: { type: 'appStoreVersionExperimentTreatments', attributes: defined({ name: t.name, appIconName: t.app_icon_name }), relationships: { appStoreVersionExperimentV2: rel('appStoreVersionExperiments', experimentId) } },
  });
  return (doc.data as JsonApiResource).id;
}

const TREATMENTS_SCHEMA = {
  type: 'array',
  description: 'Treatments (max 3): [{name, app_icon_name?}]. app_icon_name = name of an alternate app icon included in the build, to test icons.',
  items: { type: 'object', properties: { id: { type: 'string', description: 'update_experiment only: existing treatment id to rename' }, name: { type: 'string' }, app_icon_name: { type: 'string' } }, required: ['name'] },
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SHOT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    locale: S.locale,
    display_type: { type: 'string', enum: DISPLAY_TYPES },
    files: { type: 'array', items: { type: 'string' }, description: 'Image paths in display order' },
  },
  required: ['locale', 'display_type', 'files'],
};

const PREVIEW_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    locale: S.locale,
    preview_type: { type: 'string', enum: PREVIEW_TYPES },
    files: {
      type: 'array',
      description: 'Videos in order: paths, or {path, frame_time_code} where frame_time_code ("00:00:05:00" = HH:MM:SS:FF) picks the poster frame',
      items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string' }, frame_time_code: { type: 'string' } }, required: ['path'] }] },
    },
  },
  required: ['locale', 'preview_type', 'files'],
};

export const mediaTools: ToolDef[] = [
  // ----- Screenshots -----
  {
    name: 'list_screenshots',
    description:
      'List App Store screenshots per locale: screenshot sets by display type, each screenshot\'s file name, size and processing state, in display order. Works for the version product page (default; newest editable version, else newest), a custom product page (custom_product_page) or an experiment treatment (treatment). include_urls adds full-size image URLs.',
    inputSchema: {
      type: 'object',
      properties: { ...TARGET_PROPS, locales: { type: 'array', items: { type: 'string' }, description: 'Only these locales (default all)' }, include_urls: { type: 'boolean', description: 'Add downloadable image URLs' } },
      required: ['app'],
    },
    annotations: { title: 'List screenshots', readOnlyHint: true },
    handler: (args, ctx) => listMedia(ctx, SHOTS, args),
  },
  {
    name: 'upload_screenshots',
    description:
      'Upload App Store screenshots for one or many locales/device sizes in one call. Finds the localization, creates the screenshot set if missing, uploads each file (reserve, PUT, commit), sets the display order to the order given, and waits for Apple\'s processing. mode "append" (default) adds after existing ones; "replace" deletes the set\'s existing screenshots first (needs confirm). Max 10 per set; PNG/JPEG without transparency. Targets the editable version by default, or a custom product page / experiment treatment (their localizations are created if missing). ' +
      DISPLAY_TYPE_HELP,
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        items: { type: 'array', items: SHOT_ITEM_SCHEMA, description: 'Batch: [{locale, display_type, files[]}]. Alternative to locale/display_type/files.' },
        locale: S.locale,
        display_type: { type: 'string', enum: DISPLAY_TYPES },
        files: { type: 'array', items: { type: 'string' }, description: 'Image paths in display order' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default append' },
        wait: { type: 'boolean', description: 'Wait for processing (default true)' },
        timeout_seconds: { type: 'number', description: 'Max wait (default 180)' },
        confirm: S.confirm,
      },
      required: ['app'],
    },
    annotations: { title: 'Upload screenshots' },
    async handler(args, ctx) {
      const target = await resolveTarget(ctx, args, true);
      return uploadIntoSets(ctx, SHOTS, target, uploadItems(args, 'display_type'), args);
    },
  },
  {
    name: 'reorder_screenshots',
    description:
      'Set the display order of screenshots (or app previews with media: "previews") in one set. order lists screenshot ids or file names; anything not listed keeps its relative order after them. Use list_screenshots first to see names.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        locale: S.locale,
        display_type: { type: 'string', description: 'Screenshot display type (or preview type when media is previews), e.g. APP_IPHONE_67' },
        order: { type: 'array', items: { type: 'string' }, description: 'Ids or file names in the new order' },
        media: { type: 'string', enum: ['screenshots', 'previews'], description: 'Default screenshots' },
      },
      required: ['app', 'locale', 'display_type', 'order'],
    },
    annotations: { title: 'Reorder screenshots', idempotentHint: true },
    async handler(args, ctx) {
      const kind = args.media === 'previews' ? PREVIEWS : SHOTS;
      const target = await resolveTarget(ctx, args, true);
      const set = await findSet(ctx, kind, target, args.locale, args.display_type);
      const picked: any[] = [];
      for (const key of args.order as string[]) {
        const matches = set.items.filter(i => i.id === key || i.fileName === key);
        if (matches.length !== 1) throw new Error(`"${key}" ${matches.length ? 'matches several items; use ids' : 'is not in this set'}. Items: ${set.items.map(i => `${i.fileName} (${i.id})`).join(', ')}`);
        if (!picked.includes(matches[0])) picked.push(matches[0]);
      }
      const final = [...picked, ...set.items.filter(i => !picked.includes(i))];
      await setOrder(ctx, kind, set.id, final.map(i => i.id));
      return { target: target.info, locale: args.locale, set_id: set.id, order: final.map(i => i.fileName ?? i.id) };
    },
  },
  {
    name: 'delete_screenshots',
    description:
      'Delete screenshots: either specific ids, or whole screenshot sets by locales + display_types (["ALL"] matches every locale/type). Needs confirm. Works on the version, a custom_product_page or a treatment.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        ids: { type: 'array', items: { type: 'string' }, description: 'Screenshot ids to delete' },
        locales: { type: 'array', items: { type: 'string' }, description: 'Locales whose sets to delete, or ["ALL"]' },
        display_types: { type: 'array', items: { type: 'string' }, description: 'Display types to delete, or ["ALL"]' },
        confirm: S.confirm,
      },
      required: ['app'],
    },
    annotations: { title: 'Delete screenshots', destructiveHint: true },
    handler: (args, ctx) => deleteMedia(ctx, SHOTS, args),
  },
  {
    name: 'copy_screenshots',
    description:
      'Copy screenshots from one locale to other locales (e.g. reuse en-US images for de-DE, fr-FR), optionally into a different target (to_custom_product_page / to_treatment / to_version). Downloads the processed full-resolution images from Apple\'s CDN as PNG and re-uploads them in the same order. display_types limits which sets are copied (default all). mode "replace" (needs confirm when it deletes) or "append".',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        from_locale: S.locale,
        to_locales: { type: 'array', items: { type: 'string' }, description: 'Destination locales' },
        display_types: { type: 'array', items: { type: 'string', enum: DISPLAY_TYPES }, description: 'Only these sets (default all in the source locale)' },
        to_version: { type: 'string', description: 'Destination version string (default same target as source)' },
        to_custom_product_page: { type: 'string', description: 'Destination custom product page id or name' },
        to_treatment: { type: 'string', description: 'Destination experiment treatment id' },
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default replace' },
        wait: { type: 'boolean', description: 'Wait for processing (default true)' },
        confirm: S.confirm,
      },
      required: ['app', 'from_locale', 'to_locales'],
    },
    annotations: { title: 'Copy screenshots between locales' },
    async handler(args, ctx) {
      const source = await resolveTarget(ctx, args, false);
      const srcLoc = await source.ensureLocale(args.from_locale, false);
      const wantTypes = asArray<string>(args.display_types);
      const sets = (await listSets(ctx, SHOTS, source.locType, srcLoc)).filter(s => s.items.length && (!wantTypes.length || wantTypes.includes(s.type)));
      if (!sets.length) throw new Error(`No screenshots to copy in ${args.from_locale}.`);
      const hasDest = args.to_version || args.to_custom_product_page || args.to_treatment;
      const dest = hasDest
        ? await resolveTarget(ctx, { app: args.app, platform: args.platform, version: args.to_version, custom_product_page: args.to_custom_product_page, treatment: args.to_treatment }, true)
        : await resolveTarget(ctx, args, true);
      const dir = mkdtempSync(path.join(tmpdir(), 'asc-shots-'));
      try {
        const files = new Map<string, Array<{ path: string }>>();
        for (const s of sets) {
          // One directory per image so duplicate file names cannot collide.
          const paths = await Promise.all(s.items.map(item => downloadScreenshot(item, mkdtempSync(path.join(dir, 'img-')))));
          files.set(s.type, paths.map(p => ({ path: p })));
        }
        const items: UploadItem[] = asArray<string>(args.to_locales).flatMap(locale => sets.map(s => ({ locale, type: s.type, files: files.get(s.type)! })));
        const result = await uploadIntoSets(ctx, SHOTS, dest, items, { ...args, mode: args.mode ?? 'replace' });
        return { source: { ...source.info, locale: args.from_locale, sets: sets.map(s => `${s.type} (${s.items.length})`) }, ...result };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },

  // ----- App previews -----
  {
    name: 'list_app_previews',
    description: 'List app preview videos per locale: preview sets by preview type, each video\'s file name, poster frame time code and processing state. Same targets as list_screenshots (version, custom_product_page, treatment).',
    inputSchema: {
      type: 'object',
      properties: { ...TARGET_PROPS, locales: { type: 'array', items: { type: 'string' } }, include_urls: { type: 'boolean', description: 'Add poster image / video URLs' } },
      required: ['app'],
    },
    annotations: { title: 'List app previews', readOnlyHint: true },
    handler: (args, ctx) => listMedia(ctx, PREVIEWS, args),
  },
  {
    name: 'upload_app_previews',
    description:
      'Upload app preview videos (.mov/.m4v/.mp4, 15-30 s, max 500 MB, up to 3 per set) for one or many locales and preview types; creates sets as needed and keeps the given order. frame_time_code ("HH:MM:SS:FF", e.g. "00:00:05:00") picks the poster frame. Preview types: IPHONE_67 (6.9"/6.7", 886x1920), IPHONE_65, IPHONE_61, IPHONE_58 (886x1920), IPHONE_55 (1080x1920), IPHONE_47 (750x1334), IPAD_PRO_3GEN_129 / IPAD_PRO_3GEN_11 / IPAD_PRO_129 / IPAD_105 (1200x1600), IPAD_97 (900x1200), DESKTOP / APPLE_TV (1920x1080), APPLE_VISION_PRO (3840x2160). Video processing takes minutes; wait defaults to false. mode "replace" needs confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        items: { type: 'array', items: PREVIEW_ITEM_SCHEMA, description: 'Batch: [{locale, preview_type, files}]' },
        locale: S.locale,
        preview_type: { type: 'string', enum: PREVIEW_TYPES },
        files: PREVIEW_ITEM_SCHEMA.properties.files,
        mode: { type: 'string', enum: ['append', 'replace'], description: 'Default append' },
        wait: { type: 'boolean', description: 'Wait for video processing (default false)' },
        timeout_seconds: { type: 'number', description: 'Max wait when wait is true (default 600)' },
        confirm: S.confirm,
      },
      required: ['app'],
    },
    annotations: { title: 'Upload app previews' },
    async handler(args, ctx) {
      const target = await resolveTarget(ctx, args, true);
      return uploadIntoSets(ctx, PREVIEWS, target, uploadItems(args, 'preview_type'), args);
    },
  },
  {
    name: 'delete_app_previews',
    description: 'Delete app previews: specific ids, or whole preview sets by locales + preview_types (["ALL"] matches all). Needs confirm.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        ids: { type: 'array', items: { type: 'string' } },
        locales: { type: 'array', items: { type: 'string' } },
        preview_types: { type: 'array', items: { type: 'string' } },
        confirm: S.confirm,
      },
      required: ['app'],
    },
    annotations: { title: 'Delete app previews', destructiveHint: true },
    handler: (args, ctx) => deleteMedia(ctx, PREVIEWS, args),
  },

  // ----- Review attachments & routing coverage -----
  {
    name: 'upload_review_attachments',
    description:
      'Attach files for App Review (demo videos, documents, screenshots of hardware) to a version\'s App Review information. Creates the review detail record if missing. replace: true deletes existing attachments first (needs confirm). Call with no files to just list current attachments.',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, platform: S.platform, version: S.version, files: { type: 'array', items: { type: 'string' }, description: 'Local file paths' }, replace: { type: 'boolean' }, confirm: S.confirm },
      required: ['app'],
    },
    annotations: { title: 'Upload App Review attachments' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const version = await resolveVersion(ctx, app.id, args.platform ?? 'IOS', args.version);
      const files = asArray<string>(args.files);
      files.forEach(f => readLocalFile(f));
      let detail: any;
      try {
        const doc = await ctx.client.get(`/v1/appStoreVersions/${version.id}/appStoreReviewDetail`, { include: 'appStoreReviewAttachments' });
        if (doc.data) detail = { ...compact(doc.data as JsonApiResource), attachments: (doc.included ?? []).filter(r => r.type === 'appStoreReviewAttachments').map(compact) };
      } catch (e: any) {
        if (e.status !== 404) throw e;
      }
      if (!files.length) return { version: version.versionString, review_detail_id: detail?.id, attachments: (detail?.attachments ?? []).map((a: any) => mediaSummary(a)) };
      let created = false;
      if (!detail) {
        const doc = await ctx.client.post('/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', relationships: { appStoreVersion: rel('appStoreVersions', version.id) } } });
        detail = { id: (doc.data as JsonApiResource).id, attachments: [] };
        created = true;
      }
      const removed: string[] = [];
      if (args.replace && detail.attachments.length) {
        requireConfirm(args, `Deleting ${detail.attachments.length} existing review attachments`);
        for (const a of detail.attachments) {
          await ctx.client.delete(`/v1/appStoreReviewAttachments/${a.id}`);
          removed.push(a.fileName);
        }
      }
      const uploaded: any[] = [];
      for (const f of files) {
        const a = await uploadAsset(ctx, { type: 'appStoreReviewAttachments', parentRelationship: 'appStoreReviewDetail', parentType: 'appStoreReviewDetails', parentId: detail.id, filePath: f });
        uploaded.push({ ...mediaSummary(a), fileName: path.basename(f) });
      }
      return defined({ version: version.versionString, review_detail_id: detail.id, review_detail_created: created || undefined, removed: removed.length ? removed : undefined, uploaded });
    },
  },
  {
    name: 'upload_routing_coverage',
    description:
      'Upload the routing app coverage file (.geojson) for a navigation/routing app version; replaces the existing file (needs confirm if one exists). Call with no file to see the current one.',
    inputSchema: { type: 'object', properties: { app: S.app, platform: S.platform, version: S.version, file: S.filePath, confirm: S.confirm }, required: ['app'] },
    annotations: { title: 'Upload routing app coverage' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const version = await resolveVersion(ctx, app.id, args.platform ?? 'IOS', args.version);
      let existing: any;
      try {
        const doc = await ctx.client.get(`/v1/appStoreVersions/${version.id}/routingAppCoverage`);
        if (doc.data) existing = compact(doc.data as JsonApiResource);
      } catch (e: any) {
        if (e.status !== 404) throw e;
      }
      if (!args.file) return { version: version.versionString, routing_coverage: existing ? mediaSummary(existing) : null };
      if (path.extname(args.file).toLowerCase() !== '.geojson') throw new Error('Routing coverage must be a .geojson file.');
      readLocalFile(args.file);
      if (existing) {
        requireConfirm(args, `Replacing the existing routing coverage file ${existing.fileName}`);
        await ctx.client.delete(`/v1/routingAppCoverages/${existing.id}`);
      }
      const a = await uploadAsset(ctx, { type: 'routingAppCoverages', parentRelationship: 'appStoreVersion', parentType: 'appStoreVersions', parentId: version.id, filePath: args.file });
      return { version: version.versionString, replaced: existing?.fileName, uploaded: { ...mediaSummary(a), fileName: path.basename(args.file) } };
    },
  },

  // ----- Custom product pages -----
  {
    name: 'list_custom_product_pages',
    description: 'List custom product pages with URL, visibility, versions (state, deep link) and localizations (promotional text). Pass custom_product_page for one page only. Screenshots: list_screenshots with custom_product_page.',
    inputSchema: { type: 'object', properties: { app: S.app, custom_product_page: { type: 'string', description: 'Id or name (default all)' } }, required: ['app'] },
    annotations: { title: 'List custom product pages', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const pages = args.custom_product_page
        ? [await resolveCustomProductPage(ctx, app.id, args.custom_product_page)]
        : (await ctx.client.getAll(`/v1/apps/${app.id}/appCustomProductPages`, {}, 100)).data.map(compact);
      const out: any[] = [];
      for (const p of pages) {
        const versions = await customPageVersions(ctx, p.id);
        const vs: any[] = [];
        for (const v of versions.slice(0, 3)) {
          const locs = compactList(await ctx.client.get(`/v1/appCustomProductPageVersions/${v.id}/appCustomProductPageLocalizations`, { limit: 200, 'fields[appCustomProductPageLocalizations]': 'locale,promotionalText' }));
          vs.push(defined({ id: v.id, version: v.version, state: v.state, deepLink: v.deepLink, localizations: locs.map(l => defined({ id: l.id, locale: l.locale, promotionalText: l.promotionalText })) }));
        }
        out.push({ id: p.id, name: p.name, url: p.url, visible: p.visible, versions: vs });
      }
      return { app: app.name, count: out.length, custom_product_pages: out };
    },
  },
  {
    name: 'create_custom_product_page',
    description:
      'Create a custom product page (max 35 per app) with its first version and localizations in one call. Optionally copy screenshots/previews from an App Store version (template_version) or another custom page (template_custom_product_page). Then add media with upload_screenshots / copy_screenshots (custom_product_page arg), and submit the page version for review through a review submission. Default locale: the app\'s primary locale.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        name: { type: 'string', description: 'Page name (internal, max 30 chars)' },
        localizations: CPP_LOCS_SCHEMA,
        deep_link: { type: 'string', description: 'Optional universal link opened when the app is launched from this page' },
        template_version: { type: 'string', description: 'Copy media from this App Store version string (e.g. the live 1.0)' },
        platform: S.platform,
        template_custom_product_page: { type: 'string', description: 'Copy media from this custom product page (id or name)' },
      },
      required: ['app', 'name'],
    },
    annotations: { title: 'Create custom product page' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const locs: Array<{ locale: string; promotional_text?: string }> = args.localizations?.length ? args.localizations : [{ locale: app.primaryLocale }];
      const relationships: Record<string, any> = {
        app: rel('apps', app.id),
        appCustomProductPageVersions: rels('appCustomProductPageVersions', ['${new-version}']),
      };
      if (args.template_version) {
        const v = await resolveVersion(ctx, app.id, args.platform ?? 'IOS', args.template_version);
        relationships.appStoreVersionTemplate = rel('appStoreVersions', v.id);
      }
      if (args.template_custom_product_page) {
        const p = await resolveCustomProductPage(ctx, app.id, args.template_custom_product_page);
        relationships.customProductPageTemplate = rel('appCustomProductPages', p.id);
      }
      const locIds = locs.map((_, i) => `\${new-loc-${i}}`);
      const doc = await ctx.client.post('/v1/appCustomProductPages', {
        data: { type: 'appCustomProductPages', attributes: { name: args.name }, relationships },
        included: [
          {
            type: 'appCustomProductPageVersions',
            id: '${new-version}',
            ...(args.deep_link ? { attributes: { deepLink: args.deep_link } } : {}),
            relationships: { appCustomProductPageLocalizations: rels('appCustomProductPageLocalizations', locIds) },
          },
          ...locs.map((l, i) => ({ type: 'appCustomProductPageLocalizations', id: locIds[i], attributes: defined({ locale: l.locale, promotionalText: l.promotional_text }) })),
        ],
      });
      const page = compact(doc.data as JsonApiResource);
      return { custom_product_page: defined({ id: page.id, name: page.name, url: page.url, visible: page.visible }), locales: locs.map(l => l.locale), next: 'Add screenshots with upload_screenshots or copy_screenshots (custom_product_page: id), then submit the page version for review.' };
    },
  },
  {
    name: 'update_custom_product_page',
    description:
      'Update a custom product page: name, visible, deep link, and upsert localizations (promotional text; new locales are created). If the page has no editable version (e.g. approved) and you change deep link or localizations, pass create_new_version: true to start a new version. delete_locales removes localizations (needs confirm).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        custom_product_page: { type: 'string', description: 'Id or name' },
        name: { type: 'string' },
        visible: { type: 'boolean', description: 'Whether the page URL is usable/visible' },
        deep_link: { type: 'string' },
        localizations: CPP_LOCS_SCHEMA,
        delete_locales: { type: 'array', items: { type: 'string' } },
        create_new_version: { type: 'boolean', description: 'Create a new page version when none is editable' },
        confirm: S.confirm,
      },
      required: ['app', 'custom_product_page'],
    },
    annotations: { title: 'Update custom product page' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const page = await resolveCustomProductPage(ctx, app.id, args.custom_product_page);
      const out: any = { custom_product_page: page.name, id: page.id };
      const touchesVersion = args.deep_link !== undefined || args.localizations?.length || args.delete_locales?.length;
      // Validate before the first write so a failure does not leave a half-applied update.
      const versions = touchesVersion ? await customPageVersions(ctx, page.id) : [];
      let v = versions.find(x => CPP_EDITABLE.includes(x.state));
      if (touchesVersion && !v && !args.create_new_version) throw new Error(`No editable version of "${page.name}" (states: ${versions.map(x => x.state).join(', ')}). Re-run with create_new_version: true.`);
      if (args.delete_locales?.length) requireConfirm(args, `Deleting localizations ${args.delete_locales.join(', ')}`);
      if (args.name !== undefined || args.visible !== undefined) {
        await ctx.client.patch(`/v1/appCustomProductPages/${page.id}`, { data: { type: 'appCustomProductPages', id: page.id, attributes: defined({ name: args.name, visible: args.visible }) } });
        out.page_updated = defined({ name: args.name, visible: args.visible });
      }
      if (!touchesVersion) return out;
      if (!v) {
        const doc = await ctx.client.post('/v1/appCustomProductPageVersions', {
          data: { type: 'appCustomProductPageVersions', attributes: defined({ deepLink: args.deep_link }), relationships: { appCustomProductPage: rel('appCustomProductPages', page.id) } },
        });
        v = compact(doc.data as JsonApiResource);
        out.new_version_id = v.id;
      } else if (args.deep_link !== undefined) {
        await ctx.client.patch(`/v1/appCustomProductPageVersions/${v.id}`, { data: { type: 'appCustomProductPageVersions', id: v.id, attributes: { deepLink: args.deep_link } } });
      }
      out.version = defined({ id: v.id, version: v.version, state: v.state, deepLink: args.deep_link });
      if (args.localizations?.length) out.localizations = await upsertCppLocalizations(ctx, v.id, args.localizations);
      if (args.delete_locales?.length) {
        const existing = isDry(v.id) ? [] : compactList(await ctx.client.get(`/v1/appCustomProductPageVersions/${v.id}/appCustomProductPageLocalizations`, { limit: 200 }));
        out.deleted_locales = [];
        for (const l of existing.filter(x => args.delete_locales.includes(x.locale))) {
          await ctx.client.delete(`/v1/appCustomProductPageLocalizations/${l.id}`);
          out.deleted_locales.push(l.locale);
        }
      }
      return out;
    },
  },
  {
    name: 'delete_custom_product_page',
    description: 'Delete a custom product page and all its versions/media. Its URL stops working. Needs confirm.',
    inputSchema: { type: 'object', properties: { app: S.app, custom_product_page: { type: 'string', description: 'Id or name' }, confirm: S.confirm }, required: ['app', 'custom_product_page'] },
    annotations: { title: 'Delete custom product page', destructiveHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const page = await resolveCustomProductPage(ctx, app.id, args.custom_product_page);
      requireConfirm(args, `Deleting custom product page "${page.name}"`);
      await ctx.client.delete(`/v1/appCustomProductPages/${page.id}`);
      return { deleted: { id: page.id, name: page.name } };
    },
  },

  // ----- In-app events -----
  {
    name: 'list_app_events',
    description: 'List in-app events with state, badge, schedules, deep link, and per-locale name/descriptions plus event card / details page media and their processing state. Pass event (id or reference name) for one event; states filters by eventState.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        event: { type: 'string', description: 'Event id or reference name' },
        states: { type: 'array', items: { type: 'string', enum: ['DRAFT', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'REJECTED', 'ACCEPTED', 'APPROVED', 'PUBLISHED', 'PAST', 'ARCHIVED'] } },
      },
      required: ['app'],
    },
    annotations: { title: 'List in-app events', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const events = args.event
        ? [await resolveAppEvent(ctx, app.id, args.event)]
        : (await ctx.client.getAll(`/v1/apps/${app.id}/appEvents`, { 'filter[eventState]': args.states?.length ? args.states : undefined }, 100)).data.map(compact);
      const out: any[] = [];
      for (const e of events) {
        const { locs, media } = await eventLocalizations(ctx, e.id, true);
        const { relationships, type, ...attrs } = e;
        out.push({
          ...attrs,
          localizations: locs.map(l =>
            defined({
              id: l.id,
              locale: l.locale,
              name: l.name,
              shortDescription: l.shortDescription,
              longDescription: l.longDescription,
              media: [...asArray<string>(l.relationships?.appEventScreenshots), ...asArray<string>(l.relationships?.appEventVideoClips)].map(id => mediaSummary(media.get(id) ?? { id })),
            }),
          ),
        });
      }
      return { app: app.name, count: out.length, events: out };
    },
  },
  {
    name: 'create_app_event',
    description:
      'Create an in-app event (starts as DRAFT) with its attributes and localizations in one call. Then add media with upload_app_event_media (an event card and details page image or video per locale) and submit it for review through a review submission.',
    inputSchema: { type: 'object', properties: { app: S.app, ...EVENT_PROPS }, required: ['app', 'reference_name'] },
    annotations: { title: 'Create in-app event' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const doc = await ctx.client.post('/v1/appEvents', { data: { type: 'appEvents', attributes: eventAttributes(args), relationships: { app: rel('apps', app.id) } } });
      const event = compact(doc.data as JsonApiResource);
      const localizations = args.localizations?.length ? await upsertEventLocalizations(ctx, event.id, args.localizations) : [];
      return { event: { id: event.id, referenceName: event.referenceName, eventState: event.eventState }, localizations };
    },
  },
  {
    name: 'update_app_event',
    description: 'Update an in-app event\'s attributes (only fields you pass) and upsert localizations (creates missing locales). Use this to set event names/descriptions per locale.',
    inputSchema: { type: 'object', properties: { app: S.app, event: { type: 'string', description: 'Event id or reference name' }, ...EVENT_PROPS }, required: ['app', 'event'] },
    annotations: { title: 'Update in-app event' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const event = await resolveAppEvent(ctx, app.id, args.event);
      const attributes = eventAttributes(args);
      if (Object.keys(attributes).length) await ctx.client.patch(`/v1/appEvents/${event.id}`, { data: { type: 'appEvents', id: event.id, attributes } });
      const localizations = args.localizations?.length ? await upsertEventLocalizations(ctx, event.id, args.localizations) : [];
      return { event: { id: event.id, referenceName: event.referenceName }, updated: Object.keys(attributes), localizations };
    },
  },
  {
    name: 'upload_app_event_media',
    description:
      'Upload in-app event media per locale: EVENT_CARD (16:9, 1920x1080 image or video) and EVENT_DETAILS_PAGE (9:16, 1080x1920 image or video). Images: .png/.jpg; videos: .mov/.mp4/.m4v (frame_time_code "HH:MM:SS:FF" sets the poster frame). Creates the event localization if missing. An existing asset of the same type in that locale is replaced (needs confirm).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        event: { type: 'string', description: 'Event id or reference name' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { locale: S.locale, asset_type: { type: 'string', enum: ['EVENT_CARD', 'EVENT_DETAILS_PAGE'] }, file: S.filePath, frame_time_code: { type: 'string' } },
            required: ['locale', 'asset_type', 'file'],
          },
        },
        wait: { type: 'boolean', description: 'Wait for processing (default true for images, false for videos)' },
        confirm: S.confirm,
      },
      required: ['app', 'event', 'items'],
    },
    annotations: { title: 'Upload in-app event media' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const event = await resolveAppEvent(ctx, app.id, args.event);
      const { locs, media } = await eventLocalizations(ctx, event.id, true);
      const locByLocale = new Map(locs.map(l => [l.locale, l]));
      const plan = (args.items as any[]).map(it => {
        const ext = path.extname(it.file).toLowerCase();
        const video = !!VIDEO_MIME[ext];
        if (!video && !['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error(`${it.file}: use .png/.jpg images or .mov/.mp4/.m4v videos`);
        readLocalFile(it.file);
        const loc = locByLocale.get(it.locale);
        const ids = loc ? [...asArray<string>(loc.relationships?.appEventScreenshots), ...asArray<string>(loc.relationships?.appEventVideoClips)] : [];
        const existing = ids.map(id => media.get(id)).filter(m => m?.appEventAssetType === it.asset_type);
        return { ...it, video, existing };
      });
      const replacing = plan.flatMap(p => p.existing);
      if (replacing.length) requireConfirm(args, `Replacing ${replacing.length} existing event media`);
      const results: any[] = [];
      const waits: Array<{ id: string; type: string; video: boolean }> = [];
      for (const p of plan) {
        let locId = locByLocale.get(p.locale)?.id;
        if (!locId) {
          locId = (await upsertEventLocalizations(ctx, event.id, [{ locale: p.locale }]))[0].id as string;
          locByLocale.set(p.locale, { id: locId, locale: p.locale });
        }
        for (const old of p.existing) await ctx.client.delete(`/v1/${old.type}/${old.id}`);
        const type = p.video ? 'appEventVideoClips' : 'appEventScreenshots';
        const { bytes, fileName } = readLocalFile(p.file);
        const a = await uploadBytes(ctx, {
          type, parentRelationship: 'appEventLocalization', parentType: 'appEventLocalizations', parentId: locId!, bytes, fileName, sendChecksum: false,
          extraAttributes: defined({ appEventAssetType: p.asset_type, previewFrameTimeCode: p.video ? p.frame_time_code : undefined }),
        });
        waits.push({ id: a.id, type, video: p.video });
        results.push({ locale: p.locale, asset_type: p.asset_type, replaced: p.existing.length || undefined, ...mediaSummary(a), fileName });
      }
      if (!ctx.dryRun) {
        for (const w of waits) {
          if (args.wait ?? !w.video) {
            const done = await waitAll(ctx, w.type, [w.id], (w.video ? 600 : 180) * 1000, w.video);
            Object.assign(results.find(r => r.id === w.id), done.get(w.id), { fileName: results.find(r => r.id === w.id).fileName });
          }
        }
      }
      return { event: event.referenceName, results };
    },
  },
  {
    name: 'delete_app_event',
    description: 'Delete an in-app event (typically drafts or unpublished events), or only some of its localizations with locales. Needs confirm.',
    inputSchema: { type: 'object', properties: { app: S.app, event: { type: 'string', description: 'Event id or reference name' }, locales: { type: 'array', items: { type: 'string' }, description: 'Only delete these localizations' }, confirm: S.confirm }, required: ['app', 'event'] },
    annotations: { title: 'Delete in-app event', destructiveHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const event = await resolveAppEvent(ctx, app.id, args.event);
      const locales = asArray<string>(args.locales);
      if (locales.length) {
        const { locs } = await eventLocalizations(ctx, event.id);
        const hits = locs.filter(l => locales.includes(l.locale));
        requireConfirm(args, `Deleting ${hits.length} localizations of event "${event.referenceName}"`);
        for (const l of hits) await ctx.client.delete(`/v1/appEventLocalizations/${l.id}`);
        return { event: event.referenceName, deleted_locales: hits.map(l => l.locale) };
      }
      requireConfirm(args, `Deleting in-app event "${event.referenceName}"`);
      await ctx.client.delete(`/v1/appEvents/${event.id}`);
      return { deleted: { id: event.id, referenceName: event.referenceName } };
    },
  },

  // ----- Product page optimization -----
  {
    name: 'list_experiments',
    description: 'List product page optimization (A/B test) experiments: state, platform, traffic proportion, dates, review requirement, and treatments with their locales. Pass experiment id for one. Treatment screenshots: list_screenshots with treatment.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        experiment: { type: 'string', description: 'Experiment id (default all)' },
        states: { type: 'array', items: { type: 'string', enum: ['PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'ACCEPTED', 'APPROVED', 'REJECTED', 'COMPLETED', 'STOPPED'] } },
      },
      required: ['app'],
    },
    annotations: { title: 'List experiments', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const exps = args.experiment
        ? [compact((await ctx.client.get(`/v2/appStoreVersionExperiments/${args.experiment}`)).data as JsonApiResource)]
        : (await ctx.client.getAll(`/v1/apps/${app.id}/appStoreVersionExperimentsV2`, { 'filter[state]': args.states?.length ? args.states : undefined }, 100)).data.map(compact);
      const out: any[] = [];
      for (const e of exps) {
        const doc = await ctx.client.get(`/v2/appStoreVersionExperiments/${e.id}/appStoreVersionExperimentTreatments`, {
          include: 'appStoreVersionExperimentTreatmentLocalizations',
          'fields[appStoreVersionExperimentTreatmentLocalizations]': 'locale',
          limit: 50,
        });
        const locs = new Map((doc.included ?? []).map(r => [r.id, r.attributes?.locale]));
        const { relationships, type, ...attrs } = e;
        out.push({
          ...attrs,
          latestControlVersion: relationships?.latestControlVersion,
          treatments: compactList(doc).map(t => defined({ id: t.id, name: t.name, appIconName: t.appIconName, promotedDate: t.promotedDate, locales: asArray<string>(t.relationships?.appStoreVersionExperimentTreatmentLocalizations).map(id => locs.get(id)) })),
        });
      }
      return { app: app.name, count: out.length, experiments: out };
    },
  },
  {
    name: 'create_experiment',
    description:
      'Create a product page optimization experiment (V2) with up to 3 treatments and their localizations in one call. traffic_proportion = percent of App Store traffic in the test, split evenly between control and treatments. locales defaults to the locales of the newest App Store version. Then upload treatment screenshots/previews with upload_screenshots / copy_screenshots (treatment: id); submit for review if reviewRequired; then start_experiment.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        name: { type: 'string', description: 'Experiment name' },
        platform: S.platform,
        traffic_proportion: { type: 'number', description: 'Percent of traffic (integer 1-100)' },
        treatments: TREATMENTS_SCHEMA,
        locales: { type: 'array', items: { type: 'string' }, description: 'Treatment localizations to create' },
      },
      required: ['app', 'name', 'traffic_proportion', 'treatments'],
    },
    annotations: { title: 'Create experiment' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const platform: Platform = args.platform ?? 'IOS';
      if (!args.treatments?.length || args.treatments.length > 3) throw new Error('Pass 1-3 treatments.');
      let locales: string[] = asArray(args.locales);
      if (!locales.length) {
        const v = await findVersion(ctx, app.id, platform, undefined, false).catch(() => undefined);
        locales = v ? [...(await versionLocalizations(ctx, v.id)).keys()] : [app.primaryLocale];
      }
      const doc = await ctx.client.post('/v2/appStoreVersionExperiments', {
        data: { type: 'appStoreVersionExperiments', attributes: { name: args.name, platform, trafficProportion: Math.round(args.traffic_proportion) }, relationships: { app: rel('apps', app.id) } },
      });
      const exp = compact(doc.data as JsonApiResource);
      const treatments: any[] = [];
      for (const t of args.treatments) {
        const id = await createTreatment(ctx, exp.id, t);
        treatments.push({ id, name: t.name, locales: await addTreatmentLocales(ctx, id, locales) });
      }
      return { experiment: defined({ id: exp.id, name: args.name, platform, trafficProportion: exp.trafficProportion, state: exp.state }), treatments, next: 'Upload media per treatment with upload_screenshots (treatment: id) or copy_screenshots (to_treatment: id).' };
    },
  },
  {
    name: 'update_experiment',
    description: 'Update an experiment: name, traffic_proportion, add or rename treatments (treatments with id are updated, without id are created), add locales to every treatment, or delete treatments (delete_treatment_ids, needs confirm).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        experiment: { type: 'string', description: 'Experiment id' },
        name: { type: 'string' },
        traffic_proportion: { type: 'number' },
        treatments: TREATMENTS_SCHEMA,
        locales: { type: 'array', items: { type: 'string' }, description: 'Ensure these localizations exist on all treatments' },
        delete_treatment_ids: { type: 'array', items: { type: 'string' } },
        confirm: S.confirm,
      },
      required: ['app', 'experiment'],
    },
    annotations: { title: 'Update experiment' },
    async handler(args, ctx) {
      await resolveApp(ctx, args.app);
      const id = args.experiment;
      const out: any = { experiment: id };
      const attributes = defined({ name: args.name, trafficProportion: args.traffic_proportion !== undefined ? Math.round(args.traffic_proportion) : undefined });
      if (Object.keys(attributes).length) {
        await ctx.client.patch(`/v2/appStoreVersionExperiments/${id}`, { data: { type: 'appStoreVersionExperiments', id, attributes } });
        out.updated = Object.keys(attributes);
      }
      if (args.delete_treatment_ids?.length) {
        requireConfirm(args, `Deleting ${args.delete_treatment_ids.length} treatments`);
        for (const t of args.delete_treatment_ids) await ctx.client.delete(`/v1/appStoreVersionExperimentTreatments/${t}`);
        out.deleted_treatments = args.delete_treatment_ids;
      }
      out.treatments = [];
      for (const t of args.treatments ?? []) {
        if (t.id) {
          await ctx.client.patch(`/v1/appStoreVersionExperimentTreatments/${t.id}`, { data: { type: 'appStoreVersionExperimentTreatments', id: t.id, attributes: defined({ name: t.name, appIconName: t.app_icon_name }) } });
          out.treatments.push({ id: t.id, name: t.name, action: 'updated' });
        } else {
          out.treatments.push({ id: await createTreatment(ctx, id, t), name: t.name, action: 'created' });
        }
      }
      if (args.locales?.length) {
        const all = [...(await treatmentsOf(ctx, id)).map(t => t.id), ...out.treatments.filter((t: any) => t.action === 'created').map((t: any) => t.id)];
        out.locales_added = {};
        for (const t of new Set(all)) out.locales_added[t] = await addTreatmentLocales(ctx, t, args.locales);
      }
      return out;
    },
  },
  {
    name: 'start_experiment',
    description: 'Start a product page optimization experiment so App Store users see the treatments. If reviewRequired is true it must be approved first (submit via a review submission). Needs confirm.',
    inputSchema: { type: 'object', properties: { app: S.app, experiment: { type: 'string', description: 'Experiment id' }, confirm: S.confirm }, required: ['app', 'experiment'] },
    annotations: { title: 'Start experiment', destructiveHint: true },
    async handler(args, ctx) {
      await resolveApp(ctx, args.app);
      const exp = compact((await ctx.client.get(`/v2/appStoreVersionExperiments/${args.experiment}`)).data as JsonApiResource);
      requireConfirm(args, `Starting experiment "${exp.name}" for ${exp.trafficProportion}% of traffic`);
      const doc = await ctx.client.patch(`/v2/appStoreVersionExperiments/${exp.id}`, { data: { type: 'appStoreVersionExperiments', id: exp.id, attributes: { started: true } } });
      const after = compact(doc.data as JsonApiResource);
      return defined({ id: exp.id, name: exp.name, state: after.state ?? exp.state, startDate: after.startDate, previous_state: exp.state });
    },
  },
  {
    name: 'stop_experiment',
    description: 'Stop a running product page optimization experiment (all users see the original page again; it cannot be restarted). Needs confirm.',
    inputSchema: { type: 'object', properties: { app: S.app, experiment: { type: 'string', description: 'Experiment id' }, confirm: S.confirm }, required: ['app', 'experiment'] },
    annotations: { title: 'Stop experiment', destructiveHint: true },
    async handler(args, ctx) {
      await resolveApp(ctx, args.app);
      const exp = compact((await ctx.client.get(`/v2/appStoreVersionExperiments/${args.experiment}`)).data as JsonApiResource);
      requireConfirm(args, `Stopping experiment "${exp.name}"`);
      const doc = await ctx.client.patch(`/v2/appStoreVersionExperiments/${exp.id}`, { data: { type: 'appStoreVersionExperiments', id: exp.id, attributes: { started: false } } });
      const after = compact(doc.data as JsonApiResource);
      return defined({ id: exp.id, name: exp.name, state: after.state ?? exp.state, endDate: after.endDate, previous_state: exp.state });
    },
  },
  {
    name: 'delete_experiment',
    description: 'Delete a product page optimization experiment that has not run (or its treatments with update_experiment). Needs confirm.',
    inputSchema: { type: 'object', properties: { app: S.app, experiment: { type: 'string', description: 'Experiment id' }, confirm: S.confirm }, required: ['app', 'experiment'] },
    annotations: { title: 'Delete experiment', destructiveHint: true },
    async handler(args, ctx) {
      await resolveApp(ctx, args.app);
      requireConfirm(args, `Deleting experiment ${args.experiment}`);
      await ctx.client.delete(`/v2/appStoreVersionExperiments/${args.experiment}`);
      return { deleted: args.experiment };
    },
  },
];
