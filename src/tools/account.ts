/**
 * Account-level workflow tools: code signing & identifiers (bundle ids,
 * capabilities, certificates, profiles, merchant/pass type ids), devices,
 * users & invitations, customer reviews, sales/finance/analytics reports,
 * performance metrics & diagnostics, and webhooks.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { gunzipSync } from 'zlib';
import { randomBytes } from 'crypto';
import type { JsonApiResource } from '../asc/client.js';
import { compact, defined, rel, rels } from '../asc/format.js';
import { compactList, readLocalFile, requireConfirm, resolveApp, S, saveOutput } from './helpers.js';
import type { ToolContext, ToolDef } from './types.js';

const run = promisify(execFile);

// ---------------------------------------------------------------- enums

const ID_PLATFORMS = ['IOS', 'MAC_OS', 'UNIVERSAL'];

const CAPABILITY_TYPES = [
  'ICLOUD', 'IN_APP_PURCHASE', 'GAME_CENTER', 'PUSH_NOTIFICATIONS', 'WALLET', 'INTER_APP_AUDIO', 'MAPS', 'ASSOCIATED_DOMAINS',
  'PERSONAL_VPN', 'APP_GROUPS', 'HEALTHKIT', 'HOMEKIT', 'WIRELESS_ACCESSORY_CONFIGURATION', 'APPLE_PAY', 'DATA_PROTECTION', 'SIRIKIT',
  'NETWORK_EXTENSIONS', 'MULTIPATH', 'HOT_SPOT', 'NFC_TAG_READING', 'CLASSKIT', 'AUTOFILL_CREDENTIAL_PROVIDER', 'ACCESS_WIFI_INFORMATION',
  'NETWORK_CUSTOM_PROTOCOL', 'COREMEDIA_HLS_LOW_LATENCY', 'SYSTEM_EXTENSION_INSTALL', 'USER_MANAGEMENT', 'APPLE_ID_AUTH',
];

const CERTIFICATE_TYPES = [
  'DEVELOPMENT', 'DISTRIBUTION', 'IOS_DEVELOPMENT', 'IOS_DISTRIBUTION', 'MAC_APP_DEVELOPMENT', 'MAC_APP_DISTRIBUTION',
  'MAC_INSTALLER_DISTRIBUTION', 'DEVELOPER_ID_APPLICATION', 'DEVELOPER_ID_APPLICATION_G2', 'DEVELOPER_ID_KEXT', 'DEVELOPER_ID_KEXT_G2',
  'APPLE_PAY', 'APPLE_PAY_MERCHANT_IDENTITY', 'APPLE_PAY_PSP_IDENTITY', 'APPLE_PAY_RSA', 'IDENTITY_ACCESS', 'PASS_TYPE_ID', 'PASS_TYPE_ID_WITH_NFC',
];

const PROFILE_TYPES = [
  'IOS_APP_DEVELOPMENT', 'IOS_APP_STORE', 'IOS_APP_ADHOC', 'IOS_APP_INHOUSE', 'MAC_APP_DEVELOPMENT', 'MAC_APP_STORE', 'MAC_APP_DIRECT',
  'TVOS_APP_DEVELOPMENT', 'TVOS_APP_STORE', 'TVOS_APP_ADHOC', 'TVOS_APP_INHOUSE', 'MAC_CATALYST_APP_DEVELOPMENT', 'MAC_CATALYST_APP_STORE',
  'MAC_CATALYST_APP_DIRECT',
];

/** Certificate types that can sign each profile type. */
const PROFILE_CERT_TYPES: Record<string, string[]> = {
  IOS_APP_DEVELOPMENT: ['DEVELOPMENT', 'IOS_DEVELOPMENT'],
  TVOS_APP_DEVELOPMENT: ['DEVELOPMENT', 'IOS_DEVELOPMENT'],
  IOS_APP_STORE: ['DISTRIBUTION', 'IOS_DISTRIBUTION'],
  IOS_APP_ADHOC: ['DISTRIBUTION', 'IOS_DISTRIBUTION'],
  IOS_APP_INHOUSE: ['DISTRIBUTION', 'IOS_DISTRIBUTION'],
  TVOS_APP_STORE: ['DISTRIBUTION', 'IOS_DISTRIBUTION'],
  TVOS_APP_ADHOC: ['DISTRIBUTION', 'IOS_DISTRIBUTION'],
  TVOS_APP_INHOUSE: ['DISTRIBUTION', 'IOS_DISTRIBUTION'],
  MAC_APP_DEVELOPMENT: ['DEVELOPMENT', 'MAC_APP_DEVELOPMENT'],
  MAC_CATALYST_APP_DEVELOPMENT: ['DEVELOPMENT', 'MAC_APP_DEVELOPMENT'],
  MAC_APP_STORE: ['DISTRIBUTION', 'MAC_APP_DISTRIBUTION'],
  MAC_CATALYST_APP_STORE: ['DISTRIBUTION', 'MAC_APP_DISTRIBUTION'],
  MAC_APP_DIRECT: ['DEVELOPER_ID_APPLICATION', 'DEVELOPER_ID_APPLICATION_G2'],
  MAC_CATALYST_APP_DIRECT: ['DEVELOPER_ID_APPLICATION', 'DEVELOPER_ID_APPLICATION_G2'],
};

const DEVICE_PROFILE_TYPES = ['IOS_APP_DEVELOPMENT', 'IOS_APP_ADHOC', 'TVOS_APP_DEVELOPMENT', 'TVOS_APP_ADHOC', 'MAC_APP_DEVELOPMENT', 'MAC_CATALYST_APP_DEVELOPMENT'];

const ROLES = [
  'ADMIN', 'FINANCE', 'ACCOUNT_HOLDER', 'SALES', 'MARKETING', 'APP_MANAGER', 'DEVELOPER', 'ACCESS_TO_REPORTS', 'CUSTOMER_SUPPORT',
  'CREATE_APPS', 'CLOUD_MANAGED_DEVELOPER_ID', 'CLOUD_MANAGED_APP_DISTRIBUTION', 'GENERATE_INDIVIDUAL_KEYS',
];

const WEBHOOK_EVENTS = [
  'ALTERNATIVE_DISTRIBUTION_PACKAGE_AVAILABLE_UPDATED', 'ALTERNATIVE_DISTRIBUTION_PACKAGE_VERSION_CREATED',
  'ALTERNATIVE_DISTRIBUTION_TERRITORY_AVAILABILITY_UPDATED', 'APP_STORE_VERSION_APP_VERSION_STATE_UPDATED',
  'BACKGROUND_ASSET_VERSION_APP_STORE_RELEASE_STATE_UPDATED', 'BACKGROUND_ASSET_VERSION_EXTERNAL_BETA_RELEASE_STATE_UPDATED',
  'BACKGROUND_ASSET_VERSION_INTERNAL_BETA_RELEASE_CREATED', 'BACKGROUND_ASSET_VERSION_STATE_UPDATED', 'BETA_FEEDBACK_CRASH_SUBMISSION_CREATED',
  'BETA_FEEDBACK_SCREENSHOT_SUBMISSION_CREATED', 'BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED', 'BUILD_UPLOAD_STATE_UPDATED',
];

const SALES_REPORT_TYPES = ['SALES', 'PRE_ORDER', 'NEWSSTAND', 'SUBSCRIPTION', 'SUBSCRIPTION_EVENT', 'SUBSCRIBER', 'SUBSCRIPTION_OFFER_CODE_REDEMPTION', 'INSTALLS', 'FIRST_ANNUAL', 'WIN_BACK_ELIGIBILITY'];
const SALES_DEFAULT_VERSION: Record<string, string> = {
  SALES: '1_1', SUBSCRIPTION: '1_3', SUBSCRIPTION_EVENT: '1_3', SUBSCRIBER: '1_3', PRE_ORDER: '1_0', NEWSSTAND: '1_0',
  SUBSCRIPTION_OFFER_CODE_REDEMPTION: '1_0', INSTALLS: '1_0', FIRST_ANNUAL: '1_0', WIN_BACK_ELIGIBILITY: '1_0',
};
const PERF_METRIC_TYPES = ['DISK', 'HANG', 'BATTERY', 'LAUNCH', 'MEMORY', 'ANIMATION', 'TERMINATION', 'STORAGE'];

// ---------------------------------------------------------------- shared helpers

const isDry = (id: string | undefined) => !!id && id.startsWith('DRY_RUN_');
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const dropContent = ({ certificateContent, csrContent, profileContent, ...rest }: any) => rest;

function checkEnum(values: string[] | undefined, allowed: string[], what: string) {
  for (const v of values ?? []) if (!allowed.includes(v)) throw new Error(`Unknown ${what} "${v}". Allowed: ${allowed.join(', ')}`);
}

/** Resolve a bundle id resource from its resource id or its identifier (com.example.app). */
async function resolveBundleId(ctx: ToolContext, value: string): Promise<any> {
  if (!value) throw new Error('bundle_id is required (bundle identifier like com.example.app, or the bundleIds resource id)');
  const byIdent = await ctx.client.get('/v1/bundleIds', { 'filter[identifier]': value, limit: 50 });
  const exact = compactList(byIdent).find(b => b.identifier === value);
  if (exact) return exact;
  try {
    const doc = await ctx.client.get(`/v1/bundleIds/${encodeURIComponent(value)}`);
    return compact(doc.data as JsonApiResource);
  } catch {
    throw new Error(`No bundle id found for "${value}". Use list_bundle_ids, or create it with create_bundle_id.`);
  }
}

async function resolveProfile(ctx: ToolContext, value: string): Promise<any> {
  if (!value) throw new Error('profile is required (profile id or exact name)');
  const byName = await ctx.client.get('/v1/profiles', { 'filter[name]': value, limit: 50 });
  const named = compactList(byName).filter(p => p.name === value);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new Error(`Several profiles are named "${value}": ${named.map(p => p.id).join(', ')}. Pass the id.`);
  try {
    const doc = await ctx.client.get(`/v1/profiles/${encodeURIComponent(value)}`);
    return compact(doc.data as JsonApiResource);
  } catch {
    throw new Error(`No profile found for "${value}". Use list_profiles.`);
  }
}

async function resolveUser(ctx: ToolContext, value: string): Promise<any> {
  if (!value) throw new Error('user is required (user id or email/username)');
  if (value.includes('@')) {
    const doc = await ctx.client.get('/v1/users', { 'filter[username]': value, limit: 10 });
    const u = compactList(doc).find(x => x.username?.toLowerCase() === value.toLowerCase());
    if (!u) throw new Error(`No user with username ${value}. Use list_users (pending people are in list_user_invitations).`);
    return u;
  }
  const doc = await ctx.client.get(`/v1/users/${encodeURIComponent(value)}`);
  return compact(doc.data as JsonApiResource);
}

async function resolveAppIds(ctx: ToolContext, apps: string[] | undefined): Promise<string[] | undefined> {
  if (apps === undefined) return undefined;
  const ids: string[] = [];
  for (const a of apps) ids.push((await resolveApp(ctx, a)).id);
  return ids;
}

