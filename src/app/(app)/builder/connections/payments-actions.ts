'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { encryptJson, keyringFromEnv } from '../../../../lib/integrations/crypto';
import { missingFor } from '../../../../lib/integrations/env';

export type PayResult = { ok: true; message: string } | { ok: false; error: string };
const UUID = /^[0-9a-f-]{36}$/i;
const SAFE = ['22023', '23505', '42501', 'P0002'];
// Organization and role come from the signed-in membership, never from the request; the database re-checks owner/admin and that billing is enabled.
async function ctx(): Promise<{ error: string } | { org: string; db: Awaited<ReturnType<typeof supabaseServer>> }> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  if (!canBuild(s.role)) return { error: 'Only owners and admins can connect a payment gateway.' };
  return { org: s.organizationId, db: await supabaseServer() };
}
const fail = (e: { code?: string; message: string }): { ok: false; error: string } => ({ ok: false, error: SAFE.includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.' });
const done = (message: string): { ok: true; message: string } => { revalidatePath('/builder/connections'); return { ok: true, message }; };

export async function createPaymentsConnectionAction(): Promise<PayResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  const missing = missingFor('payments'); if (missing.length) return { ok: false, error: `Payments are not configured on this deployment: ${missing.join(', ')}.` };
  const r = await c.db.rpc('payments_connection_create', { p_org: c.org, p_name: 'Razorpay', p_gateway: 'razorpay' });
  return r.error ? fail(r.error) : done('Created. Follow the steps below to finish the setup.');
}
/** Stores the gateway's webhook signing secret, encrypted. The value is never returned, logged or shown again. */
export async function savePaymentsSecretAction(connId: string, secret: string): Promise<PayResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(connId)) return { ok: false, error: 'Connection not found.' };
  const s = typeof secret === 'string' ? secret.trim() : ''; if (s.length < 8 || s.length > 128 || /\s/.test(s)) return { ok: false, error: 'The webhook secret must be 8 to 128 characters with no spaces. Copy it exactly from the gateway.' };
  const missing = missingFor('payments'); if (missing.length) return { ok: false, error: `Payments are not configured on this deployment: ${missing.join(', ')}.` };
  const ring = keyringFromEnv(process.env);
  const r = await c.db.rpc('integration_store_credentials', { p_org: c.org, p_conn: connId, p_ciphertext: encryptJson({ webhook_secret: s }, ring), p_expires_at: null, p_key_version: ring.version });
  return r.error ? fail(r.error) : done('Secret saved (encrypted). It cannot be shown again; paste a new one to replace it.');
}
/** Activation requires a correctly signed notification to have been received (enforced by the database, not only here). */
export async function activatePaymentsAction(connId: string): Promise<PayResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error }; if (!UUID.test(connId)) return { ok: false, error: 'Connection not found.' };
  const r = await c.db.rpc('integration_set_status', { p_org: c.org, p_conn: connId, p_status: 'connected', p_error: null });
  return r.error ? fail(r.error) : done('Payments are active. Verified gateway payments will now be recorded against invoices.');
}
