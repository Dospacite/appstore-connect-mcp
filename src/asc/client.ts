/**
 * App Store Connect API client.
 * Handles JWT auth (cached), retries, pagination, raw downloads,
 * asset upload operations, and an optional dry-run mode for writes.
 */
import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';

export const API_BASE = 'https://api.appstoreconnect.apple.com';

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKey: string;
}

export type Query = Record<string, string | number | boolean | Array<string | number> | undefined | null>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** Extra headers (e.g. Accept for report downloads). */
  headers?: Record<string, string>;
}

export interface JsonApiResource {
  type: string;
  id: string;
  attributes?: Record<string, any>;
  relationships?: Record<string, any>;
  links?: Record<string, any>;
}

export interface JsonApiDocument {
  data?: JsonApiResource | JsonApiResource[] | null;
  included?: JsonApiResource[];
  links?: { self?: string; next?: string; [k: string]: any };
  meta?: any;
  [k: string]: any;
}

export interface UploadOperation {
  method: string;
  url: string;
  length: number;
  offset: number;
  requestHeaders?: Array<{ name: string; value: string }>;
}

export class AscApiError extends Error {
  constructor(
    public status: number,
    public method: string,
    public path: string,
    public errors: Array<{ code?: string; title?: string; detail?: string; source?: any; meta?: any }>,
    raw: string,
  ) {
    super(AscApiError.format(status, method, path, errors, raw));
  }

  static format(status: number, method: string, path: string, errors: any[], raw: string): string {
    const lines = [`App Store Connect API ${status} on ${method} ${path}`];
    if (errors.length === 0) {
      lines.push(raw.slice(0, 2000));
    }
    for (const e of errors) {
      const where = e.source?.pointer || e.source?.parameter;
      lines.push(`- ${e.code ?? ''}: ${e.detail ?? e.title ?? ''}${where ? ` (at ${where})` : ''}`);
      const assoc = e.meta?.associatedErrors;
      if (assoc && typeof assoc === 'object') {
        for (const [k, list] of Object.entries(assoc)) {
          for (const a of list as any[]) lines.push(`  - ${k}: ${a.code ?? ''}: ${a.detail ?? a.title ?? ''}`);
        }
      }
    }
    if (status === 401) lines.push('Hint: the Key ID, Issuer ID or .p8 key is wrong, or the key was revoked.');
    if (status === 403) lines.push('Hint: the API key role does not allow this action (e.g. Users/Finance need Admin or Finance role).');
    return lines.join('\n');
  }
}

