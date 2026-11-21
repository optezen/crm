'use server';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { decryptJson, encryptJson, KEY_VERSION, parseKey } from '../../../../lib/integrations/crypto';
import { MetaClient, type MetaCreds } from '../../../../lib/integrations/meta';
import { messagingAdapter } from '../../../../lib/integrations/whatsapp';
import { ProviderError } from '../../../../lib/integrations/types';
import { CRM_TARGETS } from '../../../../lib/integrations/types';
import { missingFor } from '../../../../lib/integrations/env';
import { observedFields } from '../../../../lib/integrations/service';

type Db = Awaited<ReturnType<typeof supabaseServer>>;
export type HubResult<T = Record<string, never>> = ({ ok: true; message: string } & T) | { ok: false; error: string };
const UUID = /^[0-9a-f-]{36}$/i;
// Organization and role come from the signed-in user's membership, never from the request; the database re-checks the role on every call.
async function ctx(): Promise<{ error: string } | { org: string; db: Db }> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  if (!canBuild(s.role)) return { error: 'Only owners and admins can manage connections.' };
  return { org: s.organizationId, db: await supabaseServer() };
}
const msg = (e: { code?: string; message: string }) => (['22023', '23505', '42501', 'P0002'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.');
const done = <T extends object>(message: string, extra?: T): HubResult<T> => { revalidatePath('/builder/connections'); return { ok: true, message, ...(extra ?? {}) } as HubResult<T>; };
async function siteUrl() { const h = await headers(); return process.env.NEXT_PUBLIC_SITE_URL || `${h.get('x-forwarded-proto') ?? 'https'}://${h.get('host')}`; }

export async function createFormConnectionAction(name: string): Promise<HubResult<{ id: string; webhookUrl: string; secret: string }>> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  const r = await c.db.rpc('integration_create_connection', { p_org: c.org, p_provider: 'website_forms', p_name: name, p_config: {} });
  if (r.error) return { ok: false, error: msg(r.error) };
  const v = r.data as { id: string; public_id: string; secret: string };
  return done('Connection created. Copy the secret now: it is shown only once.', { id: v.id, secret: v.secret, webhookUrl: `${await siteUrl()}/api/webhooks/forms/${v.public_id}` });
}
export async function rotateSecretAction(id: string): Promise<HubResult<{ secret: string }>> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(id)) return { ok: false, error: 'Connection not found.' };
  const r = await c.db.rpc('integration_rotate_secret', { p_org: c.org, p_conn: id });
  return r.error ? { ok: false, error: msg(r.error) } : done('New secret created. The old one stopped working. Copy this one now: it is shown only once.', { secret: (r.data as { secret: string }).secret });
}
export async function disconnectAction(id: string): Promise<HubResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(id)) return { ok: false, error: 'Connection not found.' };
  // best effort: stop Meta from sending page events to us before the credentials are deleted
  const key = process.env.INTEGRATION_ENCRYPTION_KEY;
  const conn = await c.db.from('integration_connections').select('provider').eq('id', id).eq('organization_id', c.org).maybeSingle();
  if (conn.data?.provider === 'meta_lead_ads' && key) {
    try {
      const cred = (await c.db.rpc('integration_read_credentials', { p_org: c.org, p_conn: id })).data as { ciphertext: string } | null;
      const assets = (await c.db.from('integration_assets').select('external_id').eq('connection_id', id).eq('selected', true)).data ?? [];
      if (cred) { const creds = decryptJson<MetaCreds>(cred.ciphertext, parseKey(key)); for (const a of assets) { const t = creds.pages[a.external_id]; if (t) await new MetaClient(fetch).unsubscribePage(a.external_id, t).catch(() => {}); } }
    } catch { /* credentials unreadable: still disconnect locally */ }
  }
  const r = await c.db.rpc('integration_disconnect', { p_org: c.org, p_conn: id });
  return r.error ? { ok: false, error: msg(r.error) } : done('Disconnected. New events are no longer accepted; history is kept.');
}
export async function saveMappingsAction(id: string, mappings: { external_field: string; target: string }[]): Promise<HubResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(id)) return { ok: false, error: 'Connection not found.' };
  const clean = (Array.isArray(mappings) ? mappings : []).filter(m => m && typeof m.external_field === 'string' && (CRM_TARGETS as readonly string[]).includes(m.target)).slice(0, 60).map(m => ({ external_field: m.external_field.trim(), target: m.target }));
  const r = await c.db.rpc('integration_save_mappings', { p_org: c.org, p_conn: id, p_mappings: clean });
  return r.error ? { ok: false, error: msg(r.error) } : done('Field mapping saved. It applies to new submissions.');
}
export async function setRateLimitAction(id: string, perMinute: number): Promise<HubResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(id)) return { ok: false, error: 'Connection not found.' };
  const r = await c.db.rpc('integration_set_config', { p_org: c.org, p_conn: id, p_config: { rate_limit_per_min: Math.trunc(Number(perMinute)) } });
  return r.error ? { ok: false, error: msg(r.error) } : done('Rate limit saved.');
}
export async function setAllowQueryKeyAction(id: string, allow: boolean): Promise<HubResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(id)) return { ok: false, error: 'Connection not found.' };
  const r = await c.db.rpc('integration_set_config', { p_org: c.org, p_conn: id, p_config: { allow_query_key: allow === true } });
  return r.error ? { ok: false, error: msg(r.error) } : done(allow ? 'URL credentials enabled. Rotate the secret regularly and never share the URL.' : 'URL credentials disabled. Only the Authorization header is accepted.');
}
export async function loadObservedFieldsAction(id: string): Promise<string[]> {
  const c = await ctx(); if ('error' in c || !UUID.test(id)) return []; return observedFields(c.db, c.org, id);
}

