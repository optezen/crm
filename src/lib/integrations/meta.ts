// Meta Lead Ads adapter (Facebook / Instagram instant forms). Written against Meta's documented Graph API and exercised ONLY with mocked HTTP:
// nothing here has talked to a real Meta app. Production use needs a Meta app, Business verification and App Review for the permissions below.
import { ProviderError, type Fetch, type IncomingLead, type LeadSourceAdapter } from './types.ts';
import { META_PERMISSIONS } from './env.ts';

export type MetaCreds = { user_token: string; pages: Record<string, string>; expires_at?: string | null };
export type MetaPage = { id: string; name: string; access_token: string };
export const GRAPH_VERSION = (typeof process !== 'undefined' && process.env?.META_GRAPH_VERSION) || 'v26.0'; // v21.0 is supported until 2027-01-21 per Meta's version table; override with META_GRAPH_VERSION and re-run the contract tests when upgrading
const base = (v = GRAPH_VERSION) => `https://graph.facebook.com/${v}`;

export function authUrl(p: { appId: string; redirectUri: string; state: string; version?: string }): string {
  const u = new URL(`https://www.facebook.com/${p.version ?? GRAPH_VERSION}/dialog/oauth`);
  u.search = new URLSearchParams({ client_id: p.appId, redirect_uri: p.redirectUri, state: p.state, response_type: 'code', scope: META_PERMISSIONS.join(',') }).toString();
  return u.toString();
}

/** Classifies a Graph error (https://developers.facebook.com/docs/graph-api/guides/error-handling).
 * 190 = token invalid; subcodes 463 expired / 467 invalid / 460 password changed / 492 the user no longer has a role on the Page; 458 = the app is no longer installed on the Page;
 * 4/17/32/341/613 = throttling (plus WhatsApp 80007 account, 130429 throughput, 131056 pair rate limits); 459/464 = account checkpoint/unconfirmed; 10 and 200-299 = a permission was not granted or was removed; 1/2 and 5xx = transient. */
export function classify(status: number, body: unknown): ProviderError {
  const e = (body as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error;
  const code = e?.code, sub = e?.error_subcode, msg = e?.message ?? `Meta returned HTTP ${status}`;
  if (sub === 458) return new ProviderError('The app is no longer installed on this Page. Reconnect Meta and select the Page again.', 'auth', '458');
  if (sub === 492) return new ProviderError('The person who connected Meta no longer has the required role on this Page. Reconnect with an account that can advertise on the Page.', 'auth', '492');
  if (sub === 459 || sub === 464) return new ProviderError('The connected Facebook account needs attention (checkpoint or unconfirmed). Log in to Facebook, then reconnect Meta.', 'auth', '190');
  if (sub === 460) return new ProviderError('The connected Facebook password was changed. Reconnect Meta.', 'auth', '190');
  if (code === 190 || status === 401) return new ProviderError(`Meta rejected the access token (${sub === 463 ? 'expired' : sub === 467 ? 'invalid' : 'expired, revoked or invalid'}). Reconnect Meta.`, 'auth', String(code ?? status));
  if (code !== undefined && [4, 17, 32, 341, 613, 80007, 130429, 131056].includes(code) || status === 429) return new ProviderError(`Meta rate limit: ${msg}`, 'rate_limit', String(code ?? status));
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || status === 403) return new ProviderError(`A Meta permission is missing or was removed (${msg}). Reconnect Meta and approve every requested permission.`, 'permanent', String(code ?? status));
  if (status >= 500 || code === 1 || code === 2) return new ProviderError(`Meta is temporarily unavailable: ${msg}`, 'transient', String(code ?? status));
  return new ProviderError(msg, 'permanent', String(code ?? status));
}

