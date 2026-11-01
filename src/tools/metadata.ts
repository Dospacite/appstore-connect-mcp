/**
 * App metadata & release workflow tools: apps, app info (categories, name/subtitle/privacy),
 * age rating, App Store versions and their localizations, review details, build attachment,
 * phased release, manual release, review submissions, and custom EULA.
 */
import type { JsonApiResource } from '../asc/client.js';
import { compact, defined, rel, rels } from '../asc/format.js';
import {
  EDITABLE_VERSION_STATES,
  S,
  compactList,
  requireConfirm,
  resolveApp,
  resolveEditableAppInfo,
  resolveVersion,
  type Platform,
} from './helpers.js';
import type { ToolContext, ToolDef } from './types.js';

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

const isDry = (id?: string) => !!id && id.startsWith('DRY_RUN_');
const len = (s?: string | null) => (s ? [...s].length : 0);

/** Apple's documented text limits (characters). */
const LIMITS: Record<string, number> = {
  name: 30,
  subtitle: 30,
  keywords: 100,
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
};

function checkLimits(locale: string, attrs: Record<string, any>) {
  for (const [k, max] of Object.entries(LIMITS)) {
    if (typeof attrs[k] === 'string' && len(attrs[k]) > max) {
      throw new Error(`${locale}: ${k} is ${len(attrs[k])} characters; the App Store limit is ${max}. Shorten it and retry (nothing was written for this locale).`);
    }
  }
}

const versionInput = {
  version: S.version,
  version_id: { type: 'string', description: 'App Store version id (overrides app/platform/version lookup)' },
  platform: S.platform,
};

/** Fetch an App Store version by id in compact form. */
async function getVersion(ctx: ToolContext, id: string, include?: string) {
  const doc = await ctx.client.get(`/v1/appStoreVersions/${id}`, include ? { include } : undefined);
  return { version: compact(doc.data as JsonApiResource), included: (doc.included ?? []).map(compact) };
}

/** All versions of an app (optionally one platform), newest first. */
async function listVersions(ctx: ToolContext, appId: string, platform?: Platform, include?: string) {
  const q: Record<string, any> = { limit: 200 };
  if (platform) q['filter[platform]'] = platform;
  if (include) q.include = include;
  const all = await ctx.client.getAll(`/v1/apps/${appId}/appStoreVersions`, q, 200);
  const versions = all.data.map(compact).sort((a, b) => String(b.createdDate ?? '').localeCompare(String(a.createdDate ?? '')));
  return { versions, included: all.included.map(compact) };
}

const stateOf = (v: any) => v.appVersionState ?? v.appStoreState;

/**
 * Pick the version a tool should act on.
 * - version_id: used directly
 * - version: exact version string on the platform
 * - otherwise: newest version whose state is in `states` (default: editable states);
 *   'preferEditable' = newest editable version, else the newest version of any state
 */
async function pickVersion(ctx: ToolContext, args: any, states?: string[] | 'preferEditable'): Promise<{ appId?: string; version: any }> {
  if (args.version_id) {
    const { version } = await getVersion(ctx, args.version_id);
    return { version };
  }
  const app = await resolveApp(ctx, args.app);
  const platform: Platform = args.platform ?? 'IOS';
  if (!states) return { appId: app.id, version: await resolveVersion(ctx, app.id, platform, args.version) };
  const { versions } = await listVersions(ctx, app.id, platform);
  if (args.version) {
    const v = versions.find(x => x.versionString === args.version);
    if (!v) throw new Error(`Version ${args.version} (${platform}) not found. Existing: ${versions.map(x => `${x.versionString}=${stateOf(x)}`).join(', ') || 'none'}`);
    return { appId: app.id, version: v };
  }
  const v = states === 'preferEditable' ? (versions.find(x => EDITABLE_VERSION_STATES.includes(stateOf(x))) ?? versions[0]) : versions.find(x => states.includes(stateOf(x)));
  if (!v) throw new Error(`No ${platform} version${states === 'preferEditable' ? '' : ` in state ${states.join('/')}`}. Existing: ${versions.map(x => `${x.versionString}=${stateOf(x)}`).join(', ') || 'none'}`);
  return { appId: app.id, version: v };
}

const versionSummary = (v: any) =>
  defined({
    id: v.id,
    platform: v.platform,
    versionString: v.versionString,
    state: stateOf(v),
    appStoreState: v.appStoreState !== stateOf(v) ? v.appStoreState : undefined,
    releaseType: v.releaseType,
    earliestReleaseDate: v.earliestReleaseDate ?? undefined,
    copyright: v.copyright,
    createdDate: v.createdDate,
  });

const buildSummary = (b: any, preRelease?: any) =>
  defined({
    id: b.id,
    buildNumber: b.version,
    version: preRelease?.version,
    platform: preRelease?.platform,
    processingState: b.processingState,
    expired: b.expired,
    uploadedDate: b.uploadedDate,
    buildAudienceType: b.buildAudienceType ?? undefined,
    usesNonExemptEncryption: b.usesNonExemptEncryption,
  });

/** GET a to-one related resource; returns null on 404 / data:null. */
async function getOptional(ctx: ToolContext, path: string, query?: Record<string, any>): Promise<any | null> {
  try {
    const doc = await ctx.client.get(path, query);
    return doc.data ? compact(doc.data as JsonApiResource) : null;
  } catch (e: any) {
    if (e?.status === 404) return null;
    throw e;
  }
}

async function getAppInfoById(ctx: ToolContext, args: any, appId: string) {
  if (args.app_info_id) return { id: args.app_info_id };
  return resolveEditableAppInfo(ctx, appId);
}

const OPEN_SUBMISSION_STATES = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'];
const ACTIVE_SUBMISSION_STATES = ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES', 'READY_FOR_REVIEW'];

/** Summarize a review submission with its items. */
function submissionSummary(sub: any, items: any[], included: any[]) {
  const byKey = new Map(included.map(i => [i.type + '/' + i.id, i]));
  return {
    id: sub.id,
    platform: sub.platform,
    state: sub.state,
    submittedDate: sub.submittedDate ?? undefined,
    items: items.map(it => {
      const [relName, relId] = Object.entries(it.relationships ?? {})[0] ?? [];
      const target = relName ? [...byKey.values()].find(x => x.id === relId) : undefined;
      return defined({
        id: it.id,
        state: it.state,
        kind: relName,
        targetId: relId,
        versionString: target?.versionString,
        targetState: target ? (target.appVersionState ?? target.state ?? target.appStoreState) : undefined,
      });
    }),
  };
}

const ITEM_INCLUDES = 'appStoreVersion,appCustomProductPageVersion,appEvent,inAppPurchaseVersion,subscriptionVersion,appStoreVersionExperimentV2';

async function submissionWithItems(ctx: ToolContext, sub: any) {
  if (isDry(sub.id)) return submissionSummary(sub, [], []);
  const doc = await ctx.client.get(`/v1/reviewSubmissions/${sub.id}/items`, { include: ITEM_INCLUDES, limit: 50 });
  return submissionSummary(sub, compactList(doc), (doc.included ?? []).map(compact));
}

// ---------------------------------------------------------------------------
// Submission readiness (shared by check_submission_readiness and submit_for_review)
// ---------------------------------------------------------------------------