/** Select / deselect a Meta Page. Selecting subscribes the Page to lead events; if Meta refuses, the selection is rolled back. */
export async function selectMetaPageAction(connId: string, assetId: string, selected: boolean): Promise<HubResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(connId) || !UUID.test(assetId)) return { ok: false, error: 'Not found.' };
  if (missingFor('meta').length) return { ok: false, error: 'Meta is not configured on this deployment.' };
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  const sel = await c.db.rpc('integration_select_asset', { p_org: c.org, p_conn: connId, p_asset: assetId, p_selected: selected });
  if (sel.error) return { ok: false, error: msg(sel.error) };
  const asset = (await c.db.from('integration_assets').select('external_id').eq('id', assetId).eq('connection_id', connId).single()).data;
  const cred = (await c.db.rpc('integration_read_credentials', { p_org: c.org, p_conn: connId })).data as { ciphertext: string } | null;
  try {
    if (!asset || !cred) throw new ProviderError('Meta credentials are missing. Reconnect Meta.', 'auth');
    const token = decryptJson<MetaCreds>(cred.ciphertext, key).pages[asset.external_id]; if (!token) throw new ProviderError('No access token for this Page. Reconnect Meta.', 'auth');
    const client = new MetaClient(fetch); if (selected) await client.subscribePage(asset.external_id, token); else await client.unsubscribePage(asset.external_id, token).catch(() => {});
  } catch (e) {
    await c.db.rpc('integration_select_asset', { p_org: c.org, p_conn: connId, p_asset: assetId, p_selected: !selected });
    const m = e instanceof ProviderError ? e.message : 'Could not reach Meta.';
    await c.db.rpc('integration_set_status', { p_org: c.org, p_conn: connId, p_status: e instanceof ProviderError && e.kind === 'auth' ? 'expired' : 'error', p_error: m });
    return { ok: false, error: m };
  }
  const any = ((await c.db.from('integration_assets').select('id').eq('connection_id', connId).eq('selected', true)).data ?? []).length > 0;
  await c.db.rpc('integration_set_status', { p_org: c.org, p_conn: connId, p_status: any ? 'connected' : 'setup_required', p_error: null });
  return done(selected ? 'Page connected. New leads from its forms will arrive through Meta webhooks.' : 'Page disconnected.');
}

