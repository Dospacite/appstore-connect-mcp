/**
 * Monetization: app pricing & availability, in-app purchases, subscriptions,
 * offers (introductory, promotional, offer codes, win-back) and promoted purchases.
 */
import type { JsonApiDocument, JsonApiResource } from '../asc/client.js';
import { AscApiError } from '../asc/client.js';
import { compact, defined, rel, rels } from '../asc/format.js';
import { compactList, requireConfirm, resolveApp, saveOutput, S, uploadAsset } from './helpers.js';
import type { ToolContext, ToolDef } from './types.js';

// ---------------------------------------------------------------------------
// Constants & schema snippets
// ---------------------------------------------------------------------------

const IAP_TYPES = ['CONSUMABLE', 'NON_CONSUMABLE', 'NON_RENEWING_SUBSCRIPTION'];
const SUB_PERIODS = ['ONE_WEEK', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];
const OFFER_DURATIONS = ['THREE_DAYS', 'ONE_WEEK', 'TWO_WEEKS', 'ONE_MONTH', 'TWO_MONTHS', 'THREE_MONTHS', 'SIX_MONTHS', 'ONE_YEAR'];
const OFFER_MODES = ['FREE_TRIAL', 'PAY_AS_YOU_GO', 'PAY_UP_FRONT'];
const PLAN_TYPES = ['UPFRONT', 'MONTHLY'];

const T = {
  iap: { type: 'string', description: 'In-app purchase: its App Store Connect id, or its product id (then also pass app)' },
  subscription: { type: 'string', description: 'Auto-renewable subscription: its id, or its product id (then also pass app)' },
  group: { type: 'string', description: 'Subscription group: its id, or its reference name (then also pass app)' },
  appOptional: { ...S.app, description: 'App (id, bundle id or name). Needed only when iap/subscription/group is given by product id or reference name.' },
  territory: { type: 'string', description: 'Territory as 3-letter code (USA, GBR, DEU, JPN...). See list_territories.' },
  territories: {
    description: 'Territories: "all", or an array of 3-letter codes like ["USA","CAN","GBR"]',
    oneOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'string' } }],
  },
  exclude: { type: 'array', items: { type: 'string' }, description: 'Territory codes to leave out (applied after territories; implies territories "all" if territories is omitted)' },
  newTerritories: { type: 'boolean', description: 'Also make it available automatically in territories Apple adds in the future' },
  price: { type: ['string', 'number'], description: 'Customer price in the base territory currency, e.g. "0.99", 4.99, or 0 for free. Must match an Apple price point exactly (use find_price_points).' },
  baseTerritory: { type: 'string', description: 'Territory whose price you give; other territories are equalized from it (default USA)' },
  territoryPrices: {
    type: 'object',
    additionalProperties: { type: ['string', 'number'] },
    description: 'Optional manual overrides in other territories, in local currency: {"GBR":"0.99","JPN":"160"}. Otherwise Apple equalizes automatically.',
  },
  date: { type: 'string', description: 'Date YYYY-MM-DD' },
  planType: { type: 'string', enum: PLAN_TYPES, description: 'Subscription plan type: UPFRONT (standard billing, default) or MONTHLY (annual commitment billed monthly). Only set for MONTHLY plans.' },
  offerMode: {
    type: 'string',
    enum: OFFER_MODES,
    description: 'FREE_TRIAL (free for duration), PAY_AS_YOU_GO (discounted price each period for number_of_periods; duration = subscription period), PAY_UP_FRONT (one discounted payment for the whole duration)',
  },
  duration: { type: 'string', enum: OFFER_DURATIONS, description: 'Offer period length. FREE_TRIAL: any; PAY_UP_FRONT: ONE_MONTH..ONE_YEAR; PAY_AS_YOU_GO: the subscription period.' },
  periods: { type: 'number', description: 'Number of periods (PAY_AS_YOU_GO: 1-12 (or more for weekly); FREE_TRIAL and PAY_UP_FRONT: 1). Default 1.' },
  localizations: (withCustomAppName = false) => ({
    type: 'array',
    description: withCustomAppName
      ? 'Localizations: [{locale, name, custom_app_name?}]. Existing locales are updated, new ones created.'
      : 'Localizations: [{locale, name, description?}]. Display name max ~35 chars, description max ~55 chars. Existing locales are updated, new ones created.',
    items: {
      type: 'object',
      properties: withCustomAppName
        ? { locale: S.locale, name: { type: 'string' }, custom_app_name: { type: 'string' } }
        : { locale: S.locale, name: { type: 'string' }, description: { type: 'string' } },
      required: ['locale'],
    },
  }),
};

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const isDry = (id?: string) => !!id && id.startsWith('DRY_RUN_');
const inlineId = (name: string) => '${' + name + '}';

