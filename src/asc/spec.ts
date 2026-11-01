/**
 * Index over Apple's App Store Connect OpenAPI spec (bundled, gzip).
 * Powers api_search / api_describe / api_schema so every endpoint is reachable.
 */
import { readFileSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';
import { fileURLToPath } from 'url';
import path from 'path';

export interface OperationInfo {
  operationId: string;
  method: string;
  path: string;
  tags: string[];
  summary: string;
  deprecated: boolean;
  words: string[];
}

let spec: any;
let ops: OperationInfo[] = [];

function specPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../spec/openapi.json.gz'), path.resolve(here, '../spec/openapi.json.gz')];
  const found = candidates.find(p => existsSync(p));
  if (!found) throw new Error('Bundled OpenAPI spec not found (spec/openapi.json.gz). Run `npm run update-spec`.');
  return found;
}

export function loadSpec(): any {
  if (spec) return spec;
  spec = JSON.parse(gunzipSync(readFileSync(specPath())).toString('utf-8'));
  ops = [];
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const method of ['get', 'post', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      const tags = op.tags ?? [];
      ops.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path: p,
        tags,
        summary: summarize(op.operationId, method, p),
        deprecated: !!op.deprecated,
        words: tokenize(`${op.operationId} ${p} ${tags.join(' ')}`),
      });
    }
  }
  return spec;
}

export function specVersion(): string {
  return loadSpec().info?.version ?? 'unknown';
}

export function operations(): OperationInfo[] {
  loadSpec();
  return ops;
}

function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && w.endsWith('es') && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(s: string): string[] {
  return [...new Set(splitWords(s).map(stem))];
}

const SYNONYMS: Record<string, string[]> = {
  testflight: ['beta'],
  tester: ['beta', 'tester'],
  iap: ['in', 'app', 'purchase'],
  price: ['price', 'pricing', 'point', 'schedule'],
  metadata: ['localization', 'info'],
  description: ['localization'],
  keyword: ['localization'],
  release: ['release', 'phased', 'version'],
  submit: ['submission', 'review'],
  screenshot: ['screenshot'],
  provisioning: ['profile'],
  certificate: ['certificate'],
  capability: ['capability'],
  xcode: ['ci'],
  cloud: ['ci'],
  sale: ['sales', 'report'],
  achievement: ['game', 'center', 'achievement'],
  leaderboard: ['game', 'center', 'leaderboard'],
};

function summarize(opId: string, method: string, p: string): string {
  const parts = opId.split('_');
  const action = parts[parts.length - 1];
  const subject = parts.slice(0, -1).join(' → ');
  const map: Record<string, string> = {
    getCollection: 'List',
    getInstance: 'Get one',
    createInstance: 'Create',
    updateInstance: 'Update',
    deleteInstance: 'Delete',
    getToManyRelated: 'List related',
    getToOneRelated: 'Get related',
    getToManyRelationship: 'List linked ids of',
    getToOneRelationship: 'Get linked id of',
    createToManyRelationship: 'Add links to',
    deleteToManyRelationship: 'Remove links from',
    replaceToManyRelationship: 'Replace links of',
    updateToOneRelationship: 'Set link of',
  };
  return `${map[action] ?? action} ${subject}`.trim();
}

