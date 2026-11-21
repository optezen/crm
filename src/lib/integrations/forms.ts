// Website Forms: turns an HTTP request from WordPress, Elementor, Next.js or any server into one flat submission and hands it to the database,
// which authenticates the connection secret, de-duplicates, maps fields and creates the lead. No service-role key is involved.
import type { Result } from './types.ts';

export const MAX_BODY_BYTES = 20000;
type Flat = Record<string, string | number | boolean>;
const SKIP_LAST = new Set(['id', 'type', 'title', 'raw_value', 'required']);

/** Flattens nested form data (Elementor `fields[email][value]`, JSON objects) into one level. Arrays become comma-separated text. */
export function flatten(input: unknown): Flat {
  const out: Flat = {};
  const walk = (v: unknown, path: string[], depth: number) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') { out[path.join('.')] = v; return; }
    if (Array.isArray(v)) { const parts = v.filter(x => ['string', 'number', 'boolean'].includes(typeof x)); if (parts.length) out[path.join('.')] = parts.join(', '); return; }
    if (typeof v === 'object' && depth < 3) {
      const o = v as Record<string, unknown>;
      // Elementor sends {id, type, title, value, raw_value, required} per field: keep only the value
      const elementor = 'value' in o && Object.keys(o).every(k => k === 'value' || SKIP_LAST.has(k));
      if (elementor) { walk(o.value, path, depth + 1); return; }
      for (const [k, x] of Object.entries(o)) walk(x, [...path, k], depth + 1);
    }
  };
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) for (const [k, v] of Object.entries(input)) walk(v, [k], 0);
  // wrappers used by plugins: fields.email -> email
  const res: Flat = {};
  for (const [k, v] of Object.entries(out)) res[k.replace(/^(form_fields|fields|data|form)\./, '')] = v;
  return res;
}
/** Parses `a[b][c]=1&d=2` into nested objects (PHP / Elementor style). */
export function parseBrackets(params: URLSearchParams): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of params) {
    const path = key.replace(/\]/g, '').split('[').filter(Boolean); if (!path.length) continue;
    let cur = root;
    path.slice(0, -1).forEach(p => { if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}; cur = cur[p] as Record<string, unknown>; });
    cur[path[path.length - 1]!] = value;
  }
  return root;
}

export async function parseSubmission(req: Request): Promise<Result<Flat>> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) return { ok: false, error: 'The submission is larger than 20 KB.' };
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { ok: false, error: 'The submission is larger than 20 KB.' };
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  let data: unknown;
  try {
    if (type === 'application/json') data = JSON.parse(raw);
    else if (type === 'application/x-www-form-urlencoded') data = parseBrackets(new URLSearchParams(raw));
    else return { ok: false, error: 'Send the form as application/json or application/x-www-form-urlencoded.' };
  } catch { return { ok: false, error: 'The body could not be parsed.' }; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, error: 'The body must be an object of form fields.' };
  const flat = flatten(data);
  if (Object.keys(flat).length === 0) return { ok: false, error: 'The submission has no fields.' };
  if (Object.keys(flat).length > 60) return { ok: false, error: 'Too many fields (maximum 60).' };
  return { ok: true, value: flat };
}

/**
 * Header credential (preferred) or ?key= (only for plugins that cannot set headers). A credential in the URL ends up in access logs and browser history,
 * so the database refuses it unless the owner enabled "allow credential in URL" on that connection.
 */
export function extractCredential(req: Request): { secret: string; source: 'header' | 'query' } | null {
  const auth = req.headers.get('authorization'); const m = auth && /^Bearer\s+(\S+)$/i.exec(auth);
  const h = (m && m[1]) || req.headers.get('x-optizen-key'); if (h) return { secret: h, source: 'header' };
  const q = new URL(req.url).searchParams.get('key'); return q ? { secret: q, source: 'query' } : null;
}

export type IngestRpc = (args: { p_public_id: string; p_secret: string; p_payload: unknown; p_idem: string | null; p_meta: Record<string, string> }) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers } });

export async function handleFormSubmission(req: Request, publicId: string, rpc: IngestRpc): Promise<Response> {
  const cred = extractCredential(req);
  if (!cred) return json(401, { ok: false, error: 'Missing credential. Send "Authorization: Bearer <secret>".' });
  const parsed = await parseSubmission(req);
  if (!parsed.ok) return json(400, { ok: false, error: parsed.error });
  const idem = (req.headers.get('idempotency-key') ?? '').slice(0, 200) || null;
  const meta: Record<string, string> = { credential_source: cred.source };
  const referer = req.headers.get('referer') ?? req.headers.get('origin'); if (referer) meta.referrer = referer.slice(0, 500);
  const ua = req.headers.get('user-agent'); if (ua) meta.user_agent = ua.slice(0, 300);
  const page = parsed.value.page_url ?? parsed.value['_optizen_page_url']; if (typeof page === 'string') meta.page_url = page.slice(0, 500);
  const { data, error } = await rpc({ p_public_id: publicId, p_secret: cred.secret, p_payload: parsed.value, p_idem: idem, p_meta: meta });
  if (error) return json(503, { ok: false, error: 'Temporarily unavailable. Retry with the same Idempotency-Key.' }, { 'retry-after': '30' });
  const r = data as { status: string; lead_id?: string; reason?: string; duplicate?: boolean };
  switch (r.status) {
    case 'created': return json(201, { ok: true, status: 'created', lead_id: r.lead_id });
    case 'duplicate': return json(200, { ok: true, status: 'duplicate', lead_id: r.lead_id });
    case 'rejected': return json(422, { ok: false, status: 'rejected', error: r.reason });
    case 'invalid': return json(400, { ok: false, error: r.reason });
    case 'rate_limited': return json(429, { ok: false, error: r.reason ?? 'Rate limited.' }, { 'retry-after': '60' });
    default: return json(401, { ok: false, error: r.reason ?? 'Invalid credentials.' });
  }
}