function checkDate(d: string | undefined, field: string): string | undefined {
  if (d === undefined || d === null || d === '') return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`${field} must be a date like 2026-12-31`);
  return d;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function tryGet(ctx: ToolContext, path: string, query?: Record<string, any>): Promise<JsonApiDocument | null> {
  try {
    return await ctx.client.get(path, query);
  } catch (e) {
    if (e instanceof AscApiError && e.status === 404) return null;
    throw e;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: Array<{ item: T; ok: boolean; value?: R; error?: string }> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { item: items[i], ok: true, value: await fn(items[i]) };
      } catch (e: any) {
        results[i] = { item: items[i], ok: false, error: e.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function includedMap(doc: { included?: JsonApiResource[] }): Map<string, JsonApiResource> {
  const m = new Map<string, JsonApiResource>();
  for (const r of doc.included ?? []) m.set(`${r.type}/${r.id}`, r);
  return m;
}

function relId(r: JsonApiResource, name: string): string | undefined {
  return r.relationships?.[name]?.data?.id;
}

function relIds(r: JsonApiResource, name: string): string[] {
  const d = r.relationships?.[name]?.data;
  return Array.isArray(d) ? d.map((x: any) => x.id) : [];
}

// ---------------------------------------------------------------------------
// Territories
// ---------------------------------------------------------------------------

let territoryCache: Array<{ id: string; currency?: string }> | undefined;

async function allTerritories(ctx: ToolContext) {
  if (!territoryCache) {
    const all = await ctx.client.getAll('/v1/territories', { limit: 200 }, 500);
    territoryCache = all.data.map(t => ({ id: t.id, currency: t.attributes?.currency }));
  }
  return territoryCache;
}

async function normTerritory(ctx: ToolContext, t: string | undefined, fallback = 'USA'): Promise<string> {
  const code = String(t ?? fallback).trim().toUpperCase();
  const known = await allTerritories(ctx);
  if (!known.some(k => k.id === code)) {
    throw new Error(`Unknown territory "${t}". Use 3-letter App Store territory codes like USA, GBR, DEU, JPN (see list_territories).`);
  }
  return code;
}

/** Resolve territories ("all" | list) minus exclusions into a validated list of codes. */
async function selectTerritories(ctx: ToolContext, territories: any, exclude?: string[], required = true): Promise<string[] | undefined> {
  if (territories === undefined && !exclude?.length) {
    if (required) throw new Error('Pass territories ("all" or a list like ["USA","GBR"]) and/or exclude_territories.');
    return undefined;
  }
  const known = (await allTerritories(ctx)).map(t => t.id);
  let list: string[];
  if (territories === undefined || territories === 'all' || (Array.isArray(territories) && territories.length === 1 && String(territories[0]).toLowerCase() === 'all')) {
    list = [...known];
  } else if (Array.isArray(territories)) {
    list = territories.map(t => String(t).trim().toUpperCase());
  } else if (typeof territories === 'string') {
    list = territories.split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  } else {
    throw new Error('territories must be "all" or an array of territory codes');
  }
  const unknown = list.filter(t => !known.includes(t));
  if (unknown.length) throw new Error(`Unknown territories: ${unknown.join(', ')}. Use 3-letter codes (list_territories).`);
  const ex = new Set((exclude ?? []).map(t => String(t).trim().toUpperCase()));
  const badEx = [...ex].filter(t => !known.includes(t));
  if (badEx.length) throw new Error(`Unknown territories in exclude_territories: ${badEx.join(', ')}`);
  return [...new Set(list)].filter(t => !ex.has(t));
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

async function resolveIap(ctx: ToolContext, args: any): Promise<any> {
  const ref = String(args.iap ?? '').trim();
  if (!ref) throw new Error('iap is required (in-app purchase id, or product id together with app)');
  if (args.app) {
    const app = await resolveApp(ctx, args.app);
    const doc = await ctx.client.get(`/v1/apps/${app.id}/inAppPurchasesV2`, { 'filter[productId]': ref, limit: 10 });
    const hit = compactList(doc).find(x => x.productId === ref);
    if (hit) return { ...hit, appId: app.id };
    if (!/^\d+$/.test(ref)) throw new Error(`No in-app purchase with product id "${ref}" in ${app.name}. Use list_in_app_purchases.`);
  }
  if (/^\d+$/.test(ref)) {
    const doc = await ctx.client.get(`/v2/inAppPurchases/${ref}`);
    return compact(doc.data as JsonApiResource);
  }
  throw new Error(`"${ref}" is not an in-app purchase id. Pass app too to look it up by product id.`);
}

async function resolveSubscription(ctx: ToolContext, args: any): Promise<any> {
  const ref = String(args.subscription ?? '').trim();
  if (!ref) throw new Error('subscription is required (subscription id, or product id together with app)');
  if (args.app) {
    const app = await resolveApp(ctx, args.app);
    const all = await ctx.client.getAll(`/v1/apps/${app.id}/subscriptionGroups`, { include: 'subscriptions', 'limit[subscriptions]': 50 }, 200);
    const hit = all.included.find(r => r.type === 'subscriptions' && (r.attributes?.productId === ref || r.id === ref));
    if (hit) return { ...compact(hit), appId: app.id };
    if (!/^\d+$/.test(ref)) throw new Error(`No subscription with product id "${ref}" in ${app.name}. Use list_subscription_groups.`);
  }
  if (/^\d+$/.test(ref)) {
    const doc = await ctx.client.get(`/v1/subscriptions/${ref}`, { include: 'group' });
    return compact(doc.data as JsonApiResource);
  }
  throw new Error(`"${ref}" is not a subscription id. Pass app too to look it up by product id.`);
}

async function resolveGroup(ctx: ToolContext, args: any): Promise<any> {
  const ref = String(args.group ?? '').trim();
  if (!ref) throw new Error('group is required (subscription group id, or reference name together with app)');
  if (/^\d+$/.test(ref)) {
    const doc = await ctx.client.get(`/v1/subscriptionGroups/${ref}`);
    return compact(doc.data as JsonApiResource);
  }
  if (!args.app) throw new Error('Pass app to look up a subscription group by reference name.');
  const app = await resolveApp(ctx, args.app);
  const doc = await ctx.client.get(`/v1/apps/${app.id}/subscriptionGroups`, { 'filter[referenceName]': ref, limit: 10 });
  const hit = compactList(doc).find(g => g.referenceName === ref);
  if (!hit) throw new Error(`No subscription group "${ref}" in ${app.name}. Use list_subscription_groups.`);
  return hit;
}

// ---------------------------------------------------------------------------
// Price points
// ---------------------------------------------------------------------------

type Kind = 'app' | 'iap' | 'subscription';

const PP: Record<Kind, { list: (id: string) => string; eq: (pp: string) => string; type: string; pageLimit: number }> = {
  app: { list: id => `/v1/apps/${id}/appPricePoints`, eq: pp => `/v3/appPricePoints/${pp}/equalizations`, type: 'appPricePoints', pageLimit: 200 },
  iap: { list: id => `/v2/inAppPurchases/${id}/pricePoints`, eq: pp => `/v1/inAppPurchasePricePoints/${pp}/equalizations`, type: 'inAppPurchasePricePoints', pageLimit: 8000 },
  subscription: { list: id => `/v1/subscriptions/${id}/pricePoints`, eq: pp => `/v1/subscriptionPricePoints/${pp}/equalizations`, type: 'subscriptionPricePoints', pageLimit: 8000 },
};

interface PricePointRow {
  id: string;
  territory: string;
  customerPrice: string;
  proceeds?: string;
  proceedsYear2?: string;
}

function decodeTerritory(id: string): string | undefined {
  try {
    return JSON.parse(Buffer.from(id, 'base64url').toString('utf-8')).t;
  } catch {
    return undefined;
  }
}

function ppRow(r: JsonApiResource): PricePointRow {
  return defined({
    id: r.id,
    territory: relId(r, 'territory') ?? decodeTerritory(r.id) ?? '?',
    customerPrice: r.attributes?.customerPrice,
    proceeds: r.attributes?.proceeds,
    proceedsYear2: r.attributes?.proceedsYear2 ?? undefined,
  }) as PricePointRow;
}

const num = (v: any) => Number(String(v).replace(',', '.'));

async function listPricePoints(ctx: ToolContext, kind: Kind, ownerId: string, territory: string): Promise<PricePointRow[]> {
  const p = PP[kind];
  const all = await ctx.client.getAll(p.list(ownerId), { 'filter[territory]': territory, include: 'territory', limit: p.pageLimit }, 20000);
  return all.data.map(ppRow).sort((a, b) => num(a.customerPrice) - num(b.customerPrice));
}

function nearest(rows: PricePointRow[], target: number, count: number) {
  return [...rows].sort((a, b) => Math.abs(num(a.customerPrice) - target) - Math.abs(num(b.customerPrice) - target)).slice(0, count);
}

async function findPricePoint(ctx: ToolContext, kind: Kind, ownerId: string, territory: string, price: any): Promise<PricePointRow> {
  if (price === undefined || price === null || price === '' || !Number.isFinite(num(price))) throw new Error('price is required, e.g. "0.99" or 0 for free');
  const target = num(price);
  const rows = await listPricePoints(ctx, kind, ownerId, territory);
  const hit = rows.find(r => Math.abs(num(r.customerPrice) - target) < 0.0001);
  if (hit) return hit;
  const near = nearest(rows, target, 6).map(r => r.customerPrice).sort((a, b) => num(a) - num(b));
  throw new Error(`No ${kind} price point of ${price} in ${territory}. Nearest valid prices: ${near.join(', ')}. Use find_price_points for the full list.`);
}

async function equalizations(ctx: ToolContext, kind: Kind, ppId: string, territories?: string[]): Promise<Map<string, PricePointRow>> {
  const p = PP[kind];
  const q: Record<string, any> = { include: 'territory', limit: p.pageLimit };
  if (territories?.length && territories.length < 50) q['filter[territory]'] = territories.join(',');
  const all = await ctx.client.getAll(p.eq(ppId), q, 20000);
  const m = new Map<string, PricePointRow>();
  for (const r of all.data) {
    const row = ppRow(r);
    m.set(row.territory, row);
  }
  return m;
}

/**
 * Price points for a set of territories: base territory price + equalized
 * prices elsewhere, with optional per-territory overrides.
 */
async function pricePointsForTerritories(
  ctx: ToolContext,
  kind: Kind,
  ownerId: string,
  opts: { baseTerritory: string; price: any; territories: string[]; overrides?: Record<string, any> },
): Promise<{ base: PricePointRow; rows: PricePointRow[]; missing: string[] }> {
  const base = await findPricePoint(ctx, kind, ownerId, opts.baseTerritory, opts.price);
  const others = opts.territories.filter(t => t !== opts.baseTerritory);
  const eq = others.length ? await equalizations(ctx, kind, base.id, others) : new Map<string, PricePointRow>();
  const rows: PricePointRow[] = opts.territories.includes(opts.baseTerritory) ? [base] : [];
  const missing: string[] = [];
  for (const t of others) {
    const r = eq.get(t);
    if (r) rows.push(r);
    else missing.push(t);
  }
  for (const [t0, p] of Object.entries(opts.overrides ?? {})) {
    const t = await normTerritory(ctx, t0);
    const r = await findPricePoint(ctx, kind, ownerId, t, p);
    const i = rows.findIndex(x => x.territory === t);
    if (i >= 0) rows[i] = r;
    else rows.push(r);
    const mi = missing.indexOf(t);
    if (mi >= 0) missing.splice(mi, 1);
  }
  return { base, rows, missing };
}

/** Rows of scheduled prices joined with their price points. */
function priceRows(doc: { data?: any; included?: JsonApiResource[] }, ppRel: string) {
  const inc = includedMap(doc);
  const list: JsonApiResource[] = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
  return list.map(p => {
    const ppId = relId(p, ppRel);
    const pp = ppId ? [...inc.values()].find(r => r.id === ppId && r.type.endsWith('PricePoints')) : undefined;
    return defined({
      territory: relId(p, 'territory') ?? (ppId ? decodeTerritory(ppId) : undefined),
      customerPrice: pp?.attributes?.customerPrice,
      proceeds: pp?.attributes?.proceeds,
      startDate: p.attributes?.startDate ?? undefined,
      endDate: p.attributes?.endDate ?? undefined,
      manual: p.attributes?.manual,
      preserved: p.attributes?.preserved,
      planType: p.attributes?.planType ?? undefined,
      pricePointId: ppId,
    });
  });
}

function activeAt<T extends { startDate?: string; endDate?: string }>(rows: T[], date = today()): T[] {
  return rows.filter(r => (!r.startDate || r.startDate <= date) && (!r.endDate || r.endDate > date));
}

// ---------------------------------------------------------------------------
// Localization upsert (shared by IAPs, subscriptions, groups)
// ---------------------------------------------------------------------------

async function upsertLocalizations(
  ctx: ToolContext,
  p: { listPath: string; type: string; parentRel: string; parentType: string; parentId: string; items: any[]; map: (item: any) => Record<string, any>; required: string[] },
) {
  if (!Array.isArray(p.items) || !p.items.length) throw new Error('localizations must be a non-empty array of {locale, name, ...}');
  const existing = isDry(p.parentId) ? [] : (await ctx.client.getAll(p.listPath, { limit: 200 }, 500)).data.map(compact);
  // Validate everything first so a bad entry does not leave a half-applied batch.
  for (const item of p.items) {
    const locale = String(item.locale ?? '').trim();
    if (!locale) throw new Error('Each localization needs a locale');
    const attrs = defined(p.map(item));
    if (!existing.some(e => e.locale === locale)) {
      const missing = p.required.filter(k => attrs[k] === undefined);
      if (missing.length) throw new Error(`Locale ${locale} does not exist yet; creating it needs: ${missing.join(', ')}. Nothing was changed.`);
    }
  }
  const out: any[] = [];
  for (const item of p.items) {
    const locale = String(item.locale).trim();
    const attrs = defined(p.map(item));
    const found = existing.find(e => e.locale === locale);
    if (found) {
      const changed = Object.entries(attrs).some(([k, v]) => found[k] !== v);
      if (!changed) {
        out.push({ locale, action: 'unchanged', id: found.id });
        continue;
      }
      await ctx.client.patch(`/v1/${p.type}/${found.id}`, { data: { type: p.type, id: found.id, attributes: attrs } });
      out.push({ locale, action: 'updated', id: found.id });
    } else {
      const doc = await ctx.client.post(`/v1/${p.type}`, {
        data: { type: p.type, attributes: { ...attrs, locale }, relationships: { [p.parentRel]: rel(p.parentType, p.parentId) } },
      });
      out.push({ locale, action: 'created', id: (doc.data as JsonApiResource)?.id });
    }
  }
  return out;
}

const iapLocMap = (i: any) => ({ name: i.name, description: i.description });
const groupLocMap = (i: any) => ({ name: i.name, customAppName: i.custom_app_name });

// ---------------------------------------------------------------------------
// Availability helpers
// ---------------------------------------------------------------------------

async function availableTerritoryIds(ctx: ToolContext, path: string): Promise<string[]> {
  const all = await ctx.client.getAll(path, { limit: 200 }, 500);
  return all.data.map(t => t.id);
}

/** Legacy (deprecated v1) subscription availability, for subscriptions set up before plan availabilities. */
async function legacySubAvailability(ctx: ToolContext, subId: string) {
  const doc = await tryGet(ctx, `/v1/subscriptions/${subId}/subscriptionAvailability`);
  const a = doc?.data as JsonApiResource | undefined;
  if (!a?.id) return null;
  const ids = await availableTerritoryIds(ctx, `/v1/subscriptionAvailabilities/${a.id}/availableTerritories`);
  return { id: a.id, legacy: true, availableInNewTerritories: a.attributes?.availableInNewTerritories, territories: ids };
}

/** Territories a subscription is sold in (plan availability), else all territories. */
async function subscriptionTerritories(ctx: ToolContext, subId: string, planType?: string): Promise<string[]> {
  if (!isDry(subId)) {
    const doc = await tryGet(ctx, `/v1/subscriptions/${subId}/planAvailabilities`, { limit: 10 });
    const list = (doc?.data as JsonApiResource[]) ?? [];
    const pa = list.find(x => (x.attributes?.planType ?? 'UPFRONT') === (planType ?? 'UPFRONT')) ?? list[0];
    if (pa) {
      const ids = await availableTerritoryIds(ctx, `/v1/subscriptionPlanAvailabilities/${pa.id}/availableTerritories`);
      if (ids.length) return ids;
    }
    const legacy = await legacySubAvailability(ctx, subId);
    if (legacy?.territories.length) return legacy.territories;
  }
  return (await allTerritories(ctx)).map(t => t.id);
}

async function resolveOfferTerritories(ctx: ToolContext, subId: string, args: any): Promise<string[]> {
  if (args.territories === undefined && !args.exclude_territories?.length) return subscriptionTerritories(ctx, subId, args.plan_type);
  if (args.territories === 'all' || args.territories === undefined) {
    const base = await subscriptionTerritories(ctx, subId, args.plan_type);
    const ex = new Set((args.exclude_territories ?? []).map((t: string) => t.toUpperCase()));
    return base.filter(t => !ex.has(t));
  }
  return (await selectTerritories(ctx, args.territories, args.exclude_territories))!;
}

/** Inline offer prices for promo offers / offer codes / win-back offers. */
async function offerPrices(ctx: ToolContext, subId: string, args: any, inlineType: string) {
  const territories = await resolveOfferTerritories(ctx, subId, args);
  const mode = args.offer_mode;
  let rows: Array<{ territory: string; id?: string; customerPrice?: string }>;
  let missing: string[] = [];
  if (mode === 'FREE_TRIAL') {
    rows = territories.map(t => ({ territory: t }));
  } else {
    if (args.price === undefined) throw new Error(`${mode} offers need price (the discounted customer price in base_territory).`);
    if (isDry(subId)) throw new Error('Cannot resolve price points for a subscription that does not exist yet.');
    const r = await pricePointsForTerritories(ctx, 'subscription', subId, {
      baseTerritory: await normTerritory(ctx, args.base_territory),
      price: args.price,
      territories,
      overrides: args.territory_prices,
    });
    rows = r.rows;
    missing = r.missing;
  }
  const included = rows.map(r => ({
    type: inlineType,
    id: inlineId(`price-${r.territory}`),
    relationships: defined({
      territory: rel('territories', r.territory),
      subscriptionPricePoint: r.id ? rel('subscriptionPricePoints', r.id) : undefined,
    }),
  }));
  return { included, linkage: rels(inlineType, included.map(i => i.id)), rows, missing };
}

function periodsDefault(args: any) {
  return args.number_of_periods ?? 1;
}

function summarizePrices(rows: Array<{ territory: string; customerPrice?: string }>, show = 8) {
  return { territories: rows.length, sample: rows.slice(0, show).map(r => `${r.territory}: ${r.customerPrice ?? 'free'}`) };
}

// ---------------------------------------------------------------------------
// Readiness checks
// ---------------------------------------------------------------------------

async function iapDetails(ctx: ToolContext, iapId: string) {
  const doc = await ctx.client.get(`/v2/inAppPurchases/${iapId}`, {
    include: 'inAppPurchaseLocalizations,appStoreReviewScreenshot,promotedPurchase,images,versions',
    'limit[inAppPurchaseLocalizations]': 50,
  });
  const iap = compact(doc.data as JsonApiResource);
  const inc = (doc.included ?? []).map(compact);
  const localizations = inc.filter(r => r.type === 'inAppPurchaseLocalizations').map(l => ({ id: l.id, locale: l.locale, name: l.name, description: l.description, state: l.state }));
  const shot = inc.find(r => r.type === 'inAppPurchaseAppStoreReviewScreenshots');
  const images = inc.filter(r => r.type === 'inAppPurchaseImages').map(i => ({ id: i.id, fileName: i.fileName, state: i.state ?? i.assetDeliveryState?.state }));
  const versions = inc.filter(r => r.type === 'inAppPurchaseVersions').map(v => ({ id: v.id, version: v.version, state: v.state }));
  const promoted = inc.find(r => r.type === 'promotedPurchases');

  const sched = await tryGet(ctx, `/v2/inAppPurchases/${iapId}/iapPriceSchedule`, { include: 'baseTerritory' });
  let pricing: any = null;
  if (sched?.data) {
    const sid = (sched.data as JsonApiResource).id;
    const base = relId(sched.data as JsonApiResource, 'baseTerritory');
    const manual = await ctx.client.getAll(`/v1/inAppPurchasePriceSchedules/${sid}/manualPrices`, { include: 'inAppPurchasePricePoint,territory', limit: 200 }, 500);
    const rows = priceRows(manual, 'inAppPurchasePricePoint');
    pricing = { baseTerritory: base, manualPrices: rows.map(({ pricePointId, ...r }) => r) };
  }
  const avail = await tryGet(ctx, `/v2/inAppPurchases/${iapId}/inAppPurchaseAvailability`);
  let availability: any = null;
  if (avail?.data) {
    const a = avail.data as JsonApiResource;
    const ids = await availableTerritoryIds(ctx, `/v1/inAppPurchaseAvailabilities/${a.id}/availableTerritories`);
    availability = { availableInNewTerritories: a.attributes?.availableInNewTerritories, territoryCount: ids.length, territories: ids.length > 40 ? undefined : ids };
  }
  const missing: string[] = [];
  if (!localizations.length) missing.push('localization (set_iap_localizations)');
  if (!pricing?.manualPrices?.length) missing.push('price (set_iap_price)');
  if (!availability?.territoryCount) missing.push('availability (set_iap_availability)');
  if (!shot) missing.push('App Review screenshot (upload_iap_review_screenshot)');
  else if (shot.assetDeliveryState?.state && shot.assetDeliveryState.state !== 'COMPLETE') missing.push(`review screenshot is ${shot.assetDeliveryState.state}`);
  const { relationships, ...core } = iap as any;
  return {
    ...core,
    localizations,
    pricing,
    availability,
    reviewScreenshot: shot ? { id: shot.id, fileName: shot.fileName, state: shot.assetDeliveryState?.state, width: shot.imageAsset?.width, height: shot.imageAsset?.height } : null,
    images,
    versions,
    promotedPurchase: promoted ? { id: promoted.id, enabled: promoted.enabled, visibleForAllUsers: promoted.visibleForAllUsers, state: promoted.state } : null,
    missing,
    readyToSubmit: missing.length === 0,
  };
}

async function subscriptionDetails(ctx: ToolContext, subId: string, priceTerritories?: string[]) {
  const doc = await ctx.client.get(`/v1/subscriptions/${subId}`, {
    include: 'subscriptionLocalizations,appStoreReviewScreenshot,group,introductoryOffers,promotionalOffers,offerCodes,winBackOffers,images,planAvailabilities,promotedPurchase',
    'limit[subscriptionLocalizations]': 50,
    'limit[introductoryOffers]': 50,
    'limit[promotionalOffers]': 50,
    'limit[offerCodes]': 50,
    'limit[winBackOffers]': 50,
  });
  const sub = doc.data as JsonApiResource;
  const inc = (doc.included ?? []).map(compact);
  const of = (type: string) => inc.filter(r => r.type === type);
  const localizations = of('subscriptionLocalizations').map(l => ({ id: l.id, locale: l.locale, name: l.name, description: l.description, state: l.state }));
  const shot = of('subscriptionAppStoreReviewScreenshots')[0];
  const group = of('subscriptionGroups')[0];

  const prices = await ctx.client.getAll(`/v1/subscriptions/${subId}/prices`, { include: 'subscriptionPricePoint,territory', limit: 200 }, 2000);
  const rows = priceRows(prices, 'subscriptionPricePoint');
  const current = new Map<string, any>();
  for (const r of activeAt(rows)) {
    const key = `${r.territory}/${r.planType ?? 'UPFRONT'}`;
    const prev = current.get(key);
    if (!prev || (r.startDate ?? '') > (prev.startDate ?? '')) current.set(key, r);
  }
  const currentRows = [...current.values()];
  const show = priceTerritories?.length ? currentRows.filter(r => priceTerritories.includes(r.territory)) : currentRows.filter(r => r.territory === 'USA');
  const scheduled = rows.filter(r => r.startDate && r.startDate > today());

  const planAvail = of('subscriptionPlanAvailabilities');
  const availability: any[] = [];
  for (const pa of planAvail) {
    const ids = await availableTerritoryIds(ctx, `/v1/subscriptionPlanAvailabilities/${pa.id}/availableTerritories`);
    availability.push({ id: pa.id, planType: pa.planType, availableInNewTerritories: pa.availableInNewTerritories, territoryCount: ids.length });
  }
  if (!availability.length) {
    const legacy = await legacySubAvailability(ctx, subId);
    if (legacy) availability.push({ id: legacy.id, legacy: true, availableInNewTerritories: legacy.availableInNewTerritories, territoryCount: legacy.territories.length });
  }

  const missing: string[] = [];
  if (!localizations.length) missing.push('localization (set_subscription_localizations)');
  if (!currentRows.length) missing.push('price (set_subscription_price)');
  if (!availability.some(a => a.territoryCount > 0)) missing.push('availability (set_subscription_availability)');
  if (!shot) missing.push('App Review screenshot (upload_subscription_review_screenshot)');
  if (group) {
    const gl = await ctx.client.get(`/v1/subscriptionGroups/${group.id}/subscriptionGroupLocalizations`, { limit: 50 });
    if (!compactList(gl).length) missing.push('subscription group localization (set_subscription_group_localizations)');
  }
  return {
    ...compact({ ...sub, relationships: undefined }),
    group: group ? { id: group.id, referenceName: group.referenceName } : undefined,
    localizations,
    prices: {
      territoriesPriced: new Set(currentRows.map(r => r.territory)).size,
      current: show.map(({ pricePointId, manual, ...r }) => r),
      scheduledChanges: scheduled.length ? scheduled.slice(0, 20).map(({ pricePointId, manual, ...r }) => r) : undefined,
    },
    availability,
    reviewScreenshot: shot ? { id: shot.id, fileName: shot.fileName, state: shot.assetDeliveryState?.state } : null,
    images: of('subscriptionImages').map(i => ({ id: i.id, fileName: i.fileName, state: i.assetDeliveryState?.state })),
    introductoryOffers: summarizeOffers(of('subscriptionIntroductoryOffers'), sub, 'introductoryOffers'),
    promotionalOffers: of('subscriptionPromotionalOffers').map(o => ({ id: o.id, name: o.name, offerCode: o.offerCode, offerMode: o.offerMode, duration: o.duration, numberOfPeriods: o.numberOfPeriods })),
    offerCodes: of('subscriptionOfferCodes').map(o => ({ id: o.id, name: o.name, active: o.active, offerMode: o.offerMode, duration: o.duration, customerEligibilities: o.customerEligibilities, totalNumberOfCodes: o.totalNumberOfCodes })),
    winBackOffers: of('winBackOffers').map(o => ({ id: o.id, referenceName: o.referenceName, offerId: o.offerId, offerMode: o.offerMode, startDate: o.startDate, endDate: o.endDate })),
    missing,
    readyToSubmit: missing.length === 0,
  };
}

function summarizeOffers(list: any[], sub: JsonApiResource, relName: string) {
  const total = sub.relationships?.[relName]?.meta?.paging?.total ?? list.length;
  const groups = new Map<string, any>();
  for (const o of list) {
    const key = [o.offerMode, o.duration, o.numberOfPeriods, o.startDate ?? '', o.endDate ?? ''].join('|');
    const g = groups.get(key) ?? { offerMode: o.offerMode, duration: o.duration, numberOfPeriods: o.numberOfPeriods, startDate: o.startDate ?? undefined, endDate: o.endDate ?? undefined, count: 0 };
    g.count++;
    groups.set(key, g);
  }
  return { total, kinds: [...groups.values()] };
}

// ---------------------------------------------------------------------------
// Price schedules (app & IAP share the same shape)
// ---------------------------------------------------------------------------

async function buildPriceSchedule(
  ctx: ToolContext,
  kind: 'app' | 'iap',
  ownerId: string,
  args: any,
  currentBase: string | undefined,
  currentScheduleId: string | undefined,
) {
  const cfg =
    kind === 'app'
      ? { scheduleType: 'appPriceSchedules', ownerRel: 'app', ownerType: 'apps', priceType: 'appPrices', ppRel: 'appPricePoint', ppType: 'appPricePoints', manualPath: (s: string) => `/v1/appPriceSchedules/${s}/manualPrices` }
      : { scheduleType: 'inAppPurchasePriceSchedules', ownerRel: 'inAppPurchase', ownerType: 'inAppPurchases', priceType: 'inAppPurchasePrices', ppRel: 'inAppPurchasePricePoint', ppType: 'inAppPurchasePricePoints', manualPath: (s: string) => `/v1/inAppPurchasePriceSchedules/${s}/manualPrices` };
  const baseTerritory = await normTerritory(ctx, args.base_territory ?? currentBase ?? 'USA');
  const startDate = checkDate(args.start_date, 'start_date');
  if (startDate && startDate <= today()) throw new Error('start_date must be in the future (omit it to change the price now)');
  const base = await findPricePoint(ctx, kind, ownerId, baseTerritory, args.price);

  const entries: Array<{ pp: PricePointRow; startDate?: string | null; endDate?: string | null; note?: string }> = [];
  if (startDate) {
    // Keep the current base price until the new one starts.
    if (!currentScheduleId) throw new Error('There is no current price to keep until start_date; omit start_date to set the first price.');
    const manual = await ctx.client.getAll(cfg.manualPath(currentScheduleId), { 'filter[territory]': baseTerritory, include: cfg.ppRel, limit: 200 }, 500);
    const cur = activeAt(priceRows(manual, cfg.ppRel))[0];
    if (!cur?.pricePointId) throw new Error(`No current manual price in ${baseTerritory} to keep until ${startDate}. Set base_territory to the current base territory (${currentBase ?? 'unknown'}).`);
    entries.push({ pp: { id: cur.pricePointId, territory: baseTerritory, customerPrice: cur.customerPrice }, startDate: null, endDate: startDate, note: 'current price kept until start_date' });
  }
  entries.push({ pp: base, startDate: startDate ?? null, endDate: null });
  for (const [t0, p] of Object.entries(args.territory_prices ?? {})) {
    const t = await normTerritory(ctx, t0);
    if (t === baseTerritory) throw new Error('Use price for the base territory; territory_prices is for other territories.');
    entries.push({ pp: await findPricePoint(ctx, kind, ownerId, t, p), startDate: startDate ?? null, endDate: null });
  }
  const included = entries.map((e, i) => ({
    type: cfg.priceType,
    id: inlineId(`price-${i}`),
    attributes: { startDate: e.startDate ?? null, endDate: e.endDate ?? null },
    relationships: defined({
      [cfg.ppRel]: rel(cfg.ppType, e.pp.id),
      ...(kind === 'iap' ? { inAppPurchaseV2: rel('inAppPurchases', ownerId) } : {}),
    }),
  }));
  const body = {
    data: {
      type: cfg.scheduleType,
      relationships: {
        [cfg.ownerRel]: rel(cfg.ownerType, ownerId),
        baseTerritory: rel('territories', baseTerritory),
        manualPrices: rels(cfg.priceType, included.map(i => i.id)),
      },
    },
    included,
  };
  const plan = entries.map(e => defined({ territory: e.pp.territory, customerPrice: e.pp.customerPrice, proceeds: e.pp.proceeds, startDate: e.startDate ?? undefined, endDate: e.endDate ?? undefined, note: e.note }));
  return { body, plan, baseTerritory };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const monetizationTools: ToolDef[] = [
  // ----------------------------- Territories / pricing / availability
  {
    name: 'list_territories',
    description: 'List all App Store territories (3-letter codes like USA, GBR, DEU) with their currency. Use these codes in every pricing and availability tool.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'List territories', readOnlyHint: true },
    async handler(_args, ctx) {
      const list = await allTerritories(ctx);
      return { count: list.length, territories: list.map(t => `${t.id}:${t.currency ?? ''}`).join(' ') };
    },
  },
  {
    name: 'get_app_pricing',
    description:
      "Show an app's current price schedule: base territory, manual prices (with customer price, proceeds and start/end dates, including scheduled changes), and the automatically equalized prices in other territories. Free apps show customerPrice 0.0.",
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        territories: { type: 'array', items: { type: 'string' }, description: 'Also show automatic prices for these territories (default none; pass ["all"] for every territory)' },
      },
      required: ['app'],
    },
    annotations: { title: 'Get app pricing', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const sched = await tryGet(ctx, `/v1/apps/${app.id}/appPriceSchedule`, { include: 'baseTerritory,automaticPrices', 'limit[automaticPrices]': 1 });
      if (!sched?.data) return { app: app.name, appId: app.id, priceSchedule: null, note: 'No price set yet. Use set_app_price (price 0 for free).' };
      const s = sched.data as JsonApiResource;
      const baseTerritory = relId(s, 'baseTerritory');
      const currency = (sched.included ?? []).find(r => r.type === 'territories')?.attributes?.currency;
      const manual = await ctx.client.getAll(`/v1/appPriceSchedules/${s.id}/manualPrices`, { include: 'appPricePoint,territory', limit: 200 }, 500);
      const manualRows = priceRows(manual, 'appPricePoint').map(({ pricePointId, manual, ...r }) => r);
      const autoQuery: Record<string, any> = { include: 'appPricePoint,territory', limit: 200 };
      const wantAll = Array.isArray(args.territories) && args.territories.some((t: string) => t.toLowerCase() === 'all');
      if (args.territories?.length && !wantAll) autoQuery['filter[territory]'] = args.territories.map((t: string) => t.toUpperCase()).join(',');
      let automatic: any;
      if (args.territories?.length) {
        const auto = await ctx.client.getAll(`/v1/appPriceSchedules/${s.id}/automaticPrices`, autoQuery, 1000);
        automatic = priceRows(auto, 'appPricePoint').map(r => `${r.territory}: ${r.customerPrice} (proceeds ${r.proceeds})${r.startDate ? ` from ${r.startDate}` : ''}${r.endDate ? ` until ${r.endDate}` : ''}`);
      } else {
        automatic = { count: s.relationships?.automaticPrices?.meta?.paging?.total, hint: 'Pass territories to list them' };
      }
      return { app: app.name, appId: app.id, baseTerritory, currency, manualPrices: manualRows, automaticPrices: automatic };
    },
  },
  {
    name: 'find_price_points',
    description:
      'Look up Apple price points (the only prices you can set) for an app, in-app purchase or subscription in one territory. Give target_price to get the nearest price points with ids, customer price and proceeds. Without target_price it lists every valid customer price. Give price_point_id to see what that price becomes in other territories (equalizations). set_* price tools do this lookup themselves; use this to pick a valid price.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['app', 'iap', 'subscription'], description: 'Whose price points (they differ per product type)' },
        app: S.app,
        iap: T.iap,
        subscription: T.subscription,
        territory: { ...T.territory, description: 'Territory (default USA)' },
        target_price: { type: ['string', 'number'], description: 'Price to match, e.g. 2.99' },
        count: { type: 'number', description: 'How many nearest price points to return (default 7)' },
        price_point_id: { type: 'string', description: 'Show equalized prices of this price point in other territories' },
        equalization_territories: { type: 'array', items: { type: 'string' }, description: 'With price_point_id: only these territories' },
      },
      required: ['kind'],
    },
    annotations: { title: 'Find price points', readOnlyHint: true },
    async handler(args, ctx) {
      const kind = args.kind as Kind;
      if (args.price_point_id) {
        const terr = args.equalization_territories?.map((t: string) => t.toUpperCase());
        const eq = await equalizations(ctx, kind, args.price_point_id, terr);
        let rows = [...eq.values()];
        if (terr?.length) rows = rows.filter(r => terr.includes(r.territory));
        return { pricePointId: args.price_point_id, count: rows.length, equalizations: rows.map(r => `${r.territory}: ${r.customerPrice} (proceeds ${r.proceeds})`) };
      }
      let ownerId: string;
      if (kind === 'app') ownerId = (await resolveApp(ctx, args.app)).id;
      else if (kind === 'iap') ownerId = (await resolveIap(ctx, args)).id;
      else ownerId = (await resolveSubscription(ctx, args)).id;
      const territory = await normTerritory(ctx, args.territory);
      const rows = await listPricePoints(ctx, kind, ownerId, territory);
      const currency = (await allTerritories(ctx)).find(t => t.id === territory)?.currency;
      if (args.target_price === undefined) {
        return { territory, currency, count: rows.length, prices: rows.map(r => r.customerPrice).join(' '), hint: 'Pass target_price to get price point ids and proceeds.' };
      }
      const near = nearest(rows, num(args.target_price), args.count ?? 7).sort((a, b) => num(a.customerPrice) - num(b.customerPrice));
      return { territory, currency, count: rows.length, nearest: near.map(r => ({ ...r, exact: Math.abs(num(r.customerPrice) - num(args.target_price)) < 0.0001 })) };
    },
  },
  {
    name: 'set_app_price',
    description:
      'Set the price of an app (price 0 = free). Finds the matching Apple price point in the base territory and replaces the price schedule; other territories are equalized automatically unless you give territory_prices. With start_date the current price stays until that date, then the new one applies. Gotchas: this replaces the whole schedule, so earlier scheduled changes and manual overrides you do not repeat are dropped; paid apps need the Paid Apps agreement active.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        price: T.price,
        base_territory: { ...T.baseTerritory, description: 'Base territory (default: current base territory, or USA)' },
        start_date: { ...T.date, description: 'Future date YYYY-MM-DD when the new price starts (default now)' },
        territory_prices: T.territoryPrices,
      },
      required: ['app', 'price'],
    },
    annotations: { title: 'Set app price' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const sched = await tryGet(ctx, `/v1/apps/${app.id}/appPriceSchedule`, { include: 'baseTerritory' });
      const s = sched?.data as JsonApiResource | undefined;
      const { body, plan, baseTerritory } = await buildPriceSchedule(ctx, 'app', app.id, args, s ? relId(s, 'baseTerritory') : undefined, s?.id);
      const doc = await ctx.client.post('/v1/appPriceSchedules', body);
      return { app: app.name, baseTerritory, prices: plan, scheduleId: (doc.data as JsonApiResource)?.id };
    },
  },
  {
    name: 'get_app_availability',
    description: 'Show where an app is available: availableInNewTerritories plus each territory\'s availability, release date, pre-order and content status (e.g. MISSING_RATING, BRAZIL_REQUIRED_TAX_ID explain why a territory cannot sell).',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, details: { type: 'boolean', description: 'List every territory with its status (default: summary with available/unavailable codes and problem statuses)' } },
      required: ['app'],
    },
    annotations: { title: 'Get app availability', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const av = await tryGet(ctx, `/v1/apps/${app.id}/appAvailabilityV2`);
      if (!av?.data) return { app: app.name, appId: app.id, availability: null, note: 'No availability set yet. Use set_app_availability.' };
      const a = av.data as JsonApiResource;
      const tas = await ctx.client.getAll(`/v2/appAvailabilities/${a.id}/territoryAvailabilities`, { include: 'territory', limit: 200 }, 500);
      const rows = tas.data.map(t => ({ territory: relId(t, 'territory') ?? '?', ...(t.attributes ?? {}) })) as any[];
      if (args.details) return { app: app.name, availabilityId: a.id, availableInNewTerritories: a.attributes?.availableInNewTerritories, territories: rows };
      const problems = rows.filter(r => (r.contentStatuses ?? []).some((c: string) => c.startsWith('CANNOT') || c.startsWith('MISSING') || c.includes('REQUIRED') || c.includes('INVALID') || c.includes('NOT_')));
      return {
        app: app.name,
        availabilityId: a.id,
        availableInNewTerritories: a.attributes?.availableInNewTerritories,
        availableCount: rows.filter(r => r.available).length,
        available: rows.filter(r => r.available).map(r => r.territory),
        unavailable: rows.filter(r => !r.available).map(r => r.territory),
        preOrders: rows.filter(r => r.preOrderEnabled).map(r => `${r.territory} ${r.releaseDate ?? ''}`),
        problems: problems.map(r => `${r.territory}: ${r.contentStatuses.join(',')}`),
      };
    },
  },
  {
    name: 'set_app_availability',
    description:
      'Choose the territories where an app is sold: territories "all", a list, and/or exclude_territories (e.g. all except CHN and RUS). If the app has no availability yet it is created; otherwise only territories that change are updated. available_in_new_territories controls future territories. Removing a territory takes the app off sale there.',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, territories: T.territories, exclude_territories: T.exclude, available_in_new_territories: T.newTerritories },
      required: ['app'],
    },
    annotations: { title: 'Set app availability', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const all = (await allTerritories(ctx)).map(t => t.id);
      const av = await tryGet(ctx, `/v1/apps/${app.id}/appAvailabilityV2`);
      const existing = av?.data as JsonApiResource | undefined;
      const wantTerritories = args.territories !== undefined || args.exclude_territories?.length;
      if (!wantTerritories && args.available_in_new_territories === undefined) throw new Error('Pass territories, exclude_territories and/or available_in_new_territories.');

      if (existing) {
        const tas = await ctx.client.getAll(`/v2/appAvailabilities/${existing.id}/territoryAvailabilities`, { include: 'territory', limit: 200 }, 500);
        const current = tas.data.map(t => ({ id: t.id, territory: relId(t, 'territory')!, available: !!t.attributes?.available }));
        const desired = wantTerritories ? new Set(await selectTerritories(ctx, args.territories, args.exclude_territories)) : new Set(current.filter(c => c.available).map(c => c.territory));
        const flagChange = args.available_in_new_territories !== undefined && args.available_in_new_territories !== existing.attributes?.availableInNewTerritories;
        if (flagChange) {
          // availableInNewTerritories can only be set by (re)creating the availability.
          const included = all.map(t => ({ type: 'territoryAvailabilities', id: inlineId(`ta-${t}`), attributes: { available: desired.has(t) }, relationships: { territory: rel('territories', t) } }));
          await ctx.client.post('/v2/appAvailabilities', {
            data: { type: 'appAvailabilities', attributes: { availableInNewTerritories: !!args.available_in_new_territories }, relationships: { app: rel('apps', app.id), territoryAvailabilities: rels('territoryAvailabilities', included.map(i => i.id)) } },
            included,
          });
          return { app: app.name, action: 'recreated availability', availableInNewTerritories: !!args.available_in_new_territories, availableCount: desired.size, note: 'If Apple rejects re-creating availability, change "Available in new territories" in App Store Connect web.' };
        }
        const changes = current.filter(c => c.available !== desired.has(c.territory));
        const results = await mapLimit(changes, 4, c =>
          ctx.client.patch(`/v1/territoryAvailabilities/${c.id}`, { data: { type: 'territoryAvailabilities', id: c.id, attributes: { available: desired.has(c.territory) } } }),
        );
        const unknownNew = [...desired].filter(t => !current.some(c => c.territory === t));
        return {
          app: app.name,
          madeAvailable: changes.filter(c => desired.has(c.territory)).map(c => c.territory),
          madeUnavailable: changes.filter(c => !desired.has(c.territory)).map(c => c.territory),
          failed: results.filter(r => !r.ok).map(r => `${r.item.territory}: ${r.error}`),
          notInAvailability: unknownNew.length ? unknownNew : undefined,
          availableCount: desired.size,
        };
      }
      const desired = new Set(wantTerritories ? await selectTerritories(ctx, args.territories, args.exclude_territories) : all);
      const included = all.map(t => ({ type: 'territoryAvailabilities', id: inlineId(`ta-${t}`), attributes: { available: desired.has(t) }, relationships: { territory: rel('territories', t) } }));
      const doc = await ctx.client.post('/v2/appAvailabilities', {
        data: {
          type: 'appAvailabilities',
          attributes: { availableInNewTerritories: args.available_in_new_territories ?? true },
          relationships: { app: rel('apps', app.id), territoryAvailabilities: rels('territoryAvailabilities', included.map(i => i.id)) },
        },
        included,
      });
      return { app: app.name, action: 'created availability', id: (doc.data as JsonApiResource)?.id, availableCount: desired.size, unavailable: all.filter(t => !desired.has(t)) };
    },
  },

  // ----------------------------- In-app purchases
  {
    name: 'list_in_app_purchases',
    description: 'List an app\'s in-app purchases (consumable, non-consumable, non-renewing subscription) with product id, type and state. Auto-renewable subscriptions are listed by list_subscription_groups.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        state: { type: 'string', description: 'Filter by state, e.g. MISSING_METADATA, READY_TO_SUBMIT, WAITING_FOR_REVIEW, APPROVED, REJECTED' },
        type: { type: 'string', enum: IAP_TYPES, description: 'Filter by type' },
      },
      required: ['app'],
    },
    annotations: { title: 'List in-app purchases', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const all = await ctx.client.getAll(`/v1/apps/${app.id}/inAppPurchasesV2`, { 'filter[state]': args.state, 'filter[inAppPurchaseType]': args.type, limit: 200 }, 1000);
      return {
        app: app.name,
        count: all.data.length,
        inAppPurchases: all.data.map(r => {
          const a = r.attributes ?? {};
          return defined({ id: r.id, productId: a.productId, name: a.name, type: a.inAppPurchaseType, state: a.state, familySharable: a.familySharable || undefined });
        }),
      };
    },
  },
  {
    name: 'get_in_app_purchase',
    description:
      'Full details of one in-app purchase: state, localizations, price schedule, availability, review screenshot, images, versions, promoted purchase, plus a "missing" checklist of what still blocks submission (localization, price, availability, review screenshot).',
    inputSchema: { type: 'object', properties: { iap: T.iap, app: T.appOptional }, required: ['iap'] },
    annotations: { title: 'Get in-app purchase', readOnlyHint: true },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      return iapDetails(ctx, iap.id);
    },
  },
  {
    name: 'create_in_app_purchase',
    description:
      'Create an in-app purchase (CONSUMABLE, NON_CONSUMABLE or NON_RENEWING_SUBSCRIPTION; use create_subscription for auto-renewable). Optionally adds localizations in the same call. After this: set_iap_price, set_iap_availability, upload_iap_review_screenshot, then submit. Gotchas: product_id is permanent and can never be reused, even after deletion; type cannot change later.',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        product_id: { type: 'string', description: 'Unique product identifier used in StoreKit, e.g. com.example.app.coins100 (permanent)' },
        reference_name: { type: 'string', description: 'Internal name shown in App Store Connect and reports (not visible to customers)' },
        type: { type: 'string', enum: IAP_TYPES },
        family_sharable: { type: 'boolean', description: 'Allow Family Sharing (non-consumables/non-renewing only; cannot be turned off once on)' },
        review_note: { type: 'string', description: 'Notes for App Review (how to find/test the purchase)' },
        localizations: T.localizations(),
      },
      required: ['app', 'product_id', 'reference_name', 'type'],
    },
    annotations: { title: 'Create in-app purchase' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      if (!IAP_TYPES.includes(args.type)) throw new Error(`type must be one of ${IAP_TYPES.join(', ')} (auto-renewable subscriptions: create_subscription)`);
      const doc = await ctx.client.post('/v2/inAppPurchases', {
        data: {
          type: 'inAppPurchases',
          attributes: defined({ name: args.reference_name, productId: args.product_id, inAppPurchaseType: args.type, familySharable: args.family_sharable, reviewNote: args.review_note }),
          relationships: { app: rel('apps', app.id) },
        },
      });
      const iap = compact(doc.data as JsonApiResource);
      const localizations = args.localizations?.length
        ? await upsertLocalizations(ctx, { listPath: `/v2/inAppPurchases/${iap.id}/inAppPurchaseLocalizations`, type: 'inAppPurchaseLocalizations', parentRel: 'inAppPurchaseV2', parentType: 'inAppPurchases', parentId: iap.id, items: args.localizations, map: iapLocMap, required: ['name'] })
        : undefined;
      return { inAppPurchase: { id: iap.id, productId: iap.productId, name: iap.name, type: iap.inAppPurchaseType, state: iap.state }, localizations, next: 'set_iap_price, set_iap_availability, upload_iap_review_screenshot' };
    },
  },
  {
    name: 'update_in_app_purchase',
    description: 'Change an in-app purchase\'s reference name, review note or Family Sharing. Product id and type cannot be changed. For customer-facing name/description use set_iap_localizations.',
    inputSchema: {
      type: 'object',
      properties: { iap: T.iap, app: T.appOptional, reference_name: { type: 'string' }, review_note: { type: 'string' }, family_sharable: { type: 'boolean', description: 'Cannot be turned off once enabled' } },
      required: ['iap'],
    },
    annotations: { title: 'Update in-app purchase', idempotentHint: true },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      const attributes = defined({ name: args.reference_name, reviewNote: args.review_note, familySharable: args.family_sharable });
      if (!Object.keys(attributes).length) throw new Error('Nothing to update: pass reference_name, review_note or family_sharable');
      const doc = await ctx.client.patch(`/v2/inAppPurchases/${iap.id}`, { data: { type: 'inAppPurchases', id: iap.id, attributes } });
      const { relationships, ...out } = compact(doc.data as JsonApiResource) as any;
      return { ...out, id: iap.id, productId: iap.productId };
    },
  },
  {
    name: 'delete_in_app_purchase',
    description: 'Delete an in-app purchase. Only possible before it was ever approved; approved ones must be removed from sale in App Store Connect instead. The product id can never be reused.',
    inputSchema: { type: 'object', properties: { iap: T.iap, app: T.appOptional, confirm: S.confirm }, required: ['iap'] },
    annotations: { title: 'Delete in-app purchase', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting an in-app purchase');
      const iap = await resolveIap(ctx, args);
      await ctx.client.delete(`/v2/inAppPurchases/${iap.id}`);
      return { deleted: { id: iap.id, productId: iap.productId, name: iap.name } };
    },
  },
  {
    name: 'set_iap_localizations',
    description: 'Create or update an in-app purchase\'s customer-facing display name and description for many locales in one call (upsert by locale). Apple limits: name 35 chars, description 55 chars.',
    inputSchema: { type: 'object', properties: { iap: T.iap, app: T.appOptional, localizations: T.localizations() }, required: ['iap', 'localizations'] },
    annotations: { title: 'Set IAP localizations', idempotentHint: true },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      const results = await upsertLocalizations(ctx, {
        listPath: `/v2/inAppPurchases/${iap.id}/inAppPurchaseLocalizations`,
        type: 'inAppPurchaseLocalizations',
        parentRel: 'inAppPurchaseV2',
        parentType: 'inAppPurchases',
        parentId: iap.id,
        items: args.localizations,
        map: iapLocMap,
        required: ['name'],
      });
      return { inAppPurchase: iap.productId, results };
    },
  },
  {
    name: 'set_iap_price',
    description:
      'Set an in-app purchase price: give the customer price in a base territory (default USA); Apple equalizes all other territories unless you give territory_prices overrides. With start_date the current price stays until then. Replaces the whole price schedule (earlier scheduled changes and overrides you do not repeat are dropped). A price is required before submission.',
    inputSchema: {
      type: 'object',
      properties: {
        iap: T.iap,
        app: T.appOptional,
        price: T.price,
        base_territory: { ...T.baseTerritory, description: 'Base territory (default: current base territory, or USA)' },
        start_date: { ...T.date, description: 'Future date when the new price starts (default now)' },
        territory_prices: T.territoryPrices,
      },
      required: ['iap', 'price'],
    },
    annotations: { title: 'Set IAP price' },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      const sched = await tryGet(ctx, `/v2/inAppPurchases/${iap.id}/iapPriceSchedule`, { include: 'baseTerritory' });
      const s = sched?.data as JsonApiResource | undefined;
      const hasManual = s ? (s.relationships?.manualPrices?.meta?.paging?.total ?? 1) > 0 : false;
      const { body, plan, baseTerritory } = await buildPriceSchedule(ctx, 'iap', iap.id, args, s ? relId(s, 'baseTerritory') : undefined, hasManual ? s?.id : undefined);
      await ctx.client.post('/v1/inAppPurchasePriceSchedules', body);
      return { inAppPurchase: iap.productId, baseTerritory, prices: plan };
    },
  },
  {
    name: 'set_iap_availability',
    description: 'Choose the territories where an in-app purchase is sold ("all", a list, and/or exclusions) and whether it becomes available in new territories automatically. Replaces the current availability. Required before submission.',
    inputSchema: {
      type: 'object',
      properties: { iap: T.iap, app: T.appOptional, territories: T.territories, exclude_territories: T.exclude, available_in_new_territories: { ...T.newTerritories, description: 'Default true' } },
      required: ['iap'],
    },
    annotations: { title: 'Set IAP availability', idempotentHint: true },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      const territories = (await selectTerritories(ctx, args.territories ?? (args.exclude_territories?.length ? undefined : 'all'), args.exclude_territories))!;
      const doc = await ctx.client.post('/v1/inAppPurchaseAvailabilities', {
        data: {
          type: 'inAppPurchaseAvailabilities',
          attributes: { availableInNewTerritories: args.available_in_new_territories ?? true },
          relationships: { inAppPurchase: rel('inAppPurchases', iap.id), availableTerritories: rels('territories', territories) },
        },
      });
      return { inAppPurchase: iap.productId, availabilityId: (doc.data as JsonApiResource)?.id, territoryCount: territories.length, availableInNewTerritories: args.available_in_new_territories ?? true };
    },
  },
  {
    name: 'upload_iap_review_screenshot',
    description: 'Upload the App Review screenshot for an in-app purchase (required for submission): a screenshot of the purchase in your app, e.g. 1284x2778 PNG/JPG. Replaces an existing one.',
    inputSchema: { type: 'object', properties: { iap: T.iap, app: T.appOptional, file_path: S.filePath }, required: ['iap', 'file_path'] },
    annotations: { title: 'Upload IAP review screenshot' },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      const cur = await tryGet(ctx, `/v2/inAppPurchases/${iap.id}/appStoreReviewScreenshot`);
      const old = cur?.data as JsonApiResource | undefined;
      if (old?.id) await ctx.client.delete(`/v1/inAppPurchaseAppStoreReviewScreenshots/${old.id}`);
      const res = await uploadAsset(ctx, { type: 'inAppPurchaseAppStoreReviewScreenshots', parentRelationship: 'inAppPurchaseV2', parentType: 'inAppPurchases', parentId: iap.id, filePath: args.file_path });
      return { inAppPurchase: iap.productId, replaced: old?.id, screenshot: { id: res.id, fileName: res.fileName, state: res.assetDeliveryState?.state, note: res.note } };
    },
  },
  {
    name: 'upload_iap_image',
    description: 'Upload the promotional image for an in-app purchase (shown on the App Store when the purchase is promoted / in win-back etc.): 1024x1024 PNG/JPG, no rounded corners or transparency. Optional for review.',
    inputSchema: { type: 'object', properties: { iap: T.iap, app: T.appOptional, file_path: S.filePath }, required: ['iap', 'file_path'] },
    annotations: { title: 'Upload IAP image' },
    async handler(args, ctx) {
      const iap = await resolveIap(ctx, args);
      const res = await uploadAsset(ctx, { type: 'inAppPurchaseImages', parentRelationship: 'inAppPurchase', parentType: 'inAppPurchases', parentId: iap.id, filePath: args.file_path });
      return { inAppPurchase: iap.productId, image: { id: res.id, fileName: res.fileName, state: res.state ?? res.assetDeliveryState?.state, note: res.note } };
    },
  },
  {
    name: 'submit_in_app_purchase',
    description:
      'Submit an in-app purchase for App Review. It must be READY_TO_SUBMIT (localization, price, availability and review screenshot set; check with get_in_app_purchase). Gotcha: an app\'s FIRST in-app purchase must be submitted together with a new app version: add it in the version\'s "In-App Purchases and Subscriptions" section in App Store Connect, then submit the version; this call will fail for it.',
    inputSchema: { type: 'object', properties: { iap: T.iap, app: T.appOptional, confirm: S.confirm }, required: ['iap'] },
    annotations: { title: 'Submit in-app purchase', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Submitting an in-app purchase for review');
      const iap = await resolveIap(ctx, args);
      if (iap.state && iap.state !== 'READY_TO_SUBMIT' && iap.state !== 'DEVELOPER_ACTION_NEEDED' && iap.state !== 'REJECTED') {
        throw new Error(`In-app purchase is ${iap.state}, not READY_TO_SUBMIT. Run get_in_app_purchase to see what is missing.`);
      }
      const doc = await ctx.client.post('/v1/inAppPurchaseSubmissions', { data: { type: 'inAppPurchaseSubmissions', relationships: { inAppPurchaseV2: rel('inAppPurchases', iap.id) } } });
      return { submitted: iap.productId, submissionId: (doc.data as JsonApiResource)?.id };
    },
  },

  // ----------------------------- Subscription groups
  {
    name: 'list_subscription_groups',
    description: 'List an app\'s auto-renewable subscription groups with their localizations and subscriptions (id, product id, period, level, state).',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'List subscription groups', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const all = await ctx.client.getAll(`/v1/apps/${app.id}/subscriptionGroups`, { include: 'subscriptions,subscriptionGroupLocalizations', 'limit[subscriptions]': 50, 'limit[subscriptionGroupLocalizations]': 50 }, 200);
      const inc = includedMap(all);
      const get = (type: string, id: string) => inc.get(`${type}/${id}`);
      return {
        app: app.name,
        groups: all.data.map(g => ({
          id: g.id,
          referenceName: g.attributes?.referenceName,
          localizations: relIds(g, 'subscriptionGroupLocalizations').map(id => {
            const l = get('subscriptionGroupLocalizations', id)?.attributes ?? {};
            return defined({ locale: l.locale, name: l.name, customAppName: l.customAppName ?? undefined, state: l.state });
          }),
          subscriptions: relIds(g, 'subscriptions')
            .map(id => get('subscriptions', id))
            .filter(Boolean)
            .map(s => ({ id: s!.id, productId: s!.attributes?.productId, name: s!.attributes?.name, period: s!.attributes?.subscriptionPeriod, groupLevel: s!.attributes?.groupLevel, state: s!.attributes?.state }))
            .sort((a, b) => (a.groupLevel ?? 99) - (b.groupLevel ?? 99)),
        })),
      };
    },
  },
  {
    name: 'create_subscription_group',
    description: 'Create a subscription group (a set of subscriptions users can switch between; a user can only have one active per group). Optionally add its localizations (display name shown in subscription management) in the same call.',
    inputSchema: {
      type: 'object',
      properties: { app: S.app, reference_name: { type: 'string', description: 'Internal name, e.g. "Premium"' }, localizations: T.localizations(true) },
      required: ['app', 'reference_name'],
    },
    annotations: { title: 'Create subscription group' },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const doc = await ctx.client.post('/v1/subscriptionGroups', { data: { type: 'subscriptionGroups', attributes: { referenceName: args.reference_name }, relationships: { app: rel('apps', app.id) } } });
      const g = doc.data as JsonApiResource;
      const localizations = args.localizations?.length
        ? await upsertLocalizations(ctx, { listPath: `/v1/subscriptionGroups/${g.id}/subscriptionGroupLocalizations`, type: 'subscriptionGroupLocalizations', parentRel: 'subscriptionGroup', parentType: 'subscriptionGroups', parentId: g.id, items: args.localizations, map: groupLocMap, required: ['name'] })
        : undefined;
      return { group: { id: g.id, referenceName: args.reference_name }, localizations, next: 'create_subscription' };
    },
  },
  {
    name: 'update_subscription_group',
    description: 'Rename a subscription group (internal reference name).',
    inputSchema: { type: 'object', properties: { group: T.group, app: T.appOptional, reference_name: { type: 'string' } }, required: ['group', 'reference_name'] },
    annotations: { title: 'Update subscription group', idempotentHint: true },
    async handler(args, ctx) {
      const g = await resolveGroup(ctx, args);
      await ctx.client.patch(`/v1/subscriptionGroups/${g.id}`, { data: { type: 'subscriptionGroups', id: g.id, attributes: { referenceName: args.reference_name } } });
      return { group: g.id, referenceName: args.reference_name };
    },
  },
  {
    name: 'delete_subscription_group',
    description: 'Delete a subscription group. Only possible when it has no subscriptions that were ever submitted.',
    inputSchema: { type: 'object', properties: { group: T.group, app: T.appOptional, confirm: S.confirm }, required: ['group'] },
    annotations: { title: 'Delete subscription group', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a subscription group');
      const g = await resolveGroup(ctx, args);
      await ctx.client.delete(`/v1/subscriptionGroups/${g.id}`);
      return { deleted: { id: g.id, referenceName: g.referenceName } };
    },
  },
  {
    name: 'set_subscription_group_localizations',
    description: 'Create or update a subscription group\'s display name (and optional custom app name shown instead of the app name) for many locales in one call. At least one group localization is required before its subscriptions can be submitted.',
    inputSchema: { type: 'object', properties: { group: T.group, app: T.appOptional, localizations: T.localizations(true) }, required: ['group', 'localizations'] },
    annotations: { title: 'Set subscription group localizations', idempotentHint: true },
    async handler(args, ctx) {
      const g = await resolveGroup(ctx, args);
      const results = await upsertLocalizations(ctx, {
        listPath: `/v1/subscriptionGroups/${g.id}/subscriptionGroupLocalizations`,
        type: 'subscriptionGroupLocalizations',
        parentRel: 'subscriptionGroup',
        parentType: 'subscriptionGroups',
        parentId: g.id,
        items: args.localizations,
        map: groupLocMap,
        required: ['name'],
      });
      return { group: g.referenceName ?? g.id, results };
    },
  },

  // ----------------------------- Subscriptions
  {
    name: 'get_subscription',
    description:
      'Full details of an auto-renewable subscription: state, period, level, localizations, current prices (USA by default) and scheduled price changes, availability, review screenshot, introductory/promotional/offer-code/win-back offers, plus a "missing" checklist of what blocks submission.',
    inputSchema: {
      type: 'object',
      properties: { subscription: T.subscription, app: T.appOptional, price_territories: { type: 'array', items: { type: 'string' }, description: 'Show current prices for these territories (default USA)' } },
      required: ['subscription'],
    },
    annotations: { title: 'Get subscription', readOnlyHint: true },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      return subscriptionDetails(ctx, sub.id, args.price_territories?.map((t: string) => t.toUpperCase()));
    },
  },
  {
    name: 'create_subscription',
    description:
      'Create an auto-renewable subscription in a group, optionally with localizations. Then: set_subscription_price, set_subscription_availability, upload_subscription_review_screenshot, and make sure the group has a localization. Gotchas: product_id is permanent and never reusable; group_level 1 is the highest tier (users upgrade/downgrade between levels; same level = crossgrade); the first subscription must be submitted with a new app version.',
    inputSchema: {
      type: 'object',
      properties: {
        group: T.group,
        app: T.appOptional,
        product_id: { type: 'string', description: 'Unique product identifier, e.g. com.example.app.premium.monthly (permanent)' },
        reference_name: { type: 'string', description: 'Internal name (not shown to customers)' },
        period: { type: 'string', enum: SUB_PERIODS, description: 'Billing period' },
        group_level: { type: 'number', description: 'Rank within the group: 1 = highest tier. Default: after existing ones.' },
        family_sharable: { type: 'boolean', description: 'Allow Family Sharing (cannot be turned off once enabled)' },
        review_note: { type: 'string', description: 'Notes for App Review' },
        localizations: T.localizations(),
      },
      required: ['group', 'product_id', 'reference_name', 'period'],
    },
    annotations: { title: 'Create subscription' },
    async handler(args, ctx) {
      const g = await resolveGroup(ctx, args);
      if (!SUB_PERIODS.includes(args.period)) throw new Error(`period must be one of ${SUB_PERIODS.join(', ')}`);
      const doc = await ctx.client.post('/v1/subscriptions', {
        data: {
          type: 'subscriptions',
          attributes: defined({ name: args.reference_name, productId: args.product_id, subscriptionPeriod: args.period, groupLevel: args.group_level, familySharable: args.family_sharable, reviewNote: args.review_note }),
          relationships: { group: rel('subscriptionGroups', g.id) },
        },
      });
      const s = compact(doc.data as JsonApiResource);
      const localizations = args.localizations?.length
        ? await upsertLocalizations(ctx, { listPath: `/v1/subscriptions/${s.id}/subscriptionLocalizations`, type: 'subscriptionLocalizations', parentRel: 'subscription', parentType: 'subscriptions', parentId: s.id, items: args.localizations, map: iapLocMap, required: ['name'] })
        : undefined;
      return { subscription: { id: s.id, productId: s.productId, name: s.name, period: s.subscriptionPeriod, groupLevel: s.groupLevel, state: s.state }, localizations, next: 'set_subscription_price, set_subscription_availability, upload_subscription_review_screenshot' };
    },
  },
  {
    name: 'update_subscription',
    description: 'Change a subscription\'s reference name, period, group level, Family Sharing or review note. Customer-facing name/description: set_subscription_localizations. Changing period of an approved subscription affects renewals.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        reference_name: { type: 'string' },
        period: { type: 'string', enum: SUB_PERIODS },
        group_level: { type: 'number' },
        family_sharable: { type: 'boolean' },
        review_note: { type: 'string' },
      },
      required: ['subscription'],
    },
    annotations: { title: 'Update subscription', idempotentHint: true },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const attributes = defined({ name: args.reference_name, subscriptionPeriod: args.period, groupLevel: args.group_level, familySharable: args.family_sharable, reviewNote: args.review_note });
      if (!Object.keys(attributes).length) throw new Error('Nothing to update');
      const doc = await ctx.client.patch(`/v1/subscriptions/${sub.id}`, { data: { type: 'subscriptions', id: sub.id, attributes } });
      const { relationships, ...out } = compact(doc.data as JsonApiResource) as any;
      return { ...out, id: sub.id, productId: sub.productId };
    },
  },
  {
    name: 'delete_subscription',
    description: 'Delete an auto-renewable subscription. Only possible before it was ever submitted for review; the product id can never be reused.',
    inputSchema: { type: 'object', properties: { subscription: T.subscription, app: T.appOptional, confirm: S.confirm }, required: ['subscription'] },
    annotations: { title: 'Delete subscription', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a subscription');
      const sub = await resolveSubscription(ctx, args);
      await ctx.client.delete(`/v1/subscriptions/${sub.id}`);
      return { deleted: { id: sub.id, productId: sub.productId, name: sub.name } };
    },
  },
  {
    name: 'set_subscription_localizations',
    description: 'Create or update a subscription\'s customer-facing display name and description for many locales in one call (upsert by locale). Limits: name 35 chars, description 55 chars.',
    inputSchema: { type: 'object', properties: { subscription: T.subscription, app: T.appOptional, localizations: T.localizations() }, required: ['subscription', 'localizations'] },
    annotations: { title: 'Set subscription localizations', idempotentHint: true },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const results = await upsertLocalizations(ctx, {
        listPath: `/v1/subscriptions/${sub.id}/subscriptionLocalizations`,
        type: 'subscriptionLocalizations',
        parentRel: 'subscription',
        parentType: 'subscriptions',
        parentId: sub.id,
        items: args.localizations,
        map: iapLocMap,
        required: ['name'],
      });
      return { subscription: sub.productId, results };
    },
  },
  {
    name: 'set_subscription_price',
    description:
      'Set a subscription\'s price. Give the price in a base territory (default USA); by default every territory gets Apple\'s equalized price for it in one call (all_territories true), or limit with territories, and override with territory_prices. For an existing subscription, preserve_current_price keeps current subscribers on their old price; start_date schedules the change. Gotchas: subscriptions have no automatic equalization like apps, so a territory without a price is not sold; price increases may need customer consent.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        price: T.price,
        base_territory: T.baseTerritory,
        all_territories: { type: 'boolean', description: 'Set equalized prices in every territory (default true unless territories is given)' },
        territories: { ...T.territories, description: 'Only these territories (instead of all)' },
        exclude_territories: T.exclude,
        territory_prices: T.territoryPrices,
        start_date: { ...T.date, description: 'Future date the new price starts (default now)' },
        preserve_current_price: { type: 'boolean', description: 'Existing subscribers keep their current price (default false)' },
        plan_type: T.planType,
        one_request_per_territory: { type: 'boolean', description: 'Send one POST per territory instead of a single batch PATCH (slower; reports per-territory errors)' },
      },
      required: ['subscription', 'price'],
    },
    annotations: { title: 'Set subscription price' },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const baseTerritory = await normTerritory(ctx, args.base_territory);
      const startDate = checkDate(args.start_date, 'start_date');
      let territories: string[];
      if (args.territories !== undefined) territories = (await selectTerritories(ctx, args.territories, args.exclude_territories))!;
      else if (args.all_territories === false) territories = [baseTerritory];
      else territories = (await selectTerritories(ctx, 'all', args.exclude_territories))!;
      const { rows, missing } = await pricePointsForTerritories(ctx, 'subscription', sub.id, { baseTerritory, price: args.price, territories, overrides: args.territory_prices });
      const attributes = defined({ startDate, preserveCurrentPrice: args.preserve_current_price, planType: args.plan_type });
      let failed: string[] = [];
      if (rows.length === 1 || args.one_request_per_territory) {
        const res = await mapLimit(rows, 4, r =>
          ctx.client.post('/v1/subscriptionPrices', {
            data: {
              type: 'subscriptionPrices',
              ...(Object.keys(attributes).length ? { attributes } : {}),
              relationships: { subscription: rel('subscriptions', sub.id), territory: rel('territories', r.territory), subscriptionPricePoint: rel('subscriptionPricePoints', r.id) },
            },
          }),
        );
        failed = res.filter(r => !r.ok).map(r => `${r.item.territory}: ${r.error}`);
      } else {
        const included = rows.map(r => ({
          type: 'subscriptionPrices',
          id: inlineId(`price-${r.territory}`),
          ...(Object.keys(attributes).length ? { attributes } : {}),
          relationships: { subscription: rel('subscriptions', sub.id), territory: rel('territories', r.territory), subscriptionPricePoint: rel('subscriptionPricePoints', r.id) },
        }));
        await ctx.client.patch(`/v1/subscriptions/${sub.id}`, {
          data: { type: 'subscriptions', id: sub.id, relationships: { prices: rels('subscriptionPrices', included.map(i => i.id)) } },
          included,
        });
      }
      const base = rows.find(r => r.territory === baseTerritory);
      return {
        subscription: sub.productId,
        base: base ? { territory: baseTerritory, customerPrice: base.customerPrice, proceeds: base.proceeds, proceedsYear2: base.proceedsYear2 } : undefined,
        territoriesSet: rows.length - failed.length,
        sample: rows.slice(0, 8).map(r => `${r.territory}: ${r.customerPrice}`),
        noEqualizedPrice: missing.length ? missing : undefined,
        failed: failed.length ? failed : undefined,
        startDate,
        preserveCurrentPrice: args.preserve_current_price,
      };
    },
  },
  {
    name: 'set_subscription_availability',
    description: 'Choose the territories where a subscription is sold ("all", a list, and/or exclusions) and whether new territories are added automatically. Creates or updates the subscription\'s plan availability. Required before submission; territories also need a price.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        territories: T.territories,
        exclude_territories: T.exclude,
        available_in_new_territories: { ...T.newTerritories, description: 'Default true' },
        plan_type: { ...T.planType, description: 'Plan type (default UPFRONT, the standard plan)' },
      },
      required: ['subscription'],
    },
    annotations: { title: 'Set subscription availability', idempotentHint: true },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const planType = args.plan_type ?? 'UPFRONT';
      const territories = (await selectTerritories(ctx, args.territories ?? (args.exclude_territories?.length ? undefined : 'all'), args.exclude_territories))!;
      const doc = await tryGet(ctx, `/v1/subscriptions/${sub.id}/planAvailabilities`, { limit: 10 });
      const existing = ((doc?.data as JsonApiResource[]) ?? []).find(p => (p.attributes?.planType ?? 'UPFRONT') === planType);
      if (existing) {
        await ctx.client.patch(`/v1/subscriptionPlanAvailabilities/${existing.id}`, {
          data: {
            type: 'subscriptionPlanAvailabilities',
            id: existing.id,
            attributes: defined({ availableInNewTerritories: args.available_in_new_territories }),
            relationships: { availableTerritories: rels('territories', territories) },
          },
        });
        return { subscription: sub.productId, action: 'updated', planType, territoryCount: territories.length };
      }
      const created = await ctx.client.post('/v1/subscriptionPlanAvailabilities', {
        data: {
          type: 'subscriptionPlanAvailabilities',
          attributes: { availableInNewTerritories: args.available_in_new_territories ?? true, planType },
          relationships: { availableTerritories: rels('territories', territories), subscription: rel('subscriptions', sub.id) },
        },
      });
      return { subscription: sub.productId, action: 'created', id: (created.data as JsonApiResource)?.id, planType, territoryCount: territories.length };
    },
  },
  {
    name: 'upload_subscription_review_screenshot',
    description: 'Upload the App Review screenshot for a subscription (required for submission): a screenshot of the subscription offer in your app. Replaces an existing one.',
    inputSchema: { type: 'object', properties: { subscription: T.subscription, app: T.appOptional, file_path: S.filePath }, required: ['subscription', 'file_path'] },
    annotations: { title: 'Upload subscription review screenshot' },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const cur = await tryGet(ctx, `/v1/subscriptions/${sub.id}/appStoreReviewScreenshot`);
      const old = cur?.data as JsonApiResource | undefined;
      if (old?.id) await ctx.client.delete(`/v1/subscriptionAppStoreReviewScreenshots/${old.id}`);
      const res = await uploadAsset(ctx, { type: 'subscriptionAppStoreReviewScreenshots', parentRelationship: 'subscription', parentType: 'subscriptions', parentId: sub.id, filePath: args.file_path });
      return { subscription: sub.productId, replaced: old?.id, screenshot: { id: res.id, fileName: res.fileName, state: res.assetDeliveryState?.state, note: res.note } };
    },
  },
  {
    name: 'upload_subscription_image',
    description: 'Upload a subscription\'s promotional image (1024x1024 PNG/JPG, used when promoting the subscription and for win-back offers). Optional for review.',
    inputSchema: { type: 'object', properties: { subscription: T.subscription, app: T.appOptional, file_path: S.filePath }, required: ['subscription', 'file_path'] },
    annotations: { title: 'Upload subscription image' },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const res = await uploadAsset(ctx, { type: 'subscriptionImages', parentRelationship: 'subscription', parentType: 'subscriptions', parentId: sub.id, filePath: args.file_path });
      return { subscription: sub.productId, image: { id: res.id, fileName: res.fileName, state: res.state ?? res.assetDeliveryState?.state, note: res.note } };
    },
  },
  {
    name: 'submit_subscription',
    description:
      'Submit a subscription (or, with group, every ready subscription in a group) for App Review. Each must be READY_TO_SUBMIT: localization, price, availability, review screenshot, and the group needs a localization (check with get_subscription). Gotcha: an app\'s FIRST subscription must be submitted with a new app version: add it in the version\'s "In-App Purchases and Subscriptions" section in App Store Connect, then submit the version.',
    inputSchema: { type: 'object', properties: { subscription: T.subscription, group: T.group, app: T.appOptional, confirm: S.confirm } },
    annotations: { title: 'Submit subscription', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Submitting subscriptions for review');
      if (args.group && !args.subscription) {
        const g = await resolveGroup(ctx, args);
        const doc = await ctx.client.post('/v1/subscriptionGroupSubmissions', { data: { type: 'subscriptionGroupSubmissions', relationships: { subscriptionGroup: rel('subscriptionGroups', g.id) } } });
        return { submittedGroup: g.referenceName ?? g.id, submissionId: (doc.data as JsonApiResource)?.id };
      }
      const sub = await resolveSubscription(ctx, args);
      if (sub.state && !['READY_TO_SUBMIT', 'DEVELOPER_ACTION_NEEDED', 'REJECTED'].includes(sub.state)) {
        throw new Error(`Subscription is ${sub.state}, not READY_TO_SUBMIT. Run get_subscription to see what is missing.`);
      }
      const doc = await ctx.client.post('/v1/subscriptionSubmissions', { data: { type: 'subscriptionSubmissions', relationships: { subscription: rel('subscriptions', sub.id) } } });
      return { submitted: sub.productId, submissionId: (doc.data as JsonApiResource)?.id };
    },
  },
  {
    name: 'set_subscription_grace_period',
    description: 'Configure the app-wide Billing Grace Period for auto-renewable subscriptions (subscribers keep access while Apple retries a failed payment).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        opt_in: { type: 'boolean', description: 'Turn grace period on in production' },
        sandbox_opt_in: { type: 'boolean', description: 'Turn it on in sandbox' },
        duration: { type: 'string', enum: ['THREE_DAYS', 'SIXTEEN_DAYS', 'TWENTY_EIGHT_DAYS'] },
        renewal_type: { type: 'string', enum: ['ALL_RENEWALS', 'PAID_TO_PAID_ONLY'] },
      },
      required: ['app'],
    },
    annotations: { title: 'Set billing grace period', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const cur = await ctx.client.get(`/v1/apps/${app.id}/subscriptionGracePeriod`);
      const gp = cur.data as JsonApiResource;
      const attributes = defined({ optIn: args.opt_in, sandboxOptIn: args.sandbox_opt_in, duration: args.duration, renewalType: args.renewal_type });
      if (!Object.keys(attributes).length) return { app: app.name, current: gp.attributes };
      const doc = await ctx.client.patch(`/v1/subscriptionGracePeriods/${gp.id}`, { data: { type: 'subscriptionGracePeriods', id: gp.id, attributes } });
      return { app: app.name, gracePeriod: (doc.data as JsonApiResource)?.attributes ?? attributes };
    },
  },

  // ----------------------------- Offers
  {
    name: 'list_subscription_offers',
    description: 'List every offer on a subscription: introductory offers (per territory, grouped), promotional offers, offer codes (with generated one-time/custom code batches) and win-back offers.',
    inputSchema: { type: 'object', properties: { subscription: T.subscription, app: T.appOptional, territory: { ...T.territory, description: 'Only intro offers in this territory (shows per-territory detail)' } }, required: ['subscription'] },
    annotations: { title: 'List subscription offers', readOnlyHint: true },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const intro = await ctx.client.getAll(`/v1/subscriptions/${sub.id}/introductoryOffers`, { include: 'territory,subscriptionPricePoint', limit: 200, 'filter[territory]': args.territory?.toUpperCase() }, 2000);
      const inc = includedMap(intro);
      const introRows = intro.data.map(o => {
        const pp = relId(o, 'subscriptionPricePoint');
        return defined({ id: o.id, territory: relId(o, 'territory'), ...o.attributes, price: pp ? inc.get(`subscriptionPricePoints/${pp}`)?.attributes?.customerPrice : undefined });
      });
      const promos = await ctx.client.getAll(`/v1/subscriptions/${sub.id}/promotionalOffers`, { include: 'prices', limit: 200 }, 500);
      const codes = await ctx.client.getAll(`/v1/subscriptions/${sub.id}/offerCodes`, { include: 'oneTimeUseCodes,customCodes', limit: 200 }, 500);
      const cinc = includedMap(codes);
      const wb = await ctx.client.getAll(`/v1/subscriptions/${sub.id}/winBackOffers`, { limit: 200 }, 500);
      let introductory: any;
      if (args.territory) introductory = introRows;
      else {
        const groups = new Map<string, any>();
        for (const r of introRows as any[]) {
          const key = [r.offerMode, r.duration, r.numberOfPeriods, r.startDate ?? '', r.endDate ?? ''].join('|');
          const g = groups.get(key) ?? { offerMode: r.offerMode, duration: r.duration, numberOfPeriods: r.numberOfPeriods, startDate: r.startDate, endDate: r.endDate, territories: [] as string[] };
          g.territories.push(r.price ? `${r.territory}:${r.price}` : r.territory);
          groups.set(key, g);
        }
        introductory = [...groups.values()].map(g => ({ ...g, territoryCount: g.territories.length, territories: g.territories.length > 30 ? g.territories.slice(0, 30).concat('…') : g.territories }));
      }
      return {
        subscription: sub.productId,
        introductoryOffers: introductory,
        promotionalOffers: promos.data.map(o => ({ id: o.id, ...o.attributes, priceTerritories: relIds(o, 'prices').length || o.relationships?.prices?.meta?.paging?.total })),
        offerCodes: codes.data.map(o => ({
          id: o.id,
          ...o.attributes,
          oneTimeUseCodes: relIds(o, 'oneTimeUseCodes').map(id => ({ id, ...(cinc.get(`subscriptionOfferCodeOneTimeUseCodes/${id}`)?.attributes ?? {}) })),
          customCodes: relIds(o, 'customCodes').map(id => ({ id, ...(cinc.get(`subscriptionOfferCodeCustomCodes/${id}`)?.attributes ?? {}) })),
        })),
        winBackOffers: wb.data.map(o => ({ id: o.id, ...o.attributes })),
      };
    },
  },
  {
    name: 'create_introductory_offer',
    description:
      'Create an introductory offer (free trial or discounted first periods for new subscribers) in many territories at once (one offer per territory; default: every territory the subscription is available in). Paid modes need price in base_territory; it is equalized per territory. Rules: one intro offer per territory at a time; FREE_TRIAL and PAY_UP_FRONT use number_of_periods 1; PAY_AS_YOU_GO duration must equal the subscription period.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        offer_mode: T.offerMode,
        duration: T.duration,
        number_of_periods: T.periods,
        territories: { ...T.territories, description: 'Territories (default: where the subscription is available)' },
        exclude_territories: T.exclude,
        price: { ...T.price, description: 'Discounted price in base_territory (PAY_AS_YOU_GO / PAY_UP_FRONT only)' },
        base_territory: T.baseTerritory,
        territory_prices: T.territoryPrices,
        start_date: { ...T.date, description: 'Optional start date' },
        end_date: { ...T.date, description: 'Optional end date' },
        plan_type: T.planType,
      },
      required: ['subscription', 'offer_mode', 'duration'],
    },
    annotations: { title: 'Create introductory offer' },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      if (!OFFER_MODES.includes(args.offer_mode)) throw new Error(`offer_mode must be one of ${OFFER_MODES.join(', ')}`);
      const territories = await resolveOfferTerritories(ctx, sub.id, args);
      let rows: Array<{ territory: string; id?: string; customerPrice?: string }> = territories.map(t => ({ territory: t }));
      let missing: string[] = [];
      if (args.offer_mode !== 'FREE_TRIAL') {
        if (args.price === undefined) throw new Error(`${args.offer_mode} needs price (the discounted price in base_territory)`);
        const r = await pricePointsForTerritories(ctx, 'subscription', sub.id, { baseTerritory: await normTerritory(ctx, args.base_territory), price: args.price, territories, overrides: args.territory_prices });
        rows = r.rows;
        missing = r.missing;
      }
      const attributes = defined({
        duration: args.duration,
        offerMode: args.offer_mode,
        numberOfPeriods: periodsDefault(args),
        startDate: checkDate(args.start_date, 'start_date'),
        endDate: checkDate(args.end_date, 'end_date'),
        targetSubscriptionPlanType: args.plan_type,
      });
      const results = await mapLimit(rows, 4, r =>
        ctx.client.post('/v1/subscriptionIntroductoryOffers', {
          data: {
            type: 'subscriptionIntroductoryOffers',
            attributes,
            relationships: defined({
              subscription: rel('subscriptions', sub.id),
              territory: rel('territories', r.territory),
              subscriptionPricePoint: r.id ? rel('subscriptionPricePoints', r.id) : undefined,
            }),
          },
        }),
      );
      return {
        subscription: sub.productId,
        offer: attributes,
        created: results.filter(r => r.ok).length,
        prices: args.offer_mode === 'FREE_TRIAL' ? undefined : summarizePrices(rows),
        noEqualizedPrice: missing.length ? missing : undefined,
        failed: results.filter(r => !r.ok).map(r => `${r.item.territory}: ${r.error}`),
      };
    },
  },
  {
    name: 'delete_introductory_offers',
    description: 'Delete a subscription\'s introductory offers: all of them, those in given territories, or specific offer ids (see list_subscription_offers). Use to replace an intro offer (one per territory at a time).',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        territories: { ...T.territories, description: '"all" or territory codes whose intro offers to delete' },
        offer_ids: { type: 'array', items: { type: 'string' }, description: 'Specific introductory offer ids' },
        confirm: S.confirm,
      },
      required: ['subscription'],
    },
    annotations: { title: 'Delete introductory offers', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting introductory offers');
      const sub = await resolveSubscription(ctx, args);
      if (!args.offer_ids?.length && args.territories === undefined) throw new Error('Pass territories ("all" or codes) or offer_ids');
      const intro = await ctx.client.getAll(`/v1/subscriptions/${sub.id}/introductoryOffers`, { include: 'territory', limit: 200 }, 2000);
      const terr = args.territories === undefined ? undefined : args.territories === 'all' ? undefined : new Set((args.territories as string[]).map(t => t.toUpperCase()));
      const targets = intro.data.filter(o => (args.offer_ids?.length ? args.offer_ids.includes(o.id) : !terr || terr.has(relId(o, 'territory') ?? '')));
      const results = await mapLimit(targets, 4, o => ctx.client.delete(`/v1/subscriptionIntroductoryOffers/${o.id}`));
      return { subscription: sub.productId, deleted: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => `${relId(r.item, 'territory')}: ${r.error}`) };
    },
  },
  {
    name: 'create_promotional_offer',
    description:
      'Create a promotional offer for existing/lapsed subscribers (your app presents it with a signed offer via StoreKit). offer_code is the identifier your app uses. Prices are set for every territory (default: where the subscription is available) from price in base_territory. FREE_TRIAL needs no price.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        name: { type: 'string', description: 'Reference name (internal)' },
        offer_code: { type: 'string', description: 'Offer identifier used in StoreKit, e.g. "winback50" (unique per subscription)' },
        offer_mode: T.offerMode,
        duration: T.duration,
        number_of_periods: T.periods,
        price: { ...T.price, description: 'Discounted price in base_territory (not for FREE_TRIAL)' },
        base_territory: T.baseTerritory,
        territories: T.territories,
        exclude_territories: T.exclude,
        territory_prices: T.territoryPrices,
        plan_type: T.planType,
      },
      required: ['subscription', 'name', 'offer_code', 'offer_mode', 'duration'],
    },
    annotations: { title: 'Create promotional offer' },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const p = await offerPrices(ctx, sub.id, args, 'subscriptionPromotionalOfferPrices');
      const attributes = defined({ name: args.name, offerCode: args.offer_code, offerMode: args.offer_mode, duration: args.duration, numberOfPeriods: periodsDefault(args), targetSubscriptionPlanType: args.plan_type });
      const doc = await ctx.client.post('/v1/subscriptionPromotionalOffers', {
        data: { type: 'subscriptionPromotionalOffers', attributes, relationships: { subscription: rel('subscriptions', sub.id), prices: p.linkage } },
        included: p.included,
      });
      return { subscription: sub.productId, id: (doc.data as JsonApiResource)?.id, offer: attributes, prices: summarizePrices(p.rows), noEqualizedPrice: p.missing.length ? p.missing : undefined };
    },
  },
  {
    name: 'delete_promotional_offer',
    description: 'Delete a subscription promotional offer by id (see list_subscription_offers). Apps presenting it will no longer be able to.',
    inputSchema: { type: 'object', properties: { offer_id: { type: 'string' }, confirm: S.confirm }, required: ['offer_id'] },
    annotations: { title: 'Delete promotional offer', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a promotional offer');
      await ctx.client.delete(`/v1/subscriptionPromotionalOffers/${args.offer_id}`);
      return { deleted: args.offer_id };
    },
  },
  {
    name: 'create_offer_code',
    description:
      'Create an offer code campaign (redeemable codes) for a subscription or an in-app purchase. Subscription: customer_eligibilities NEW/EXISTING/EXPIRED, offer_eligibility STACK_WITH_INTRO_OFFERS or REPLACE_INTRO_OFFERS, offer_mode, duration, number_of_periods; prices per territory from price in base_territory (FREE_TRIAL needs no price). In-app purchase: customer_eligibilities NON_SPENDER/ACTIVE_SPENDER/CHURNED_SPENDER and a price. Then create codes with generate_one_time_codes or create_custom_code.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        iap: T.iap,
        app: T.appOptional,
        name: { type: 'string', description: 'Reference name (internal)' },
        customer_eligibilities: { type: 'array', items: { type: 'string', enum: ['NEW', 'EXISTING', 'EXPIRED', 'NON_SPENDER', 'ACTIVE_SPENDER', 'CHURNED_SPENDER'] }, description: 'Who can redeem' },
        offer_eligibility: { type: 'string', enum: ['STACK_WITH_INTRO_OFFERS', 'REPLACE_INTRO_OFFERS'], description: 'Subscriptions only (default STACK_WITH_INTRO_OFFERS)' },
        offer_mode: { ...T.offerMode, description: 'Subscriptions only' },
        duration: { ...T.duration, description: 'Subscriptions only' },
        number_of_periods: T.periods,
        auto_renew_enabled: { type: 'boolean', description: 'Subscriptions only: renew automatically after the offer (default true)' },
        price: { ...T.price, description: 'Offer price in base_territory (required for paid subscription modes and for IAPs)' },
        base_territory: T.baseTerritory,
        territories: T.territories,
        exclude_territories: T.exclude,
        territory_prices: T.territoryPrices,
        plan_type: T.planType,
      },
      required: ['name', 'customer_eligibilities'],
    },
    annotations: { title: 'Create offer code' },
    async handler(args, ctx) {
      if (!!args.subscription === !!args.iap) throw new Error('Pass exactly one of subscription or iap');
      if (args.iap) {
        const iap = await resolveIap(ctx, args);
        const territories = (await selectTerritories(ctx, args.territories ?? 'all', args.exclude_territories))!;
        if (args.price === undefined) throw new Error('In-app purchase offer codes need price (offer price in base_territory)');
        const r = await pricePointsForTerritories(ctx, 'iap', iap.id, { baseTerritory: await normTerritory(ctx, args.base_territory), price: args.price, territories, overrides: args.territory_prices });
        const included = r.rows.map(x => ({ type: 'inAppPurchaseOfferPrices', id: inlineId(`price-${x.territory}`), relationships: { territory: rel('territories', x.territory), pricePoint: rel('inAppPurchasePricePoints', x.id) } }));
        const doc = await ctx.client.post('/v1/inAppPurchaseOfferCodes', {
          data: {
            type: 'inAppPurchaseOfferCodes',
            attributes: { name: args.name, customerEligibilities: args.customer_eligibilities },
            relationships: { inAppPurchase: rel('inAppPurchases', iap.id), prices: rels('inAppPurchaseOfferPrices', included.map(i => i.id)) },
          },
          included,
        });
        return { inAppPurchase: iap.productId, offerCodeId: (doc.data as JsonApiResource)?.id, kind: 'iap', prices: summarizePrices(r.rows), noEqualizedPrice: r.missing.length ? r.missing : undefined, next: 'generate_one_time_codes or create_custom_code' };
      }
      const sub = await resolveSubscription(ctx, args);
      if (!args.offer_mode || !args.duration) throw new Error('Subscription offer codes need offer_mode and duration');
      const p = await offerPrices(ctx, sub.id, args, 'subscriptionOfferCodePrices');
      const attributes = defined({
        name: args.name,
        customerEligibilities: args.customer_eligibilities,
        offerEligibility: args.offer_eligibility ?? 'STACK_WITH_INTRO_OFFERS',
        offerMode: args.offer_mode,
        duration: args.duration,
        numberOfPeriods: periodsDefault(args),
        autoRenewEnabled: args.auto_renew_enabled,
        targetSubscriptionPlanType: args.plan_type,
      });
      const doc = await ctx.client.post('/v1/subscriptionOfferCodes', {
        data: { type: 'subscriptionOfferCodes', attributes, relationships: { subscription: rel('subscriptions', sub.id), prices: p.linkage } },
        included: p.included,
      });
      return { subscription: sub.productId, offerCodeId: (doc.data as JsonApiResource)?.id, kind: 'subscription', offer: attributes, prices: summarizePrices(p.rows), noEqualizedPrice: p.missing.length ? p.missing : undefined, next: 'generate_one_time_codes or create_custom_code' };
    },
  },
  {
    name: 'generate_one_time_codes',
    description: 'Generate a batch of unique one-time-use codes for an offer code campaign (subscription or IAP) and save them to a CSV file (path returned). Max 25,000 codes per batch; expiration_date is required. Codes may take a moment to generate; if the file is not ready, fetch later with api_request GET /v1/<kind>OfferCodeOneTimeUseCodes/{id}/values.',
    inputSchema: {
      type: 'object',
      properties: {
        offer_code_id: { type: 'string', description: 'Offer code campaign id (from create_offer_code / list_subscription_offers)' },
        kind: { type: 'string', enum: ['subscription', 'iap'], description: 'Campaign belongs to a subscription (default) or an in-app purchase' },
        number_of_codes: { type: 'number', description: 'How many codes (up to 25000)' },
        expiration_date: { ...T.date, description: 'Codes expire on this date' },
        environment: { type: 'string', enum: ['PRODUCTION', 'SANDBOX'], description: 'Default PRODUCTION' },
      },
      required: ['offer_code_id', 'number_of_codes', 'expiration_date'],
    },
    annotations: { title: 'Generate one-time offer codes' },
    async handler(args, ctx) {
      const prefix = args.kind === 'iap' ? 'inAppPurchase' : 'subscription';
      const type = `${prefix}OfferCodeOneTimeUseCodes`;
      const doc = await ctx.client.post(`/v1/${type}`, {
        data: {
          type,
          attributes: defined({ numberOfCodes: args.number_of_codes, expirationDate: checkDate(args.expiration_date, 'expiration_date'), environment: args.environment }),
          relationships: { offerCode: rel(`${prefix}OfferCodes`, args.offer_code_id) },
        },
      });
      const id = (doc.data as JsonApiResource)?.id;
      if (ctx.dryRun || isDry(id)) return { batchId: id, numberOfCodes: args.number_of_codes };
      try {
        const { bytes } = await ctx.client.download(`/v1/${type}/${id}/values`, undefined, 'text/csv');
        const file = saveOutput(ctx, `offer-codes-${id}.csv`, bytes);
        return { batchId: id, numberOfCodes: args.number_of_codes, file };
      } catch (e: any) {
        return { batchId: id, numberOfCodes: args.number_of_codes, note: `Codes requested but not downloadable yet (${e.message.split('\n')[0]}). Retry: api_request GET /v1/${type}/${id}/values` };
      }
    },
  },
  {
    name: 'create_custom_code',
    description: 'Create a custom (vanity) offer code like "SUMMER2026" that many customers can redeem, for a subscription or IAP offer code campaign. number_of_codes caps total redemptions.',
    inputSchema: {
      type: 'object',
      properties: {
        offer_code_id: { type: 'string', description: 'Offer code campaign id' },
        kind: { type: 'string', enum: ['subscription', 'iap'], description: 'Default subscription' },
        custom_code: { type: 'string', description: 'The code customers type (letters and digits)' },
        number_of_codes: { type: 'number', description: 'Maximum redemptions' },
        expiration_date: { ...T.date, description: 'Optional expiry date' },
      },
      required: ['offer_code_id', 'custom_code', 'number_of_codes'],
    },
    annotations: { title: 'Create custom offer code' },
    async handler(args, ctx) {
      const prefix = args.kind === 'iap' ? 'inAppPurchase' : 'subscription';
      const type = `${prefix}OfferCodeCustomCodes`;
      const doc = await ctx.client.post(`/v1/${type}`, {
        data: {
          type,
          attributes: defined({ customCode: args.custom_code, numberOfCodes: args.number_of_codes, expirationDate: checkDate(args.expiration_date, 'expiration_date') }),
          relationships: { offerCode: rel(`${prefix}OfferCodes`, args.offer_code_id) },
        },
      });
      return { id: (doc.data as JsonApiResource)?.id, customCode: args.custom_code, numberOfCodes: args.number_of_codes };
    },
  },
  {
    name: 'deactivate_offer_code',
    description: 'Deactivate an offer code campaign, a one-time-use code batch, or a custom code (subscription or IAP). Deactivated codes can no longer be redeemed; this cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the campaign, one-time batch or custom code' },
        target: { type: 'string', enum: ['campaign', 'one_time_codes', 'custom_code'], description: 'What the id is' },
        kind: { type: 'string', enum: ['subscription', 'iap'], description: 'Default subscription' },
        confirm: S.confirm,
      },
      required: ['id', 'target'],
    },
    annotations: { title: 'Deactivate offer code', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deactivating offer codes');
      const prefix = args.kind === 'iap' ? 'inAppPurchase' : 'subscription';
      const type = { campaign: `${prefix}OfferCodes`, one_time_codes: `${prefix}OfferCodeOneTimeUseCodes`, custom_code: `${prefix}OfferCodeCustomCodes` }[args.target as string];
      if (!type) throw new Error('target must be campaign, one_time_codes or custom_code');
      await ctx.client.patch(`/v1/${type}/${args.id}`, { data: { type, id: args.id, attributes: { active: false } } });
      return { deactivated: args.id, type };
    },
  },
  {
    name: 'create_win_back_offer',
    description:
      'Create a win-back offer shown to lapsed subscribers (on the App Store and in-app). Eligibility: customers who paid at least eligibility_paid_months, lapsed between eligibility_lapsed_min_months and eligibility_lapsed_max_months ago, optionally waiting wait_between_offers_months between offers. Prices for every territory come from price in base_territory (FREE_TRIAL needs none). Requires iOS 18+ customers.',
    inputSchema: {
      type: 'object',
      properties: {
        subscription: T.subscription,
        app: T.appOptional,
        reference_name: { type: 'string' },
        offer_id: { type: 'string', description: 'Offer identifier (unique per subscription)' },
        offer_mode: T.offerMode,
        duration: T.duration,
        period_count: { type: 'number', description: 'Number of periods (default 1)' },
        eligibility_paid_months: { type: 'number', description: 'Minimum months the customer paid before lapsing' },
        eligibility_lapsed_min_months: { type: 'number', description: 'Lapsed at least this many months ago' },
        eligibility_lapsed_max_months: { type: 'number', description: 'Lapsed at most this many months ago' },
        wait_between_offers_months: { type: 'number', description: 'Optional months between win-back offers for a customer' },
        start_date: { ...T.date, description: 'Start date (default today)' },
        end_date: { ...T.date, description: 'Optional end date' },
        priority: { type: 'string', enum: ['HIGH', 'NORMAL'], description: 'Default NORMAL' },
        promotion_intent: { type: 'string', enum: ['NOT_PROMOTED', 'USE_AUTO_GENERATED_ASSETS'], description: 'Promote on the App Store (default NOT_PROMOTED)' },
        price: { ...T.price, description: 'Offer price in base_territory (not for FREE_TRIAL)' },
        base_territory: T.baseTerritory,
        territories: T.territories,
        exclude_territories: T.exclude,
        territory_prices: T.territoryPrices,
        plan_type: T.planType,
      },
      required: ['subscription', 'reference_name', 'offer_id', 'offer_mode', 'duration', 'eligibility_paid_months', 'eligibility_lapsed_min_months'],
    },
    annotations: { title: 'Create win-back offer' },
    async handler(args, ctx) {
      const sub = await resolveSubscription(ctx, args);
      const p = await offerPrices(ctx, sub.id, args, 'winBackOfferPrices');
      const attributes = defined({
        referenceName: args.reference_name,
        offerId: args.offer_id,
        duration: args.duration,
        offerMode: args.offer_mode,
        periodCount: args.period_count ?? 1,
        customerEligibilityPaidSubscriptionDurationInMonths: args.eligibility_paid_months,
        customerEligibilityTimeSinceLastSubscribedInMonths: defined({ minimum: args.eligibility_lapsed_min_months, maximum: args.eligibility_lapsed_max_months }),
        customerEligibilityWaitBetweenOffersInMonths: args.wait_between_offers_months,
        startDate: checkDate(args.start_date, 'start_date') ?? today(),
        endDate: checkDate(args.end_date, 'end_date'),
        priority: args.priority ?? 'NORMAL',
        promotionIntent: args.promotion_intent,
        targetSubscriptionPlanType: args.plan_type,
      });
      const doc = await ctx.client.post('/v1/winBackOffers', {
        data: { type: 'winBackOffers', attributes, relationships: { subscription: rel('subscriptions', sub.id), prices: p.linkage } },
        included: p.included,
      });
      return { subscription: sub.productId, id: (doc.data as JsonApiResource)?.id, offer: attributes, prices: summarizePrices(p.rows), noEqualizedPrice: p.missing.length ? p.missing : undefined };
    },
  },
  {
    name: 'delete_win_back_offer',
    description: 'Delete a win-back offer by id (see list_subscription_offers).',
    inputSchema: { type: 'object', properties: { offer_id: { type: 'string' }, confirm: S.confirm }, required: ['offer_id'] },
    annotations: { title: 'Delete win-back offer', destructiveHint: true },
    async handler(args, ctx) {
      requireConfirm(args, 'Deleting a win-back offer');
      await ctx.client.delete(`/v1/winBackOffers/${args.offer_id}`);
      return { deleted: args.offer_id };
    },
  },

  // ----------------------------- Promoted purchases
  {
    name: 'list_promoted_purchases',
    description: 'List the in-app purchases and subscriptions promoted on the app\'s App Store page, in display order, with enabled/visibility/state.',
    inputSchema: { type: 'object', properties: { app: S.app }, required: ['app'] },
    annotations: { title: 'List promoted purchases', readOnlyHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const all = await ctx.client.getAll(`/v1/apps/${app.id}/promotedPurchases`, { include: 'inAppPurchaseV2,subscription', limit: 200 }, 200);
      const inc = includedMap(all);
      return {
        app: app.name,
        promotedPurchases: all.data.map((p, i) => {
          const iapId = relId(p, 'inAppPurchaseV2');
          const subId = relId(p, 'subscription');
          const prod = iapId ? inc.get(`inAppPurchases/${iapId}`) : subId ? inc.get(`subscriptions/${subId}`) : undefined;
          return defined({ position: i + 1, id: p.id, ...p.attributes, product: prod?.attributes?.productId, productName: prod?.attributes?.name, kind: iapId ? 'iap' : subId ? 'subscription' : undefined, productRecordId: iapId ?? subId });
        }),
      };
    },
  },
  {
    name: 'set_promoted_purchases',
    description:
      'Set which in-app purchases/subscriptions are promoted on the App Store page and in what order (first = shown first). Creates missing promotions, updates enabled/visibility, then applies the order. Products not listed are kept after the listed ones unless remove_unlisted is true. Promotions are reviewed with the product (state PREPARE_FOR_SUBMISSION until then).',
    inputSchema: {
      type: 'object',
      properties: {
        app: S.app,
        products: {
          type: 'array',
          description: 'Ordered list: [{product: "<product id or record id>", enabled?: true, visible_for_all_users?: true}]',
          items: {
            type: 'object',
            properties: {
              product: { type: 'string', description: 'Product id (or IAP/subscription record id)' },
              enabled: { type: 'boolean', description: 'Show it (default true)' },
              visible_for_all_users: { type: 'boolean', description: 'Show to everyone, not only eligible users (default true)' },
            },
            required: ['product'],
          },
        },
        remove_unlisted: { type: 'boolean', description: 'Drop promotions not in the list from the page (default false)' },
      },
      required: ['app', 'products'],
    },
    annotations: { title: 'Set promoted purchases', idempotentHint: true },
    async handler(args, ctx) {
      const app = await resolveApp(ctx, args.app);
      const [iaps, groups, promoted] = await Promise.all([
        ctx.client.getAll(`/v1/apps/${app.id}/inAppPurchasesV2`, { limit: 200 }, 1000),
        ctx.client.getAll(`/v1/apps/${app.id}/subscriptionGroups`, { include: 'subscriptions', 'limit[subscriptions]': 50 }, 200),
        ctx.client.getAll(`/v1/apps/${app.id}/promotedPurchases`, { include: 'inAppPurchaseV2,subscription', limit: 200 }, 200),
      ]);
      const subs = groups.included.filter(r => r.type === 'subscriptions');
      const findProduct = (ref: string) => {
        const iap = iaps.data.find(r => r.attributes?.productId === ref || r.id === ref);
        if (iap) return { kind: 'iap' as const, id: iap.id, productId: iap.attributes?.productId };
        const sub = subs.find(r => r.attributes?.productId === ref || r.id === ref);
        if (sub) return { kind: 'subscription' as const, id: sub.id, productId: sub.attributes?.productId };
        throw new Error(`No in-app purchase or subscription "${ref}" in ${app.name}`);
      };
      const order: string[] = [];
      const actions: any[] = [];
      for (const item of args.products ?? []) {
        const prod = findProduct(String(item.product));
        const attrs = { visibleForAllUsers: item.visible_for_all_users ?? true, enabled: item.enabled ?? true };
        const existing = promoted.data.find(p => relId(p, prod.kind === 'iap' ? 'inAppPurchaseV2' : 'subscription') === prod.id);
        let promotedId = existing?.id;
        if (existing) {
          if (existing.attributes?.enabled !== attrs.enabled || existing.attributes?.visibleForAllUsers !== attrs.visibleForAllUsers) {
            await ctx.client.patch(`/v1/promotedPurchases/${existing.id}`, { data: { type: 'promotedPurchases', id: existing.id, attributes: attrs } });
            actions.push({ product: prod.productId, action: 'updated', id: existing.id });
          } else actions.push({ product: prod.productId, action: 'unchanged', id: existing.id });
        }
        if (!promotedId) {
          const doc = await ctx.client.post('/v1/promotedPurchases', {
            data: {
              type: 'promotedPurchases',
              attributes: attrs,
              relationships: { app: rel('apps', app.id), ...(prod.kind === 'iap' ? { inAppPurchaseV2: rel('inAppPurchases', prod.id) } : { subscription: rel('subscriptions', prod.id) }) },
            },
          });
          promotedId = (doc.data as JsonApiResource).id;
          actions.push({ product: prod.productId, action: 'created', id: promotedId });
        }
        order.push(promotedId!);
      }
      const rest = args.remove_unlisted ? [] : promoted.data.map(p => p.id).filter(id => !order.includes(id));
      const finalOrder = [...order, ...rest];
      await ctx.client.patch(`/v1/apps/${app.id}/relationships/promotedPurchases`, rels('promotedPurchases', finalOrder));
      return { app: app.name, actions, order: finalOrder, removed: args.remove_unlisted ? promoted.data.map(p => p.id).filter(id => !order.includes(id)) : undefined };
    },
  },
];