export function searchOperations(query: string, opts: { method?: string; limit?: number; includeRelationshipEndpoints?: boolean } = {}) {
  loadSpec();
  const q = tokenize(query);
  const expanded = new Set<string>(q);
  for (const t of q) for (const s of SYNONYMS[t] ?? []) expanded.add(stem(s));
  const scored: Array<{ op: OperationInfo; score: number }> = [];
  for (const op of ops) {
    if (opts.method && op.method !== opts.method.toUpperCase()) continue;
    const isRelationship = op.path.includes('/relationships/');
    if (isRelationship && !opts.includeRelationshipEndpoints) continue;
    let score = 0;
    for (const t of q) {
      if (op.words.includes(t)) score += 3;
      else if (op.words.some(w => w.startsWith(t) || t.startsWith(w) && w.length > 3)) score += 1.5;
      else if ((SYNONYMS[t] ?? []).some(s => op.words.includes(stem(s)))) score += 1;
    }
    if (score === 0) continue;
    // Prefer shorter, top-level paths and non-deprecated operations.
    score -= op.path.split('/').length * 0.15;
    if (op.deprecated) score -= 2;
    if (op.tags.some(t => q.some(x => t.toLowerCase().includes(x)))) score += 1;
    scored.push({ op, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 25).map(({ op }) => ({
    operationId: op.operationId,
    method: op.method,
    path: op.path,
    summary: op.summary + (op.deprecated ? ' (deprecated)' : ''),
  }));
}

export function findOperation(idOrMethodPath: string, maybePath?: string): { info: OperationInfo; op: any } | undefined {
  loadSpec();
  let info: OperationInfo | undefined;
  if (maybePath) {
    const m = idOrMethodPath.toUpperCase();
    const norm = normalizePath(maybePath);
    info = ops.find(o => o.method === m && pathMatches(o.path, norm));
  } else {
    info = ops.find(o => o.operationId === idOrMethodPath);
  }
  if (!info) return undefined;
  return { info, op: spec.paths[info.path][info.method.toLowerCase()] };
}

function normalizePath(p: string): string {
  let out = p;
  try {
    if (p.startsWith('http')) out = new URL(p).pathname;
  } catch {
    /* keep */
  }
  return out.split('?')[0].replace(/\/+$/, '');
}

/** Does a concrete path like /v1/apps/123/builds match /v1/apps/{id}/builds ? */
export function pathMatches(template: string, concrete: string): boolean {
  const a = template.split('/');
  const b = concrete.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => (seg.startsWith('{') ? b[i].length > 0 : seg === b[i]));
}

// ---------- Schema rendering ----------

function resolveRef(ref: string): { name: string; schema: any } {
  const name = ref.replace('#/components/schemas/', '');
  return { name, schema: spec.components.schemas[name] };
}

/**
 * Render a schema as a compact TypeScript-like shape.
 * `required` fields get no '?'. Enums become "A" | "B".
 */
export function renderSchema(schema: any, depth = 0, maxDepth = 7, stack: string[] = []): string {
  loadSpec();
  if (!schema) return 'any';
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (schema.$ref) {
    const { name, schema: s } = resolveRef(schema.$ref);
    if (stack.includes(name) || depth >= maxDepth) return name;
    return renderSchema(s, depth, maxDepth, [...stack, name]);
  }
  if (schema.oneOf || schema.anyOf) {
    const list = (schema.oneOf ?? schema.anyOf).map((s: any) => (s.$ref ? resolveRef(s.$ref).name : renderSchema(s, depth, maxDepth, stack)));
    return list.join(' | ');
  }
  if (schema.enum) return schema.enum.map((e: any) => JSON.stringify(e)).join(' | ');
  if (schema.type === 'array') return `Array<${renderSchema(schema.items, depth, maxDepth, stack)}>`;
  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties ?? {};
    const req = new Set<string>(schema.required ?? []);
    const keys = Object.keys(props);
    if (keys.length === 0) return schema.additionalProperties ? 'Record<string, any>' : 'object';
    const lines = keys.map(k => {
      const p = props[k];
      const dep = p.deprecated ? ' /* deprecated */' : '';
      return `${pad}${k}${req.has(k) ? '' : '?'}: ${renderSchema(p, depth + 1, maxDepth, stack)}${dep}`;
    });
    return `{\n${lines.join('\n')}\n${close}}`;
  }
  let t = schema.type ?? 'any';
  if (schema.format) t += ` /* ${schema.format} */`;
  return t;
}

export function schemaByName(name: string): any | undefined {
  loadSpec();
  return spec.components.schemas[name];
}

export function schemaNames(filter?: string): string[] {
  loadSpec();
  const names = Object.keys(spec.components.schemas);
  if (!filter) return names;
  const f = filter.toLowerCase();
  return names.filter(n => n.toLowerCase().includes(f));
}

/** Human-oriented description of one operation: params, body shape, response. */
export function describeOperation(info: OperationInfo, op: any, showFieldsParams = false): string {
  const out: string[] = [];
  out.push(`${info.method} ${info.path}`);
  out.push(`operationId: ${info.operationId}${info.deprecated ? ' (DEPRECATED)' : ''}`);
  out.push(`summary: ${info.summary}`);
  const params: any[] = op.parameters ?? [];
  const pathParams = params.filter(p => p.in === 'path');
  const queryParams = params.filter(p => p.in === 'query');
  if (pathParams.length) out.push(`path params: ${pathParams.map(p => p.name).join(', ')}`);
  const fieldsParams = queryParams.filter(p => p.name.startsWith('fields['));
  const other = queryParams.filter(p => !p.name.startsWith('fields['));
  if (other.length) {
    out.push('query params:');
    for (const p of other) {
      const s = p.schema ?? {};
      const en = s.enum ?? s.items?.enum;
      const type = s.type === 'array' ? 'comma-separated list' : s.type ?? '';
      out.push(`  ${p.name}${p.required ? ' (required)' : ''}: ${type}${en ? ` of ${en.join('|')}` : ''}${s.maximum ? ` (max ${s.maximum})` : ''}${p.deprecated ? ' (deprecated)' : ''}`);
    }
  }
  if (fieldsParams.length) {
    if (showFieldsParams) {
      out.push('fields params (sparse fieldsets):');
      for (const p of fieldsParams) out.push(`  ${p.name}: ${(p.schema?.items?.enum ?? []).join(',')}`);
    } else {
      out.push(`fields params available: ${fieldsParams.map(p => p.name).join(' ')} (call with show_fields=true for values)`);
    }
  }
  const body = op.requestBody?.content?.['application/json']?.schema;
  if (body) {
    const name = body.$ref ? resolveRef(body.$ref).name : '';
    out.push(`request body${name ? ` (${name})` : ''}:`);
    out.push(renderSchema(body));
  }
  const okCode = Object.keys(op.responses ?? {}).find(c => c.startsWith('2'));
  if (okCode) {
    const rs = op.responses[okCode]?.content?.['application/json']?.schema;
    if (rs?.$ref) {
      const { name, schema } = resolveRef(rs.$ref);
      const dataSchema = schema?.properties?.data;
      const item = dataSchema?.items?.$ref ?? dataSchema?.$ref;
      out.push(`response ${okCode}: ${name}${item ? ` (data: ${dataSchema.type === 'array' ? 'array of ' : ''}${resolveRef(item).name}; see api_schema for its attributes)` : ''}`);
    } else {
      out.push(`response ${okCode}${rs ? '' : ' (no JSON body)'}`);
    }
  }
  return out.join('\n');
}