/** A write that was skipped because dry-run mode is on. */
export interface PlannedRequest {
  method: string;
  path: string;
  query?: Query;
  body?: unknown;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class AscClient {
  private token?: { value: string; expiresAt: number };
  /** When set, non-GET requests are recorded here instead of being sent. */
  dryRunLog?: PlannedRequest[];

  constructor(private creds: AscCredentials) {}

  private getToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.token && this.token.expiresAt - 60 > now) return this.token.value;
    const exp = now + 19 * 60;
    const value = jwt.sign({ iss: this.creds.issuerId, iat: now, exp, aud: 'appstoreconnect-v1' }, this.creds.privateKey, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: this.creds.keyId, typ: 'JWT' },
      noTimestamp: true,
    });
    this.token = { value, expiresAt: exp };
    return value;
  }

  static buildUrl(path: string, query?: Query): string {
    const url = new URL(path.startsWith('http') ? path : API_BASE + (path.startsWith('/') ? path : '/' + path));
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
      }
    }
    if (url.origin !== API_BASE) throw new Error(`Refusing to send credentials to ${url.origin}`);
    return url.toString();
  }

  private async send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = AscClient.buildUrl(path, opts.query);
    let attempt = 0;
    for (;;) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.getToken()}`,
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      // Rate limits get several retries; server errors only a couple (Apple
      // also answers 500 for some bad report parameters).
      const maxAttempts = res.status === 429 ? 4 : res.status >= 500 ? 2 : 0;
      if (attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        attempt++;
        continue;
      }
      if (!res.ok) {
        const raw = await res.text();
        let errors: any[] = [];
        try {
          errors = JSON.parse(raw).errors ?? [];
        } catch {
          /* not JSON */
        }
        throw new AscApiError(res.status, method, new URL(url).pathname, errors, raw);
      }
      return res;
    }
  }

  /** JSON request. Non-GET requests are only recorded when dry-run is on. */
  async request<T = JsonApiDocument>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    method = method.toUpperCase();
    if (method !== 'GET' && this.dryRunLog) {
      this.dryRunLog.push({ method, path, query: opts.query, body: redact(opts.body) });
      const data = (opts.body as any)?.data;
      const type = data?.type ?? 'dryRun';
      // PATCH/DELETE keep the real id so follow-up steps reference the right resource.
      const id = data?.id ?? (method === 'POST' ? `DRY_RUN_${this.dryRunLog.length}` : path.split('?')[0].split('/').pop());
      return { data: { type, id, attributes: redact(data?.attributes) ?? {} } } as T;
    }
    const res = await this.send(method, path, opts);
    if (res.status === 204) return {} as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  get<T = JsonApiDocument>(path: string, query?: Query) {
    return this.request<T>('GET', path, { query });
  }
  post<T = JsonApiDocument>(path: string, body: unknown) {
    return this.request<T>('POST', path, { body });
  }
  patch<T = JsonApiDocument>(path: string, body: unknown) {
    return this.request<T>('PATCH', path, { body });
  }
  delete<T = JsonApiDocument>(path: string, body?: unknown) {
    return this.request<T>('DELETE', path, { body });
  }

  /**
   * GET a collection and follow `links.next` until `maxItems` items are collected.
   * Returns merged data and included arrays.
   */
  async getAll(path: string, query: Query = {}, maxItems = 200, opts: { sendLimit?: boolean } = {}): Promise<{ data: JsonApiResource[]; included: JsonApiResource[]; total?: number; truncated: boolean }> {
    const data: JsonApiResource[] = [];
    const included: JsonApiResource[] = [];
    const seen = new Set<string>();
    let next: string | undefined = undefined;
    let total: number | undefined;
    const q: Query = opts.sendLimit === false ? { ...query } : { limit: Math.min(200, Math.max(1, maxItems)), ...query };
    let doc: JsonApiDocument = await this.get(path, q);
    for (;;) {
      total = doc.meta?.paging?.total ?? total;
      const items = Array.isArray(doc.data) ? doc.data : doc.data ? [doc.data] : [];
      data.push(...items);
      for (const inc of doc.included ?? []) {
        const k = inc.type + '/' + inc.id;
        if (!seen.has(k)) {
          seen.add(k);
          included.push(inc);
        }
      }
      next = doc.links?.next;
      if (!next || data.length >= maxItems) break;
      doc = await this.get(next);
    }
    const truncated = !!next || data.length > maxItems;
    return { data: data.slice(0, maxItems), included, total, truncated };
  }

  /** Raw download (e.g. gzip reports). Returns body bytes and content type. */
  async download(path: string, query?: Query, accept = 'application/a-gzip'): Promise<{ bytes: Buffer; contentType: string }> {
    const res = await this.send('GET', path, { query, headers: { Accept: accept } });
    return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  }

  /**
   * Execute upload operations returned by an asset reservation
   * (screenshots, previews, review attachments, builds...).
   * These go to Apple's asset hosts, without our JWT.
   */
  async runUploadOperations(ops: UploadOperation[], file: Buffer): Promise<void> {
    if (this.dryRunLog) {
      this.dryRunLog.push({ method: 'UPLOAD', path: `${ops.length} upload part(s), ${file.length} bytes` });
      return;
    }
    const queue = [...ops];
    const worker = async () => {
      for (let op = queue.shift(); op; op = queue.shift()) {
        const headers: Record<string, string> = {};
        for (const h of op.requestHeaders ?? []) headers[h.name] = h.value;
        const chunk = file.subarray(op.offset, op.offset + op.length);
        let attempt = 0;
        for (;;) {
          const res = await fetch(op.url, { method: op.method, headers, body: new Uint8Array(chunk) });
          if (res.ok) break;
          if (attempt++ >= 3) throw new Error(`Upload part at offset ${op.offset} failed: ${res.status} ${await res.text()}`);
          await sleep(1000 * 2 ** attempt);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ops.length) }, worker));
  }
}

/** Fetch a pre-signed external URL (report segments, CI artifacts) without our JWT. */
export async function fetchExternal(url: string): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (attempt >= 2 || res.status < 500) throw new Error(`Download failed (${res.status}) for ${new URL(url).host}`);
    await sleep(1000 * 2 ** attempt);
  }
}

const SECRET_KEYS = /^(password|secret|demoAccountPassword|sharedSecret)$/i;

/** Mask secret-looking fields in dry-run logs and echoed attributes. */
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? '***' : redact(v);
    return out;
  }
  return value;
}

export function md5Hex(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}