export class MetaClient {
  private readonly fetch: Fetch;
  private readonly version: string;
  constructor(fetch: Fetch, version = GRAPH_VERSION) { this.fetch = fetch; this.version = version; }
  private async call(path: string, init?: { method?: string; body?: string }): Promise<Record<string, unknown>> {
    let res; try { res = await this.fetch(`${base(this.version)}${path}`, { method: init?.method ?? 'GET', headers: init?.body ? { 'content-type': 'application/x-www-form-urlencoded' } : undefined, body: init?.body }); }
    catch (e) { throw new ProviderError(`Could not reach Meta: ${(e as Error).message}`, 'transient'); }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw classify(res.status, body);
    return (body ?? {}) as Record<string, unknown>;
  }
  async exchangeCode(p: { appId: string; appSecret: string; redirectUri: string; code: string }): Promise<{ token: string; expiresAt: string | null }> {
    const q = new URLSearchParams({ client_id: p.appId, client_secret: p.appSecret, redirect_uri: p.redirectUri, code: p.code });
    const short = await this.call(`/oauth/access_token?${q}`); // short-lived user token
    const q2 = new URLSearchParams({ grant_type: 'fb_exchange_token', client_id: p.appId, client_secret: p.appSecret, fb_exchange_token: String(short.access_token) });
    const long = await this.call(`/oauth/access_token?${q2}`);
    const exp = typeof long.expires_in === 'number' ? new Date(Date.now() + long.expires_in * 1000).toISOString() : null;
    return { token: String(long.access_token), expiresAt: exp };
  }
  /** Pages the user administers, with page access tokens (long-lived when requested with a long-lived user token). */
  async listPages(userToken: string): Promise<MetaPage[]> {
    const out: MetaPage[] = []; let path: string | null = `/me/accounts?fields=id,name,access_token&limit=100&access_token=${encodeURIComponent(userToken)}`;
    for (let i = 0; path && i < 5; i++) {
      const b = await this.call(path) as { data?: { id: string; name: string; access_token: string }[]; paging?: { next?: string } };
      out.push(...(b.data ?? []).map(p => ({ id: p.id, name: p.name, access_token: p.access_token })));
      path = b.paging?.next ? b.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+/, '') : null;
    }
    return out;
  }
  async subscribePage(pageId: string, pageToken: string): Promise<void> {
    const b = await this.call(`/${encodeURIComponent(pageId)}/subscribed_apps`, { method: 'POST', body: new URLSearchParams({ subscribed_fields: 'leadgen', access_token: pageToken }).toString() });
    if (b.success !== true) throw new ProviderError('Meta did not confirm the leadgen subscription.', 'permanent');
  }
  async unsubscribePage(pageId: string, pageToken: string): Promise<void> {
    await this.call(`/${encodeURIComponent(pageId)}/subscribed_apps?access_token=${encodeURIComponent(pageToken)}`, { method: 'DELETE' });
  }
  /** Checks that a token still works (used for expiry detection). */
  async debugMe(token: string): Promise<{ id: string }> { return (await this.call(`/me?fields=id&access_token=${encodeURIComponent(token)}`)) as { id: string }; }
  async getLead(leadgenId: string, pageToken: string): Promise<Record<string, unknown>> { return this.call(`/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(pageToken)}`); }
}

/** Meta's `field_data` ([{name, values: []}]) becomes the same flat object website forms use, so mapping and CRM creation are shared. */
export function normalizeLead(raw: Record<string, unknown>): IncomingLead {
  const fields: Record<string, string> = {};
  for (const f of (raw.field_data as { name?: string; values?: unknown[] }[] | undefined) ?? []) if (f.name && Array.isArray(f.values) && f.values.length) fields[f.name] = f.values.map(String).join(', ');
  const provider: Record<string, string> = {};
  for (const k of ['form_id', 'ad_id', 'adset_id', 'campaign_id', 'ad_name', 'campaign_name', 'platform', 'created_time', 'is_organic']) if (raw[k] !== undefined) provider[k] = String(raw[k]);
  return { externalId: String(raw.id ?? ''), fields, meta: { provider } };
}
export class MetaLeadAdapter implements LeadSourceAdapter {
  readonly provider = 'meta_lead_ads' as const;
  private readonly client: MetaClient;
  constructor(client: MetaClient) { this.client = client; }
  async fetchLead(ref: Record<string, string>, creds: unknown): Promise<IncomingLead> {
    const c = creds as MetaCreds, token = c.pages?.[ref.page_id ?? ''];
    if (!token) throw new ProviderError('No access token is stored for this Page. Reconnect Meta and select the Page again.', 'auth');
    const lead = normalizeLead(await this.client.getLead(ref.leadgen_id ?? '', token));
    if (!lead.externalId) throw new ProviderError('Meta returned no lead for this id.', 'permanent');
    return lead;
  }
}

/** Webhook GET handshake: echo hub.challenge only when the verify token matches. */
export function verifyChallenge(params: URLSearchParams, verifyToken: string | undefined): string | null {
  return verifyToken && params.get('hub.mode') === 'subscribe' && params.get('hub.verify_token') === verifyToken ? params.get('hub.challenge') : null;
}
export type GatewayEvent = { kind: 'meta_leadgen' | 'whatsapp_status'; asset_kind: 'page' | 'phone_number'; asset_id: string; dedupe_key: string; payload: Record<string, unknown> };
/** leadgen webhook body -> gateway events (routed by Page id; the organization is resolved in the database, never taken from the payload). */
export function parseLeadgenWebhook(body: unknown): GatewayEvent[] {
  const out: GatewayEvent[] = [];
  const b = body as { object?: string; entry?: { id?: string; changes?: { field?: string; value?: { leadgen_id?: string; page_id?: string; form_id?: string; ad_id?: string; created_time?: number } }[] }[] };
  if (b?.object !== 'page') return out;
  for (const e of b.entry ?? []) for (const c of e.changes ?? []) {
    const v = c.value; if (c.field !== 'leadgen' || !v?.leadgen_id) continue;
    const page = String(v.page_id ?? e.id ?? ''); if (!page) continue;
    out.push({ kind: 'meta_leadgen', asset_kind: 'page', asset_id: page, dedupe_key: `lead:${v.leadgen_id}`, payload: { leadgen_id: String(v.leadgen_id), page_id: page, form_id: String(v.form_id ?? ''), ad_id: String(v.ad_id ?? '') } });
  }
  return out;
}
