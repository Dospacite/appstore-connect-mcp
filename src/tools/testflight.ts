/**
 * TestFlight & builds: build listing/upload, export compliance, beta groups,
 * testers, beta app info, What to Test, beta review, feedback, Xcode Cloud,
 * and sandbox testers.
 */
import { inflateRawSync } from 'zlib';
import path from 'path';
import { md5Hex, type JsonApiResource, type UploadOperation } from '../asc/client.js';
import { compact, defined, rel, rels } from '../asc/format.js';
import { S, compactList, readLocalFile, requireConfirm, resolveApp, saveOutput, uploadAsset, type Platform } from './helpers.js';
import type { ToolContext, ToolDef } from './types.js';

// ---------------------------------------------------------------------------
// Small module helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isFake = (id?: string) => !!id && id.startsWith('DRY_RUN_');
const looksLikeId = (s: string) => UUID_RE.test(s) || isFake(s);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

function indexIncluded(included: JsonApiResource[] | undefined): Map<string, any> {
  const m = new Map<string, any>();
  for (const r of included ?? []) m.set(`${r.type}/${r.id}`, compact(r));
  return m;
}
function relId(r: JsonApiResource, name: string): string | undefined {
  return r.relationships?.[name]?.data?.id;
}
function relIds(r: JsonApiResource, name: string): string[] {
  const d = r.relationships?.[name]?.data;
  return Array.isArray(d) ? d.map((x: any) => x.id) : [];
}
function iconUrl(token: any): string | undefined {
  if (!token?.templateUrl) return undefined;
  return String(token.templateUrl).replace('{w}', String(token.width ?? 512)).replace('{h}', String(token.height ?? 512)).replace('{f}', 'png');
}

/** Flatten a build plus its preReleaseVersion / buildBetaDetail from `included`. */
function summarizeBuild(b: JsonApiResource, inc: Map<string, any>) {
  const a = b.attributes ?? {};
  const prv = inc.get(`preReleaseVersions/${relId(b, 'preReleaseVersion')}`);
  const bbd = inc.get(`buildBetaDetails/${relId(b, 'buildBetaDetail')}`);
  return defined({
    id: b.id,
    version: prv?.version,
    buildNumber: a.version,
    platform: prv?.platform,
    uploadedDate: a.uploadedDate,
    expirationDate: a.expirationDate,
    expired: a.expired,
    processingState: a.processingState,
    buildAudienceType: a.buildAudienceType,
    usesNonExemptEncryption: a.usesNonExemptEncryption,
    minOsVersion: a.minOsVersion,
    internalBuildState: bbd?.internalBuildState,
    externalBuildState: bbd?.externalBuildState,
    autoNotifyEnabled: bbd?.autoNotifyEnabled,
  });
}

/**
 * Resolve a build reference: a build id, or a build number (CFBundleVersion)
 * / "latest" within an app (optionally narrowed by marketing version + platform).
 */
async function resolveBuildId(ctx: ToolContext, build: string, app?: string, version?: string, platform?: Platform): Promise<string> {
  if (!build) throw new Error('build is required (build id, or build number / "latest" together with app)');
  if (looksLikeId(build)) return build;
  if (!app) throw new Error(`"${build}" is not a build id. Pass app too so the build number can be looked up (or use list_builds to get ids).`);
  const appId = (await resolveApp(ctx, app)).id;
  const q: Record<string, any> = { 'filter[app]': appId, sort: '-uploadedDate', limit: 20, 'fields[builds]': 'version,uploadedDate' };
  if (build !== 'latest') q['filter[version]'] = build;
  if (version) q['filter[preReleaseVersion.version]'] = version;
  if (platform) q['filter[preReleaseVersion.platform]'] = platform;
  const doc = await ctx.client.get('/v1/builds', q);
  const list = (doc.data as JsonApiResource[]) ?? [];
  if (!list.length) throw new Error(`No build ${build === 'latest' ? '' : `number ${build} `}found${version ? ` for version ${version}` : ''}. Use list_builds to see builds.`);
  return list[0].id;
}

async function resolveBuildIds(ctx: ToolContext, builds: string | string[], app?: string, version?: string, platform?: Platform): Promise<string[]> {
  const out: string[] = [];
  for (const b of asArray(builds)) out.push(await resolveBuildId(ctx, String(b), app, version, platform));
  if (!out.length) throw new Error('At least one build is required');
  return out;
}

/** Build's app id (needed when a build id is given without app). */
async function appIdOfBuild(ctx: ToolContext, buildId: string): Promise<string | undefined> {
  if (isFake(buildId)) return undefined;
  const doc = await ctx.client.get(`/v1/builds/${buildId}/app`, { 'fields[apps]': 'bundleId' });
  return (doc.data as JsonApiResource)?.id;
}

/** Resolve beta groups by id or by (case-insensitive) name within the app. */
async function resolveGroups(ctx: ToolContext, groups: string | string[], appId?: string): Promise<Array<{ id: string; name?: string; isInternalGroup?: boolean }>> {
  const wanted = asArray(groups).map(String);
  if (!wanted.length) throw new Error('At least one beta group (id or name) is required');
  const names = wanted.filter(g => !looksLikeId(g));
  let all: any[] = [];
  if (names.length) {
    if (!appId) throw new Error(`Group names (${names.join(', ')}) need app to be resolved. Pass app, or use group ids from list_beta_groups.`);
    const doc = await ctx.client.getAll('/v1/betaGroups', { 'filter[app]': appId, 'fields[betaGroups]': 'name,isInternalGroup' }, 500);
    all = doc.data.map(compact);
  }
  return wanted.map(g => {
    if (looksLikeId(g)) return { id: g };
    const hit = all.filter(x => x.name?.toLowerCase() === g.toLowerCase());
    if (hit.length !== 1) throw new Error(`Beta group "${g}" ${hit.length ? 'is ambiguous' : 'not found'}. Existing groups: ${all.map(x => `${x.name} (${x.id})`).join(', ') || 'none'}`);
    return { id: hit[0].id, name: hit[0].name, isInternalGroup: hit[0].isInternalGroup };
  });
}

/** Look up existing beta testers by email (team-wide). Returns lower-cased email -> tester. */
async function findTestersByEmail(ctx: ToolContext, emails: string[], appId?: string): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  for (const part of chunk([...new Set(emails.map(e => e.trim()).filter(Boolean))], 20)) {
    const q: Record<string, any> = { 'filter[email]': part.join(','), limit: 200, 'fields[betaTesters]': 'email,firstName,lastName,inviteType,state' };
    if (appId) q['filter[apps]'] = appId;
    const doc = await ctx.client.get('/v1/betaTesters', q);
    for (const t of compactList(doc)) if (t.email) out.set(String(t.email).toLowerCase(), t);
  }
  return out;
}

/** Testers given as ids or emails -> ids. Unknown emails throw. */
async function resolveTesterIds(ctx: ToolContext, testers: string | string[], appId?: string): Promise<string[]> {
  const list = asArray(testers).map(String);
  const emails = list.filter(t => t.includes('@'));
  const found = emails.length ? await findTestersByEmail(ctx, emails, appId) : new Map();
  const missing = emails.filter(e => !found.has(e.toLowerCase()));
  if (missing.length) throw new Error(`No beta tester found for: ${missing.join(', ')}${appId ? ' (in this app)' : ''}. Add them first with add_beta_testers.`);
  return list.map(t => (t.includes('@') ? found.get(t.toLowerCase()).id : t));
}

// ---------------------------------------------------------------------------
// IPA reading: minimal ZIP reader + binary/XML plist parser
// ---------------------------------------------------------------------------