/** Resolve a build from a build id, or app + build number (CFBundleVersion). */
async function resolveBuildId(ctx: ToolContext, args: any): Promise<string> {
  if (args.build_id) return args.build_id;
  if (!args.app || !args.build_number) throw new Error('Pass build_id, or app + build_number (CFBundleVersion, e.g. "42").');
  const app = await resolveApp(ctx, args.app);
  const q: Record<string, any> = { 'filter[app]': app.id, 'filter[version]': args.build_number, limit: 10, 'fields[builds]': 'version,uploadedDate' };
  if (args.version) q['filter[preReleaseVersion.version]'] = args.version;
  const builds = compactList(await ctx.client.get('/v1/builds', q));
  if (!builds.length) throw new Error(`No build ${args.build_number} for ${app.name}.`);
  if (builds.length > 1) throw new Error(`Several builds numbered ${args.build_number} (${builds.map(b => b.id).join(', ')}); pass version or build_id.`);
  return builds[0].id;
}

function saveSecret(ctx: ToolContext, name: string, bytes: Buffer | string): string {
  const p = saveOutput(ctx, name, '');
  chmodSync(p, 0o600);
  writeFileSync(p, bytes);
  return p;
}

function maybeGunzip(bytes: Buffer): Buffer {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

function num(v: string | undefined): number {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Parse a TSV report and compute simple totals when known columns exist. */
function summarizeTsv(text: string, previewRows = 10) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return { rows: 0 };
  const header = lines[0].split('\t');
  const rows: string[][] = [];
  const trailer: string[] = [];
  for (const l of lines.slice(1)) {
    const cells = l.split('\t');
    if (cells.length >= header.length - 1 && cells.length > 1) rows.push(cells);
    else trailer.push(l);
  }
  const col = (...names: string[]) => {
    for (const n of names) {
      const i = header.findIndex(h => h.trim().toLowerCase() === n.toLowerCase());
      if (i >= 0) return i;
    }
    return -1;
  };
  const units = col('Units', 'Quantity', 'Counts');
  const title = col('Title', 'App Name', 'SKU', 'Vendor Identifier', 'Product Type Identifier');
  const devProceeds = col('Developer Proceeds');
  const proceedsCur = col('Currency of Proceeds');
  const extShare = col('Extended Partner Share');
  const shareCur = col('Partner Share Currency');
  const out: any = {
    columns: header,
    rows: rows.length,
    preview: rows.slice(0, previewRows).map(r => Object.fromEntries(header.map((h, i) => [h, r[i]]))),
  };
  if (trailer.length) out.trailer = trailer.slice(0, 10);
  if (units >= 0) {
    out.totalUnits = rows.reduce((s, r) => s + num(r[units]), 0);
    if (title >= 0) {
      const byTitle: Record<string, number> = {};
      for (const r of rows) byTitle[r[title]] = (byTitle[r[title]] ?? 0) + num(r[units]);
      out.unitsBy = { column: header[title], values: Object.fromEntries(Object.entries(byTitle).sort((a, b) => b[1] - a[1]).slice(0, 25)) };
    }
  }
  const proceeds: Record<string, number> = {};
  if (devProceeds >= 0 && units >= 0) {
    for (const r of rows) {
      const cur = proceedsCur >= 0 ? r[proceedsCur] : '?';
      proceeds[cur] = (proceeds[cur] ?? 0) + num(r[units]) * num(r[devProceeds]);
    }
  } else if (extShare >= 0) {
    for (const r of rows) {
      const cur = shareCur >= 0 ? r[shareCur] : '?';
      proceeds[cur] = (proceeds[cur] ?? 0) + num(r[extShare]);
    }
  }
  if (Object.keys(proceeds).length) out.proceedsByCurrency = Object.fromEntries(Object.entries(proceeds).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return out;
}

async function openssl(args: string[], env?: Record<string, string>) {
  try {
    return await run('openssl', args, { env: { ...process.env, ...(env ?? {}) }, maxBuffer: 10 * 1024 * 1024 });
  } catch (e: any) {
    if (e.code === 'ENOENT') throw new Error('The openssl CLI is not installed or not on PATH; install it, or pass csr_path with a CSR you made elsewhere.');
    throw new Error(`openssl ${args[0]} failed: ${e.stderr || e.message}`);
  }
}

function profileExtension(profileType: string) {
  return profileType.startsWith('MAC_') ? 'provisionprofile' : 'mobileprovision';
}

function saveProfileFile(ctx: ToolContext, p: any): string | undefined {
  if (!p.profileContent) return undefined;
  return saveOutput(ctx, `${p.name || p.id}.${profileExtension(p.profileType ?? '')}`, Buffer.from(p.profileContent, 'base64'));
}

/** Valid (unexpired) certificates usable for a profile type. */
async function certsForProfile(ctx: ToolContext, profileType: string): Promise<any[]> {
  const types = PROFILE_CERT_TYPES[profileType];
  const all = await ctx.client.getAll('/v1/certificates', { 'filter[certificateType]': types.join(','), 'fields[certificates]': 'name,certificateType,expirationDate,displayName,serialNumber' }, 200);
  const now = Date.now();
  return all.data.map(compact).filter(c => !c.expirationDate || Date.parse(c.expirationDate) > now);
}

/** Enabled devices matching a profile's platform. */
async function devicesForProfile(ctx: ToolContext, profileType: string): Promise<any[]> {
  const mac = profileType.startsWith('MAC_');
  const all = await ctx.client.getAll('/v1/devices', { 'filter[status]': 'ENABLED', 'filter[platform]': mac ? 'MAC_OS' : 'IOS' }, 1000);
  return all.data.map(compact).filter(d => {
    if (mac) return true;
    const tv = d.deviceClass === 'APPLE_TV';
    return profileType.startsWith('TVOS_') ? tv : !tv;
  });
}

interface ProfileSpec {
  name: string;
  profileType: string;
  bundleIdId: string;
  certificateIds: string[];
  deviceIds: string[];
}

async function createProfileFromSpec(ctx: ToolContext, spec: ProfileSpec, download: boolean) {
  const needsDevices = DEVICE_PROFILE_TYPES.includes(spec.profileType);
  if (!spec.certificateIds.length) throw new Error(`No certificates to sign a ${spec.profileType} profile. Types accepted: ${PROFILE_CERT_TYPES[spec.profileType].join(', ')}. Create one with create_certificate.`);
  if (needsDevices && !spec.deviceIds.length) throw new Error(`${spec.profileType} profiles need at least one device. Register devices with register_devices.`);
  const doc = await ctx.client.post('/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name: spec.name, profileType: spec.profileType },
      relationships: {
        bundleId: rel('bundleIds', spec.bundleIdId),
        certificates: rels('certificates', spec.certificateIds),
        ...(needsDevices ? { devices: rels('devices', spec.deviceIds) } : {}),
      },
    },
  });
  const p = compact(doc.data as JsonApiResource);
  const file = download && !ctx.dryRun ? saveProfileFile(ctx, p) : undefined;
  return { profile: dropContent(p), certificates: spec.certificateIds.length, devices: needsDevices ? spec.deviceIds.length : 0, file };
}

function buildCapabilitySettings(c: any): any[] | undefined {
  const settings: any[] = [...(c.settings ?? [])];
  const opt = (key: string, option: string) => settings.push({ key, options: [{ key: option, enabled: true }] });
  if (c.icloud_version) opt('ICLOUD_VERSION', c.icloud_version);
  if (c.data_protection_level) opt('DATA_PROTECTION_PERMISSION_LEVEL', c.data_protection_level);
  if (c.apple_id_auth_consent) opt('APPLE_ID_AUTH_APP_CONSENT', c.apple_id_auth_consent);
  return settings.length ? settings : undefined;
}

async function enableCapabilities(ctx: ToolContext, bundleIdId: string, caps: any[]) {
  const existing = isDry(bundleIdId) ? [] : compactList(await ctx.client.get(`/v1/bundleIds/${bundleIdId}/bundleIdCapabilities`));
  const results: any[] = [];
  for (const raw of caps) {
    const c = typeof raw === 'string' ? { type: raw } : raw;
    const type = c.type ?? c.capability_type;
    checkEnum([type], CAPABILITY_TYPES, 'capability type');
    const settings = buildCapabilitySettings(c);
    const found = existing.find(e => e.capabilityType === type);
    if (found) {
      if (!settings) {
        results.push({ capabilityType: type, status: 'already enabled', id: found.id });
        continue;
      }
      const doc = await ctx.client.patch(`/v1/bundleIdCapabilities/${found.id}`, {
        data: { type: 'bundleIdCapabilities', id: found.id, attributes: { capabilityType: type, settings } },
      });
      results.push({ status: 'updated', ...compact(doc.data as JsonApiResource) });
    } else {
      const doc = await ctx.client.post('/v1/bundleIdCapabilities', {
        data: { type: 'bundleIdCapabilities', attributes: defined({ capabilityType: type, settings }), relationships: { bundleId: rel('bundleIds', bundleIdId) } },
      });
      results.push({ status: 'enabled', ...compact(doc.data as JsonApiResource) });
    }
  }
  return results;
}

const capabilityItemSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: CAPABILITY_TYPES },
    icloud_version: { type: 'string', enum: ['XCODE_5', 'XCODE_6'], description: 'ICLOUD only. XCODE_6 = CloudKit (modern), XCODE_5 = legacy iCloud documents' },
    data_protection_level: { type: 'string', enum: ['COMPLETE_PROTECTION', 'PROTECTED_UNLESS_OPEN', 'PROTECTED_UNTIL_FIRST_USER_AUTH'], description: 'DATA_PROTECTION only' },
    apple_id_auth_consent: { type: 'string', enum: ['PRIMARY_APP_CONSENT'], description: 'APPLE_ID_AUTH (Sign in with Apple) only' },
    settings: { type: 'array', items: { type: 'object' }, description: 'Raw CapabilitySetting objects ({key, options:[{key, enabled}]}) for anything not covered above' },
  },
  required: ['type'],
};

function compactReview(r: JsonApiResource, included: JsonApiResource[]) {
  const c = compact(r);
  const respId = (r.relationships?.response as any)?.data?.id;
  const resp = respId ? included.find(i => i.type === 'customerReviewResponses' && i.id === respId) : undefined;
  const { relationships, ...rest } = c;
  return { ...rest, response: resp ? compact(resp) : null };
}

// ---------------------------------------------------------------- tools