async function readiness(ctx: ToolContext, appId: string, version: any) {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const info: Record<string, any> = {};
  const platform: Platform = version.platform ?? 'IOS';

  const [appDoc, vDoc, locDoc, appInfo, allVersions, priceSchedule, availability, submissions] = await Promise.all([
    ctx.client.get(`/v1/apps/${appId}`, { 'fields[apps]': 'name,bundleId,primaryLocale,contentRightsDeclaration' }),
    getVersion(ctx, version.id, 'build,appStoreReviewDetail'),
    ctx.client.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, { limit: 200 }),
    resolveEditableAppInfo(ctx, appId),
    listVersions(ctx, appId, platform),
    getOptional(ctx, `/v1/apps/${appId}/appPriceSchedule`, { include: 'manualPrices' }).catch(() => null),
    getOptional(ctx, `/v1/apps/${appId}/appAvailabilityV2`).catch(() => null),
    ctx.client.get('/v1/reviewSubmissions', { 'filter[app]': appId, 'filter[platform]': platform, 'filter[state]': ['WAITING_FOR_REVIEW', 'IN_REVIEW'].join(','), limit: 10 }),
  ]);
  const app = compact(appDoc.data as JsonApiResource);
  const primaryLocale = app.primaryLocale;
  const v = vDoc.version;
  info.version = versionSummary(v);

  // Version state
  if (!EDITABLE_VERSION_STATES.includes(stateOf(v))) blockers.push(`Version ${v.versionString} is ${stateOf(v)}; only versions in ${EDITABLE_VERSION_STATES.join('/')} can be submitted.`);
  const inReview = compactList(submissions);
  if (inReview.length) warnings.push(`A ${platform} review submission is already ${inReview.map(s => s.state).join('/')} (${inReview.map(s => s.id).join(', ')}).`);

  // App-level
  if (!app.contentRightsDeclaration) blockers.push('App content rights declaration is not set. Use update_app with contentRightsDeclaration.');
  if (!v.copyright) blockers.push('Version copyright is empty. Use update_version with copyright (e.g. "2026 Your Company").');
  if (v.releaseType === 'SCHEDULED' && !v.earliestReleaseDate) blockers.push('releaseType is SCHEDULED but earliestReleaseDate is not set.');

  // Build
  const build = vDoc.included.find(i => i.type === 'builds');
  if (!build) blockers.push('No build attached. Use attach_build.');
  else {
    info.build = buildSummary(build);
    if (build.processingState !== 'VALID') blockers.push(`Attached build ${build.version} is ${build.processingState}, not VALID.`);
    if (build.expired) blockers.push(`Attached build ${build.version} has expired. Attach a newer build.`);
    if (build.buildAudienceType === 'INTERNAL_ONLY') blockers.push(`Attached build ${build.version} is INTERNAL_ONLY (TestFlight internal) and cannot go to the App Store.`);
    if (build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined)
      blockers.push(`Build ${build.version} has no export compliance answer (usesNonExemptEncryption). Set it (PATCH /v1/builds/{id} usesNonExemptEncryption) or add ITSAppUsesNonExemptEncryption to Info.plist.`);
  }

  // Review details
  const review = vDoc.included.find(i => i.type === 'appStoreReviewDetails');
  if (!review) blockers.push('No App Review contact details. Use set_review_details.');
  else {
    const missing = ['contactFirstName', 'contactLastName', 'contactPhone', 'contactEmail'].filter(k => !review[k]);
    if (missing.length) blockers.push(`App Review details missing: ${missing.join(', ')}. Use set_review_details.`);
    if (review.demoAccountRequired && (!review.demoAccountName || !review.demoAccountPassword)) blockers.push('demoAccountRequired is true but demo account name/password are empty.');
  }

  // Version localizations
  const locs = compactList(locDoc);
  const isFirstVersion = allVersions.versions.length <= 1;
  info.locales = locs.map(l => l.locale);
  if (!locs.length) blockers.push('Version has no localizations. Use set_version_localizations.');
  if (primaryLocale && !locs.some(l => l.locale === primaryLocale)) blockers.push(`No version localization for the primary locale ${primaryLocale}.`);
  for (const l of locs) {
    const miss = ['description', 'keywords', 'supportUrl'].filter(k => !l[k]);
    if (miss.length) blockers.push(`${l.locale}: missing ${miss.join(', ')}.`);
    if (!isFirstVersion && !l.whatsNew) warnings.push(`${l.locale}: whatsNew (release notes) is empty.`);
    for (const [k, max] of Object.entries(LIMITS)) if (len(l[k]) > max) blockers.push(`${l.locale}: ${k} is ${len(l[k])} chars (max ${max}).`);
  }

  // Screenshots per locale
  const shotInfo: Record<string, Record<string, number>> = {};
  await Promise.all(
    locs.map(async l => {
      const doc = await ctx.client.get(`/v1/appStoreVersionLocalizations/${l.id}/appScreenshotSets`, { include: 'appScreenshots', 'fields[appScreenshots]': 'fileName', 'limit[appScreenshots]': 10, limit: 50 });
      const counts: Record<string, number> = {};
      for (const s of compactList(doc)) counts[s.screenshotDisplayType] = (s.relationships?.appScreenshots as string[] | undefined)?.length ?? 0;
      shotInfo[l.locale] = counts;
    }),
  );
  info.screenshots = shotInfo;
  for (const l of locs) {
    const total = Object.values(shotInfo[l.locale] ?? {}).reduce((a, b) => a + b, 0);
    if (total === 0) {
      if (l.locale === primaryLocale) blockers.push(`${l.locale} (primary): no screenshots. Upload screenshots (media tools).`);
      else warnings.push(`${l.locale}: no screenshots; the primary locale's screenshots will be shown.`);
    }
  }
  if (platform === 'IOS') {
    const p = shotInfo[primaryLocale] ?? {};
    const hasIphone = Object.keys(p).some(t => t.startsWith('APP_IPHONE') && p[t] > 0);
    if (Object.keys(p).length && !hasIphone) blockers.push('Primary locale has no iPhone screenshots (6.9"/6.5" APP_IPHONE_67 or APP_IPHONE_65 is required).');
    const hasIpad = Object.keys(p).some(t => t.startsWith('APP_IPAD') && p[t] > 0);
    if (!hasIpad) warnings.push('No iPad screenshots. Required (13" APP_IPAD_PRO_3GEN_129) if the build supports iPad.');
  }

  // App info: category, localizations, privacy policy, age rating
  const aiDoc = await ctx.client.get(`/v1/appInfos/${appInfo.id}`, { include: 'appInfoLocalizations,ageRatingDeclaration,primaryCategory' });
  const ai = compact(aiDoc.data as JsonApiResource);
  const aiIncluded = (aiDoc.included ?? []).map(compact);
  if (!ai.relationships?.primaryCategory) blockers.push('Primary category is not set. Use update_app_info (see list_categories).');
  const aiLocs = aiIncluded.filter(i => i.type === 'appInfoLocalizations');
  const primaryAiLoc = aiLocs.find(l => l.locale === primaryLocale);
  if (!primaryAiLoc?.name) blockers.push(`App name for primary locale ${primaryLocale} is missing. Use set_app_info_localizations.`);
  if (!primaryAiLoc?.privacyPolicyUrl) blockers.push(`Privacy policy URL for ${primaryLocale} is missing (required for all apps). Use set_app_info_localizations.`);
  for (const l of locs) if (!aiLocs.some(a => a.locale === l.locale)) warnings.push(`${l.locale}: has version metadata but no app info localization (name/subtitle). Use set_app_info_localizations.`);
  const age = aiIncluded.find(i => i.type === 'ageRatingDeclarations');
  if (!age) blockers.push('No age rating declaration. Use set_age_rating.');
  else {
    const unset = Object.entries(age).filter(([k, val]) => val === null && !['kidsAgeBand', 'gracRatingClassificationNumber', 'developerAgeRatingInfoUrl', 'ageRatingOverride', 'ageRatingOverrideV2', 'koreaAgeRatingOverride'].includes(k)).map(([k]) => k);
    if (unset.length) blockers.push(`Age rating questionnaire incomplete: ${unset.join(', ')}. Use set_age_rating.`);
    info.ageRating = ai.appStoreAgeRating;
  }

  // Pricing & availability
  if (!priceSchedule) blockers.push('No price set for the app. Set a price schedule (monetization tools).');
  if (!availability) warnings.push('Could not read app availability (GET appAvailabilityV2 returned 404). Apps whose availability was set before the v2 API may show this; otherwise set territories with the monetization tools.');

  warnings.push('Not checkable via API: App Privacy "data collection" answers, and any agreements/tax/banking status. Check those in App Store Connect if submission fails.');
  return { ready: blockers.length === 0, blockers, warnings, details: info };
}

// ---------------------------------------------------------------------------
// Age rating schema
// ---------------------------------------------------------------------------

