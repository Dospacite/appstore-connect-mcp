/**
 * Compact JSON:API resources so tool output stays small and readable.
 */
import type { JsonApiDocument, JsonApiResource } from './client.js';

export interface CompactResource {
  type: string;
  id: string;
  [k: string]: any;
}

/** Flatten a resource: attributes inline, relationships reduced to ids. */
export function compact(r: JsonApiResource): CompactResource {
  const out: CompactResource = { type: r.type, id: r.id, ...(r.attributes ?? {}) };
  const rels: Record<string, string | string[] | number> = {};
  for (const [name, rel] of Object.entries(r.relationships ?? {})) {
    const d = (rel as any)?.data;
    if (Array.isArray(d)) rels[name] = d.map((x: any) => x.id);
    else if (d && d.id) rels[name] = d.id;
    const total = (rel as any)?.meta?.paging?.total;
    if (total !== undefined) rels[`${name}Total`] = total;
  }
  if (Object.keys(rels).length) out.relationships = rels;
  return out;
}

export function compactDoc(doc: JsonApiDocument): any {
  const out: any = {};
  if (Array.isArray(doc.data)) out.data = doc.data.map(compact);
  else if (doc.data) out.data = compact(doc.data);
  else if (doc.data === null) out.data = null;
  if (doc.included?.length) out.included = doc.included.map(compact);
  if (doc.meta?.paging?.total !== undefined) out.total = doc.meta.paging.total;
  if (doc.links?.next) out.next = doc.links.next;
  // Non JSON:API payloads (rare) pass through.
  for (const k of Object.keys(doc)) if (!['data', 'included', 'links', 'meta'].includes(k)) out[k] = doc[k];
  return out;
}

/** JSON:API relationship helper: { data: { type, id } }. */
export function rel(type: string, id: string) {
  return { data: { type, id } };
}

/** JSON:API to-many relationship helper. */
export function rels(type: string, ids: string[]) {
  return { data: ids.map(id => ({ type, id })) };
}

/** Remove undefined values so PATCH bodies only contain fields the caller set. */
export function defined<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

const MAX_OUTPUT = 80_000;

export function toText(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  if (text.length <= MAX_OUTPUT) return text;
  return text.slice(0, MAX_OUTPUT) + `\n…[truncated ${text.length - MAX_OUTPUT} chars; narrow the request with filters, fields or a smaller limit]`;
}