export type WhatsAppForm = { provider: string; accessToken?: string; phoneNumberId?: string; apiKey?: string; templateName: string; templateLanguage: string; defaultCountryCode?: string; confirmUnverified?: boolean };
/** Saves WhatsApp credentials (encrypted) and verifies them where the provider allows. Nothing is sent. */
export async function saveWhatsAppAction(f: WhatsAppForm): Promise<HubResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  const missing = missingFor('whatsapp'); if (missing.length) return { ok: false, error: `WhatsApp is not configured on this deployment: ${missing.join(', ')}.` };
  if (f.provider !== 'meta_cloud' && f.provider !== 'interakt') return { ok: false, error: 'Choose Meta Cloud API or Interakt.' };
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  let conn = (await c.db.from('integration_connections').select('id').eq('organization_id', c.org).eq('provider', 'whatsapp').maybeSingle()).data?.id as string | undefined;
  if (!conn) { const r = await c.db.rpc('integration_create_connection', { p_org: c.org, p_provider: 'whatsapp', p_name: 'WhatsApp', p_config: {} }); if (r.error) return { ok: false, error: msg(r.error) }; conn = (r.data as { id: string }).id; }
  const cfg: Record<string, string> = { provider: f.provider, template_name: f.templateName.trim(), template_language: f.templateLanguage.trim() };
  if (f.defaultCountryCode?.trim()) cfg.default_country_code = f.defaultCountryCode.trim();
  if (f.provider === 'meta_cloud') cfg.phone_number_id = (f.phoneNumberId ?? '').trim();
  const sc = await c.db.rpc('integration_set_config', { p_org: c.org, p_conn: conn, p_config: cfg }); if (sc.error) return { ok: false, error: msg(sc.error) };
  const secret = f.provider === 'meta_cloud' ? { access_token: (f.accessToken ?? '').trim(), phone_number_id: cfg.phone_number_id } : { api_key: (f.apiKey ?? '').trim() };
  if (!Object.values(secret).every(Boolean)) return { ok: false, error: f.provider === 'meta_cloud' ? 'Enter the permanent access token and the phone number id.' : 'Enter the Interakt API key.' };
  const st = await c.db.rpc('integration_store_credentials', { p_org: c.org, p_conn: conn, p_ciphertext: encryptJson(secret, key), p_expires_at: null, p_key_version: KEY_VERSION });
  if (st.error) return { ok: false, error: msg(st.error) };
  const setStatus = (status: string, error: string | null) => c.db.rpc('integration_set_status', { p_org: c.org, p_conn: conn, p_status: status, p_error: error });
  if (f.provider === 'interakt') {
    if (!f.confirmUnverified) { await setStatus('setup_required', 'Saved, not enabled: Interakt credentials cannot be verified without sending a message.'); return done('Saved. Tick the confirmation to enable sending (Interakt keys cannot be verified automatically).'); }
    await setStatus('connected', null); return done('Interakt enabled. The first send is the first real test of the key.');
  }
  try {
    const info = await messagingAdapter('meta_cloud', fetch).verify(secret);
    const up = await c.db.rpc('integration_upsert_assets', { p_org: c.org, p_conn: conn, p_assets: [{ kind: 'phone_number', external_id: cfg.phone_number_id, name: info.displayName }] }); if (up.error) throw new Error(msg(up.error));
    const asset = (await c.db.from('integration_assets').select('id').eq('connection_id', conn).eq('external_id', cfg.phone_number_id!).single()).data;
    const sel = await c.db.rpc('integration_select_asset', { p_org: c.org, p_conn: conn, p_asset: asset?.id, p_selected: true }); if (sel.error) throw new Error(msg(sel.error));
    await setStatus('connected', null); return done(`Verified: ${info.displayName}. Messages are sent only from automations and only with your approved template.`);
  } catch (e) {
    const m = e instanceof ProviderError ? (e.kind === 'auth' ? `Invalid credentials: ${e.message}` : e.message) : (e as Error).message;
    await setStatus('error', m); revalidatePath('/builder/connections'); return { ok: false, error: m };
  }
}