const LEVEL_ENUM = ['NONE', 'INFREQUENT_OR_MILD', 'FREQUENT_OR_INTENSE'];
const AGE_LEVEL_FIELDS = [
  'alcoholTobaccoOrDrugUseOrReferences',
  'contests',
  'gamblingSimulated',
  'gunsOrOtherWeapons',
  'horrorOrFearThemes',
  'matureOrSuggestiveThemes',
  'medicalOrTreatmentInformation',
  'profanityOrCrudeHumor',
  'sexualContentGraphicAndNudity',
  'sexualContentOrNudity',
  'violenceCartoonOrFantasy',
  'violenceRealistic',
  'violenceRealisticProlongedGraphicOrSadistic',
];
const AGE_BOOL_FIELDS = [
  'advertising',
  'ageAssurance',
  'gambling',
  'healthOrWellnessTopics',
  'lootBox',
  'messagingAndChat',
  'parentalControls',
  'socialMedia',
  'socialMediaAgeRestricted',
  'unrestrictedWebAccess',
  'userGeneratedContent',
];
const ageRatingProps: Record<string, any> = {};
for (const f of AGE_LEVEL_FIELDS) ageRatingProps[f] = { type: 'string', enum: LEVEL_ENUM };
for (const f of AGE_BOOL_FIELDS) ageRatingProps[f] = { type: 'boolean' };
Object.assign(ageRatingProps, {
  kidsAgeBand: { type: ['string', 'null'], enum: ['FIVE_AND_UNDER', 'SIX_TO_EIGHT', 'NINE_TO_ELEVEN', null], description: 'Only for apps in the Kids category; null to clear' },
  ageRatingOverrideV2: { type: 'string', enum: ['NONE', 'NINE_PLUS', 'THIRTEEN_PLUS', 'SIXTEEN_PLUS', 'EIGHTEEN_PLUS', 'UNRATED'], description: 'Force a higher rating than the questionnaire computes' },
  koreaAgeRatingOverride: { type: 'string', enum: ['NONE', 'ALL', 'TWELVE_PLUS', 'FIFTEEN_PLUS', 'NINETEEN_PLUS'] },
  gracRatingClassificationNumber: { type: 'string', description: 'Korea GRAC classification number, if any' },
  developerAgeRatingInfoUrl: { type: 'string', description: 'URL with your own age rating info' },
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const versionLocProps = {
  locale: S.locale,
  description: { type: 'string', description: 'Full description, max 4000 chars' },
  keywords: { type: 'string', description: 'Comma-separated search keywords, max 100 chars total (no spaces needed after commas; do not repeat the app name)' },
  whatsNew: { type: 'string', description: 'Release notes, max 4000 chars. Not allowed on the first version of an app (skipped with a warning).' },
  promotionalText: { type: 'string', description: 'Max 170 chars. Can be changed any time, even on a live version, without review.' },
  marketingUrl: { type: 'string', description: 'Marketing URL (optional)' },
  supportUrl: { type: 'string', description: 'Support URL (required for submission)' },
};

const appInfoLocProps = {
  locale: S.locale,
  name: { type: 'string', description: 'App name on the store, max 30 chars, must be unique on the App Store. Required when adding a locale.' },
  subtitle: { type: 'string', description: 'Max 30 chars' },
  privacyPolicyUrl: { type: 'string', description: 'Privacy policy URL (required for the primary locale)' },
  privacyChoicesUrl: { type: 'string', description: 'URL where users manage privacy choices (optional)' },
  privacyPolicyText: { type: 'string', description: 'Privacy policy text (tvOS only)' },
};

export const metadataTools: ToolDef[] = [
  // ----------------------------------------------------------------- apps
  {
    name: 'list_apps',
    description: 'List all apps in the App Store Connect account: id, name, bundleId, sku, primaryLocale. Use the id or bundleId as `app` in other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name_contains: { type: 'string', description: 'Only apps whose name contains this text (case-insensitive)' },
        limit: S.limit,
      },
    },
    annotations: { title: 'List apps', readOnlyHint: true },
    async handler(args, ctx) {
      const all = await ctx.client.getAll('/v1/apps', { 'fields[apps]': 'name,bundleId,sku,primaryLocale', sort: 'name' }, args.limit ?? 200);
      let apps = all.data.map(compact).map(({ type, ...a }) => a);
      if (args.name_contains) apps = apps.filter(a => String(a.name).toLowerCase().includes(String(args.name_contains).toLowerCase()));
      return { count: apps.length, truncated: all.truncated || undefined, apps };
    },
  },
  {
    name: 'app_overview',
    description:
      'One-call status of an app: basic settings, app infos (state, categories, localized names), recent App Store versions per platform (state, release type, attached build, phased release), latest builds, and review submissions. Start here before editing or submitting anything.',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'App overview', readOnlyHint: true },
    async handler(args, ctx) {
      const { id } = await resolveApp(ctx, args.app);
      const [appDoc, infosDoc, versions, buildsDoc, subsDoc] = await Promise.all([
        ctx.client.get(`/v1/apps/${id}`),
        ctx.client.get(`/v1/apps/${id}/appInfos`, { include: 'appInfoLocalizations,primaryCategory,secondaryCategory', 'fields[appInfoLocalizations]': 'locale,name,subtitle', limit: 10 }),
        listVersions(ctx, id, undefined, 'build,appStoreVersionPhasedRelease'),
        ctx.client.get('/v1/builds', { 'filter[app]': id, sort: '-uploadedDate', limit: 5, include: 'preReleaseVersion', 'fields[builds]': 'version,uploadedDate,processingState,expired,buildAudienceType,usesNonExemptEncryption,preReleaseVersion' }),
        ctx.client.get('/v1/reviewSubmissions', { 'filter[app]': id, limit: 5, include: 'appStoreVersionForReview', 'fields[appStoreVersions]': 'versionString,platform' }),
      ]);
      const app = compact(appDoc.data as JsonApiResource);
      const infosIncluded = (infosDoc.included ?? []).map(compact);
      const appInfos = compactList(infosDoc).map(i => ({
        id: i.id,
        state: i.state ?? i.appStoreState,
        appStoreAgeRating: i.appStoreAgeRating,
        primaryCategory: i.relationships?.primaryCategory,
        secondaryCategory: i.relationships?.secondaryCategory,
        localizations: infosIncluded.filter(x => x.type === 'appInfoLocalizations' && (i.relationships?.appInfoLocalizations as string[] | undefined)?.includes(x.id)).map(({ type, id: _id, ...l }) => l),
      }));
      const inc = new Map(versions.included.map(x => [x.type + '/' + x.id, x]));
      const byPlatform: Record<string, any[]> = {};
      for (const v of versions.versions) {
        const list = (byPlatform[v.platform] ??= []);
        if (list.length >= 3) continue;
        const b = v.relationships?.build ? inc.get('builds/' + v.relationships.build) : undefined;
        const pr = v.relationships?.appStoreVersionPhasedRelease ? inc.get('appStoreVersionPhasedReleases/' + v.relationships.appStoreVersionPhasedRelease) : undefined;
        list.push(defined({ ...versionSummary(v), build: b ? buildSummary(b) : null, phasedRelease: pr ? { id: pr.id, state: pr.phasedReleaseState, currentDayNumber: pr.currentDayNumber } : undefined }));
      }
      const pre = new Map((buildsDoc.included ?? []).map(x => [x.id, compact(x)]));
      const builds = compactList(buildsDoc).map(b => buildSummary(b, pre.get(b.relationships?.preReleaseVersion as string)));
      const subInc = new Map((subsDoc.included ?? []).map(x => [x.id, compact(x)]));
      const reviewSubmissions = compactList(subsDoc).map(s =>
        defined({ id: s.id, platform: s.platform, state: s.state, submittedDate: s.submittedDate ?? undefined, version: subInc.get(s.relationships?.appStoreVersionForReview as string)?.versionString }),
      );
      const { type, relationships, ...appAttrs } = app;
      return { app: appAttrs, appInfos, versions: byPlatform, totalVersions: versions.versions.length, latestBuilds: builds, reviewSubmissions };
    },
  },
  {
    name: 'update_app',
    description:
      'Update app-level settings: primary locale, content rights declaration (required before first submission), App Store Server Notification URLs (production/sandbox, V1/V2), accessibility URL, streamlined purchasing. Only sends fields you pass. App name/subtitle live in app info localizations (set_app_info_localizations), not here.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        primaryLocale: { type: 'string', description: 'Primary language, e.g. en-US. A localization for it must exist.' },
        contentRightsDeclaration: { type: 'string', enum: ['DOES_NOT_USE_THIRD_PARTY_CONTENT', 'USES_THIRD_PARTY_CONTENT'] },
        subscriptionStatusUrl: { type: 'string', description: 'Production App Store Server Notifications URL' },
        subscriptionStatusUrlVersion: { type: 'string', enum: ['V1', 'V2'] },
        subscriptionStatusUrlForSandbox: { type: 'string', description: 'Sandbox App Store Server Notifications URL' },
        subscriptionStatusUrlVersionForSandbox: { type: 'string', enum: ['V1', 'V2'] },
        accessibilityUrl: { type: 'string', description: 'URL describing accessibility support' },
        streamlinedPurchasingEnabled: { type: 'boolean', description: 'Allow purchases via streamlined purchasing (in-app purchase flow)' },
      },
      required: ['app'],
    },
    annotations: { title: 'Update app settings', idempotentHint: true },
    async handler(args, ctx) {
      const { id } = await resolveApp(ctx, args.app);
      const attributes = defined({
        primaryLocale: args.primaryLocale,
        contentRightsDeclaration: args.contentRightsDeclaration,
        subscriptionStatusUrl: args.subscriptionStatusUrl,
        subscriptionStatusUrlVersion: args.subscriptionStatusUrlVersion,
        subscriptionStatusUrlForSandbox: args.subscriptionStatusUrlForSandbox,
        subscriptionStatusUrlVersionForSandbox: args.subscriptionStatusUrlVersionForSandbox,
        accessibilityUrl: args.accessibilityUrl,
        streamlinedPurchasingEnabled: args.streamlinedPurchasingEnabled,
      });
      if (!Object.keys(attributes).length) throw new Error('Pass at least one field to change.');
      const doc = await ctx.client.patch(`/v1/apps/${id}`, { data: { type: 'apps', id, attributes } });
      return compact(doc.data as JsonApiResource);
    },
  },

  // ----------------------------------------------------------------- app info
  {
    name: 'list_categories',
    description: 'List App Store categories and their subcategories (ids like GAMES, GAMES_PUZZLE, PRODUCTIVITY). Subcategories exist only for GAMES and STICKERS. Use ids with update_app_info.',
    inputSchema: { type: 'object', properties: { platform: S.platform } },
    annotations: { title: 'List categories', readOnlyHint: true },
    async handler(args, ctx) {
      const all = await ctx.client.getAll('/v1/appCategories', { 'filter[platforms]': args.platform ?? 'IOS', 'exists[parent]': false, include: 'subcategories', 'limit[subcategories]': 50 }, 200);
      return all.data.map(compact).map(c => defined({ id: c.id, subcategories: (c.relationships?.subcategories as string[] | undefined)?.length ? c.relationships!.subcategories : undefined }));
    },
  },
  {
    name: 'get_app_info',
    description:
      'Show app info records (one live + one editable when a new version is in progress): state, categories, age rating, and per-locale name/subtitle/privacy URLs. Edits always go to the editable record.',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'Get app info', readOnlyHint: true },
    async handler(args, ctx) {
      const { id } = await resolveApp(ctx, args.app);
      const catKeys = ['primaryCategory', 'primarySubcategoryOne', 'primarySubcategoryTwo', 'secondaryCategory', 'secondarySubcategoryOne', 'secondarySubcategoryTwo'];
      const doc = await ctx.client.get(`/v1/apps/${id}/appInfos`, { include: ['appInfoLocalizations', ...catKeys].join(','), 'limit[appInfoLocalizations]': 50, 'fields[appCategories]': 'platforms', limit: 10 });
      const inc = (doc.included ?? []).map(compact).filter(x => x.type === 'appInfoLocalizations');
      return compactList(doc).map(i => {
        const r: Record<string, any> = i.relationships ?? {};
        return {
          id: i.id,
          state: i.state ?? i.appStoreState,
          appStoreAgeRating: i.appStoreAgeRating,
          ageRatingDeclarationId: r.ageRatingDeclaration,
          categories: Object.fromEntries(catKeys.filter(k => r[k]).map(k => [k, r[k]])),
          localizations: inc.filter(x => (r.appInfoLocalizations as string[] | undefined)?.includes(x.id)).map(({ type, ...l }) => l),
        };
      });
    },
  },
  {
    name: 'update_app_info',
    description:
      'Set the app\'s primary/secondary category and subcategories on the editable app info. Category ids come from list_categories (e.g. GAMES, GAMES_PUZZLE, EDUCATION). Pass null to clear a secondary category/subcategory. Subcategories apply only to GAMES/STICKERS. Changes ship with the next version (or immediately if the app info is not yet live).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        app_info_id: { type: 'string', description: 'Specific appInfo id (default: the editable one)' },
        primaryCategory: { type: 'string' },
        primarySubcategoryOne: { type: ['string', 'null'] },
        primarySubcategoryTwo: { type: ['string', 'null'] },
        secondaryCategory: { type: ['string', 'null'] },
        secondarySubcategoryOne: { type: ['string', 'null'] },
        secondarySubcategoryTwo: { type: ['string', 'null'] },
      },
      required: ['app'],
    },
    annotations: { title: 'Update app categories', idempotentHint: true },
    async handler(args, ctx) {
      const { id: appId } = await resolveApp(ctx, args.app);
      const info = await getAppInfoById(ctx, args, appId);
      const relationships: Record<string, any> = {};
      for (const k of ['primaryCategory', 'primarySubcategoryOne', 'primarySubcategoryTwo', 'secondaryCategory', 'secondarySubcategoryOne', 'secondarySubcategoryTwo']) {
        if (args[k] === undefined) continue;
        relationships[k] = args[k] === null ? { data: null } : rel('appCategories', String(args[k]).toUpperCase());
      }
      if (!Object.keys(relationships).length) throw new Error('Pass at least one category field.');
      const doc = await ctx.client.patch(`/v1/appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships } });
      return { appInfoId: info.id, updated: Object.keys(relationships), result: compact(doc.data as JsonApiResource) };
    },
  },
  {
    name: 'set_app_info_localizations',
    description:
      'Bulk upsert app-level localized info on the editable app info: name (max 30), subtitle (max 30), privacyPolicyUrl, privacyChoicesUrl, privacyPolicyText. Creates missing locales (name required then), patches existing ones with only the fields you pass. Name/subtitle changes for a live app only go live with the next approved version.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        app_info_id: { type: 'string', description: 'Specific appInfo id (default: the editable one)' },
        localizations: { type: 'array', items: { type: 'object', properties: appInfoLocProps, required: ['locale'] }, description: 'One entry per locale' },
      },
      required: ['app', 'localizations'],
    },
    annotations: { title: 'Set app name/subtitle/privacy per locale', idempotentHint: true },
    async handler(args, ctx) {
      const { id: appId } = await resolveApp(ctx, args.app);
      const info = await getAppInfoById(ctx, args, appId);
      const existing = compactList(await ctx.client.get(`/v1/appInfos/${info.id}/appInfoLocalizations`, { limit: 200 }));
      const results: any[] = [];
      for (const l of args.localizations as any[]) {
        try {
          const attributes = defined({ name: l.name, subtitle: l.subtitle, privacyPolicyUrl: l.privacyPolicyUrl, privacyChoicesUrl: l.privacyChoicesUrl, privacyPolicyText: l.privacyPolicyText });
          checkLimits(l.locale, attributes);
          const cur = existing.find(e => e.locale === l.locale);
          if (cur) {
            if (!Object.keys(attributes).length) {
              results.push({ locale: l.locale, action: 'unchanged' });
              continue;
            }
            await ctx.client.patch(`/v1/appInfoLocalizations/${cur.id}`, { data: { type: 'appInfoLocalizations', id: cur.id, attributes } });
            results.push({ locale: l.locale, action: 'updated', id: cur.id, fields: Object.keys(attributes) });
          } else {
            if (!l.name) throw new Error(`${l.locale}: name is required to add a new locale.`);
            const doc = await ctx.client.post('/v1/appInfoLocalizations', { data: { type: 'appInfoLocalizations', attributes: { locale: l.locale, ...attributes }, relationships: { appInfo: rel('appInfos', info.id) } } });
            results.push({ locale: l.locale, action: 'created', id: (doc.data as JsonApiResource).id });
          }
        } catch (e: any) {
          results.push({ locale: l.locale, action: 'failed', error: e.message });
        }
      }
      return { appInfoId: info.id, results, failed: results.filter(r => r.action === 'failed').length };
    },
  },
  {
    name: 'delete_app_info_localization',
    description: 'Remove a locale from the editable app info (its name/subtitle/privacy URLs). The primary locale cannot be removed. Usually also remove the matching version localization with delete_version_localization.',
    inputSchema: { type: 'object', properties: { app: S.app, locale: S.locale, app_info_id: { type: 'string' }, confirm: S.confirm }, required: ['app', 'locale'] },
    annotations: { title: 'Delete app info locale', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, `Deleting app info locale ${args.locale}`);
      const { id: appId, primaryLocale } = await resolveApp(ctx, args.app);
      if (args.locale === primaryLocale) throw new Error(`${args.locale} is the primary locale and cannot be removed. Change primaryLocale with update_app first.`);
      const info = await getAppInfoById(ctx, args, appId);
      const list = compactList(await ctx.client.get(`/v1/appInfos/${info.id}/appInfoLocalizations`, { 'filter[locale]': args.locale }));
      const cur = list.find(l => l.locale === args.locale);
      if (!cur) throw new Error(`Locale ${args.locale} not found on app info ${info.id}.`);
      await ctx.client.delete(`/v1/appInfoLocalizations/${cur.id}`);
      return { deleted: { locale: args.locale, id: cur.id } };
    },
  },

  // ----------------------------------------------------------------- age rating
  {
    name: 'get_age_rating',
    description: 'Show the age rating questionnaire answers (ageRatingDeclaration) for the editable app info and the resulting App Store age rating.',
    inputSchema: { type: 'object', properties: { app: S.app, app_info_id: { type: 'string' } }, required: ['app'] },
    annotations: { title: 'Get age rating', readOnlyHint: true },
    async handler(args, ctx) {
      const { id: appId } = await resolveApp(ctx, args.app);
      const info = await getAppInfoById(ctx, args, appId);
      const decl = await getOptional(ctx, `/v1/appInfos/${info.id}/ageRatingDeclaration`);
      return { appInfoId: info.id, appStoreAgeRating: info.appStoreAgeRating, declaration: decl };
    },
  },
  {
    name: 'set_age_rating',
    description:
      'Answer the age rating questionnaire (only fields you pass are changed). Frequency fields take NONE | INFREQUENT_OR_MILD | FREQUENT_OR_INTENSE; others are booleans. All questions must have an answer before submission. advertising=true if the app shows ads. kidsAgeBand only for the Kids category. Applies to the editable app info (new version in progress).',
    inputSchema: { type: 'object', properties: { app: S.app, app_info_id: { type: 'string' }, ...ageRatingProps }, required: ['app'] },
    annotations: { title: 'Set age rating', idempotentHint: true },
    async handler(args, ctx) {
      const { id: appId } = await resolveApp(ctx, args.app);
      const info = await getAppInfoById(ctx, args, appId);
      const attributes: Record<string, any> = {};
      for (const k of Object.keys(ageRatingProps)) if (args[k] !== undefined) attributes[k] = args[k];
      if (!Object.keys(attributes).length) throw new Error(`Pass at least one questionnaire field: ${Object.keys(ageRatingProps).join(', ')}`);
      const decl = await getOptional(ctx, `/v1/appInfos/${info.id}/ageRatingDeclaration`, { 'fields[ageRatingDeclarations]': 'advertising' });
      if (!decl) throw new Error(`App info ${info.id} has no age rating declaration.`);
      const doc = await ctx.client.patch(`/v1/ageRatingDeclarations/${decl.id}`, { data: { type: 'ageRatingDeclarations', id: decl.id, attributes } });
      return { appInfoId: info.id, updated: Object.keys(attributes), declaration: compact(doc.data as JsonApiResource) };
    },
  },

  // ----------------------------------------------------------------- versions
  {
    name: 'list_versions',
    description: 'List App Store versions (newest first) with state, release type, and attached build. States: PREPARE_FOR_SUBMISSION/REJECTED/etc. are editable; WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE, READY_FOR_DISTRIBUTION (live) are not.',
    inputSchema: { type: 'object', properties: { app: S.app, platform: { ...S.platform, description: 'Only this platform (default all)' }, limit: S.limit }, required: ['app'] },
    annotations: { title: 'List versions', readOnlyHint: true },
    async handler(args, ctx) {
      const { id } = await resolveApp(ctx, args.app);
      const { versions, included } = await listVersions(ctx, id, args.platform, 'build');
      const builds = new Map(included.filter(i => i.type === 'builds').map(b => [b.id, b]));
      return versions.slice(0, args.limit ?? 50).map(v => {
        const b = builds.get(v.relationships?.build as string);
        return { ...versionSummary(v), build: b ? { id: b.id, buildNumber: b.version, processingState: b.processingState } : null };
      });
    },
  },
  {
    name: 'create_version',
    description:
      'Create a new App Store version (e.g. 1.1.0) for a platform. Only one unreleased version per platform may exist at a time. Apple copies localized metadata and screenshots from the previous version. Optionally attach a build in the same call. releaseType: MANUAL (you call release_version), AFTER_APPROVAL (auto), SCHEDULED (needs earliestReleaseDate, ISO 8601).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        platform: S.platform,
        versionString: { type: 'string', description: 'Version like 1.2.0 (must be higher than the live version)' },
        copyright: { type: 'string', description: 'e.g. "2026 Your Company"' },
        releaseType: { type: 'string', enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] },
        earliestReleaseDate: { type: 'string', description: 'ISO 8601 date-time, for SCHEDULED' },
        build_id: { type: 'string', description: 'Optional build id to attach right away (see attach_build for picking by number)' },
      },
      required: ['app', 'versionString'],
    },
    annotations: { title: 'Create version' },
    async handler(args, ctx) {
      const { id: appId } = await resolveApp(ctx, args.app);
      if (args.releaseType === 'SCHEDULED' && !args.earliestReleaseDate) throw new Error('releaseType SCHEDULED needs earliestReleaseDate (ISO 8601).');
      const relationships: Record<string, any> = { app: rel('apps', appId) };
      if (args.build_id) relationships.build = rel('builds', args.build_id);
      const doc = await ctx.client.post('/v1/appStoreVersions', {
        data: {
          type: 'appStoreVersions',
          attributes: defined({ platform: args.platform ?? 'IOS', versionString: args.versionString, copyright: args.copyright, releaseType: args.releaseType, earliestReleaseDate: args.earliestReleaseDate }),
          relationships,
        },
      });
      return versionSummary(compact(doc.data as JsonApiResource));
    },
  },
  {
    name: 'update_version',
    description:
      'Update an App Store version: versionString, copyright, releaseType (MANUAL/AFTER_APPROVAL/SCHEDULED), earliestReleaseDate. Only editable versions (PREPARE_FOR_SUBMISSION, REJECTED, ...) can change; releaseType can also change while WAITING_FOR_REVIEW. Defaults to the newest editable version.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        ...versionInput,
        versionString: { type: 'string', description: 'New version string' },
        copyright: { type: 'string' },
        releaseType: { type: 'string', enum: ['MANUAL', 'AFTER_APPROVAL', 'SCHEDULED'] },
        earliestReleaseDate: { type: ['string', 'null'], description: 'ISO 8601 date-time (SCHEDULED); null to clear' },
      },
      required: ['app'],
    },
    annotations: { title: 'Update version', idempotentHint: true },
    async handler(args, ctx) {
      const { version } = await pickVersion(ctx, args);
      if (args.releaseType === 'SCHEDULED' && !args.earliestReleaseDate && !version.earliestReleaseDate) throw new Error('releaseType SCHEDULED needs earliestReleaseDate (ISO 8601).');
      const attributes = defined({ versionString: args.versionString, copyright: args.copyright, releaseType: args.releaseType, earliestReleaseDate: args.earliestReleaseDate });
      if (!Object.keys(attributes).length) throw new Error('Pass at least one field to change.');
      const doc = await ctx.client.patch(`/v1/appStoreVersions/${version.id}`, { data: { type: 'appStoreVersions', id: version.id, attributes } });
      return versionSummary(compact(doc.data as JsonApiResource));
    },
  },
  {
    name: 'delete_version',
    description: 'Delete an App Store version that has never been submitted (PREPARE_FOR_SUBMISSION). Its metadata and screenshots are lost. Versions that were submitted, rejected or released cannot be deleted.',
    inputSchema: { type: 'object', properties: { app: S.app, ...versionInput, confirm: S.confirm }, required: ['app'] },
    annotations: { title: 'Delete version', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting an App Store version');
      const { version } = await pickVersion(ctx, args, ['PREPARE_FOR_SUBMISSION']);
      if (stateOf(version) !== 'PREPARE_FOR_SUBMISSION') throw new Error(`Version ${version.versionString} is ${stateOf(version)}; only PREPARE_FOR_SUBMISSION versions can be deleted.`);
      await ctx.client.delete(`/v1/appStoreVersions/${version.id}`);
      return { deleted: versionSummary(version) };
    },
  },

  // ----------------------------------------------------------------- version localizations
  {
    name: 'get_version_localizations',
    description: 'Show the per-locale store listing of a version: description, keywords, whatsNew, promotionalText, marketingUrl, supportUrl, with character counts vs. limits. Defaults to the newest editable version; pass version to read a live one.',
    inputSchema: { type: 'object', properties: { app: S.app, ...versionInput, locale: { type: 'string', description: 'Only this locale' } }, required: ['app'] },
    annotations: { title: 'Get version localizations', readOnlyHint: true },
    async handler(args, ctx) {
      const { version } = await pickVersion(ctx, args, 'preferEditable');
      const q: Record<string, any> = { limit: 200 };
      if (args.locale) q['filter[locale]'] = args.locale;
      const locs = compactList(await ctx.client.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, q));
      return {
        version: versionSummary(version),
        localizations: locs.map(({ type, relationships, ...l }) => ({
          ...l,
          lengths: Object.fromEntries(['description', 'keywords', 'whatsNew', 'promotionalText'].filter(k => l[k]).map(k => [k, `${len(l[k])}/${LIMITS[k]}`])),
        })),
      };
    },
  },
  {
    name: 'set_version_localizations',
    description:
      'Bulk upsert the store listing per locale for a version: description, keywords (max 100 chars), whatsNew, promotionalText (max 170), marketingUrl, supportUrl. Creates missing locales, patches only fields you pass. Text limits are checked before sending. whatsNew is skipped on an app\'s first version. Only editable versions accept changes, except promotionalText (pass version= the live version string). For a new language also add name/subtitle with set_app_info_localizations.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        ...versionInput,
        localizations: { type: 'array', items: { type: 'object', properties: versionLocProps, required: ['locale'] }, description: 'One entry per locale' },
      },
      required: ['app', 'localizations'],
    },
    annotations: { title: 'Set store listing per locale', idempotentHint: true },
    async handler(args, ctx) {
      const promoOnly = (args.localizations as any[]).every(l => Object.keys(l).every(k => k === 'locale' || k === 'promotionalText'));
      const { appId, version } = await pickVersion(ctx, args, promoOnly || args.version ? 'preferEditable' : undefined);
      const warnings: string[] = [];
      let firstVersion = false;
      if ((args.localizations as any[]).some(l => l.whatsNew !== undefined)) {
        const aid = appId ?? (await getVersion(ctx, version.id, 'app')).version.relationships?.app;
        const { versions } = await listVersions(ctx, aid as string, version.platform);
        firstVersion = versions.length <= 1;
        if (firstVersion) warnings.push('whatsNew was skipped: it is not allowed on the first version of an app.');
      }
      const existing = compactList(await ctx.client.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, { limit: 200 }));
      const results: any[] = [];
      for (const l of args.localizations as any[]) {
        try {
          const attributes = defined({
            description: l.description,
            keywords: l.keywords,
            whatsNew: firstVersion ? undefined : l.whatsNew,
            promotionalText: l.promotionalText,
            marketingUrl: l.marketingUrl,
            supportUrl: l.supportUrl,
          });
          checkLimits(l.locale, attributes);
          const cur = existing.find(e => e.locale === l.locale);
          if (cur) {
            if (!Object.keys(attributes).length) {
              results.push({ locale: l.locale, action: 'unchanged' });
              continue;
            }
            await ctx.client.patch(`/v1/appStoreVersionLocalizations/${cur.id}`, { data: { type: 'appStoreVersionLocalizations', id: cur.id, attributes } });
            results.push({ locale: l.locale, action: 'updated', id: cur.id, fields: Object.keys(attributes) });
          } else {
            const doc = await ctx.client.post('/v1/appStoreVersionLocalizations', {
              data: { type: 'appStoreVersionLocalizations', attributes: { locale: l.locale, ...attributes }, relationships: { appStoreVersion: rel('appStoreVersions', version.id) } },
            });
            results.push({ locale: l.locale, action: 'created', id: (doc.data as JsonApiResource).id, fields: Object.keys(attributes) });
          }
        } catch (e: any) {
          results.push({ locale: l.locale, action: 'failed', error: e.message });
        }
      }
      return { version: versionSummary(version), results, failed: results.filter(r => r.action === 'failed').length, warnings: warnings.length ? warnings : undefined };
    },
  },
  {
    name: 'delete_version_localization',
    description: 'Remove a locale (description, keywords, screenshots for that locale) from an editable version. The primary locale cannot be removed.',
    inputSchema: { type: 'object', properties: { app: S.app, ...versionInput, locale: S.locale, confirm: S.confirm }, required: ['app', 'locale'] },
    annotations: { title: 'Delete version locale', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, `Deleting version locale ${args.locale}`);
      const app = await resolveApp(ctx, args.app);
      if (args.locale === app.primaryLocale) throw new Error(`${args.locale} is the primary locale and cannot be removed. Change primaryLocale with update_app first.`);
      const { version } = await pickVersion(ctx, { ...args, app: app.id });
      const list = compactList(await ctx.client.get(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`, { 'filter[locale]': args.locale }));
      const cur = list.find(l => l.locale === args.locale);
      if (!cur) throw new Error(`Locale ${args.locale} not found on version ${version.versionString}.`);
      await ctx.client.delete(`/v1/appStoreVersionLocalizations/${cur.id}`);
      return { deleted: { locale: args.locale, id: cur.id, version: version.versionString } };
    },
  },

  // ----------------------------------------------------------------- build, review details
  {
    name: 'attach_build',
    description:
      'Attach a processed build to an editable App Store version. Pick by build_id, or by build_number (CFBundleVersion) and/or build_version (CFBundleShortVersionString); default is the newest VALID, unexpired, App Store eligible build for the platform. Warns if the build lacks an export compliance answer. A build cannot be changed while the version is in review.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        ...versionInput,
        build_id: { type: 'string', description: 'Exact build id' },
        build_number: { type: 'string', description: 'Build number (CFBundleVersion), e.g. "42"' },
        build_version: { type: 'string', description: 'Marketing version of the build (CFBundleShortVersionString), e.g. "1.2.0"' },
      },
      required: ['app'],
    },
    annotations: { title: 'Attach build to version', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const { version } = await pickVersion(ctx, { ...args, app: app.id });
      const platform = version.platform ?? args.platform ?? 'IOS';
      let build: any;
      if (args.build_id) {
        const doc = await ctx.client.get(`/v1/builds/${args.build_id}`, { include: 'preReleaseVersion' });
        build = buildSummary(compact(doc.data as JsonApiResource), (doc.included ?? []).map(compact)[0]);
        if (build.processingState !== 'VALID') throw new Error(`Build ${build.buildNumber} is ${build.processingState}; only VALID builds can be attached.`);
        if (build.expired) throw new Error(`Build ${build.buildNumber} has expired.`);
      } else {
        const q: Record<string, any> = {
          'filter[app]': app.id,
          'filter[processingState]': 'VALID',
          'filter[expired]': false,
          'filter[preReleaseVersion.platform]': platform,
          sort: '-uploadedDate',
          limit: 20,
          include: 'preReleaseVersion',
        };
        if (args.build_number) q['filter[version]'] = args.build_number;
        if (args.build_version) q['filter[preReleaseVersion.version]'] = args.build_version;
        const doc = await ctx.client.get('/v1/builds', q);
        const pre = new Map((doc.included ?? []).map(x => [x.id, compact(x)]));
        const candidates = compactList(doc)
          .filter(b => b.buildAudienceType !== 'INTERNAL_ONLY')
          .map(b => buildSummary(b, pre.get(b.relationships?.preReleaseVersion as string)));
        if (!candidates.length) {
          throw new Error(`No VALID, unexpired, App Store eligible ${platform} build${args.build_number ? ` with number ${args.build_number}` : ''}${args.build_version ? ` for version ${args.build_version}` : ''}. Upload one, or wait for processing to finish.`);
        }
        build = candidates[0];
      }
      await ctx.client.patch(`/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: 'builds', id: build.id } });
      const warnings: string[] = [];
      if (build.usesNonExemptEncryption === null || build.usesNonExemptEncryption === undefined) warnings.push('Build has no export compliance answer (usesNonExemptEncryption); set it before submitting.');
      if (build.version && build.version !== version.versionString && !String(build.version).startsWith(version.versionString)) warnings.push(`Build marketing version ${build.version} differs from App Store version ${version.versionString}.`);
      return { version: versionSummary(version), attached: build, warnings: warnings.length ? warnings : undefined };
    },
  },
  {
    name: 'set_review_details',
    description:
      'Create or update the App Review information for a version: contact first/last name, phone (with country code, e.g. +1 555...), email, demo account (name/password/required), and notes for the reviewer. Only fields you pass change. If demoAccountRequired is true, name and password must be set.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        ...versionInput,
        contactFirstName: { type: 'string' },
        contactLastName: { type: 'string' },
        contactPhone: { type: 'string' },
        contactEmail: { type: 'string' },
        demoAccountName: { type: 'string' },
        demoAccountPassword: { type: 'string' },
        demoAccountRequired: { type: 'boolean' },
        notes: { type: 'string', description: 'Notes for the reviewer (max 4000 chars)' },
      },
      required: ['app'],
    },
    annotations: { title: 'Set App Review details', idempotentHint: true },
    async handler(args, ctx) {
      const { version } = await pickVersion(ctx, args);
      const attributes = defined({
        contactFirstName: args.contactFirstName,
        contactLastName: args.contactLastName,
        contactPhone: args.contactPhone,
        contactEmail: args.contactEmail,
        demoAccountName: args.demoAccountName,
        demoAccountPassword: args.demoAccountPassword,
        demoAccountRequired: args.demoAccountRequired,
        notes: args.notes,
      });
      if (!Object.keys(attributes).length) throw new Error('Pass at least one field.');
      const { included } = await getVersion(ctx, version.id, 'appStoreReviewDetail');
      const cur = included.find(i => i.type === 'appStoreReviewDetails');
      const demoRequired = attributes.demoAccountRequired ?? cur?.demoAccountRequired;
      if (demoRequired && !(attributes.demoAccountName ?? cur?.demoAccountName)) throw new Error('demoAccountRequired is true: pass demoAccountName and demoAccountPassword.');
      let doc;
      if (cur) doc = await ctx.client.patch(`/v1/appStoreReviewDetails/${cur.id}`, { data: { type: 'appStoreReviewDetails', id: cur.id, attributes } });
      else doc = await ctx.client.post('/v1/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes, relationships: { appStoreVersion: rel('appStoreVersions', version.id) } } });
      const out = compact(doc.data as JsonApiResource);
      if (out.demoAccountPassword) out.demoAccountPassword = '***';
      return { version: version.versionString, action: cur ? 'updated' : 'created', reviewDetail: out };
    },
  },

  // ----------------------------------------------------------------- release
  {
    name: 'set_phased_release',
    description:
      'Control the 7-day phased release (gradual automatic-update rollout) of a version. enable: turn on before release (version not yet live). pause / resume: during rollout (pause max 30 days total). complete: release to all users immediately (confirm). disable: turn off before release. New downloads always get the latest version; phased release only affects automatic updates.',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, ...versionInput, action: { type: 'string', enum: ['enable', 'pause', 'resume', 'complete', 'disable', 'status'] }, confirm: S.confirm },
      required: ['app', 'action'],
    },
    annotations: { title: 'Phased release' },
    async handler(args, ctx) {
      const states = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'INVALID_BINARY', 'PENDING_DEVELOPER_RELEASE', 'PENDING_APPLE_RELEASE', 'READY_FOR_DISTRIBUTION', 'READY_FOR_SALE', 'PROCESSING_FOR_DISTRIBUTION'];
      const { version } = await pickVersion(ctx, args, states);
      const cur = await getOptional(ctx, `/v1/appStoreVersions/${version.id}/appStoreVersionPhasedRelease`);
      const show = (p: any) => (p ? { id: p.id, state: p.phasedReleaseState, startDate: p.startDate ?? undefined, currentDayNumber: p.currentDayNumber ?? undefined, totalPauseDuration: p.totalPauseDuration ?? undefined } : null);
      const target: Record<string, string> = { pause: 'PAUSED', resume: 'ACTIVE', complete: 'COMPLETE' };
      switch (args.action) {
        case 'status':
          return { version: versionSummary(version), phasedRelease: show(cur) };
        case 'enable': {
          if (cur) return { version: versionSummary(version), note: 'Phased release already exists', phasedRelease: show(cur) };
          const doc = await ctx.client.post('/v1/appStoreVersionPhasedReleases', {
            data: { type: 'appStoreVersionPhasedReleases', attributes: { phasedReleaseState: 'INACTIVE' }, relationships: { appStoreVersion: rel('appStoreVersions', version.id) } },
          });
          return { version: versionSummary(version), action: 'enabled (starts when the version is released)', phasedRelease: show(compact(doc.data as JsonApiResource)) };
        }
        case 'disable': {
          if (!cur) return { version: versionSummary(version), note: 'No phased release to disable' };
          if (cur.phasedReleaseState !== 'INACTIVE') throw new Error(`Phased release is ${cur.phasedReleaseState}; it can only be removed before release. Use complete to release to everyone.`);
          await ctx.client.delete(`/v1/appStoreVersionPhasedReleases/${cur.id}`);
          return { version: versionSummary(version), action: 'disabled' };
        }
        case 'pause':
        case 'resume':
        case 'complete': {
          if (args.action === 'complete') requireConfirm(args, 'Releasing the update to all users now');
          if (!cur) throw new Error(`Version ${version.versionString} has no phased release.`);
          const doc = await ctx.client.patch(`/v1/appStoreVersionPhasedReleases/${cur.id}`, { data: { type: 'appStoreVersionPhasedReleases', id: cur.id, attributes: { phasedReleaseState: target[args.action] } } });
          return { version: versionSummary(version), action: args.action, phasedRelease: show(compact(doc.data as JsonApiResource)) };
        }
        default:
          throw new Error('action must be enable, pause, resume, complete, disable or status');
      }
    },
  },
  {
    name: 'release_version',
    description: 'Release an approved version that is waiting for manual release (state PENDING_DEVELOPER_RELEASE) to the App Store now. Public and irreversible. If phased release is enabled, the 7-day rollout starts.',
    inputSchema: { type: 'object', properties: { app: S.app, ...versionInput, confirm: S.confirm }, required: ['app'] },
    annotations: { title: 'Release version', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Releasing the version to the App Store');
      const { version } = await pickVersion(ctx, args, ['PENDING_DEVELOPER_RELEASE']);
      if (stateOf(version) !== 'PENDING_DEVELOPER_RELEASE') throw new Error(`Version ${version.versionString} is ${stateOf(version)}; only PENDING_DEVELOPER_RELEASE versions can be released manually.`);
      const doc = await ctx.client.post('/v1/appStoreVersionReleaseRequests', { data: { type: 'appStoreVersionReleaseRequests', relationships: { appStoreVersion: rel('appStoreVersions', version.id) } } });
      return { released: versionSummary(version), releaseRequestId: (doc.data as JsonApiResource)?.id, note: 'The version can take a few hours to appear on the App Store.' };
    },
  },

  // ----------------------------------------------------------------- review submission
  {
    name: 'check_submission_readiness',
    description:
      'Read-only preflight before submit_for_review. Checks: version state, build attached/VALID/not expired/export compliance, review contact details, copyright, per-locale description/keywords/supportUrl and text limits, screenshots per locale (iPhone required, iPad warning), app name & privacy policy URL, primary category, age rating questionnaire, content rights, price schedule, conflicting submissions. Returns blockers (must fix) and warnings.',
    inputSchema: { type: 'object', properties: { app: S.app, ...versionInput }, required: ['app'] },
    annotations: { title: 'Check submission readiness', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const { version } = await pickVersion(ctx, { ...args, app: app.id });
      return readiness(ctx, app.id, version);
    },
  },
  {
    name: 'submit_for_review',
    description:
      'Submit an App Store version to App Review (reviewSubmissions flow): runs check_submission_readiness first (refuses on blockers unless force: true), reuses an open draft or UNRESOLVED_ISSUES submission for the platform (resubmission after rejection) or creates one, adds the version as an item if missing, then submits. Public action: needs confirm. In-app purchases/subscriptions waiting in the same draft submission are submitted with it.',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, ...versionInput, force: { type: 'boolean', description: 'Submit even if the readiness check reports blockers' }, confirm: S.confirm },
      required: ['app'],
    },
    annotations: { title: 'Submit for review', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Submitting the version to App Review');
      const app = await resolveApp(ctx, args.app);
      const { version } = await pickVersion(ctx, { ...args, app: app.id });
      const platform = version.platform ?? args.platform ?? 'IOS';
      const check = await readiness(ctx, app.id, version);
      if (!check.ready && !args.force) {
        throw new Error(`Not ready for review:\n- ${check.blockers.join('\n- ')}\nFix these (or pass force: true if you are sure the check is wrong).`);
      }
      const subsDoc = await ctx.client.get('/v1/reviewSubmissions', { 'filter[app]': app.id, 'filter[platform]': platform, 'filter[state]': [...OPEN_SUBMISSION_STATES, 'WAITING_FOR_REVIEW', 'IN_REVIEW'].join(','), limit: 20 });
      const subs = compactList(subsDoc);
      const busy = subs.find(s => s.state === 'WAITING_FOR_REVIEW' || s.state === 'IN_REVIEW');
      let submission = subs.find(s => OPEN_SUBMISSION_STATES.includes(s.state));
      const steps: string[] = [];
      if (!submission) {
        if (busy) throw new Error(`A ${platform} submission (${busy.id}) is already ${busy.state}. Wait for it, or cancel it with cancel_review_submission.`);
        const doc = await ctx.client.post('/v1/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform }, relationships: { app: rel('apps', app.id) } } });
        submission = compact(doc.data as JsonApiResource);
        steps.push(`created review submission ${submission.id}`);
      } else {
        steps.push(`reusing ${submission.state} review submission ${submission.id}`);
      }
      let hasItem = false;
      if (!isDry(submission.id)) {
        const items = compactList(await ctx.client.get(`/v1/reviewSubmissions/${submission.id}/items`, { include: 'appStoreVersion', 'fields[appStoreVersions]': 'versionString', limit: 50 }));
        hasItem = items.some(i => i.relationships?.appStoreVersion === version.id && i.state !== 'REMOVED');
      }
      if (!hasItem) {
        await ctx.client.post('/v1/reviewSubmissionItems', {
          data: { type: 'reviewSubmissionItems', relationships: { reviewSubmission: rel('reviewSubmissions', submission.id), appStoreVersion: rel('appStoreVersions', version.id) } },
        });
        steps.push(`added version ${version.versionString} to the submission`);
      } else steps.push(`version ${version.versionString} already in the submission`);
      const doc = await ctx.client.patch(`/v1/reviewSubmissions/${submission.id}`, { data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } });
      steps.push('submitted');
      return { submission: compact(doc.data as JsonApiResource), version: versionSummary(version), steps, warnings: check.warnings };
    },
  },
  {
    name: 'list_review_submissions',
    description: 'List review submissions for an app (newest first) with state (READY_FOR_REVIEW = draft, WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES = rejected/needs action, COMPLETE) and their items (versions, in-app purchases, events...). Rejection messages are only visible in App Store Connect Resolution Center.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        platform: { ...S.platform, description: 'Only this platform' },
        state: { type: 'array', items: { type: 'string', enum: ['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES', 'CANCELING', 'COMPLETING', 'COMPLETE'] }, description: 'Only these states' },
        limit: { type: 'number', description: 'Max submissions (default 10)' },
      },
      required: ['app'],
    },
    annotations: { title: 'List review submissions', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const q: Record<string, any> = { 'filter[app]': app.id, limit: Math.min(args.limit ?? 10, 50) };
      if (args.platform) q['filter[platform]'] = args.platform;
      if (args.state?.length) q['filter[state]'] = args.state.join(',');
      const subs = compactList(await ctx.client.get('/v1/reviewSubmissions', q));
      return Promise.all(subs.map(s => submissionWithItems(ctx, s)));
    },
  },
  {
    name: 'cancel_review_submission',
    description: 'Cancel (withdraw) a review submission that is WAITING_FOR_REVIEW, IN_REVIEW, UNRESOLVED_ISSUES or a draft. The version returns to an editable state (DEVELOPER_REJECTED). Pass submission_id, or app+platform to cancel the active one.',
    inputSchema: { type: 'object', properties: { app: S.app, platform: S.platform, submission_id: { type: 'string' }, confirm: S.confirm }, required: ['app'] },
    annotations: { title: 'Cancel review submission', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Cancelling the review submission');
      let id = args.submission_id;
      let found: any;
      if (!id) {
        const app = await resolveApp(ctx, args.app);
        const subs = compactList(await ctx.client.get('/v1/reviewSubmissions', { 'filter[app]': app.id, 'filter[platform]': args.platform ?? 'IOS', 'filter[state]': ACTIVE_SUBMISSION_STATES.join(','), limit: 10 }));
        found = subs.find(s => s.state !== 'READY_FOR_REVIEW') ?? subs[0];
        if (!found) throw new Error(`No active ${args.platform ?? 'IOS'} review submission to cancel.`);
        id = found.id;
      }
      const doc = await ctx.client.patch(`/v1/reviewSubmissions/${id}`, { data: { type: 'reviewSubmissions', id, attributes: { canceled: true } } });
      return { canceled: id, previousState: found?.state, result: compact(doc.data as JsonApiResource) };
    },
  },

  // ----------------------------------------------------------------- EULA
  {
    name: 'get_eula',
    description: 'Show the app\'s custom End User License Agreement and its territories. null means Apple\'s standard EULA applies.',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'Get custom EULA', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const eula = await getOptional(ctx, `/v1/apps/${app.id}/endUserLicenseAgreement`);
      if (!eula) return { eula: null, note: "Apple's standard EULA applies." };
      const terr = await ctx.client.getAll(`/v1/endUserLicenseAgreements/${eula.id}/territories`, { 'fields[territories]': 'currency' }, 200).catch(() => null);
      return { eula: { id: eula.id, agreementText: eula.agreementText, territories: terr ? terr.data.map(t => t.id) : undefined } };
    },
  },
  {
    name: 'set_eula',
    description:
      'Create or replace the app\'s custom EULA text and/or the territories it applies to (territory codes like USA, GBR, DEU). On create, territories default to all territories. Applies immediately (not tied to a version).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        agreementText: { type: 'string', description: 'Full license text' },
        territories: { type: 'array', items: { type: 'string' }, description: 'Territory codes (ISO 3166-1 alpha-3). Default on create: all.' },
      },
      required: ['app'],
    },
    annotations: { title: 'Set custom EULA', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const cur = await getOptional(ctx, `/v1/apps/${app.id}/endUserLicenseAgreement`);
      const territoryRel = (ids: string[]) => rels('territories', ids.map(t => t.toUpperCase()));
      if (cur) {
        if (args.agreementText === undefined && !args.territories) throw new Error('Pass agreementText and/or territories.');
        const body: any = { data: { type: 'endUserLicenseAgreements', id: cur.id, attributes: defined({ agreementText: args.agreementText }) } };
        if (args.territories) body.data.relationships = { territories: territoryRel(args.territories) };
        await ctx.client.patch(`/v1/endUserLicenseAgreements/${cur.id}`, body);
        return { action: 'updated', id: cur.id, territories: args.territories?.length ?? 'unchanged' };
      }
      if (!args.agreementText) throw new Error('agreementText is required to create a custom EULA.');
      const territories: string[] = args.territories ?? (await ctx.client.getAll('/v1/territories', { 'fields[territories]': 'currency' }, 500)).data.map(t => t.id);
      const doc = await ctx.client.post('/v1/endUserLicenseAgreements', {
        data: { type: 'endUserLicenseAgreements', attributes: { agreementText: args.agreementText }, relationships: { app: rel('apps', app.id), territories: territoryRel(territories) } },
      });
      return { action: 'created', id: (doc.data as JsonApiResource).id, territories: territories.length };
    },
  },
  {
    name: 'delete_eula',
    description: "Delete the app's custom EULA so Apple's standard EULA applies again.",
    inputSchema: { type: 'object', properties: { app: S.app, confirm: S.confirm }, required: ['app'] },
    annotations: { title: 'Delete custom EULA', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting the custom EULA');
      const app = await resolveApp(ctx, args.app);
      const cur = await getOptional(ctx, `/v1/apps/${app.id}/endUserLicenseAgreement`);
      if (!cur) return { note: 'No custom EULA; nothing to delete.' };
      await ctx.client.delete(`/v1/endUserLicenseAgreements/${cur.id}`);
      return { deleted: cur.id };
    },
  },
];

