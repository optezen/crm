import { NextResponse } from 'next/server';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { canBuild } from '../../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../../lib/supabase/server';
import { encryptJson, parseKey, verifyState, KEY_VERSION } from '../../../../../lib/integrations/crypto';
import { MetaClient } from '../../../../../lib/integrations/meta';
import { ProviderError } from '../../../../../lib/integrations/types';
import { missingFor } from '../../../../../lib/integrations/env';

export const dynamic = 'force-dynamic';
const back = (req: Request, q: string) => { const r = NextResponse.redirect(new URL(`/builder/connections?${q}`, req.url)); r.cookies.delete('optizen_meta_oauth'); return r; };
const fail = (req: Request, m: string) => back(req, `error=${encodeURIComponent(m)}`);

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get('error')) return fail(req, 'Meta authorization was cancelled or denied.');
  const s = await getWorkspaceState();
  if (s.status !== 'ready' || !canBuild(s.role)) return fail(req, 'Only owners and admins can connect Meta.');
  if (missingFor('meta').length) return fail(req, 'Meta is not configured on this deployment.');
  const key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY);
  const st = verifyState<{ org: string; user: string; nonce: string }>(url.searchParams.get('state') ?? '', key);
  const cookie = req.headers.get('cookie')?.split(/;\s*/).find(c => c.startsWith('optizen_meta_oauth='))?.split('=')[1];
  // the organization comes from the signed state AND must equal the current membership; the nonce must match this browser's cookie
  if (!st || st.org !== s.organizationId || st.user !== s.userId || !cookie || cookie !== st.nonce) return fail(req, 'The Meta sign-in could not be verified. Start again.');
  const code = url.searchParams.get('code'); if (!code) return fail(req, 'Meta did not return an authorization code.');
  try {
    const client = new MetaClient(fetch);
    const tok = await client.exchangeCode({ appId: process.env.META_APP_ID!, appSecret: process.env.META_APP_SECRET!, redirectUri: `${process.env.NEXT_PUBLIC_SITE_URL}/api/integrations/meta/callback`, code });
    const pages = await client.listPages(tok.token);
    const db = await supabaseServer();
    let conn = (await db.from('integration_connections').select('id').eq('organization_id', s.organizationId).eq('provider', 'meta_lead_ads').maybeSingle()).data?.id as string | undefined;
    if (!conn) { const c = await db.rpc('integration_create_connection', { p_org: s.organizationId, p_provider: 'meta_lead_ads', p_name: 'Meta Lead Ads', p_config: {} }); if (c.error) return fail(req, c.error.message); conn = (c.data as { id: string }).id; }
    const creds = { user_token: tok.token, pages: Object.fromEntries(pages.map(p => [p.id, p.access_token])) };
    const stored = await db.rpc('integration_store_credentials', { p_org: s.organizationId, p_conn: conn, p_ciphertext: encryptJson(creds, key), p_expires_at: tok.expiresAt, p_key_version: KEY_VERSION });
    if (stored.error) return fail(req, 'Could not store the Meta credentials.');
    await db.rpc('integration_upsert_assets', { p_org: s.organizationId, p_conn: conn, p_assets: pages.map(p => ({ kind: 'page', external_id: p.id, name: p.name })) });
    await db.rpc('integration_set_status', { p_org: s.organizationId, p_conn: conn, p_status: 'setup_required', p_error: null });
    return back(req, `meta=authorized&pages=${pages.length}`);
  } catch (e) { return fail(req, e instanceof ProviderError ? e.message : 'Meta connection failed.'); }
}