/** Extract one file from a ZIP archive held in memory (supports store/deflate and ZIP64). */
function zipExtract(buf: Buffer, match: (name: string) => boolean): { name: string; data: Buffer } | undefined {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (an .ipa must be a zip file)');
  let entries = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || entries === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      entries = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  let p = cdOffset;
  for (let n = 0; n < entries && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (match(name)) {
      // ZIP64 extended info for fields saturated at 0xFFFFFFFF.
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = buf.readUInt16LE(e);
        const len = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (size === 0xffffffff) (size = Number(buf.readBigUInt64LE(q))), (q += 8);
          if (compSize === 0xffffffff) (compSize = Number(buf.readBigUInt64LE(q))), (q += 8);
          if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q));
        }
        e += 4 + len;
      }
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for ${name}`);
      const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
      const raw = buf.subarray(start, start + compSize);
      if (method === 0) return { name, data: Buffer.from(raw) };
      if (method === 8) return { name, data: inflateRawSync(raw) };
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

/** Parse a binary (bplist00) or XML property list into plain JS values. */
function parsePlist(buf: Buffer): any {
  if (buf.subarray(0, 8).toString('latin1') === 'bplist00') return parseBinaryPlist(buf);
  return parseXmlPlistTop(buf.toString('utf8'));
}

function parseBinaryPlist(buf: Buffer): any {
  const t = buf.length - 32;
  const offSize = buf.readUInt8(t + 6);
  const refSize = buf.readUInt8(t + 7);
  const numObjects = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableOffset = Number(buf.readBigUInt64BE(t + 24));
  const readUInt = (pos: number, size: number): number => {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    return v;
  };
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) offsets.push(readUInt(tableOffset + i * offSize, offSize));
  const depthGuard = new Set<number>();
  const parse = (ref: number): any => {
    if (depthGuard.has(ref)) throw new Error('Cyclic plist');
    depthGuard.add(ref);
    try {
      let pos = offsets[ref];
      const marker = buf[pos];
      const hi = marker >> 4;
      const lo = marker & 0x0f;
      const readLen = () => {
        if (lo !== 0x0f) return lo;
        const intMarker = buf[pos + 1];
        const bytes = 1 << (intMarker & 0x0f);
        const len = readUInt(pos + 2, bytes);
        pos += 1 + bytes;
        return len;
      };
      switch (hi) {
        case 0x0:
          return lo === 0x8 ? false : lo === 0x9 ? true : null;
        case 0x1: {
          const bytes = 1 << lo;
          if (bytes === 8) return Number(buf.readBigInt64BE(pos + 1));
          return readUInt(pos + 1, bytes);
        }
        case 0x2:
          return lo === 2 ? buf.readFloatBE(pos + 1) : buf.readDoubleBE(pos + 1);
        case 0x3:
          return new Date((buf.readDoubleBE(pos + 1) + 978307200) * 1000).toISOString();
        case 0x4: {
          const len = readLen();
          return buf.subarray(pos + 1, pos + 1 + len).toString('base64');
        }
        case 0x5: {
          const len = readLen();
          return buf.toString('latin1', pos + 1, pos + 1 + len);
        }
        case 0x6: {
          const len = readLen();
          const s = Buffer.from(buf.subarray(pos + 1, pos + 1 + len * 2));
          s.swap16();
          return s.toString('utf16le');
        }
        case 0x8:
          return readUInt(pos + 1, lo + 1);
        case 0xa: {
          const len = readLen();
          const arr = [];
          for (let i = 0; i < len; i++) arr.push(parse(readUInt(pos + 1 + i * refSize, refSize)));
          return arr;
        }
        case 0xd: {
          const len = readLen();
          const obj: Record<string, any> = {};
          for (let i = 0; i < len; i++) {
            const k = parse(readUInt(pos + 1 + i * refSize, refSize));
            obj[String(k)] = parse(readUInt(pos + 1 + (len + i) * refSize, refSize));
          }
          return obj;
        }
        default:
          return null;
      }
    } finally {
      depthGuard.delete(ref);
    }
  };
  return parse(top);
}

/** Tiny XML plist parser (dict/array/string/integer/real/true/false/data/date). */
function parseXmlPlistTop(xml: string): any {
  const tokens = xml.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g) ?? [];
  let i = 0;
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const next = () => {
    while (i < tokens.length && !tokens[i].startsWith('<') && !tokens[i].trim()) i++;
    return tokens[i++];
  };
  const textUntil = (close: string) => {
    let s = '';
    while (i < tokens.length && tokens[i] !== close) s += tokens[i++];
    i++;
    return decode(s);
  };
  const value = (tag: string): any => {
    if (/^<(true|false)\s*\/>$/.test(tag)) return tag.includes('true');
    if (/^<(string|dict|array)\s*\/>$/.test(tag)) return tag.includes('string') ? '' : tag.includes('dict') ? {} : [];
    const name = tag.slice(1, -1).trim().split(/\s/)[0];
    switch (name) {
      case 'plist':
        return value(next());
      case 'string':
      case 'data':
      case 'date':
        return textUntil(`</${name}>`);
      case 'integer':
      case 'real':
        return Number(textUntil(`</${name}>`));
      case 'array': {
        const arr: any[] = [];
        for (let t = next(); t && t !== '</array>'; t = next()) arr.push(value(t));
        return arr;
      }
      case 'dict': {
        const obj: Record<string, any> = {};
        for (let t = next(); t && t !== '</dict>'; t = next()) {
          if (t !== '<key>') continue;
          const k = textUntil('</key>');
          obj[k] = value(next());
        }
        return obj;
      }
      default:
        return undefined;
    }
  };
  return value(next());
}

const PLATFORM_FROM_PLIST: Record<string, Platform> = {
  iphoneos: 'IOS',
  appletvos: 'TV_OS',
  xros: 'VISION_OS',
  macosx: 'MAC_OS',
};

/** Read version info from Payload/<App>.app/Info.plist inside an .ipa. */
function readIpaInfo(bytes: Buffer): { bundleId?: string; version?: string; buildNumber?: string; platform?: Platform; usesNonExemptEncryption?: boolean } {
  const entry = zipExtract(bytes, n => /^Payload\/[^/]+\.app\/Info\.plist$/.test(n));
  if (!entry) throw new Error('Payload/<App>.app/Info.plist not found in the .ipa. Pass version and build_number explicitly.');
  const pl = parsePlist(entry.data) ?? {};
  const supported = asArray(pl.CFBundleSupportedPlatforms)[0] ?? pl.DTPlatformName;
  return defined({
    bundleId: pl.CFBundleIdentifier,
    version: pl.CFBundleShortVersionString,
    buildNumber: pl.CFBundleVersion,
    platform: supported ? PLATFORM_FROM_PLIST[String(supported).toLowerCase()] : undefined,
    usesNonExemptEncryption: typeof pl.ITSAppUsesNonExemptEncryption === 'boolean' ? pl.ITSAppUsesNonExemptEncryption : undefined,
  }) as any;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const buildArg = { type: 'string', description: 'Build: build id, or build number (CFBundleVersion, e.g. "42") / "latest" together with app' };
const buildsArg = { type: 'array', items: { type: 'string' }, description: 'Builds: ids, or build numbers / "latest" together with app' };
const groupsArg = { type: 'array', items: { type: 'string' }, description: 'Beta groups: ids or exact names (names need app)' };
const testersArg = { type: 'array', items: { type: 'string' }, description: 'Testers: beta tester ids or email addresses' };
const marketingVersion = { type: 'string', description: 'Marketing version (CFBundleShortVersionString) to narrow build-number lookups, e.g. 1.2.0' };

const BUILD_INCLUDES = 'preReleaseVersion,buildBetaDetail';

export const testflightTools: ToolDef[] = [
  // ----------------------------------------------------------------- builds
  {
    name: 'list_builds',
    description:
      'List an app\'s builds, newest first, with marketing version, build number, processing state, expiry, encryption flag and TestFlight internal/external state. Filter by version, build number, processing state, expired, platform or beta review state. Builds expire 90 days after upload; processing usually takes 5-30 min after upload.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        version: marketingVersion,
        build_number: { type: 'string', description: 'Build number (CFBundleVersion)' },
        processing_state: { type: 'string', enum: ['PROCESSING', 'FAILED', 'INVALID', 'VALID'] },
        expired: { type: 'boolean', description: 'true = only expired, false = only active' },
        platform: S.platform,
        beta_review_state: { type: 'string', enum: ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'REJECTED', 'APPROVED'] },
        limit: S.limit,
      },
      required: ['app'],
    },
    annotations: { title: 'List builds', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const doc = await ctx.client.getAll(
        '/v1/builds',
        defined({
          'filter[app]': app.id,
          'filter[preReleaseVersion.version]': args.version,
          'filter[version]': args.build_number,
          'filter[processingState]': args.processing_state,
          'filter[expired]': args.expired === undefined ? undefined : String(args.expired),
          'filter[preReleaseVersion.platform]': args.platform,
          'filter[betaAppReviewSubmission.betaReviewState]': args.beta_review_state,
          sort: '-uploadedDate',
          include: BUILD_INCLUDES,
        }) as any,
        args.limit ?? 50,
      );
      const inc = indexIncluded(doc.included);
      return { app: { id: app.id, name: app.name }, total: doc.total, builds: doc.data.map(b => summarizeBuild(b, inc)), truncated: doc.truncated || undefined };
    },
  },
  {
    name: 'get_build',
    description:
      'Full details of one build: version/build number, processing state, expiry, encryption/export compliance (+declaration), TestFlight internal/external state, beta review submission status, beta groups, individual testers, What to Test per locale, linked App Store version, icon URLs and the upload record. Use it to check beta review status after submit_for_beta_review.',
    inputSchema: { type: 'object', properties: { build: buildArg, app: S.app, version: marketingVersion }, required: ['build'] },
    annotations: { title: 'Get build', readOnlyHint: true },
    async handler(args, ctx) {
      const id = await resolveBuildId(ctx, args.build, args.app, args.version);
      const doc = await ctx.client.get(`/v1/builds/${id}`, {
        include: 'preReleaseVersion,betaGroups,individualTesters,betaBuildLocalizations,appEncryptionDeclaration,betaAppReviewSubmission,buildBetaDetail,appStoreVersion,icons,buildUpload,app',
        'limit[betaGroups]': 50,
        'limit[individualTesters]': 50,
        'limit[betaBuildLocalizations]': 50,
        'limit[icons]': 10,
        'fields[betaTesters]': 'email,firstName,lastName,state',
        'fields[betaGroups]': 'name,isInternalGroup,publicLinkEnabled',
        'fields[apps]': 'name,bundleId',
      });
      const b = doc.data as JsonApiResource;
      const inc = indexIncluded(doc.included);
      const get = (type: string, rid?: string) => (rid ? inc.get(`${type}/${rid}`) : undefined);
      const strip = (x: any) => {
        if (!x) return x;
        const { type: _t, relationships: _r, ...rest } = x;
        return rest;
      };
      const upload = get('buildUploads', relId(b, 'buildUpload'));
      const review = get('betaAppReviewSubmissions', relId(b, 'betaAppReviewSubmission'));
      const asv = get('appStoreVersions', relId(b, 'appStoreVersion'));
      return defined({
        ...summarizeBuild(b, inc),
        app: strip(get('apps', relId(b, 'app'))),
        iconUrl: iconUrl(b.attributes?.iconAssetToken),
        betaReviewSubmission: review ? { id: review.id, betaReviewState: review.betaReviewState, submittedDate: review.submittedDate } : null,
        encryptionDeclaration: strip(get('appEncryptionDeclarations', relId(b, 'appEncryptionDeclaration'))) ?? null,
        betaGroups: relIds(b, 'betaGroups').map(g => strip(get('betaGroups', g)) ?? { id: g }),
        individualTesters: relIds(b, 'individualTesters').map(t => strip(get('betaTesters', t)) ?? { id: t }),
        whatToTest: relIds(b, 'betaBuildLocalizations').map(l => {
          const x = get('betaBuildLocalizations', l);
          return { id: l, locale: x?.locale, whatsNew: x?.whatsNew };
        }),
        appStoreVersion: asv ? { id: asv.id, versionString: asv.versionString, state: asv.appVersionState ?? asv.appStoreState } : null,
        icons: relIds(b, 'icons').map(i => {
          const x = get('buildIcons', i);
          return { iconType: x?.iconType, name: x?.name, url: iconUrl(x?.iconAsset) };
        }),
        upload: upload ? { id: upload.id, state: upload.state?.state, uploadedDate: upload.uploadedDate, errors: upload.state?.errors?.length ? upload.state.errors : undefined } : undefined,
      });
    },
  },
  {
    name: 'upload_build',
    description:
      'Upload an .ipa (iOS/tvOS/visionOS) or .pkg (macOS) to App Store Connect via the Build Uploads API (no Xcode/Transporter needed): reserve buildUpload + file, PUT all parts, commit with MD5, then poll until Apple accepts or rejects it. For .ipa files the version, build number, bundle id and platform are read from Payload/*.app/Info.plist (binary or XML); for .pkg pass version, build_number and platform MAC_OS. The bundle id must match the app, and the build number must be new for that version. After COMPLETE the build still needs processing (5-30 min) before it shows as VALID in list_builds. The .ipa must be signed for App Store distribution. Large files are read fully into memory.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        file_path: { ...S.filePath, description: 'Path to the .ipa or .pkg' },
        version: { type: 'string', description: 'CFBundleShortVersionString override (required for .pkg)' },
        build_number: { type: 'string', description: 'CFBundleVersion override (required for .pkg)' },
        platform: S.platform,
        wait_seconds: { type: 'number', description: 'How long to wait for Apple to accept/reject the upload (default 120, 0 = do not wait). Use get_build_upload to check later.' },
      },
      required: ['app', 'file_path'],
    },
    annotations: { title: 'Upload build' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const { bytes, fileName, fullPath } = readLocalFile(args.file_path);
      const ext = path.extname(fileName).toLowerCase();
      if (ext !== '.ipa' && ext !== '.pkg') throw new Error('file_path must be an .ipa or .pkg');
      const info = ext === '.ipa' ? readIpaInfo(bytes) : {};
      const version = args.version ?? info.version;
      const buildNumber = args.build_number ?? info.buildNumber;
      const platform: Platform = args.platform ?? info.platform ?? (ext === '.pkg' ? 'MAC_OS' : 'IOS');
      if (!version || !buildNumber) throw new Error('Could not determine version/build number; pass version and build_number.');
      if (info.bundleId && info.bundleId !== app.bundleId) {
        throw new Error(`The .ipa bundle id ${info.bundleId} does not match app ${app.name} (${app.bundleId}).`);
      }
      // Fail early on duplicate build numbers.
      const dup = await ctx.client.get(`/v1/apps/${app.id}/buildUploads`, {
        'filter[cfBundleShortVersionString]': version,
        'filter[cfBundleVersion]': buildNumber,
        'filter[platform]': platform,
        limit: 5,
      });
      const dupes = compactList(dup).filter(u => u.state?.state !== 'FAILED');
      if (dupes.length) throw new Error(`Build ${version} (${buildNumber}) for ${platform} was already uploaded (buildUpload ${dupes[0].id}, state ${dupes[0].state?.state}). Increase CFBundleVersion and rebuild.`);

      const upload = await ctx.client.post('/v1/buildUploads', {
        data: {
          type: 'buildUploads',
          attributes: { cfBundleShortVersionString: version, cfBundleVersion: buildNumber, platform },
          relationships: { app: rel('apps', app.id) },
        },
      });
      const uploadId = (upload.data as JsonApiResource).id;
      const fileRes = await ctx.client.post('/v1/buildUploadFiles', {
        data: {
          type: 'buildUploadFiles',
          attributes: { assetType: 'ASSET', fileName, fileSize: bytes.length, uti: ext === '.ipa' ? 'com.apple.ipa' : 'com.apple.pkg' },
          relationships: { buildUpload: rel('buildUploads', uploadId) },
        },
      });
      const file = fileRes.data as JsonApiResource;
      const ops: UploadOperation[] = file.attributes?.uploadOperations ?? [];
      if (!ctx.dryRun && !ops.length) throw new Error(`Apple returned no upload operations for buildUploadFile ${file.id}`);
      await ctx.client.runUploadOperations(ops, bytes);
      await ctx.client.patch(`/v1/buildUploadFiles/${file.id}`, {
        data: {
          type: 'buildUploadFiles',
          id: file.id,
          attributes: { uploaded: true, sourceFileChecksums: { file: { hash: md5Hex(bytes).toUpperCase(), algorithm: 'MD5' } } },
        },
      });
      const summary: any = { buildUploadId: uploadId, file: fullPath, size: bytes.length, parts: ops.length, version, buildNumber, platform, bundleId: info.bundleId };
      if (info.usesNonExemptEncryption === undefined && ext === '.ipa') {
        summary.exportComplianceNote = 'Info.plist has no ITSAppUsesNonExemptEncryption key; after processing, call set_export_compliance or the build will be stuck at MISSING_EXPORT_COMPLIANCE.';
      }
      const waitMs = (args.wait_seconds ?? 120) * 1000;
      if (ctx.dryRun || isFake(uploadId) || waitMs <= 0) return { ...summary, state: ctx.dryRun ? 'DRY_RUN' : 'AWAITING_PROCESSING' };
      const start = Date.now();
      let last: any;
      while (Date.now() - start < waitMs) {
        const doc = await ctx.client.get(`/v1/buildUploads/${uploadId}`, { include: 'build' });
        last = compact(doc.data as JsonApiResource);
        const st = last.state?.state;
        if (st === 'FAILED') {
          const errs = (last.state?.errors ?? []).map((e: any) => `${e.code}: ${e.description}`).join('; ');
          throw new Error(`Apple rejected build upload ${uploadId}: ${errs || 'unknown error'}`);
        }
        if (st === 'COMPLETE') break;
        await sleep(5000);
      }
      return defined({
        ...summary,
        state: last?.state?.state,
        warnings: last?.state?.warnings?.length ? last.state.warnings : undefined,
        infos: last?.state?.infos?.length ? last.state.infos : undefined,
        buildId: last?.relationships?.build,
        next: last?.state?.state === 'COMPLETE' ? 'Uploaded. Wait for processing (list_builds processing_state VALID), then set_export_compliance / add_build_to_beta_groups.' : `Still ${last?.state?.state}; check with get_build_upload.`,
      });
    },
  },
  {
    name: 'get_build_upload',
    description: 'Status of build uploads (from upload_build, Xcode, Transporter or CI): state AWAITING_UPLOAD/PROCESSING/COMPLETE/FAILED with Apple\'s errors and warnings, and the resulting build id. Pass upload_id for one, or app to list recent uploads.',
    inputSchema: { type: 'object', properties: { upload_id: { type: 'string' }, app: S.app, limit: S.limit } },
    annotations: { title: 'Get build upload status', readOnlyHint: true },
    async handler(args, ctx) {
      const shape = (u: any) =>
        defined({
          id: u.id,
          version: u.cfBundleShortVersionString,
          buildNumber: u.cfBundleVersion,
          platform: u.platform,
          state: u.state?.state,
          errors: u.state?.errors?.length ? u.state.errors : undefined,
          warnings: u.state?.warnings?.length ? u.state.warnings : undefined,
          createdDate: u.createdDate,
          uploadedDate: u.uploadedDate,
          buildId: u.relationships?.build,
        });
      if (args.upload_id) {
        if (isFake(args.upload_id)) return { id: args.upload_id, state: 'DRY_RUN' };
        const doc = await ctx.client.get(`/v1/buildUploads/${args.upload_id}`, { include: 'build' });
        return shape(compact(doc.data as JsonApiResource));
      }
      if (!args.app) throw new Error('Pass upload_id or app');
      const app = await resolveApp(ctx, args.app);
      const doc = await ctx.client.get(`/v1/apps/${app.id}/buildUploads`, { sort: '-uploadedDate', limit: args.limit ?? 10, include: 'build' });
      return compactList(doc).map(shape);
    },
  },
  {
    name: 'expire_build',
    description: 'Expire one or more builds so testers can no longer install them in TestFlight. Irreversible. (Builds also expire automatically 90 days after upload.)',
    inputSchema: { type: 'object', properties: { builds: buildsArg, app: S.app, version: marketingVersion, confirm: S.confirm }, required: ['builds'] },
    annotations: { title: 'Expire builds', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Expiring builds');
      const ids = await resolveBuildIds(ctx, args.builds, args.app, args.version);
      const out = [];
      for (const id of ids) {
        const doc = await ctx.client.patch(`/v1/builds/${id}`, { data: { type: 'builds', id, attributes: { expired: true } } });
        out.push({ id, expired: (doc.data as JsonApiResource)?.attributes?.expired ?? true });
      }
      return { expired: out };
    },
  },
  {
    name: 'set_export_compliance',
    description:
      'Answer export compliance for builds stuck at MISSING_EXPORT_COMPLIANCE: set usesNonExemptEncryption (false = only exempt encryption such as HTTPS/standard OS crypto) and/or attach an approved encryption declaration (if the app uses non-exempt encryption). Fails if the build\'s Info.plist already sets ITSAppUsesNonExemptEncryption - set that key in Info.plist to skip this step for future builds.',
    inputSchema: {
      type: 'object',
      properties: {
        builds: buildsArg,
        app: S.app,
        version: marketingVersion,
        uses_non_exempt_encryption: { type: 'boolean' },
        encryption_declaration_id: { type: 'string', description: 'appEncryptionDeclaration id (see list_encryption_declarations)' },
      },
      required: ['builds'],
    },
    annotations: { title: 'Set export compliance', idempotentHint: true },
    async handler(args, ctx) {
      if (args.uses_non_exempt_encryption === undefined && !args.encryption_declaration_id) throw new Error('Pass uses_non_exempt_encryption and/or encryption_declaration_id');
      const ids = await resolveBuildIds(ctx, args.builds, args.app, args.version);
      const out = [];
      for (const id of ids) {
        const body: any = { data: { type: 'builds', id } };
        if (args.uses_non_exempt_encryption !== undefined) body.data.attributes = { usesNonExemptEncryption: args.uses_non_exempt_encryption };
        if (args.encryption_declaration_id) body.data.relationships = { appEncryptionDeclaration: rel('appEncryptionDeclarations', args.encryption_declaration_id) };
        const doc = await ctx.client.patch(`/v1/builds/${id}`, body);
        out.push({ id, usesNonExemptEncryption: (doc.data as JsonApiResource)?.attributes?.usesNonExemptEncryption ?? args.uses_non_exempt_encryption, encryptionDeclaration: args.encryption_declaration_id });
      }
      return { updated: out };
    },
  },
  {
    name: 'list_encryption_declarations',
    description: 'List an app\'s export compliance (encryption) declarations with state (CREATED/IN_REVIEW/APPROVED/REJECTED...), exempt flag and compliance code.',
    inputSchema: { type: 'object', properties: { app: S.app, build: buildArg }, required: ['app'] },
    annotations: { title: 'List encryption declarations', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const q: any = { 'filter[app]': app.id, limit: 50, include: 'appEncryptionDeclarationDocument' };
      if (args.build) q['filter[builds]'] = await resolveBuildId(ctx, args.build, app.id);
      const doc = await ctx.client.get('/v1/appEncryptionDeclarations', q);
      const inc = indexIncluded(doc.included);
      return ((doc.data as JsonApiResource[]) ?? []).map(d => {
        const a = d.attributes ?? {};
        const docu = inc.get(`appEncryptionDeclarationDocuments/${relId(d, 'appEncryptionDeclarationDocument')}`);
        return defined({
          id: d.id,
          state: a.appEncryptionDeclarationState,
          exempt: a.exempt,
          codeValue: a.codeValue,
          appDescription: a.appDescription,
          containsProprietaryCryptography: a.containsProprietaryCryptography,
          containsThirdPartyCryptography: a.containsThirdPartyCryptography,
          availableOnFrenchStore: a.availableOnFrenchStore,
          createdDate: a.createdDate,
          document: docu ? { fileName: docu.fileName, state: docu.assetDeliveryState?.state, downloadUrl: docu.downloadUrl } : undefined,
        });
      });
    },
  },
  {
    name: 'create_encryption_declaration',
    description:
      'Create an export compliance (encryption) declaration for an app that uses non-exempt encryption, optionally upload its compliance document (e.g. French encryption declaration or CCATS, PDF) and attach it to builds. Apple reviews it; builds can use it once APPROVED. Apps using only exempt encryption should just call set_export_compliance with uses_non_exempt_encryption=false.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        app_description: { type: 'string', description: 'How the app uses encryption' },
        contains_proprietary_cryptography: { type: 'boolean' },
        contains_third_party_cryptography: { type: 'boolean' },
        available_on_french_store: { type: 'boolean' },
        document_path: { ...S.filePath, description: 'Optional compliance document to upload' },
        builds: buildsArg,
      },
      required: ['app', 'app_description', 'contains_proprietary_cryptography', 'contains_third_party_cryptography', 'available_on_french_store'],
    },
    annotations: { title: 'Create encryption declaration' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const doc = await ctx.client.post('/v1/appEncryptionDeclarations', {
        data: {
          type: 'appEncryptionDeclarations',
          attributes: {
            appDescription: args.app_description,
            containsProprietaryCryptography: args.contains_proprietary_cryptography,
            containsThirdPartyCryptography: args.contains_third_party_cryptography,
            availableOnFrenchStore: args.available_on_french_store,
          },
          relationships: { app: rel('apps', app.id) },
        },
      });
      const decl = compact(doc.data as JsonApiResource);
      const result: any = { declaration: decl };
      if (args.document_path) {
        result.document = await uploadAsset(ctx, {
          type: 'appEncryptionDeclarationDocuments',
          parentRelationship: 'appEncryptionDeclaration',
          parentType: 'appEncryptionDeclarations',
          parentId: decl.id,
          filePath: args.document_path,
        });
      }
      if (args.builds?.length) {
        const ids = await resolveBuildIds(ctx, args.builds, app.id);
        for (const id of ids) await ctx.client.patch(`/v1/builds/${id}/relationships/appEncryptionDeclaration`, { data: { type: 'appEncryptionDeclarations', id: decl.id } });
        result.attachedToBuilds = ids;
      }
      return result;
    },
  },

  // ------------------------------------------------------------ beta groups
  {
    name: 'list_beta_groups',
    description: 'List an app\'s TestFlight beta groups (internal and external) with settings, public link, and tester/build counts.',
    inputSchema: { type: 'object', properties: { app: S.app, counts: { type: 'boolean', description: 'Include tester and build counts (default true; 2 extra calls per group)' } }, required: ['app'] },
    annotations: { title: 'List beta groups', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const doc = await ctx.client.getAll('/v1/betaGroups', { 'filter[app]': app.id, sort: 'name' }, 500);
      const groups = doc.data.map(compact).map(({ type: _t, relationships: _r, ...g }) => g);
      if (args.counts !== false) {
        await Promise.all(
          groups.map(async g => {
            const [t, b] = await Promise.all([
              ctx.client.get(`/v1/betaGroups/${g.id}/betaTesters`, { limit: 1, 'fields[betaTesters]': 'email' }),
              ctx.client.get(`/v1/betaGroups/${g.id}/builds`, { limit: 1, 'fields[builds]': 'version' }),
            ]);
            g.testerCount = t.meta?.paging?.total;
            g.buildCount = b.meta?.paging?.total;
          }),
        );
      }
      return { app: { id: app.id, name: app.name }, groups };
    },
  },
  {
    name: 'create_beta_group',
    description:
      'Create a TestFlight beta group. Internal groups (is_internal: true) only accept App Store Connect users of your team, need no beta review, and can get every build automatically (has_access_to_all_builds). External groups accept anyone by email or public link, but the first build of each version must pass beta app review (submit_for_beta_review). Public links work only for external groups. Optionally add builds and existing testers at creation.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        name: { type: 'string' },
        is_internal: { type: 'boolean', description: 'Internal group (default false = external)' },
        has_access_to_all_builds: { type: 'boolean', description: 'Internal groups only: automatically get all builds' },
        public_link_enabled: { type: 'boolean', description: 'External groups only' },
        public_link_limit: { type: 'number', description: 'Max testers joining via public link (1-10000); enables the limit' },
        feedback_enabled: { type: 'boolean', description: 'Allow testers to send screenshot/crash feedback' },
        builds: buildsArg,
        testers: testersArg,
      },
      required: ['app', 'name'],
    },
    annotations: { title: 'Create beta group' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      if (args.is_internal && args.public_link_enabled) throw new Error('Public links are only available for external groups');
      const relationships: any = { app: rel('apps', app.id) };
      if (args.builds?.length) relationships.builds = rels('builds', await resolveBuildIds(ctx, args.builds, app.id));
      if (args.testers?.length) relationships.betaTesters = rels('betaTesters', await resolveTesterIds(ctx, args.testers));
      const doc = await ctx.client.post('/v1/betaGroups', {
        data: {
          type: 'betaGroups',
          attributes: defined({
            name: args.name,
            isInternalGroup: args.is_internal,
            hasAccessToAllBuilds: args.has_access_to_all_builds,
            publicLinkEnabled: args.public_link_enabled,
            publicLinkLimitEnabled: args.public_link_limit !== undefined ? true : undefined,
            publicLinkLimit: args.public_link_limit,
            feedbackEnabled: args.feedback_enabled,
          }),
          relationships,
        },
      });
      return compact(doc.data as JsonApiResource);
    },
  },
  {
    name: 'update_beta_group',
    description: 'Update a beta group: rename, toggle/limit the public link (external groups), feedback, and whether iOS builds are offered on Apple silicon Macs / Apple Vision Pro. Internal/external type and has_access_to_all_builds cannot be changed after creation.',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: 'Group id or name (name needs app)' },
        app: S.app,
        name: { type: 'string', description: 'New name' },
        public_link_enabled: { type: 'boolean' },
        public_link_limit_enabled: { type: 'boolean' },
        public_link_limit: { type: 'number' },
        feedback_enabled: { type: 'boolean' },
        ios_builds_available_for_apple_silicon_mac: { type: 'boolean' },
        ios_builds_available_for_apple_vision: { type: 'boolean' },
      },
      required: ['group'],
    },
    annotations: { title: 'Update beta group', idempotentHint: true },
    async handler(args, ctx) {
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const [g] = await resolveGroups(ctx, args.group, appId);
      const attributes = defined({
        name: args.name,
        publicLinkEnabled: args.public_link_enabled,
        publicLinkLimitEnabled: args.public_link_limit_enabled ?? (args.public_link_limit !== undefined ? true : undefined),
        publicLinkLimit: args.public_link_limit,
        feedbackEnabled: args.feedback_enabled,
        iosBuildsAvailableForAppleSiliconMac: args.ios_builds_available_for_apple_silicon_mac,
        iosBuildsAvailableForAppleVision: args.ios_builds_available_for_apple_vision,
      });
      if (!Object.keys(attributes).length) throw new Error('Nothing to update');
      const doc = await ctx.client.patch(`/v1/betaGroups/${g.id}`, { data: { type: 'betaGroups', id: g.id, attributes } });
      return compact(doc.data as JsonApiResource);
    },
  },
  {
    name: 'delete_beta_group',
    description: 'Delete a beta group. Its testers lose access to builds they only had through this group. Irreversible.',
    inputSchema: { type: 'object', properties: { group: { type: 'string', description: 'Group id or name (name needs app)' }, app: S.app, confirm: S.confirm }, required: ['group'] },
    annotations: { title: 'Delete beta group', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a beta group');
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const [g] = await resolveGroups(ctx, args.group, appId);
      await ctx.client.delete(`/v1/betaGroups/${g.id}`);
      return { deleted: g };
    },
  },

  // ---------------------------------------------------------------- testers
  {
    name: 'list_beta_testers',
    description: 'List TestFlight testers of an app or of one beta group, with invite state (INVITED/ACCEPTED/INSTALLED...), invite type (email/public link), their groups and devices. Filter by email.',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, group: { type: 'string', description: 'Group id or name (name needs app)' }, email: { type: 'string', description: 'Exact email filter' }, limit: S.limit },
    },
    annotations: { title: 'List beta testers', readOnlyHint: true },
    async handler(args, ctx) {
      if (!args.app && !args.group && !args.email) throw new Error('Pass app, group or email');
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const groupId = args.group ? (await resolveGroups(ctx, args.group, appId))[0].id : undefined;
      if (isFake(groupId)) return { testers: [] };
      const doc = await ctx.client.getAll(
        '/v1/betaTesters',
        defined({
          'filter[apps]': groupId ? undefined : appId,
          'filter[betaGroups]': groupId,
          'filter[email]': args.email,
          include: 'betaGroups',
          'limit[betaGroups]': 50,
          'fields[betaGroups]': 'name,app',
          sort: 'email',
        }) as any,
        args.limit ?? 100,
      );
      const inc = indexIncluded(doc.included);
      const testers = doc.data.map(t => {
        const a = t.attributes ?? {};
        const groups = relIds(t, 'betaGroups')
          .map(id => inc.get(`betaGroups/${id}`))
          .filter(g => g && (!appId || g.relationships?.app === undefined || g.relationships.app === appId))
          .map(g => g.name);
        return defined({ id: t.id, email: a.email, firstName: a.firstName, lastName: a.lastName, state: a.state, inviteType: a.inviteType, groups, devices: a.appDevices?.length ? a.appDevices : undefined });
      });
      return { total: doc.total, testers, truncated: doc.truncated || undefined };
    },
  },
  {
    name: 'add_beta_testers',
    description:
      'Add testers by email to one or more beta groups in one call. Existing testers (matched by email) are linked to the groups; new ones are created in the groups, which sends them a TestFlight invitation email once the group has a testable build. Internal groups only accept App Store Connect users of your team (invite them with the users tools first). Optionally also give them individual access to specific builds.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        groups: groupsArg,
        testers: {
          type: 'array',
          items: { type: 'object', properties: { email: { type: 'string' }, first_name: { type: 'string' }, last_name: { type: 'string' } }, required: ['email'] },
        },
        builds: { ...buildsArg, description: 'Optional builds to assign to these testers individually' },
      },
      required: ['testers'],
    },
    annotations: { title: 'Add beta testers' },
    async handler(args, ctx) {
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const groups = args.groups?.length ? await resolveGroups(ctx, args.groups, appId) : [];
      const buildIds = args.builds?.length ? await resolveBuildIds(ctx, args.builds, appId) : [];
      if (!groups.length && !buildIds.length) throw new Error('Pass groups and/or builds to add the testers to');
      const testers: any[] = args.testers ?? [];
      const existing = await findTestersByEmail(ctx, testers.map(t => t.email));
      const created: any[] = [];
      const linked: any[] = [];
      const failed: any[] = [];
      for (const t of testers) {
        const e = existing.get(String(t.email).trim().toLowerCase());
        if (e) {
          linked.push({ id: e.id, email: e.email });
          continue;
        }
        try {
          const doc = await ctx.client.post('/v1/betaTesters', {
            data: {
              type: 'betaTesters',
              attributes: defined({ email: String(t.email).trim(), firstName: t.first_name, lastName: t.last_name }),
              relationships: defined({
                betaGroups: groups.length ? rels('betaGroups', groups.map(g => g.id)) : undefined,
                builds: buildIds.length ? rels('builds', buildIds) : undefined,
              }),
            },
          });
          created.push({ id: (doc.data as JsonApiResource).id, email: t.email });
        } catch (err: any) {
          failed.push({ email: t.email, error: err.message });
        }
      }
      const ids = linked.map(l => l.id);
      for (const part of chunk(ids, 50)) {
        for (const g of groups) await ctx.client.post(`/v1/betaGroups/${g.id}/relationships/betaTesters`, rels('betaTesters', part));
        for (const b of buildIds) await ctx.client.post(`/v1/builds/${b}/relationships/individualTesters`, rels('betaTesters', part));
      }
      return defined({ groups: groups.map(g => g.name ?? g.id), builds: buildIds.length ? buildIds : undefined, created, addedExisting: linked, failed: failed.length ? failed : undefined });
    },
  },
  {
    name: 'remove_beta_testers',
    description:
      'Remove testers (ids or emails) from specific beta groups, from an app entirely (all its groups and builds), or delete them from your team\'s TestFlight altogether (delete_tester: true). They lose access to the builds immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        testers: testersArg,
        app: S.app,
        groups: { ...groupsArg, description: 'Remove only from these groups. Omit to remove from the whole app.' },
        delete_tester: { type: 'boolean', description: 'Delete the tester records completely (all apps)' },
        confirm: S.confirm,
      },
      required: ['testers'],
    },
    annotations: { title: 'Remove beta testers', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Removing beta testers');
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const ids = await resolveTesterIds(ctx, args.testers, args.delete_tester ? undefined : appId);
      if (args.delete_tester) {
        for (const id of ids) await ctx.client.delete(`/v1/betaTesters/${id}`);
        return { deletedTesters: ids };
      }
      if (args.groups?.length) {
        const groups = await resolveGroups(ctx, args.groups, appId);
        for (const g of groups) for (const part of chunk(ids, 50)) await ctx.client.delete(`/v1/betaGroups/${g.id}/relationships/betaTesters`, rels('betaTesters', part));
        return { removedFromGroups: groups.map(g => g.name ?? g.id), testers: ids };
      }
      if (!appId) throw new Error('Pass groups, app, or delete_tester: true');
      for (const part of chunk(ids, 50)) await ctx.client.delete(`/v1/apps/${appId}/relationships/betaTesters`, rels('betaTesters', part));
      return { removedFromApp: appId, testers: ids };
    },
  },
  {
    name: 'send_beta_invitations',
    description: 'Send (or re-send) TestFlight invitation emails to testers of an app. Testers must already be in a group of the app that has a build available to them. Sends real emails.',
    inputSchema: { type: 'object', properties: { app: S.app, testers: testersArg, confirm: S.confirm }, required: ['app', 'testers'] },
    annotations: { title: 'Send beta invitations', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Sending TestFlight invitation emails');
      const app = await resolveApp(ctx, args.app);
      const ids = await resolveTesterIds(ctx, args.testers, app.id);
      const sent: string[] = [];
      const failed: any[] = [];
      for (const id of ids) {
        try {
          await ctx.client.post('/v1/betaTesterInvitations', {
            data: { type: 'betaTesterInvitations', relationships: { betaTester: rel('betaTesters', id), app: rel('apps', app.id) } },
          });
          sent.push(id);
        } catch (err: any) {
          failed.push({ id, error: err.message });
        }
      }
      return defined({ sent, failed: failed.length ? failed : undefined });
    },
  },
  {
    name: 'set_build_testers',
    description: 'Give individual testers access to a specific build (outside of groups), or revoke that individual access (remove: true).',
    inputSchema: {
      type: 'object',
      properties: { build: buildArg, app: S.app, version: marketingVersion, testers: testersArg, remove: { type: 'boolean', description: 'Revoke instead of grant' } },
      required: ['build', 'testers'],
    },
    annotations: { title: 'Assign testers to build' },
    async handler(args, ctx) {
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const buildId = await resolveBuildId(ctx, args.build, appId, args.version);
      const ids = await resolveTesterIds(ctx, args.testers);
      for (const part of chunk(ids, 50)) {
        const body = rels('betaTesters', part);
        if (args.remove) await ctx.client.delete(`/v1/builds/${buildId}/relationships/individualTesters`, body);
        else await ctx.client.post(`/v1/builds/${buildId}/relationships/individualTesters`, body);
      }
      return { build: buildId, [args.remove ? 'removed' : 'added']: ids };
    },
  },

  // ------------------------------------------------------- builds <-> groups
  {
    name: 'add_build_to_beta_groups',
    description:
      'Make a build available to beta groups. Internal groups get it immediately once processed and export compliance is answered. External groups need the build approved by beta app review: the first build of each version must be submitted (submit_for_beta_review); later builds of the same version are usually auto-approved. Testers are notified if the build\'s auto-notify is on (default).',
    inputSchema: { type: 'object', properties: { build: buildArg, app: S.app, version: marketingVersion, groups: groupsArg }, required: ['build', 'groups'] },
    annotations: { title: 'Add build to beta groups', idempotentHint: true },
    async handler(args, ctx) {
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const buildId = await resolveBuildId(ctx, args.build, appId, args.version);
      const groups = await resolveGroups(ctx, args.groups, appId ?? (await appIdOfBuild(ctx, buildId)));
      await ctx.client.post(`/v1/builds/${buildId}/relationships/betaGroups`, rels('betaGroups', groups.map(g => g.id)));
      return { build: buildId, addedTo: groups.map(g => g.name ?? g.id) };
    },
  },
  {
    name: 'remove_build_from_beta_groups',
    description: 'Remove a build from beta groups; those groups\' testers can no longer install it (unless they have it via another group).',
    inputSchema: { type: 'object', properties: { build: buildArg, app: S.app, version: marketingVersion, groups: groupsArg }, required: ['build', 'groups'] },
    annotations: { title: 'Remove build from beta groups', destructiveHint: true },
    async handler(args, ctx) {
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const buildId = await resolveBuildId(ctx, args.build, appId, args.version);
      const groups = await resolveGroups(ctx, args.groups, appId ?? (await appIdOfBuild(ctx, buildId)));
      await ctx.client.delete(`/v1/builds/${buildId}/relationships/betaGroups`, rels('betaGroups', groups.map(g => g.id)));
      return { build: buildId, removedFrom: groups.map(g => g.name ?? g.id) };
    },
  },

  // ------------------------------------------------------- beta app info
  {
    name: 'get_beta_app_info',
    description: 'Show the app\'s TestFlight test information: beta app description/feedback email/marketing & privacy URLs per locale, beta app review contact + demo account + notes, and the beta license agreement.',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'Get beta app info', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const [locs, review, license] = await Promise.all([
        ctx.client.get(`/v1/apps/${app.id}/betaAppLocalizations`, { limit: 200 }),
        ctx.client.get(`/v1/apps/${app.id}/betaAppReviewDetail`),
        ctx.client.get(`/v1/apps/${app.id}/betaLicenseAgreement`),
      ]);
      const strip = ({ type: _t, relationships: _r, ...x }: any) => x;
      return {
        app: { id: app.id, name: app.name },
        localizations: compactList(locs).map(strip),
        reviewDetail: review.data ? strip(compact(review.data as JsonApiResource)) : null,
        licenseAgreement: license.data ? strip(compact(license.data as JsonApiResource)) : null,
      };
    },
  },
  {
    name: 'set_beta_app_info',
    description:
      'Set TestFlight test information in one call (upsert): per-locale beta description, feedback email, marketing URL, privacy policy URL, tvOS privacy policy; beta app review contact info, demo account (sign-in required) and notes; and the beta license agreement text. External testing needs a description, feedback email and review contact before the first beta review submission.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        localizations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              locale: S.locale,
              description: { type: 'string', description: 'Beta App Description shown to testers' },
              feedback_email: { type: 'string' },
              marketing_url: { type: 'string' },
              privacy_policy_url: { type: 'string' },
              tv_os_privacy_policy: { type: 'string' },
            },
            required: ['locale'],
          },
        },
        review_details: {
          type: 'object',
          properties: {
            contact_first_name: { type: 'string' },
            contact_last_name: { type: 'string' },
            contact_phone: { type: 'string' },
            contact_email: { type: 'string' },
            demo_account_required: { type: 'boolean' },
            demo_account_name: { type: 'string' },
            demo_account_password: { type: 'string' },
            notes: { type: 'string' },
          },
        },
        license_agreement: { type: 'string', description: 'Beta license agreement text (empty string = Apple standard)' },
      },
      required: ['app'],
    },
    annotations: { title: 'Set beta app info', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const result: any = {};
      if (args.localizations?.length) {
        const existing = compactList(await ctx.client.get(`/v1/apps/${app.id}/betaAppLocalizations`, { limit: 200 }));
        result.localizations = [];
        for (const l of args.localizations) {
          const attrs = defined({
            description: l.description,
            feedbackEmail: l.feedback_email,
            marketingUrl: l.marketing_url,
            privacyPolicyUrl: l.privacy_policy_url,
            tvOsPrivacyPolicy: l.tv_os_privacy_policy,
          });
          const hit = existing.find(e => e.locale === l.locale);
          if (hit) {
            await ctx.client.patch(`/v1/betaAppLocalizations/${hit.id}`, { data: { type: 'betaAppLocalizations', id: hit.id, attributes: attrs } });
            result.localizations.push({ locale: l.locale, action: 'updated', id: hit.id });
          } else {
            const doc = await ctx.client.post('/v1/betaAppLocalizations', {
              data: { type: 'betaAppLocalizations', attributes: { locale: l.locale, ...attrs }, relationships: { app: rel('apps', app.id) } },
            });
            result.localizations.push({ locale: l.locale, action: 'created', id: (doc.data as JsonApiResource).id });
          }
        }
      }
      if (args.review_details) {
        const r = args.review_details;
        const detail = await ctx.client.get(`/v1/apps/${app.id}/betaAppReviewDetail`, { 'fields[betaAppReviewDetails]': 'notes' });
        const id = (detail.data as JsonApiResource).id;
        const attributes = defined({
          contactFirstName: r.contact_first_name,
          contactLastName: r.contact_last_name,
          contactPhone: r.contact_phone,
          contactEmail: r.contact_email,
          demoAccountRequired: r.demo_account_required,
          demoAccountName: r.demo_account_name,
          demoAccountPassword: r.demo_account_password,
          notes: r.notes,
        });
        const doc = await ctx.client.patch(`/v1/betaAppReviewDetails/${id}`, { data: { type: 'betaAppReviewDetails', id, attributes } });
        const { demoAccountPassword: _p, ...shown } = compact(doc.data as JsonApiResource);
        result.reviewDetails = shown;
      }
      if (args.license_agreement !== undefined) {
        const lic = await ctx.client.get(`/v1/apps/${app.id}/betaLicenseAgreement`, { 'fields[betaLicenseAgreements]': 'agreementText' });
        const id = (lic.data as JsonApiResource).id;
        await ctx.client.patch(`/v1/betaLicenseAgreements/${id}`, { data: { type: 'betaLicenseAgreements', id, attributes: { agreementText: args.license_agreement } } });
        result.licenseAgreement = 'updated';
      }
      if (!Object.keys(result).length) throw new Error('Nothing to set: pass localizations, review_details or license_agreement');
      return result;
    },
  },
  {
    name: 'set_what_to_test',
    description:
      'Set a build\'s "What to Test" notes shown to testers (upsert per locale). Pass what_to_test for one text applied to `locales` (default: the build\'s existing locales, or the app\'s primary locale), and/or by_locale for per-locale texts. Optionally toggle auto_notify (whether testers get notified automatically when the build becomes available). Max 4000 chars.',
    inputSchema: {
      type: 'object',
      properties: {
        build: buildArg,
        app: S.app,
        version: marketingVersion,
        what_to_test: { type: 'string' },
        locales: { type: 'array', items: { type: 'string' } },
        by_locale: { type: 'object', additionalProperties: { type: 'string' }, description: '{ "en-US": "...", "de-DE": "..." }' },
        auto_notify: { type: 'boolean' },
      },
      required: ['build'],
    },
    annotations: { title: 'Set What to Test', idempotentHint: true },
    async handler(args, ctx) {
      const appRes = args.app ? await resolveApp(ctx, args.app) : undefined;
      const buildId = await resolveBuildId(ctx, args.build, appRes?.id, args.version);
      const existing = isFake(buildId) ? [] : compactList(await ctx.client.get(`/v1/builds/${buildId}/betaBuildLocalizations`, { limit: 200 }));
      const texts: Record<string, string> = { ...(args.by_locale ?? {}) };
      if (args.what_to_test !== undefined) {
        let locales: string[] = args.locales ?? existing.map(e => e.locale);
        if (!locales.length) {
          const primary = appRes?.primaryLocale ?? (isFake(buildId) ? undefined : (await ctx.client.get(`/v1/builds/${buildId}/app`, { 'fields[apps]': 'primaryLocale' })).data as JsonApiResource)?.attributes?.primaryLocale;
          locales = [primary ?? 'en-US'];
        }
        for (const l of locales) if (texts[l] === undefined) texts[l] = args.what_to_test;
      }
      const result: any = { build: buildId, localizations: [] };
      for (const [locale, whatsNew] of Object.entries(texts)) {
        const hit = existing.find(e => e.locale === locale);
        if (hit) {
          await ctx.client.patch(`/v1/betaBuildLocalizations/${hit.id}`, { data: { type: 'betaBuildLocalizations', id: hit.id, attributes: { whatsNew } } });
          result.localizations.push({ locale, action: 'updated' });
        } else {
          await ctx.client.post('/v1/betaBuildLocalizations', {
            data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew }, relationships: { build: rel('builds', buildId) } },
          });
          result.localizations.push({ locale, action: 'created' });
        }
      }
      if (args.auto_notify !== undefined) {
        // buildBetaDetail shares the build's id.
        await ctx.client.patch(`/v1/buildBetaDetails/${buildId}`, { data: { type: 'buildBetaDetails', id: buildId, attributes: { autoNotifyEnabled: args.auto_notify } } });
        result.autoNotifyEnabled = args.auto_notify;
      }
      if (!result.localizations.length && args.auto_notify === undefined) throw new Error('Pass what_to_test, by_locale or auto_notify');
      return result;
    },
  },

  // ------------------------------------------------------- beta review
  {
    name: 'submit_for_beta_review',
    description:
      'Submit a build to TestFlight beta app review so external groups can test it. Required for the first build of each version; the build must be VALID (processed), have export compliance answered, and the app needs beta app info (description, feedback email, review contact - see set_beta_app_info). Review usually takes up to 24-48h; check with get_build (betaReviewSubmission.betaReviewState) or list_builds beta_review_state.',
    inputSchema: { type: 'object', properties: { build: buildArg, app: S.app, version: marketingVersion, confirm: S.confirm }, required: ['build'] },
    annotations: { title: 'Submit for beta review', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Submitting a build for beta app review');
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const buildId = await resolveBuildId(ctx, args.build, appId, args.version);
      if (!isFake(buildId)) {
        const b = await ctx.client.get(`/v1/builds/${buildId}`, { include: 'buildBetaDetail,betaAppReviewSubmission' });
        const inc = indexIncluded(b.included);
        const build = b.data as JsonApiResource;
        const sub = inc.get(`betaAppReviewSubmissions/${relId(build, 'betaAppReviewSubmission')}`);
        if (sub) return { build: buildId, alreadySubmitted: true, betaReviewState: sub.betaReviewState, submittedDate: sub.submittedDate };
        const bbd = inc.get(`buildBetaDetails/${relId(build, 'buildBetaDetail')}`);
        if (build.attributes?.processingState !== 'VALID') throw new Error(`Build is ${build.attributes?.processingState}; wait until processing finishes (VALID).`);
        if (bbd?.externalBuildState === 'MISSING_EXPORT_COMPLIANCE') throw new Error('Build is missing export compliance; call set_export_compliance first.');
      }
      const doc = await ctx.client.post('/v1/betaAppReviewSubmissions', {
        data: { type: 'betaAppReviewSubmissions', relationships: { build: rel('builds', buildId) } },
      });
      return { build: buildId, submission: compact(doc.data as JsonApiResource) };
    },
  },
  {
    name: 'notify_testers',
    description: 'Send the "new build available" notification to the build\'s testers now (useful when auto-notify is off). Sends real emails/push notifications.',
    inputSchema: { type: 'object', properties: { build: buildArg, app: S.app, version: marketingVersion, confirm: S.confirm }, required: ['build'] },
    annotations: { title: 'Notify testers', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Notifying testers about a build');
      const appId = args.app ? (await resolveApp(ctx, args.app)).id : undefined;
      const buildId = await resolveBuildId(ctx, args.build, appId, args.version);
      const doc = await ctx.client.post('/v1/buildBetaNotifications', { data: { type: 'buildBetaNotifications', relationships: { build: rel('builds', buildId) } } });
      return { build: buildId, notification: compact(doc.data as JsonApiResource) };
    },
  },

  // ------------------------------------------------------- feedback
  {
    name: 'list_beta_feedback',
    description:
      'List TestFlight tester feedback for an app: screenshot feedback (comment + screenshot URLs, which expire) and crash feedback (comment + device info; fetch the crash log with get_beta_crash_log). Newest first. Filter by build, platform, device model, OS version or tester.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        kind: { type: 'string', enum: ['screenshots', 'crashes', 'all'], description: 'Default all' },
        build: buildArg,
        version: marketingVersion,
        platform: S.platform,
        device_model: { type: 'string' },
        os_version: { type: 'string' },
        tester: { type: 'string', description: 'Tester id or email' },
        limit: S.limit,
      },
      required: ['app'],
    },
    annotations: { title: 'List beta feedback', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const q: any = defined({
        'filter[build]': args.build ? await resolveBuildId(ctx, args.build, app.id, args.version) : undefined,
        'filter[appPlatform]': args.platform,
        'filter[deviceModel]': args.device_model,
        'filter[osVersion]': args.os_version,
        'filter[tester]': args.tester ? (await resolveTesterIds(ctx, args.tester, app.id))[0] : undefined,
        sort: '-createdDate',
        include: 'build,tester',
        'fields[builds]': 'version',
        'fields[betaTesters]': 'email,firstName,lastName',
      });
      const kind = args.kind ?? 'all';
      const limit = args.limit ?? 50;
      const shape = (r: JsonApiResource, inc: Map<string, any>, crash: boolean) => {
        const a = r.attributes ?? {};
        const tester = inc.get(`betaTesters/${relId(r, 'tester')}`);
        const build = inc.get(`builds/${relId(r, 'build')}`);
        return defined({
          id: r.id,
          kind: crash ? 'crash' : 'screenshot',
          createdDate: a.createdDate,
          comment: a.comment,
          tester: tester?.email ?? a.email,
          buildNumber: build?.version,
          buildId: relId(r, 'build'),
          device: [a.deviceModel, a.osVersion].filter(Boolean).join(' / ') || undefined,
          deviceFamily: a.deviceFamily,
          appPlatform: a.appPlatform,
          locale: a.locale,
          connectionType: a.connectionType,
          batteryPercentage: a.batteryPercentage,
          appUptimeSeconds: a.appUptimeInMilliseconds ? Math.round(a.appUptimeInMilliseconds / 1000) : undefined,
          screenshots: crash ? undefined : (a.screenshots ?? []).map((s: any) => ({ url: s.url, width: s.width, height: s.height, expires: s.expirationDate })),
        });
      };
      const out: any = { app: { id: app.id, name: app.name } };
      const fetchKind = async (p: string, crash: boolean) => {
        const doc = await ctx.client.getAll(`/v1/apps/${app.id}/${p}`, q, limit);
        const inc = indexIncluded(doc.included);
        return { total: doc.total, items: doc.data.map(r => shape(r, inc, crash)) };
      };
      if (kind !== 'crashes') out.screenshots = await fetchKind('betaFeedbackScreenshotSubmissions', false);
      if (kind !== 'screenshots') out.crashes = await fetchKind('betaFeedbackCrashSubmissions', true);
      return out;
    },
  },
  {
    name: 'get_beta_crash_log',
    description: 'Download the crash log of a TestFlight crash feedback submission (id from list_beta_feedback). Saves the full log to a file and returns the path plus the first lines.',
    inputSchema: { type: 'object', properties: { submission_id: { type: 'string' }, preview_lines: { type: 'number', description: 'Lines to include inline (default 60)' } }, required: ['submission_id'] },
    annotations: { title: 'Get beta crash log', readOnlyHint: true },
    async handler(args, ctx) {
      const doc = await ctx.client.get(`/v1/betaFeedbackCrashSubmissions/${args.submission_id}/crashLog`);
      const text: string = (doc.data as JsonApiResource)?.attributes?.logText ?? '';
      if (!text) return { submission_id: args.submission_id, note: 'No crash log text available (it may still be symbolicating).' };
      const file = saveOutput(ctx, `crash-${args.submission_id}.crash`, text);
      const lines = text.split('\n');
      return { file, lines: lines.length, preview: lines.slice(0, args.preview_lines ?? 60).join('\n') };
    },
  },
  {
    name: 'delete_beta_feedback',
    description: 'Delete TestFlight feedback submissions (screenshot or crash) by id. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        screenshot_ids: { type: 'array', items: { type: 'string' } },
        crash_ids: { type: 'array', items: { type: 'string' } },
        confirm: S.confirm,
      },
    },
    annotations: { title: 'Delete beta feedback', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting tester feedback');
      const deleted: string[] = [];
      for (const id of args.screenshot_ids ?? []) await ctx.client.delete(`/v1/betaFeedbackScreenshotSubmissions/${id}`), deleted.push(id);
      for (const id of args.crash_ids ?? []) await ctx.client.delete(`/v1/betaFeedbackCrashSubmissions/${id}`), deleted.push(id);
      if (!deleted.length) throw new Error('Pass screenshot_ids and/or crash_ids');
      return { deleted };
    },
  },

  // ------------------------------------------------------- Xcode Cloud
  {
    name: 'list_ci_products',
    description: 'List Xcode Cloud products (apps/frameworks set up for Xcode Cloud) with their primary repositories. Xcode Cloud must first be enabled for an app from Xcode; the API cannot onboard a product.',
    inputSchema: { type: 'object', properties: { app: S.app } },
    annotations: { title: 'List Xcode Cloud products', readOnlyHint: true },
    async handler(args, ctx) {
      const q: any = { include: 'app,primaryRepositories', 'fields[apps]': 'name,bundleId', 'fields[scmRepositories]': 'ownerName,repositoryName,httpCloneUrl', limit: 200 };
      if (args.app) q['filter[app]'] = (await resolveApp(ctx, args.app)).id;
      const doc = await ctx.client.get('/v1/ciProducts', q);
      const inc = indexIncluded(doc.included);
      return ((doc.data as JsonApiResource[]) ?? []).map(p => {
        const app = inc.get(`apps/${relId(p, 'app')}`);
        return defined({
          id: p.id,
          name: p.attributes?.name,
          productType: p.attributes?.productType,
          createdDate: p.attributes?.createdDate,
          app: app ? { id: app.id, name: app.name, bundleId: app.bundleId } : undefined,
          repositories: relIds(p, 'primaryRepositories').map(r => {
            const x = inc.get(`scmRepositories/${r}`);
            return { id: r, name: x ? `${x.ownerName}/${x.repositoryName}` : undefined, url: x?.httpCloneUrl };
          }),
        });
      });
    },
  },
  {
    name: 'list_ci_workflows',
    description: 'List Xcode Cloud workflows of a product (or of an app\'s product): enabled flag, actions (build/test/analyze/archive with scheme & platform), start conditions, clean setting and repository.',
    inputSchema: { type: 'object', properties: { product_id: { type: 'string' }, app: S.app }, },
    annotations: { title: 'List Xcode Cloud workflows', readOnlyHint: true },
    async handler(args, ctx) {
      const productId = await resolveCiProduct(ctx, args.product_id, args.app);
      const doc = await ctx.client.get(`/v1/ciProducts/${productId}/workflows`, { include: 'repository,xcodeVersion,macOsVersion', limit: 200 });
      const inc = indexIncluded(doc.included);
      return ((doc.data as JsonApiResource[]) ?? []).map(w => {
        const a = w.attributes ?? {};
        const repo = inc.get(`scmRepositories/${relId(w, 'repository')}`);
        const starts = ['branchStartCondition', 'tagStartCondition', 'pullRequestStartCondition', 'scheduledStartCondition', 'manualBranchStartCondition', 'manualTagStartCondition', 'manualPullRequestStartCondition'].filter(k => a[k]);
        return defined({
          id: w.id,
          name: a.name,
          description: a.description || undefined,
          isEnabled: a.isEnabled,
          isLockedForEditing: a.isLockedForEditing,
          clean: a.clean,
          containerFilePath: a.containerFilePath,
          startConditions: starts,
          actions: (a.actions ?? []).map((x: any) => defined({ name: x.name, type: x.actionType, platform: x.platform, scheme: x.scheme, destination: x.destination, audience: x.buildDistributionAudience })),
          repository: repo ? `${repo.ownerName}/${repo.repositoryName}` : relId(w, 'repository'),
          xcodeVersion: inc.get(`ciXcodeVersions/${relId(w, 'xcodeVersion')}`)?.name,
          macOsVersion: inc.get(`ciMacOsVersions/${relId(w, 'macOsVersion')}`)?.name,
          lastModifiedDate: a.lastModifiedDate,
        });
      });
    },
  },
  {
    name: 'start_ci_build',
    description:
      'Start an Xcode Cloud build for a workflow on a branch, tag, or pull request (resolved by name/number against the workflow\'s repository), or re-run an earlier build run. With none given, builds the repository\'s default branch. The workflow must have a matching manual start condition (e.g. "manual branch" for branches) or Apple rejects it. clean: true does a clean build.',
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string' },
        branch: { type: 'string', description: 'Branch name, e.g. main' },
        tag: { type: 'string', description: 'Tag name, e.g. v1.2.0' },
        pull_request: { type: 'number', description: 'Pull request number' },
        rebuild_of: { type: 'string', description: 'ciBuildRun id to re-run (same commit)' },
        clean: { type: 'boolean' },
      },
    },
    annotations: { title: 'Start Xcode Cloud build' },
    async handler(args, ctx) {
      const relationships: any = {};
      let target: any;
      if (args.rebuild_of) {
        relationships.buildRun = rel('ciBuildRuns', args.rebuild_of);
        target = { rebuildOf: args.rebuild_of };
      } else {
        if (!args.workflow_id) throw new Error('workflow_id is required (see list_ci_workflows)');
        relationships.workflow = rel('ciWorkflows', args.workflow_id);
        if (isFake(args.workflow_id)) throw new Error('workflow_id is a dry-run placeholder; pass a real workflow id from list_ci_workflows');
        const repoDoc = await ctx.client.get(`/v1/ciWorkflows/${args.workflow_id}/repository`, { include: 'defaultBranch' });
        const repo = repoDoc.data as JsonApiResource;
        if (args.pull_request !== undefined) {
          const prs = await ctx.client.getAll(`/v1/scmRepositories/${repo.id}/pullRequests`, {}, 1000);
          const pr = prs.data.find(p => p.attributes?.number === Number(args.pull_request));
          if (!pr) throw new Error(`Pull request #${args.pull_request} not found in ${repo.attributes?.ownerName}/${repo.attributes?.repositoryName}`);
          relationships.pullRequest = rel('scmPullRequests', pr.id);
          target = { pullRequest: args.pull_request, title: pr.attributes?.title };
        } else if (args.branch || args.tag) {
          const name = args.branch ?? args.tag;
          const kind = args.branch ? 'BRANCH' : 'TAG';
          const refs = await ctx.client.getAll(`/v1/scmRepositories/${repo.id}/gitReferences`, {}, 5000);
          const canonical = kind === 'BRANCH' ? `refs/heads/${name}` : `refs/tags/${name}`;
          const ref = refs.data.find(r => r.attributes?.kind === kind && !r.attributes?.isDeleted && (r.attributes?.name === name || r.attributes?.canonicalName === name || r.attributes?.canonicalName === canonical));
          if (!ref) throw new Error(`${kind === 'BRANCH' ? 'Branch' : 'Tag'} "${name}" not found in the workflow's repository (${refs.data.length} refs checked). Push it first.`);
          relationships.sourceBranchOrTag = rel('scmGitReferences', ref.id);
          target = { [kind.toLowerCase()]: ref.attributes?.name };
        } else {
          const def = relId(repo, 'defaultBranch');
          if (!def) throw new Error('Repository has no default branch; pass branch, tag or pull_request.');
          relationships.sourceBranchOrTag = rel('scmGitReferences', def);
          target = { branch: indexIncluded(repoDoc.included).get(`scmGitReferences/${def}`)?.name ?? def, note: 'default branch' };
        }
      }
      const body: any = { data: { type: 'ciBuildRuns', relationships } };
      if (args.clean !== undefined) body.data.attributes = { clean: args.clean };
      const doc = await ctx.client.post('/v1/ciBuildRuns', body);
      const run = compact(doc.data as JsonApiResource);
      return { target, buildRun: { id: run.id, number: run.number, executionProgress: run.executionProgress }, next: 'Track with get_ci_build_run.' };
    },
  },
  {
    name: 'list_ci_build_runs',
    description: 'List recent Xcode Cloud build runs (newest first) for a workflow, a product, or an app\'s product: number, progress, result, start reason, branch/PR, commit, issue counts.',
    inputSchema: { type: 'object', properties: { workflow_id: { type: 'string' }, product_id: { type: 'string' }, app: S.app, limit: S.limit } },
    annotations: { title: 'List Xcode Cloud build runs', readOnlyHint: true },
    async handler(args, ctx) {
      const base = args.workflow_id ? `/v1/ciWorkflows/${args.workflow_id}/buildRuns` : `/v1/ciProducts/${await resolveCiProduct(ctx, args.product_id, args.app)}/buildRuns`;
      const doc = await ctx.client.get(base, { sort: '-number', limit: Math.min(200, args.limit ?? 20), include: 'workflow,sourceBranchOrTag,pullRequest', 'fields[ciWorkflows]': 'name' });
      const inc = indexIncluded(doc.included);
      return ((doc.data as JsonApiResource[]) ?? []).map(r => summarizeRun(r, inc));
    },
  },
  {
    name: 'get_ci_build_run',
    description: 'Details of one Xcode Cloud build run: status, commit, branch/PR, each action (build/test/archive) with its issues (errors/warnings with file:line), failed tests, and artifacts with download URLs (logs, archives, result bundles). Optionally download artifacts of given types to files.',
    inputSchema: {
      type: 'object',
      properties: {
        build_run_id: { type: 'string' },
        include_passed_tests: { type: 'boolean', description: 'Also list passing tests (default only failures)' },
        download_artifacts: { type: 'array', items: { type: 'string', enum: ['ARCHIVE', 'ARCHIVE_EXPORT', 'LOG_BUNDLE', 'RESULT_BUNDLE', 'TEST_PRODUCTS', 'XCODEBUILD_PRODUCTS', 'STAPLED_NOTARIZED_ARCHIVE'] }, description: 'Artifact file types to download' },
      },
      required: ['build_run_id'],
    },
    annotations: { title: 'Get Xcode Cloud build run', readOnlyHint: true },
    async handler(args, ctx) {
      if (isFake(args.build_run_id)) return { id: args.build_run_id, executionProgress: 'DRY_RUN' };
      const doc = await ctx.client.get(`/v1/ciBuildRuns/${args.build_run_id}`, { include: 'workflow,sourceBranchOrTag,pullRequest,builds', 'fields[ciWorkflows]': 'name', 'limit[builds]': 10 });
      const run = doc.data as JsonApiResource;
      const inc = indexIncluded(doc.included);
      const actionsDoc = await ctx.client.get(`/v1/ciBuildRuns/${run.id}/actions`, { limit: 50 });
      const wanted = new Set<string>(args.download_artifacts ?? []);
      const actions = await Promise.all(
        ((actionsDoc.data as JsonApiResource[]) ?? []).map(async act => {
          const a = act.attributes ?? {};
          const [issues, tests, artifacts] = await Promise.all([
            ctx.client.getAll(`/v1/ciBuildActions/${act.id}/issues`, {}, 100),
            a.actionType === 'TEST' ? ctx.client.getAll(`/v1/ciBuildActions/${act.id}/testResults`, {}, 2000) : Promise.resolve({ data: [] as JsonApiResource[] }),
            ctx.client.getAll(`/v1/ciBuildActions/${act.id}/artifacts`, {}, 100),
          ]);
          const testList = tests.data.map(compact);
          const arts = artifacts.data.map(compact);
          const downloads: any[] = [];
          for (const art of arts.filter(x => wanted.has(x.fileType) && x.downloadUrl)) {
            const res = await fetch(art.downloadUrl);
            if (!res.ok) {
              downloads.push({ fileName: art.fileName, error: `HTTP ${res.status}` });
              continue;
            }
            downloads.push({ fileName: art.fileName, path: saveOutput(ctx, `${run.attributes?.number ?? run.id}-${art.fileName}`, Buffer.from(await res.arrayBuffer())) });
          }
          return defined({
            id: act.id,
            name: a.name,
            actionType: a.actionType,
            executionProgress: a.executionProgress,
            completionStatus: a.completionStatus,
            isRequiredToPass: a.isRequiredToPass,
            startedDate: a.startedDate,
            finishedDate: a.finishedDate,
            issueCounts: a.issueCounts,
            issues: issues.data.map(compact).map(i => defined({ type: i.issueType, message: i.message, category: i.category, file: i.fileSource?.path ? `${i.fileSource.path}:${i.fileSource.lineNumber ?? ''}` : undefined })),
            tests:
              a.actionType === 'TEST'
                ? {
                    total: testList.length,
                    failed: testList.filter(t => t.status === 'FAILURE' || t.status === 'MIXED').length,
                    results: testList
                      .filter(t => args.include_passed_tests || (t.status !== 'SUCCESS' && t.status !== 'SKIPPED' && t.status !== 'EXPECTED_FAILURE'))
                      .map(t => defined({ test: `${t.className}.${t.name}`, status: t.status, message: t.message, file: t.fileSource?.path ? `${t.fileSource.path}:${t.fileSource.lineNumber ?? ''}` : undefined, destinations: t.destinationTestResults })),
                  }
                : undefined,
            artifacts: arts.map(x => ({ id: x.id, fileType: x.fileType, fileName: x.fileName, fileSize: x.fileSize, downloadUrl: x.downloadUrl })),
            downloaded: downloads.length ? downloads : undefined,
          });
        }),
      );
      return { ...summarizeRun(run, inc), builds: relIds(run, 'builds'), actions };
    },
  },

  // ------------------------------------------------------- sandbox testers
  {
    name: 'list_sandbox_testers',
    description: 'List In-App Purchase sandbox tester accounts (team-wide) with territory, interrupted-purchase flag and subscription renewal rate. Creating/deleting sandbox testers is not possible via the API (use App Store Connect > Users and Access > Sandbox).',
    inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Filter by email/name substring' }, limit: S.limit } },
    annotations: { title: 'List sandbox testers', readOnlyHint: true },
    async handler(args, ctx) {
      const doc = await ctx.client.getAll('/v2/sandboxTesters', {}, args.search ? 2000 : args.limit ?? 200);
      let list = doc.data.map(compact).map(({ type: _t, relationships: _r, ...x }) => x);
      if (args.search) {
        const s = String(args.search).toLowerCase();
        list = list.filter(t => [t.acAccountName, t.firstName, t.lastName].some(v => String(v ?? '').toLowerCase().includes(s))).slice(0, args.limit ?? 200);
      }
      return { total: doc.total, testers: list };
    },
  },
  {
    name: 'update_sandbox_testers',
    description: 'Update sandbox testers (ids or account emails): App Store territory (ISO alpha-3, e.g. USA, DEU), interrupt purchases (simulate interrupted purchase flow), and subscription renewal rate (how fast monthly subscriptions renew in sandbox).',
    inputSchema: {
      type: 'object',
      properties: {
        testers: { type: 'array', items: { type: 'string' }, description: 'Sandbox tester ids or account emails' },
        territory: { type: 'string', description: 'ISO 3166-1 alpha-3 territory, e.g. USA' },
        interrupt_purchases: { type: 'boolean' },
        subscription_renewal_rate: {
          type: 'string',
          enum: ['MONTHLY_RENEWAL_EVERY_ONE_HOUR', 'MONTHLY_RENEWAL_EVERY_THIRTY_MINUTES', 'MONTHLY_RENEWAL_EVERY_FIFTEEN_MINUTES', 'MONTHLY_RENEWAL_EVERY_FIVE_MINUTES', 'MONTHLY_RENEWAL_EVERY_THREE_MINUTES'],
        },
      },
      required: ['testers'],
    },
    annotations: { title: 'Update sandbox testers', idempotentHint: true },
    async handler(args, ctx) {
      const attributes = defined({ territory: args.territory?.toUpperCase(), interruptPurchases: args.interrupt_purchases, subscriptionRenewalRate: args.subscription_renewal_rate });
      if (!Object.keys(attributes).length) throw new Error('Nothing to update');
      const ids = await resolveSandboxTesters(ctx, args.testers);
      const out = [];
      for (const id of ids) {
        const doc = await ctx.client.patch(`/v2/sandboxTesters/${id}`, { data: { type: 'sandboxTesters', id, attributes } });
        const { type: _t, ...x } = compact(doc.data as JsonApiResource);
        out.push(x);
      }
      return { updated: out };
    },
  },
  {
    name: 'clear_sandbox_purchase_history',
    description: 'Clear the purchase history of sandbox testers (ids or account emails) so consumables/non-consumables/subscriptions can be bought again from scratch. Irreversible.',
    inputSchema: { type: 'object', properties: { testers: { type: 'array', items: { type: 'string' } }, confirm: S.confirm }, required: ['testers'] },
    annotations: { title: 'Clear sandbox purchase history', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Clearing sandbox purchase history');
      const ids = await resolveSandboxTesters(ctx, args.testers);
      const doc = await ctx.client.post('/v2/sandboxTestersClearPurchaseHistoryRequest', {
        data: { type: 'sandboxTestersClearPurchaseHistoryRequest', relationships: { sandboxTesters: rels('sandboxTesters', ids) } },
      });
      return { cleared: ids, request: compact(doc.data as JsonApiResource) };
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers used by the Xcode Cloud / sandbox tools (hoisted function decls)
// ---------------------------------------------------------------------------

async function resolveCiProduct(ctx: ToolContext, productId?: string, app?: string): Promise<string> {
  if (productId) return productId;
  if (!app) throw new Error('Pass product_id or app (see list_ci_products)');
  const appRes = await resolveApp(ctx, app);
  const doc = await ctx.client.get('/v1/ciProducts', { 'filter[app]': appRes.id, limit: 5 });
  const list = (doc.data as JsonApiResource[]) ?? [];
  if (!list.length) throw new Error(`${appRes.name} has no Xcode Cloud product. Set up Xcode Cloud for it in Xcode (Product > Xcode Cloud > Create Workflow) first.`);
  return list[0].id;
}

function summarizeRun(r: JsonApiResource, inc: Map<string, any>) {
  const a = r.attributes ?? {};
  const ref = inc.get(`scmGitReferences/${relId(r, 'sourceBranchOrTag')}`);
  const pr = inc.get(`scmPullRequests/${relId(r, 'pullRequest')}`);
  return defined({
    id: r.id,
    number: a.number,
    workflow: inc.get(`ciWorkflows/${relId(r, 'workflow')}`)?.name ?? relId(r, 'workflow'),
    executionProgress: a.executionProgress,
    completionStatus: a.completionStatus,
    startReason: a.startReason,
    cancelReason: a.cancelReason,
    ref: ref ? `${ref.kind === 'TAG' ? 'tag' : 'branch'} ${ref.name}` : undefined,
    pullRequest: pr ? `#${pr.number} ${pr.title}` : undefined,
    commit: a.sourceCommit ? { sha: a.sourceCommit.commitSha?.slice(0, 12), message: a.sourceCommit.message?.split('\n')[0], author: a.sourceCommit.author?.displayName } : undefined,
    issueCounts: a.issueCounts,
    createdDate: a.createdDate,
    startedDate: a.startedDate,
    finishedDate: a.finishedDate,
  });
}

async function resolveSandboxTesters(ctx: ToolContext, testers: string | string[]): Promise<string[]> {
  const list = asArray(testers).map(String);
  if (!list.length) throw new Error('At least one sandbox tester is required');
  if (!list.some(t => t.includes('@'))) return list;
  const all = (await ctx.client.getAll('/v2/sandboxTesters', {}, 5000)).data.map(compact);
  return list.map(t => {
    if (!t.includes('@')) return t;
    const hit = all.find(x => String(x.acAccountName ?? '').toLowerCase() === t.toLowerCase());
    if (!hit) throw new Error(`Sandbox tester ${t} not found (see list_sandbox_testers)`);
    return hit.id;
  });
}