export const accountTools: ToolDef[] = [
  // ---------------- bundle ids & capabilities
  {
    name: 'list_bundle_ids',
    description:
      'List registered bundle IDs (App IDs) in the developer account, with their enabled capabilities. Filter by identifier substring/exact, platform, or name. Bundle IDs are needed to create provisioning profiles and apps.',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Exact bundle identifier(s), comma-separated' },
        name: { type: 'string', description: 'Exact name filter' },
        platform: { type: 'string', enum: ID_PLATFORMS },
        include_capabilities: { type: 'boolean', description: 'Include enabled capability types (default true)' },
        limit: S.limit,
      },
    },
    annotations: { title: 'List bundle IDs', readOnlyHint: true },
    async handler(args, ctx) {
      const caps = args.include_capabilities !== false;
      const res = await ctx.client.getAll(
        '/v1/bundleIds',
        defined({
          'filter[identifier]': args.identifier,
          'filter[name]': args.name,
          'filter[platform]': args.platform,
          // The live API rejects include=app / fields[apps] here, although the spec lists them.
          include: caps ? 'bundleIdCapabilities' : undefined,
          'limit[bundleIdCapabilities]': caps ? 50 : undefined,
          sort: 'identifier',
        }),
        args.limit ?? 50,
      );
      const inc = res.included;
      return {
        total: res.total,
        truncated: res.truncated,
        bundleIds: res.data.map(b => {
          const c = compact(b);
          const capIds = arr(c.relationships?.bundleIdCapabilities);
          return {
            id: c.id,
            identifier: c.identifier,
            name: c.name,
            platform: c.platform,
            seedId: c.seedId,
            capabilities: caps ? capIds.map(id => inc.find(i => i.type === 'bundleIdCapabilities' && i.id === id)?.attributes?.capabilityType ?? id) : undefined,
          };
        }),
      };
    },
  },
  {
    name: 'create_bundle_id',
    description:
      'Register a new explicit (com.example.app) or wildcard (com.example.*) bundle ID, optionally enabling capabilities in the same call. platform: IOS covers iOS/iPadOS/tvOS/visionOS/watchOS; MAC_OS for Mac-only; UNIVERSAL for multiplatform. Identifiers are permanent: a deleted identifier cannot be registered again by anyone. Associating App Groups / iCloud containers / Merchant IDs with the bundle ID is not possible through the API (do it in the developer portal).',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Reverse-DNS bundle identifier, e.g. com.example.myapp' },
        name: { type: 'string', description: 'Display name (letters, numbers, spaces only)' },
        platform: { type: 'string', enum: ID_PLATFORMS, description: 'Default IOS' },
        seed_id: { type: 'string', description: 'Team/App ID prefix (rarely needed; defaults to your team id)' },
        capabilities: { type: 'array', items: { anyOf: [{ type: 'string', enum: CAPABILITY_TYPES }, capabilityItemSchema] }, description: 'Capabilities to enable after creating' },
      },
      required: ['identifier', 'name'],
    },
    annotations: { title: 'Create bundle ID' },
    async handler(args, ctx) {
      const existing = compactList(await ctx.client.get('/v1/bundleIds', { 'filter[identifier]': args.identifier })).find(b => b.identifier === args.identifier);
      if (existing) throw new Error(`Bundle ID ${args.identifier} already exists (id ${existing.id}). Use enable_capability to change its capabilities.`);
      const doc = await ctx.client.post('/v1/bundleIds', {
        data: { type: 'bundleIds', attributes: defined({ identifier: args.identifier, name: args.name, platform: args.platform ?? 'IOS', seedId: args.seed_id }) },
      });
      const b = compact(doc.data as JsonApiResource);
      const capabilities = args.capabilities?.length ? await enableCapabilities(ctx, b.id, args.capabilities) : [];
      return { bundleId: b, capabilities };
    },
  },
  {
    name: 'delete_bundle_id',
    description:
      'Delete a bundle ID. Fails if an app record uses it. The identifier can never be registered again (by you or anyone). Profiles that use it become invalid.',
    inputSchema: {
      type: 'object',
      properties: { bundle_id: { type: 'string', description: 'Bundle identifier or bundleIds resource id' }, confirm: S.confirm },
      required: ['bundle_id'],
    },
    annotations: { title: 'Delete bundle ID', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a bundle ID');
      const b = await resolveBundleId(ctx, args.bundle_id);
      await ctx.client.delete(`/v1/bundleIds/${b.id}`);
      return { deleted: { id: b.id, identifier: b.identifier, name: b.name } };
    },
  },
  {
    name: 'list_capabilities',
    description: 'List capabilities enabled on a bundle ID, with their settings (iCloud version, data protection level, Sign in with Apple consent).',
    inputSchema: { type: 'object', properties: { bundle_id: { type: 'string', description: 'Bundle identifier or bundleIds resource id' } }, required: ['bundle_id'] },
    annotations: { title: 'List bundle ID capabilities', readOnlyHint: true },
    async handler(args, ctx) {
      const b = await resolveBundleId(ctx, args.bundle_id);
      const caps = compactList(await ctx.client.get(`/v1/bundleIds/${b.id}/bundleIdCapabilities`));
      return {
        bundleId: { id: b.id, identifier: b.identifier },
        capabilities: caps.map(c => ({
          id: c.id,
          capabilityType: c.capabilityType,
          settings: (c.settings ?? []).map((s: any) => ({ key: s.key, enabledOptions: (s.options ?? []).filter((o: any) => o.enabled).map((o: any) => o.key) })),
        })),
      };
    },
  },
  {
    name: 'enable_capability',
    description:
      'Enable one or more capabilities on a bundle ID (upsert: already-enabled ones are left alone, or updated if you pass settings). Use shorthand settings: icloud_version (ICLOUD), data_protection_level (DATA_PROTECTION), apple_id_auth_consent (APPLE_ID_AUTH). Existing provisioning profiles must be regenerated (regenerate_profile) to pick up new entitlements. Some capabilities (App Groups, iCloud containers, Apple Pay merchant ids, associated domain details) still need identifier assignment in the developer portal.',
    inputSchema: {
      type: 'object',
      properties: {
        bundle_id: { type: 'string', description: 'Bundle identifier or bundleIds resource id' },
        capabilities: { type: 'array', items: { anyOf: [{ type: 'string', enum: CAPABILITY_TYPES }, capabilityItemSchema] }, description: 'e.g. ["PUSH_NOTIFICATIONS", {"type":"ICLOUD","icloud_version":"XCODE_6"}]' },
      },
      required: ['bundle_id', 'capabilities'],
    },
    annotations: { title: 'Enable capabilities' },
    async handler(args, ctx) {
      const b = await resolveBundleId(ctx, args.bundle_id);
      return { bundleId: { id: b.id, identifier: b.identifier }, results: await enableCapabilities(ctx, b.id, arr(args.capabilities)) };
    },
  },
  {
    name: 'disable_capability',
    description: 'Disable capabilities on a bundle ID. Apps relying on the entitlement will stop working once re-signed; existing profiles become invalid and need regenerating.',
    inputSchema: {
      type: 'object',
      properties: {
        bundle_id: { type: 'string', description: 'Bundle identifier or bundleIds resource id' },
        capability_types: { type: 'array', items: { type: 'string', enum: CAPABILITY_TYPES } },
        confirm: S.confirm,
      },
      required: ['bundle_id', 'capability_types'],
    },
    annotations: { title: 'Disable capabilities', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Disabling capabilities');
      const b = await resolveBundleId(ctx, args.bundle_id);
      const caps = compactList(await ctx.client.get(`/v1/bundleIds/${b.id}/bundleIdCapabilities`));
      const results: any[] = [];
      for (const t of arr<string>(args.capability_types)) {
        const c = caps.find(x => x.capabilityType === t);
        if (!c) {
          results.push({ capabilityType: t, status: 'not enabled' });
          continue;
        }
        await ctx.client.delete(`/v1/bundleIdCapabilities/${c.id}`);
        results.push({ capabilityType: t, status: 'disabled', id: c.id });
      }
      return { bundleId: { id: b.id, identifier: b.identifier }, results };
    },
  },

  // ---------------- certificates
  {
    name: 'list_certificates',
    description:
      'List signing certificates (id, name, type, serial, expiration). Filter by certificate_type(s) or include expired ones. Use this to pick certificate ids for profiles or to find certificates to revoke.',
    inputSchema: {
      type: 'object',
      properties: {
        certificate_types: { type: 'array', items: { type: 'string', enum: CERTIFICATE_TYPES } },
        include_expired: { type: 'boolean', description: 'Default false' },
        limit: S.limit,
      },
    },
    annotations: { title: 'List certificates', readOnlyHint: true },
    async handler(args, ctx) {
      const res = await ctx.client.getAll(
        '/v1/certificates',
        defined({
          'filter[certificateType]': args.certificate_types?.length ? args.certificate_types.join(',') : undefined,
          'fields[certificates]': 'name,displayName,certificateType,serialNumber,platform,expirationDate,activated',
        }),
        args.limit ?? 100,
      );
      const now = Date.now();
      const certs = res.data.map(compact).map(c => ({ ...c, expired: c.expirationDate ? Date.parse(c.expirationDate) < now : undefined }));
      return { total: res.total, certificates: args.include_expired ? certs : certs.filter(c => !c.expired) };
    },
  },
  {
    name: 'create_certificate',
    description:
      'Create a signing certificate end to end. By default generates a new RSA-2048 private key and CSR locally with openssl, sends the CSR, and saves to the output dir: private key (.key, chmod 600), certificate (.cer DER and .pem), and a .p12 bundle with a generated password (returned) ready for Keychain/CI. Or pass csr_path to use an existing CSR (then pass private_key_path too if you want a .p12). Common types: DISTRIBUTION (Apple Distribution, all platforms), DEVELOPMENT (Apple Development), DEVELOPER_ID_APPLICATION_G2 (Mac outside the App Store; Account Holder key only). Apple caps certificates per type (e.g. only a few Distribution certificates per team); if creation fails with a limit error, revoke an old one first. Keep the private key safe: Apple never has it.',
    inputSchema: {
      type: 'object',
      properties: {
        certificate_type: { type: 'string', enum: CERTIFICATE_TYPES },
        csr_path: { type: 'string', description: 'Existing CSR (PEM). Omit to generate a new key + CSR.' },
        private_key_path: { type: 'string', description: 'With csr_path: the matching private key, to build a .p12' },
        common_name: { type: 'string', description: 'CSR common name for a generated key (default "App Store Connect MCP")' },
        email: { type: 'string', description: 'CSR email address (optional)' },
        key_type: { type: 'string', enum: ['RSA', 'EC'], description: 'Generated key type (default RSA 2048; Apple supports RSA for all types)' },
        p12: { type: 'boolean', description: 'Also write a .p12 (default true when the private key is available)' },
        p12_password: { type: 'string', description: 'Password for the .p12 (default: random, returned in the result)' },
        file_prefix: { type: 'string', description: 'File name prefix (default <type>_<timestamp>)' },
        merchant_id: { type: 'string', description: 'merchantIds resource id (APPLE_PAY* certificate types)' },
        pass_type_id: { type: 'string', description: 'passTypeIds resource id (PASS_TYPE_ID* certificate types)' },
      },
      required: ['certificate_type'],
    },
    annotations: { title: 'Create certificate' },
    async handler(args, ctx) {
      checkEnum([args.certificate_type], CERTIFICATE_TYPES, 'certificate type');
      const prefix = (args.file_prefix ?? `${args.certificate_type.toLowerCase()}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`).replace(/[^A-Za-z0-9._-]+/g, '_');
      const work = mkdtempSync(path.join(tmpdir(), 'asc-cert-'));
      try {
        let csrPem: string;
        let keyPem: Buffer | undefined;
        if (args.csr_path) {
          csrPem = readLocalFile(args.csr_path).bytes.toString('utf-8');
          if (!csrPem.includes('CERTIFICATE REQUEST')) throw new Error(`${args.csr_path} does not look like a PEM CSR ("-----BEGIN CERTIFICATE REQUEST-----").`);
          if (args.private_key_path) keyPem = readLocalFile(args.private_key_path).bytes;
        } else {
          const keyFile = path.join(work, 'key.pem');
          if (args.key_type === 'EC') await openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', keyFile]);
          else await openssl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', keyFile]);
          const cn = (args.common_name ?? 'App Store Connect MCP').replace(/[/\\=]/g, ' ');
          const subj = `/CN=${cn}${args.email ? `/emailAddress=${args.email.replace(/[/\\=]/g, '')}` : ''}/C=US`;
          const csrFile = path.join(work, 'csr.pem');
          await openssl(['req', '-new', '-key', keyFile, '-out', csrFile, '-subj', subj]);
          csrPem = readFileSync(csrFile, 'utf-8');
          keyPem = readFileSync(keyFile);
        }
        const files: Record<string, string> = {};
        // Persist the key before sending, so it is never lost if a later step fails.
        if (keyPem && !args.csr_path && !ctx.dryRun) files.privateKey = saveSecret(ctx, `${prefix}.key`, keyPem);

        const doc = await ctx.client.post('/v1/certificates', {
          data: defined({
            type: 'certificates',
            attributes: { certificateType: args.certificate_type, csrContent: csrPem },
            relationships: args.merchant_id || args.pass_type_id
              ? defined({ merchantId: args.merchant_id ? rel('merchantIds', args.merchant_id) : undefined, passTypeId: args.pass_type_id ? rel('passTypeIds', args.pass_type_id) : undefined })
              : undefined,
          }),
        });
        const cert = compact(doc.data as JsonApiResource);
        if (ctx.dryRun) {
          return { certificate: dropContent(cert), note: 'Dry run: a key and CSR were generated in a temp dir and discarded; nothing was saved or sent.', csrPreview: csrPem.split('\n').slice(0, 2).join('\n') + '…' };
        }
        const der = Buffer.from(cert.certificateContent, 'base64');
        files.cer = saveOutput(ctx, `${prefix}.cer`, der);
        const pemFile = path.join(work, 'cert.pem');
        await openssl(['x509', '-inform', 'DER', '-in', files.cer, '-out', pemFile]);
        files.pem = saveOutput(ctx, `${prefix}.pem`, readFileSync(pemFile));
        let p12Password: string | undefined;
        if (keyPem && args.p12 !== false) {
          const pass: string = args.p12_password ?? randomBytes(12).toString('base64url');
          p12Password = pass;
          const keyFile = path.join(work, 'key-for-p12.pem');
          writeFileSync(keyFile, keyPem, { mode: 0o600 });
          const p12File = path.join(work, 'cert.p12');
          await openssl(
            ['pkcs12', '-export', '-inkey', keyFile, '-in', pemFile, '-out', p12File, '-name', cert.name ?? prefix, '-passout', 'env:ASC_P12_PASS',
              '-certpbe', 'PBE-SHA1-3DES', '-keypbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'],
            { ASC_P12_PASS: pass },
          );
          files.p12 = saveSecret(ctx, `${prefix}.p12`, readFileSync(p12File));
        }
        return {
          certificate: dropContent(cert),
          files,
          p12Password,
          next: 'Import the .p12 into Keychain (or your CI secret store), then create_profile with this certificate id.',
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'revoke_certificate',
    description:
      'Revoke (delete) a signing certificate. Every provisioning profile that includes it becomes INVALID and must be regenerated; already-shipped App Store apps keep working, but ad hoc/development builds signed with it stop launching (Developer ID-signed Mac apps may too).',
    inputSchema: { type: 'object', properties: { certificate_id: { type: 'string' }, confirm: S.confirm }, required: ['certificate_id'] },
    annotations: { title: 'Revoke certificate', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Revoking a certificate');
      const c = compact((await ctx.client.get(`/v1/certificates/${args.certificate_id}`, { 'fields[certificates]': 'name,certificateType,serialNumber,expirationDate' })).data as JsonApiResource);
      await ctx.client.delete(`/v1/certificates/${c.id}`);
      return { revoked: c, note: 'Profiles using this certificate are now invalid; use regenerate_profile.' };
    },
  },
  {
    name: 'download_certificate',
    description: 'Save a certificate to the output dir as .cer (DER) and .pem. The private key is not included: Apple never has it.',
    inputSchema: { type: 'object', properties: { certificate_id: { type: 'string' } }, required: ['certificate_id'] },
    annotations: { title: 'Download certificate', readOnlyHint: true },
    async handler(args, ctx) {
      const c = compact((await ctx.client.get(`/v1/certificates/${args.certificate_id}`)).data as JsonApiResource);
      if (!c.certificateContent) throw new Error('Certificate has no content.');
      const base = `${c.name ?? c.id}_${c.id}`;
      const der = Buffer.from(c.certificateContent, 'base64');
      const pem = `-----BEGIN CERTIFICATE-----\n${c.certificateContent.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
      return { certificate: dropContent(c), files: { cer: saveOutput(ctx, `${base}.cer`, der), pem: saveOutput(ctx, `${base}.pem`, pem) } };
    },
  },

  // ---------------- profiles
  {
    name: 'list_profiles',
    description: 'List provisioning profiles with type, state (ACTIVE/INVALID), expiration and bundle identifier. INVALID usually means a certificate was revoked or a capability changed: use regenerate_profile.',
    inputSchema: {
      type: 'object',
      properties: {
        profile_type: { type: 'string', enum: PROFILE_TYPES },
        state: { type: 'string', enum: ['ACTIVE', 'INVALID'] },
        bundle_id: { type: 'string', description: 'Only profiles for this bundle identifier' },
        name: { type: 'string', description: 'Exact name' },
        limit: S.limit,
      },
    },
    annotations: { title: 'List profiles', readOnlyHint: true },
    async handler(args, ctx) {
      const res = await ctx.client.getAll(
        '/v1/profiles',
        defined({
          'filter[profileType]': args.profile_type,
          'filter[profileState]': args.state,
          'filter[name]': args.name,
          include: 'bundleId',
          'fields[profiles]': 'name,platform,profileType,profileState,uuid,createdDate,expirationDate,bundleId',
          'fields[bundleIds]': 'identifier',
        }),
        args.limit ?? 100,
      );
      let profiles = res.data.map(p => {
        const c = compact(p);
        const bid = c.relationships?.bundleId as string | undefined;
        const { relationships, ...rest } = c;
        return { ...rest, bundleIdentifier: res.included.find(i => i.type === 'bundleIds' && i.id === bid)?.attributes?.identifier, bundleIdId: bid };
      });
      if (args.bundle_id) profiles = profiles.filter(p => p.bundleIdentifier === args.bundle_id || p.bundleIdId === args.bundle_id);
      return { total: res.total, profiles };
    },
  },
  {
    name: 'create_profile',
    description:
      'Create a provisioning profile and save it (.mobileprovision / .provisionprofile) to the output dir. certificate_ids defaults to "all valid certificates of the matching type" (e.g. DISTRIBUTION/IOS_DISTRIBUTION for IOS_APP_STORE). For development/ad hoc profiles, device_ids defaults to all enabled devices of the matching platform. Profile names must be unique. Profiles become INVALID when a certificate is revoked, or need regenerating after capabilities or devices change.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique profile name, e.g. "MyApp App Store"' },
        profile_type: { type: 'string', enum: PROFILE_TYPES },
        bundle_id: { type: 'string', description: 'Bundle identifier or bundleIds resource id' },
        certificate_ids: { type: 'array', items: { type: 'string' }, description: 'Default: all valid certificates of the matching type' },
        device_ids: { type: 'array', items: { type: 'string' }, description: 'Device ids or UDIDs (dev/ad hoc only). Default: all enabled matching devices' },
        download: { type: 'boolean', description: 'Save the profile file (default true)' },
      },
      required: ['name', 'profile_type', 'bundle_id'],
    },
    annotations: { title: 'Create profile' },
    async handler(args, ctx) {
      checkEnum([args.profile_type], PROFILE_TYPES, 'profile type');
      const b = await resolveBundleId(ctx, args.bundle_id);
      const certificateIds = args.certificate_ids?.length ? args.certificate_ids : (await certsForProfile(ctx, args.profile_type)).map(c => c.id);
      let deviceIds: string[] = [];
      if (DEVICE_PROFILE_TYPES.includes(args.profile_type)) {
        const devices = await devicesForProfile(ctx, args.profile_type);
        deviceIds = args.device_ids?.length
          ? args.device_ids.map((d: string) => {
              const m = devices.find(x => x.id === d || x.udid === d);
              if (m) return m.id;
              if (/^[A-Z0-9]{10}$/.test(d)) return d; // a device id outside the default filter
              throw new Error(`Device ${d} is not a registered, enabled device for this platform. Use list_devices / register_devices.`);
            })
          : devices.map(d => d.id);
      }
      return { bundleId: b.identifier, ...(await createProfileFromSpec(ctx, { name: args.name, profileType: args.profile_type, bundleIdId: b.id, certificateIds, deviceIds }, args.download !== false)) };
    },
  },
  {
    name: 'download_profile',
    description: 'Save a provisioning profile to the output dir (.mobileprovision for iOS/tvOS, .provisionprofile for Mac). Accepts profile id or exact name.',
    inputSchema: { type: 'object', properties: { profile: { type: 'string', description: 'Profile id or exact name' } }, required: ['profile'] },
    annotations: { title: 'Download profile', readOnlyHint: true },
    async handler(args, ctx) {
      const p = await resolveProfile(ctx, args.profile);
      const full = p.profileContent ? p : compact((await ctx.client.get(`/v1/profiles/${p.id}`)).data as JsonApiResource);
      const file = saveProfileFile(ctx, full);
      if (!file) throw new Error('Profile has no content (it may be invalid). Use regenerate_profile.');
      return { profile: dropContent(full), file };
    },
  },
  {
    name: 'delete_profile',
    description: 'Delete a provisioning profile. Builds already signed with it keep their embedded copy, but CI using it by name/UUID will fail until a new profile exists.',
    inputSchema: { type: 'object', properties: { profile: { type: 'string', description: 'Profile id or exact name' }, confirm: S.confirm }, required: ['profile'] },
    annotations: { title: 'Delete profile', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a profile');
      const p = await resolveProfile(ctx, args.profile);
      await ctx.client.delete(`/v1/profiles/${p.id}`);
      return { deleted: { id: p.id, name: p.name, profileType: p.profileType, uuid: p.uuid } };
    },
  },
  {
    name: 'regenerate_profile',
    description:
      'Re-create a profile with the same name, type and bundle ID (delete + create), e.g. after a certificate was revoked, capabilities changed, or new devices were registered. By default uses all currently valid certificates of the matching type and (for dev/ad hoc) all enabled devices; set keep_existing_certificates / keep_existing_devices to reuse the old lists. Saves the new profile file. The profile UUID changes, so update CI that pins it.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: { type: 'string', description: 'Profile id or exact name' },
        keep_existing_certificates: { type: 'boolean', description: 'Reuse the old certificate list (still-valid ones only). Default false' },
        keep_existing_devices: { type: 'boolean', description: 'Reuse the old device list. Default false (all enabled devices)' },
        confirm: S.confirm,
      },
      required: ['profile'],
    },
    annotations: { title: 'Regenerate profile', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Regenerating (deleting and re-creating) a profile');
      const p = await resolveProfile(ctx, args.profile);
      const bundle = compact((await ctx.client.get(`/v1/profiles/${p.id}/bundleId`)).data as JsonApiResource);
      const valid = await certsForProfile(ctx, p.profileType);
      let certificateIds = valid.map(c => c.id);
      if (args.keep_existing_certificates) {
        const old = (await ctx.client.getAll(`/v1/profiles/${p.id}/certificates`, { 'fields[certificates]': 'name' }, 200)).data.map(c => c.id);
        certificateIds = certificateIds.filter(id => old.includes(id));
      }
      let deviceIds: string[] = [];
      if (DEVICE_PROFILE_TYPES.includes(p.profileType)) {
        const enabled = (await devicesForProfile(ctx, p.profileType)).map(d => d.id);
        if (args.keep_existing_devices) {
          const old = (await ctx.client.getAll(`/v1/profiles/${p.id}/devices`, { 'fields[devices]': 'name' }, 1000)).data.map(d => d.id);
          deviceIds = enabled.filter(id => old.includes(id));
        } else deviceIds = enabled;
      }
      // Validate before deleting so a failure doesn't leave the user without a profile.
      if (!certificateIds.length) throw new Error(`No valid ${PROFILE_CERT_TYPES[p.profileType].join('/')} certificate to sign the new profile; create one with create_certificate first. Nothing was deleted.`);
      if (DEVICE_PROFILE_TYPES.includes(p.profileType) && !deviceIds.length) throw new Error('No enabled devices for this profile; register_devices first. Nothing was deleted.');
      await ctx.client.delete(`/v1/profiles/${p.id}`);
      const created = await createProfileFromSpec(ctx, { name: p.name, profileType: p.profileType, bundleIdId: bundle.id, certificateIds, deviceIds }, true);
      return { deleted: { id: p.id, uuid: p.uuid, state: p.profileState }, bundleId: bundle.identifier, ...created };
    },
  },

  // ---------------- devices
  {
    name: 'list_devices',
    description: 'List registered test devices (name, UDID, class, model, status). Apple limits each device class (e.g. 100 iPhones) per membership year; disabled devices still count until the yearly reset.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ID_PLATFORMS },
        status: { type: 'string', enum: ['ENABLED', 'DISABLED'] },
        name: { type: 'string', description: 'Exact name' },
        udid: { type: 'string' },
        limit: S.limit,
      },
    },
    annotations: { title: 'List devices', readOnlyHint: true },
    async handler(args, ctx) {
      const res = await ctx.client.getAll('/v1/devices', defined({ 'filter[platform]': args.platform, 'filter[status]': args.status, 'filter[name]': args.name, 'filter[udid]': args.udid, sort: 'name' }), args.limit ?? 200);
      const devices = res.data.map(compact);
      const byClass: Record<string, number> = {};
      for (const d of devices) byClass[d.deviceClass ?? 'UNKNOWN'] = (byClass[d.deviceClass ?? 'UNKNOWN'] ?? 0) + 1;
      return { total: res.total, byClass, devices };
    },
  },
  {
    name: 'register_devices',
    description:
      'Register one or many test devices by UDID. Already-registered UDIDs are skipped (reported), not duplicated. platform: IOS for iPhone/iPad/Apple TV/Vision Pro/Watch, MAC_OS for Macs. After registering, regenerate development/ad hoc profiles so they include the new devices. Device slots are only freed at the membership renewal.',
    inputSchema: {
      type: 'object',
      properties: {
        devices: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, udid: { type: 'string' }, platform: { type: 'string', enum: ['IOS', 'MAC_OS'] } }, required: ['name', 'udid'] },
          description: 'platform defaults to IOS',
        },
      },
      required: ['devices'],
    },
    annotations: { title: 'Register devices' },
    async handler(args, ctx) {
      const list = arr<any>(args.devices);
      if (!list.length) throw new Error('devices is empty');
      const existing = (await ctx.client.getAll('/v1/devices', { 'filter[udid]': list.map(d => d.udid).join(',') }, 200)).data.map(compact);
      const results: any[] = [];
      for (const d of list) {
        const found = existing.find(e => e.udid?.toLowerCase() === d.udid.toLowerCase());
        if (found) {
          results.push({ udid: d.udid, status: 'already registered', id: found.id, name: found.name, deviceStatus: found.status });
          continue;
        }
        try {
          const doc = await ctx.client.post('/v1/devices', { data: { type: 'devices', attributes: { name: d.name, udid: d.udid, platform: d.platform ?? 'IOS' } } });
          results.push({ status: 'registered', ...compact(doc.data as JsonApiResource) });
        } catch (e: any) {
          results.push({ udid: d.udid, status: 'failed', error: e.message });
        }
      }
      return { results, next: 'Run regenerate_profile on development/ad hoc profiles to include new devices.' };
    },
  },
  {
    name: 'update_device',
    description: 'Rename a device or enable/disable it. Disabling removes it from new profiles but does not free the device slot until the membership year resets.',
    inputSchema: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'Device id or UDID' },
        name: { type: 'string' },
        status: { type: 'string', enum: ['ENABLED', 'DISABLED'] },
      },
      required: ['device'],
    },
    annotations: { title: 'Update device', idempotentHint: true },
    async handler(args, ctx) {
      let id = args.device;
      const byUdid = compactList(await ctx.client.get('/v1/devices', { 'filter[udid]': args.device }));
      if (byUdid.length) id = byUdid[0].id;
      if (args.name === undefined && args.status === undefined) throw new Error('Pass name and/or status.');
      const doc = await ctx.client.patch(`/v1/devices/${id}`, { data: { type: 'devices', id, attributes: defined({ name: args.name, status: args.status }) } });
      return compact(doc.data as JsonApiResource);
    },
  },

  // ---------------- wallet identifiers
  {
    name: 'list_wallet_identifiers',
    description: 'List Apple Pay merchant IDs and/or Wallet pass type IDs.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['merchant', 'pass_type', 'both'], description: 'Default both' } } },
    annotations: { title: 'List merchant / pass type IDs', readOnlyHint: true },
    async handler(args, ctx) {
      const kind = args.kind ?? 'both';
      const out: any = {};
      if (kind !== 'pass_type') out.merchantIds = (await ctx.client.getAll('/v1/merchantIds', { 'fields[merchantIds]': 'name,identifier' }, 200)).data.map(compact);
      if (kind !== 'merchant') out.passTypeIds = (await ctx.client.getAll('/v1/passTypeIds', { 'fields[passTypeIds]': 'name,identifier' }, 200)).data.map(compact);
      return out;
    },
  },
  {
    name: 'create_wallet_identifier',
    description: 'Register an Apple Pay merchant ID (merchant.com.example) or a Wallet pass type ID (pass.com.example). Then create its certificate with create_certificate (certificate_type APPLE_PAY* with merchant_id, or PASS_TYPE_ID* with pass_type_id).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['merchant', 'pass_type'] },
        identifier: { type: 'string', description: 'e.g. merchant.com.example.store or pass.com.example.ticket' },
        name: { type: 'string', description: 'Description' },
      },
      required: ['kind', 'identifier', 'name'],
    },
    annotations: { title: 'Create merchant / pass type ID' },
    async handler(args, ctx) {
      const type = args.kind === 'merchant' ? 'merchantIds' : 'passTypeIds';
      const doc = await ctx.client.post(`/v1/${type}`, { data: { type, attributes: { identifier: args.identifier, name: args.name } } });
      return compact(doc.data as JsonApiResource);
    },
  },

  // ---------------- users & invitations
  {
    name: 'list_users',
    description: 'List App Store Connect team members with roles, provisioning access and visible apps. Requires an Admin API key.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ROLES, description: 'Only users with this role' },
        email: { type: 'string', description: 'Exact username/email' },
        limit: S.limit,
      },
    },
    annotations: { title: 'List users', readOnlyHint: true },
    async handler(args, ctx) {
      const res = await ctx.client.getAll('/v1/users', defined({ 'filter[roles]': args.role, 'filter[username]': args.email, include: 'visibleApps', 'limit[visibleApps]': 50, 'fields[apps]': 'name,bundleId' }), args.limit ?? 200);
      return {
        total: res.total,
        users: res.data.map(u => {
          const c = compact(u);
          const appIds = arr(c.relationships?.visibleApps as string[] | undefined);
          const { relationships, ...rest } = c;
          return { ...rest, visibleApps: c.allAppsVisible ? 'ALL' : appIds.map(id => ({ id, name: res.included.find(i => i.type === 'apps' && i.id === id)?.attributes?.name })) };
        }),
      };
    },
  },
  {
    name: 'update_user',
    description:
      'Change a team member\'s roles, allAppsVisible, provisioningAllowed (certificates/profiles access), or visible apps. roles REPLACES the full role list. visible_apps (ids, bundle ids or names) REPLACES the list and only matters when allAppsVisible is false. You cannot change the Account Holder. Requires an Admin key.',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string', description: 'User id or email/username' },
        roles: { type: 'array', items: { type: 'string', enum: ROLES } },
        all_apps_visible: { type: 'boolean' },
        provisioning_allowed: { type: 'boolean' },
        visible_apps: { type: 'array', items: { type: 'string' }, description: 'Apps the user can see (replaces the list)' },
      },
      required: ['user'],
    },
    annotations: { title: 'Update user', idempotentHint: true },
    async handler(args, ctx) {
      checkEnum(args.roles, ROLES, 'role');
      const u = await resolveUser(ctx, args.user);
      const appIds = await resolveAppIds(ctx, args.visible_apps);
      const attributes = defined({ roles: args.roles, allAppsVisible: args.all_apps_visible, provisioningAllowed: args.provisioning_allowed });
      const doc = await ctx.client.patch(`/v1/users/${u.id}`, {
        data: defined({ type: 'users', id: u.id, attributes, relationships: appIds ? { visibleApps: rels('apps', appIds) } : undefined }),
      });
      return { before: { roles: u.roles, allAppsVisible: u.allAppsVisible, provisioningAllowed: u.provisioningAllowed }, after: compact(doc.data as JsonApiResource) };
    },
  },
  {
    name: 'remove_user',
    description: 'Remove a team member from App Store Connect (they lose all access immediately). Requires an Admin key.',
    inputSchema: { type: 'object', properties: { user: { type: 'string', description: 'User id or email/username' }, confirm: S.confirm }, required: ['user'] },
    annotations: { title: 'Remove user', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Removing a user');
      const u = await resolveUser(ctx, args.user);
      if (u.roles?.includes('ACCOUNT_HOLDER')) throw new Error('The Account Holder cannot be removed.');
      await ctx.client.delete(`/v1/users/${u.id}`);
      return { removed: { id: u.id, username: u.username, name: `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), roles: u.roles } };
    },
  },
  {
    name: 'list_user_invitations',
    description: 'List pending team invitations (email, roles, expiration). Requires an Admin key.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' }, limit: S.limit } },
    annotations: { title: 'List invitations', readOnlyHint: true },
    async handler(args, ctx) {
      const res = await ctx.client.getAll('/v1/userInvitations', defined({ 'filter[email]': args.email, include: 'visibleApps', 'fields[apps]': 'name' }), args.limit ?? 200);
      return {
        total: res.total,
        invitations: res.data.map(i => {
          const c = compact(i);
          const { relationships, ...rest } = c;
          const expired = c.expirationDate ? Date.parse(c.expirationDate) < Date.now() : undefined;
          return { ...rest, expired, visibleApps: c.allAppsVisible ? 'ALL' : arr(c.relationships?.visibleApps as string[] | undefined).map(id => res.included.find(x => x.type === 'apps' && x.id === id)?.attributes?.name ?? id) };
        }),
      };
    },
  },
  {
    name: 'invite_user',
    description:
      'Invite someone to the App Store Connect team (Apple emails them immediately). roles e.g. ["DEVELOPER"], ["APP_MANAGER"], ["MARKETING","CUSTOMER_SUPPORT"]. If all_apps_visible is false (default true), pass visible_apps. provisioning_allowed lets DEVELOPER/APP_MANAGER users manage certificates and profiles. Requires an Admin key.',
    inputSchema: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        roles: { type: 'array', items: { type: 'string', enum: ROLES } },
        all_apps_visible: { type: 'boolean', description: 'Default true' },
        provisioning_allowed: { type: 'boolean' },
        visible_apps: { type: 'array', items: { type: 'string' }, description: 'App ids/bundle ids/names (when all_apps_visible is false)' },
        confirm: S.confirm,
      },
      required: ['email', 'first_name', 'last_name', 'roles'],
    },
    annotations: { title: 'Invite user', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, `Inviting ${args.email} (sends an email)`);
      checkEnum(args.roles, ROLES, 'role');
      const allApps = args.all_apps_visible ?? !args.visible_apps?.length;
      const appIds = allApps ? undefined : await resolveAppIds(ctx, args.visible_apps);
      if (!allApps && !appIds?.length) throw new Error('With all_apps_visible false, pass visible_apps.');
      const doc = await ctx.client.post('/v1/userInvitations', {
        data: defined({
          type: 'userInvitations',
          attributes: defined({ email: args.email, firstName: args.first_name, lastName: args.last_name, roles: args.roles, allAppsVisible: allApps, provisioningAllowed: args.provisioning_allowed }),
          relationships: appIds ? { visibleApps: rels('apps', appIds) } : undefined,
        }),
      });
      return compact(doc.data as JsonApiResource);
    },
  },
  {
    name: 'cancel_invitation',
    description: 'Cancel a pending team invitation (by invitation id or email).',
    inputSchema: { type: 'object', properties: { invitation: { type: 'string', description: 'Invitation id or email' }, confirm: S.confirm }, required: ['invitation'] },
    annotations: { title: 'Cancel invitation', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Cancelling an invitation');
      let id = args.invitation;
      if (id.includes('@')) {
        const inv = compactList(await ctx.client.get('/v1/userInvitations', { 'filter[email]': id })).find(i => i.email?.toLowerCase() === id.toLowerCase());
        if (!inv) throw new Error(`No pending invitation for ${id}. Use list_user_invitations.`);
        id = inv.id;
      }
      await ctx.client.delete(`/v1/userInvitations/${id}`);
      return { cancelled: id };
    },
  },

  // ---------------- customer reviews
  {
    name: 'list_customer_reviews',
    description:
      'List App Store customer reviews for an app (rating, title, body, nickname, territory, date) with your existing developer response, if any. Filter by ratings, territory (3-letter, e.g. USA), and whether a response exists. Sort newest first by default. Reviews with only a star rating and no text are not returned by the API.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        ratings: { type: 'array', items: { type: 'number', enum: [1, 2, 3, 4, 5] }, description: 'e.g. [1,2] for negative reviews' },
        territory: { type: 'string', description: 'Territory code(s) like USA,GBR,DEU' },
        has_response: { type: 'boolean', description: 'true = only answered, false = only unanswered' },
        sort: { type: 'string', enum: ['-createdDate', 'createdDate', '-rating', 'rating'], description: 'Default -createdDate' },
        limit: S.limit,
      },
      required: ['app'],
    },
    annotations: { title: 'List customer reviews', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const res = await ctx.client.getAll(
        `/v1/apps/${app.id}/customerReviews`,
        defined({
          'filter[rating]': args.ratings?.length ? args.ratings.join(',') : undefined,
          'filter[territory]': args.territory,
          'exists[publishedResponse]': args.has_response,
          sort: args.sort ?? '-createdDate',
          include: 'response',
        }),
        args.limit ?? 50,
      );
      return { app: app.name, total: res.total, truncated: res.truncated, reviews: res.data.map(r => compactReview(r, res.included)) };
    },
  },
  {
    name: 'review_summary',
    description: 'Summarize an app\'s customer reviews: count and average by rating, by territory, how many are unanswered, and Apple\'s AI-generated review summary when available. Fetches up to max_reviews recent reviews (default 500).',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, max_reviews: { type: 'number', description: 'Default 500' }, platform: S.platform },
      required: ['app'],
    },
    annotations: { title: 'Review summary', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const res = await ctx.client.getAll(`/v1/apps/${app.id}/customerReviews`, { sort: '-createdDate', include: 'response', 'fields[customerReviews]': 'rating,territory,createdDate,response', 'fields[customerReviewResponses]': 'state' }, args.max_reviews ?? 500);
      const byRating: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      const byTerritory: Record<string, { count: number; sum: number }> = {};
      let unanswered = 0;
      for (const r of res.data) {
        const a = r.attributes ?? {};
        byRating[a.rating] = (byRating[a.rating] ?? 0) + 1;
        const t = (byTerritory[a.territory ?? '?'] ??= { count: 0, sum: 0 });
        t.count++;
        t.sum += a.rating ?? 0;
        if (!(r.relationships?.response as any)?.data) unanswered++;
      }
      const n = res.data.length;
      let appleSummary: any;
      try {
        const s = compactList(await ctx.client.get(`/v1/apps/${app.id}/customerReviewSummarizations`, { 'filter[platform]': args.platform ?? 'IOS', limit: 5 }));
        appleSummary = s.map(x => ({ locale: x.locale, createdDate: x.createdDate, text: x.text }));
      } catch (e: any) {
        appleSummary = `unavailable: ${e.message.split('\n')[0]}`;
      }
      return {
        app: app.name,
        reviewsAnalyzed: n,
        totalReviews: res.total,
        averageRating: n ? Math.round((res.data.reduce((s, r) => s + (r.attributes?.rating ?? 0), 0) / n) * 100) / 100 : null,
        byRating,
        byTerritory: Object.fromEntries(Object.entries(byTerritory).sort((a, b) => b[1].count - a[1].count).slice(0, 30).map(([k, v]) => [k, { count: v.count, avg: Math.round((v.sum / v.count) * 100) / 100 }])),
        unanswered,
        oldestAnalyzed: res.data.at(-1)?.attributes?.createdDate,
        appleSummary,
      };
    },
  },
  {
    name: 'respond_to_review',
    description:
      'Publish a public developer response to a customer review, or replace your existing response (Apple keeps one response per review). The response is visible on the App Store after Apple processes it (state PENDING_PUBLISH → PUBLISHED). Be polite and avoid personal data.',
    inputSchema: {
      type: 'object',
      properties: { review_id: { type: 'string' }, response: { type: 'string', description: 'Response text' }, confirm: S.confirm },
      required: ['review_id', 'response'],
    },
    annotations: { title: 'Respond to review', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Publishing a public review response');
      const review = await ctx.client.get(`/v1/customerReviews/${args.review_id}`, { include: 'response' });
      const prev = compactReview(review.data as JsonApiResource, review.included ?? []).response;
      const doc = await ctx.client.post('/v1/customerReviewResponses', {
        data: { type: 'customerReviewResponses', attributes: { responseBody: args.response }, relationships: { review: rel('customerReviews', args.review_id) } },
      });
      return { review: { id: args.review_id, rating: (review.data as any)?.attributes?.rating, title: (review.data as any)?.attributes?.title }, replaced: prev ? prev.responseBody : null, response: compact(doc.data as JsonApiResource) };
    },
  },
  {
    name: 'delete_review_response',
    description: 'Delete your public response to a customer review (pass review_id or response_id).',
    inputSchema: { type: 'object', properties: { review_id: { type: 'string' }, response_id: { type: 'string' }, confirm: S.confirm } },
    annotations: { title: 'Delete review response', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a review response');
      let id = args.response_id;
      if (!id) {
        if (!args.review_id) throw new Error('Pass review_id or response_id.');
        const doc = await ctx.client.get(`/v1/customerReviews/${args.review_id}/response`);
        id = (doc.data as any)?.id;
        if (!id) throw new Error('That review has no response.');
      }
      await ctx.client.delete(`/v1/customerReviewResponses/${id}`);
      return { deleted: id };
    },
  },

  // ---------------- sales & finance reports
  {
    name: 'download_sales_report',
    description:
      'Download a Sales and Trends report (gzip TSV), save the .tsv to the output dir, and return the columns, first rows and totals (units by product, proceeds by currency). Needs the vendor number (App Store Connect → Payments and Financial Reports, top-left under your name, e.g. 8XXXXXXX; or set APPLE_VENDOR_NUMBER) and a key with Admin, Finance or Sales/Access to Reports role. reportDate: YYYY-MM-DD (DAILY; WEEKLY = the Sunday ending the week), YYYY-MM (MONTHLY), YYYY (YEARLY); omit for the latest. Daily data appears ~1 day later; a 404 "no data" usually means the report is not ready yet or there were no sales that day. Subscription reports (SUBSCRIPTION, SUBSCRIPTION_EVENT, SUBSCRIBER) are DAILY only with DETAILED/SUMMARY subtype per Apple docs.',
    inputSchema: {
      type: 'object',
      properties: {
        report_type: { type: 'string', enum: SALES_REPORT_TYPES, description: 'Default SALES' },
        report_sub_type: { type: 'string', enum: ['SUMMARY', 'DETAILED', 'SUMMARY_INSTALL_TYPE', 'SUMMARY_TERRITORY', 'SUMMARY_CHANNEL'], description: 'Default SUMMARY (SUBSCRIBER needs DETAILED)' },
        frequency: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'], description: 'Default DAILY' },
        report_date: { type: 'string', description: 'YYYY-MM-DD, YYYY-MM or YYYY depending on frequency. Omit for latest' },
        version: { type: 'string', description: 'Report format version (default by type, e.g. SALES 1_1, SUBSCRIPTION 1_3)' },
        vendor_number: { type: 'string', description: 'Defaults to the configured APPLE_VENDOR_NUMBER' },
        preview_rows: { type: 'number', description: 'Rows to return (default 10)' },
      },
    },
    annotations: { title: 'Download sales report', readOnlyHint: true },
    async handler(args, ctx) {
      const vendor = args.vendor_number ?? ctx.vendorNumber;
      if (!vendor) throw new Error('No vendor number. Pass vendor_number or set APPLE_VENDOR_NUMBER. Find it in App Store Connect → Payments and Financial Reports (shown at the top left, an 8-digit number starting with 8).');
      const type = args.report_type ?? 'SALES';
      const sub = args.report_sub_type ?? (type === 'SUBSCRIBER' ? 'DETAILED' : 'SUMMARY');
      const freq = args.frequency ?? 'DAILY';
      const query = defined({
        'filter[vendorNumber]': vendor,
        'filter[reportType]': type,
        'filter[reportSubType]': sub,
        'filter[frequency]': freq,
        'filter[reportDate]': args.report_date,
        'filter[version]': args.version ?? SALES_DEFAULT_VERSION[type],
      });
      let bytes: Buffer;
      try {
        bytes = (await ctx.client.download('/v1/salesReports', query)).bytes;
      } catch (e: any) {
        if (e.status === 404) throw new Error(`No ${freq} ${type} report for ${args.report_date ?? 'the latest period'} (404). Usual causes: not generated yet (daily reports appear about a day later), no activity in that period, or wrong date format for the frequency.\n${e.message}`);
        if (e.status >= 500) throw new Error(`Apple returned ${e.status} for this sales report. This usually means the vendor number (${vendor}) is wrong or not linked to this API key's team, or the version (${query['filter[version]']}) is not valid for ${type}; check Payments and Financial Reports.\n${e.message}`);
        throw e;
      }
      const text = maybeGunzip(bytes).toString('utf-8');
      const file = saveOutput(ctx, `sales_${type}_${sub}_${freq}_${args.report_date ?? 'latest'}_${vendor}.tsv`, text);
      return { file, report: { type, subType: sub, frequency: freq, date: args.report_date ?? 'latest', version: query['filter[version]'] }, ...summarizeTsv(text, args.preview_rows ?? 10) };
    },
  },
  {
    name: 'download_finance_report',
    description:
      'Download a monthly financial report (gzip TSV, Apple fiscal month YYYY-MM), save the .tsv, and return columns, first rows and proceeds by currency. FINANCIAL reports are per region (regionCode like US, EU, JP, AU, CA, GB, or ZZ for all territories in one report); FINANCE_DETAIL needs regionCode Z1. Requires a key with Admin or Finance role and the vendor number (App Store Connect → Payments and Financial Reports). Reports are available after Apple closes the fiscal month (early the following month); 404 means not available yet or no earnings.',
    inputSchema: {
      type: 'object',
      properties: {
        report_date: { type: 'string', description: 'Apple fiscal month YYYY-MM' },
        region_code: { type: 'string', description: 'Default ZZ (FINANCIAL) / Z1 (FINANCE_DETAIL)' },
        report_type: { type: 'string', enum: ['FINANCIAL', 'FINANCE_DETAIL'], description: 'Default FINANCIAL' },
        vendor_number: { type: 'string' },
        preview_rows: { type: 'number' },
      },
      required: ['report_date'],
    },
    annotations: { title: 'Download finance report', readOnlyHint: true },
    async handler(args, ctx) {
      const vendor = args.vendor_number ?? ctx.vendorNumber;
      if (!vendor) throw new Error('No vendor number. Pass vendor_number or set APPLE_VENDOR_NUMBER (App Store Connect → Payments and Financial Reports, top left).');
      if (!/^\d{4}-\d{2}$/.test(args.report_date)) throw new Error('report_date must be YYYY-MM (Apple fiscal month).');
      const type = args.report_type ?? 'FINANCIAL';
      const region = args.region_code ?? (type === 'FINANCE_DETAIL' ? 'Z1' : 'ZZ');
      let bytes: Buffer;
      try {
        bytes = (await ctx.client.download('/v1/financeReports', { 'filter[vendorNumber]': vendor, 'filter[reportType]': type, 'filter[regionCode]': region, 'filter[reportDate]': args.report_date })).bytes;
      } catch (e: any) {
        if (e.status === 404) throw new Error(`No ${type} report for ${args.report_date} region ${region} (404): the fiscal month may not be closed yet, or there were no earnings in that region.\n${e.message}`);
        throw e;
      }
      const text = maybeGunzip(bytes).toString('utf-8');
      const file = saveOutput(ctx, `finance_${type}_${region}_${args.report_date}_${vendor}.tsv`, text);
      return { file, report: { type, region, date: args.report_date }, ...summarizeTsv(text, args.preview_rows ?? 10) };
    },
  },

  // ---------------- analytics reports
  {
    name: 'request_analytics_reports',
    description:
      'Turn on App Analytics reports for an app. ONGOING generates daily/weekly/monthly reports going forward (only one ongoing request per app; this returns the existing one instead of duplicating). ONE_TIME_SNAPSHOT backfills historical data once. The first reports take 1–2 days to appear; then use list_analytics_reports and download_analytics_report. Requires an Admin key.',
    inputSchema: { type: 'object', properties: { app: S.app, access_type: { type: 'string', enum: ['ONGOING', 'ONE_TIME_SNAPSHOT'], description: 'Default ONGOING' } }, required: ['app'] },
    annotations: { title: 'Request analytics reports', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const access = args.access_type ?? 'ONGOING';
      const existing = compactList(await ctx.client.get(`/v1/apps/${app.id}/analyticsReportRequests`, { 'filter[accessType]': access, limit: 50 }));
      const active = existing.find(r => !r.stoppedDueToInactivity);
      if (active && access === 'ONGOING') return { app: app.name, status: 'already requested', request: active };
      const doc = await ctx.client.post('/v1/analyticsReportRequests', {
        data: { type: 'analyticsReportRequests', attributes: { accessType: access }, relationships: { app: rel('apps', app.id) } },
      });
      return { app: app.name, status: 'requested', request: compact(doc.data as JsonApiResource), note: 'Reports appear within 1-2 days.' };
    },
  },
  {
    name: 'list_analytics_reports',
    description:
      'List the App Analytics reports available for an app (id, name, category) across its report requests. Categories: APP_STORE_ENGAGEMENT (impressions, page views), COMMERCE (downloads, purchases), APP_USAGE (sessions, installs, crashes), FRAMEWORK_USAGE, PERFORMANCE. Pass the report id to download_analytics_report. Empty means request_analytics_reports was never called (or reports are still being generated).',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, category: { type: 'string', enum: ['APP_USAGE', 'APP_STORE_ENGAGEMENT', 'COMMERCE', 'FRAMEWORK_USAGE', 'PERFORMANCE'] }, name_contains: { type: 'string', description: 'Case-insensitive substring of the report name' } },
      required: ['app'],
    },
    annotations: { title: 'List analytics reports', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const requests = compactList(await ctx.client.get(`/v1/apps/${app.id}/analyticsReportRequests`, { limit: 50 }));
      if (!requests.length) return { app: app.name, requests: [], reports: [], hint: 'No report requests yet. Call request_analytics_reports first.' };
      const reports: any[] = [];
      for (const r of requests) {
        const list = await ctx.client.getAll(`/v1/analyticsReportRequests/${r.id}/reports`, defined({ 'filter[category]': args.category }), 500);
        for (const rep of list.data.map(compact)) {
          if (args.name_contains && !rep.name?.toLowerCase().includes(args.name_contains.toLowerCase())) continue;
          reports.push({ id: rep.id, name: rep.name, category: rep.category, requestId: r.id, accessType: r.accessType });
        }
      }
      return { app: app.name, requests: requests.map(r => ({ id: r.id, accessType: r.accessType, stoppedDueToInactivity: r.stoppedDueToInactivity })), reports };
    },
  },
  {
    name: 'download_analytics_report',
    description:
      'Download an App Analytics report: picks instances by granularity and processing date (default: the latest one), downloads every segment, gunzips and merges them into one .tsv in the output dir, and returns columns + first rows. Get report_id from list_analytics_reports. Instance dates are processing dates (data is for the period before).',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string' },
        granularity: { type: 'string', enum: ['DAILY', 'WEEKLY', 'MONTHLY'], description: 'Default DAILY' },
        processing_date: { type: 'string', description: 'YYYY-MM-DD; omit for the latest' },
        instances: { type: 'number', description: 'How many latest instances to merge (default 1, max 31)' },
        preview_rows: { type: 'number' },
      },
      required: ['report_id'],
    },
    annotations: { title: 'Download analytics report', readOnlyHint: true },
    async handler(args, ctx) {
      const gran = args.granularity ?? 'DAILY';
      const report = compact((await ctx.client.get(`/v1/analyticsReports/${args.report_id}`)).data as JsonApiResource);
      const inst = await ctx.client.getAll(`/v1/analyticsReports/${args.report_id}/instances`, defined({ 'filter[granularity]': gran, 'filter[processingDate]': args.processing_date }), 500);
      const instances = inst.data.map(compact).sort((a, b) => String(b.processingDate).localeCompare(String(a.processingDate)));
      if (!instances.length) throw new Error(`No ${gran} instances for "${report.name}"${args.processing_date ? ` on ${args.processing_date}` : ''}. Try another granularity, or wait: reports appear 1-2 days after requesting.`);
      const chosen = instances.slice(0, Math.min(31, Math.max(1, args.instances ?? 1)));
      let header: string | undefined;
      const lines: string[] = [];
      let segments = 0;
      for (const i of chosen) {
        const segs = (await ctx.client.getAll(`/v1/analyticsReportInstances/${i.id}/segments`, {}, 200)).data.map(compact);
        for (const s of segs) {
          // Segment URLs are pre-signed external URLs: plain fetch, no auth header.
          const res = await fetch(s.url);
          if (!res.ok) throw new Error(`Segment download failed (${res.status}) for instance ${i.processingDate}: ${(await res.text()).slice(0, 300)}`);
          const text = maybeGunzip(Buffer.from(await res.arrayBuffer())).toString('utf-8');
          const rows = text.split(/\r?\n/).filter(l => l.trim() !== '');
          if (!rows.length) continue;
          if (header === undefined) header = rows[0];
          lines.push(...(rows[0] === header ? rows.slice(1) : rows));
          segments++;
        }
      }
      const text = [header ?? '', ...lines].join('\n') + '\n';
      const file = saveOutput(ctx, `analytics_${report.name}_${gran}_${chosen.at(-1)!.processingDate}_${chosen[0].processingDate}.tsv`, text);
      const summary = summarizeTsv(text, args.preview_rows ?? 10);
      delete (summary as any).proceedsByCurrency;
      return {
        file,
        report: { id: report.id, name: report.name, category: report.category },
        granularity: gran,
        processingDates: chosen.map(c => c.processingDate),
        availableInstances: instances.length,
        segments,
        ...summary,
      };
    },
  },

  // ---------------- performance & diagnostics
  {
    name: 'get_perf_power_metrics',
    description:
      'Get Xcode Organizer performance & power metrics (launch time, hangs, memory, disk writes, battery, terminations, animation hitches, storage) for an app or a specific build, plus Apple\'s regression/trending insights. Saves the full JSON to the output dir and returns a compact view with the most recent versions per metric. Only iOS; needs enough real-user data (often empty for new/low-traffic apps).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        build_id: { type: 'string', description: 'Use a build instead of the app' },
        metric_types: { type: 'array', items: { type: 'string', enum: PERF_METRIC_TYPES } },
        device_type: { type: 'string', description: 'Device filter, e.g. all_iPhones, all_iPads, iPhone15,2' },
        versions: { type: 'number', description: 'Data points (app versions) per dataset to return (default 3)' },
      },
    },
    annotations: { title: 'Performance & power metrics', readOnlyHint: true },
    async handler(args, ctx) {
      let target: string;
      if (args.build_id) target = `/v1/builds/${args.build_id}/perfPowerMetrics`;
      else if (args.app) target = `/v1/apps/${(await resolveApp(ctx, args.app)).id}/perfPowerMetrics`;
      else throw new Error('Pass app or build_id.');
      checkEnum(args.metric_types, PERF_METRIC_TYPES, 'metric type');
      const { bytes } = await ctx.client.download(
        target,
        defined({ 'filter[metricType]': args.metric_types?.length ? args.metric_types.join(',') : undefined, 'filter[deviceType]': args.device_type, 'filter[platform]': 'IOS' }),
        'application/vnd.apple.xcode-metrics+json',
      );
      const json = JSON.parse(maybeGunzip(bytes).toString('utf-8') || '{}');
      const file = saveOutput(ctx, `perf_metrics_${args.build_id ?? args.app}_${Date.now()}.json`, JSON.stringify(json, null, 1));
      const keep = args.versions ?? 3;
      const insight = (x: any) => ({ category: x.metricCategory, metric: x.metric, latestVersion: x.latestVersion, summary: x.summaryString, highImpact: x.highImpact });
      const metrics: any[] = [];
      for (const pd of json.productData ?? []) {
        for (const cat of pd.metricCategories ?? []) {
          for (const m of cat.metrics ?? []) {
            metrics.push({
              category: cat.identifier,
              metric: m.identifier,
              unit: m.unit?.displayName ?? m.unit?.identifier,
              datasets: (m.datasets ?? []).map((d: any) => ({
                percentile: d.filterCriteria?.percentile,
                device: d.filterCriteria?.deviceMarketingName ?? d.filterCriteria?.device,
                points: (d.points ?? []).slice(-keep).map((p: any) => ({ version: p.version, value: p.value, goal: p.goal })),
              })),
            });
          }
        }
      }
      return {
        file,
        regressions: (json.insights?.regressions ?? []).map(insight),
        trendingUp: (json.insights?.trendingUp ?? []).map(insight),
        metrics,
        note: metrics.length ? undefined : 'No metrics: Apple needs enough opted-in user data for this app/build.',
      };
    },
  },
  {
    name: 'list_diagnostic_signatures',
    description: 'List diagnostic signatures (grouped hang, launch and disk-write issues from real devices) for a build, heaviest first. Pass build_id, or app + build_number. Then get_diagnostic_logs for stack traces.',
    inputSchema: {
      type: 'object',
      properties: {
        build_id: { type: 'string' },
        app: S.app,
        build_number: { type: 'string', description: 'CFBundleVersion' },
        version: { type: 'string', description: 'Marketing version, to disambiguate build_number' },
        diagnostic_type: { type: 'string', enum: ['HANGS', 'LAUNCHES', 'DISK_WRITES'] },
        limit: S.limit,
      },
    },
    annotations: { title: 'List diagnostic signatures', readOnlyHint: true },
    async handler(args, ctx) {
      const buildId = await resolveBuildId(ctx, args);
      const res = await ctx.client.getAll(`/v1/builds/${buildId}/diagnosticSignatures`, defined({ 'filter[diagnosticType]': args.diagnostic_type }), args.limit ?? 50);
      const sigs = res.data.map(compact).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
      return { buildId, total: res.total, signatures: sigs, hint: sigs.length ? undefined : 'No diagnostics for this build (needs real-user data from opted-in devices).' };
    },
  },
  {
    name: 'get_diagnostic_logs',
    description: 'Get diagnostic logs for a diagnostic signature: device/OS metadata and the blame-frame call stacks (top frames). Saves the full JSON to the output dir.',
    inputSchema: {
      type: 'object',
      properties: { signature_id: { type: 'string' }, limit: { type: 'number', description: 'Max logs (default 10)' }, frames: { type: 'number', description: 'Frames per stack to show (default 15)' } },
      required: ['signature_id'],
    },
    annotations: { title: 'Get diagnostic logs', readOnlyHint: true },
    async handler(args, ctx) {
      const { bytes } = await ctx.client.download(`/v1/diagnosticSignatures/${args.signature_id}/logs`, { limit: args.limit ?? 10 }, 'application/vnd.apple.diagnostic-logs+json');
      const json = JSON.parse(maybeGunzip(bytes).toString('utf-8') || '{}');
      const file = saveOutput(ctx, `diagnostic_logs_${args.signature_id}.json`, JSON.stringify(json, null, 1));
      const maxFrames = args.frames ?? 15;
      const flatten = (nodes: any[] | undefined, out: string[]) => {
        // Follow the heaviest path down the tree.
        let cur = nodes;
        while (cur?.length && out.length < maxFrames) {
          const n = [...cur].sort((a, b) => (b.sampleCount ?? 0) - (a.sampleCount ?? 0))[0];
          out.push(`${n.isBlameFrame ? '>> ' : ''}${n.binaryName ?? '?'}  ${n.symbolName ?? n.rawFrame ?? n.address ?? ''}${n.fileName ? ` (${n.fileName}:${n.lineNumber ?? ''})` : ''}`);
          cur = n.subFrames;
        }
        return out;
      };
      const products = (json.productData ?? []).map((p: any) => ({
        signatureId: p.signatureId,
        insights: p.diagnosticInsights,
        logs: (p.diagnosticLogs ?? []).map((l: any) => ({
          meta: l.diagnosticMetaData,
          stacks: (l.callStackTree ?? []).flatMap((t: any) => (t.callStacks ?? []).slice(0, 3).map((cs: any) => flatten(cs.callStackRootFrames, []))),
        })),
      }));
      return { file, products };
    },
  },

  // ---------------- webhooks
  {
    name: 'list_webhooks',
    description: 'List webhooks configured for an app (name, url, enabled, event types). Secrets are never returned.',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'List webhooks', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const res = await ctx.client.getAll(`/v1/apps/${app.id}/webhooks`, {}, 200);
      return { app: app.name, webhooks: res.data.map(compact) };
    },
  },
  {
    name: 'create_webhook',
    description:
      'Create an App Store Connect webhook for an app: Apple POSTs JSON events to your HTTPS url, signed with HMAC-SHA256 using the secret (header X-Apple-SIGNATURE). If secret is omitted one is generated and returned once (Apple never shows it again). Event types include APP_STORE_VERSION_APP_VERSION_STATE_UPDATED (review status), BUILD_UPLOAD_STATE_UPDATED, BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED, BETA_FEEDBACK_*_SUBMISSION_CREATED. Test it with ping_webhook.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        name: { type: 'string' },
        url: { type: 'string', description: 'HTTPS endpoint' },
        event_types: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS } },
        secret: { type: 'string', description: 'Signing secret (default: random, returned)' },
        enabled: { type: 'boolean', description: 'Default true' },
      },
      required: ['app', 'name', 'url', 'event_types'],
    },
    annotations: { title: 'Create webhook' },
    async handler(args, ctx) {
      checkEnum(args.event_types, WEBHOOK_EVENTS, 'event type');
      if (!/^https:\/\//i.test(args.url)) throw new Error('Webhook url must be https://');
      const app = await resolveApp(ctx, args.app);
      const secret = args.secret ?? randomBytes(24).toString('base64url');
      const doc = await ctx.client.post('/v1/webhooks', {
        data: { type: 'webhooks', attributes: { name: args.name, url: args.url, eventTypes: args.event_types, secret, enabled: args.enabled ?? true }, relationships: { app: rel('apps', app.id) } },
      });
      const { secret: _s, ...wh } = compact(doc.data as JsonApiResource);
      return { app: app.name, webhook: wh, secret: args.secret ? '(as provided)' : secret, next: 'ping_webhook to test delivery.' };
    },
  },
  {
    name: 'update_webhook',
    description: 'Update a webhook\'s name, url, secret, event types (replaces the list), or enable/disable it.',
    inputSchema: {
      type: 'object',
      properties: {
        webhook_id: { type: 'string' },
        name: { type: 'string' },
        url: { type: 'string' },
        event_types: { type: 'array', items: { type: 'string', enum: WEBHOOK_EVENTS } },
        secret: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['webhook_id'],
    },
    annotations: { title: 'Update webhook', idempotentHint: true },
    async handler(args, ctx) {
      checkEnum(args.event_types, WEBHOOK_EVENTS, 'event type');
      const attributes = defined({ name: args.name, url: args.url, eventTypes: args.event_types, secret: args.secret, enabled: args.enabled });
      if (!Object.keys(attributes).length) throw new Error('Nothing to update.');
      const doc = await ctx.client.patch(`/v1/webhooks/${args.webhook_id}`, { data: { type: 'webhooks', id: args.webhook_id, attributes } });
      const { secret: _s, ...wh } = compact(doc.data as JsonApiResource);
      return wh;
    },
  },
  {
    name: 'delete_webhook',
    description: 'Delete a webhook; Apple stops sending its events.',
    inputSchema: { type: 'object', properties: { webhook_id: { type: 'string' }, confirm: S.confirm }, required: ['webhook_id'] },
    annotations: { title: 'Delete webhook', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a webhook');
      await ctx.client.delete(`/v1/webhooks/${args.webhook_id}`);
      return { deleted: args.webhook_id };
    },
  },
  {
    name: 'ping_webhook',
    description: 'Send a test (ping) event to a webhook, then check list_webhook_deliveries for the result.',
    inputSchema: { type: 'object', properties: { webhook_id: { type: 'string' } }, required: ['webhook_id'] },
    annotations: { title: 'Ping webhook' },
    async handler(args, ctx) {
      const doc = await ctx.client.post('/v1/webhookPings', { data: { type: 'webhookPings', relationships: { webhook: rel('webhooks', args.webhook_id) } } });
      return { ping: compact(doc.data as JsonApiResource), next: 'list_webhook_deliveries to see whether it succeeded.' };
    },
  },
  {
    name: 'list_webhook_deliveries',
    description: 'List recent delivery attempts for a webhook (state, HTTP status, error, event type), filterable by state and date range. Use redeliver_webhook on failed ones.',
    inputSchema: {
      type: 'object',
      properties: {
        webhook_id: { type: 'string' },
        state: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'PENDING'] },
        since: { type: 'string', description: 'ISO date-time (createdDate >=)' },
        until: { type: 'string', description: 'ISO date-time (createdDate <)' },
        include_payload: { type: 'boolean', description: 'Include event payloads (default false)' },
        limit: S.limit,
      },
      required: ['webhook_id'],
    },
    annotations: { title: 'List webhook deliveries', readOnlyHint: true },
    async handler(args, ctx) {
      const res = await ctx.client.getAll(
        `/v1/webhooks/${args.webhook_id}/deliveries`,
        defined({ 'filter[deliveryState]': args.state, 'filter[createdDateGreaterThanOrEqualTo]': args.since, 'filter[createdDateLessThan]': args.until, include: 'event' }),
        args.limit ?? 50,
      );
      return {
        total: res.total,
        deliveries: res.data.map(d => {
          const c = compact(d);
          const evId = c.relationships?.event as string | undefined;
          const ev = res.included.find(i => i.type === 'webhookEvents' && i.id === evId)?.attributes;
          const { relationships, ...rest } = c;
          return { ...rest, event: ev ? { id: evId, eventType: ev.eventType, ping: ev.ping, createdDate: ev.createdDate, payload: args.include_payload ? ev.payload : undefined } : evId };
        }),
      };
    },
  },
  {
    name: 'redeliver_webhook',
    description: 'Re-send a past webhook delivery (e.g. one that FAILED) using it as a template.',
    inputSchema: { type: 'object', properties: { delivery_id: { type: 'string' } }, required: ['delivery_id'] },
    annotations: { title: 'Redeliver webhook event' },
    async handler(args, ctx) {
      const doc = await ctx.client.post('/v1/webhookDeliveries', { data: { type: 'webhookDeliveries', relationships: { template: rel('webhookDeliveries', args.delivery_id) } } });
      return compact(doc.data as JsonApiResource);
    },
  },
];
