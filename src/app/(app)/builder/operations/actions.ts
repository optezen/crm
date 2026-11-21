'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';

export type OpsResult = { ok: true; message: string } | { ok: false; error: string };
const UUID = /^[0-9a-f-]{36}$/i;
const RPC = { message: ['integration_requeue_request', 'p_request', 'Queued to send again.'], lead: ['integration_requeue_event', 'p_event', 'Queued to retry.'], run: ['automation_requeue_run', 'p_run', 'Queued to retry.'], payment: ['payment_gateway_retry', 'p_event', 'Queued to apply again.'] } as const;
// Organization and role come from the signed-in membership, never from the request. The database re-checks the administrator role and that the row belongs to the organization.
async function retry(kind: keyof typeof RPC, id: string): Promise<OpsResult> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { ok: false, error: 'Your session has ended. Please sign in again.' };
  if (!canBuild(s.role)) return { ok: false, error: 'Only owners and admins can do this.' }; if (!UUID.test(id)) return { ok: false, error: 'Not found.' };
  const [fn, arg, message] = RPC[kind]; const r = await (await supabaseServer()).rpc(fn, { p_org: s.organizationId, [arg]: id });
  if (r.error) return { ok: false, error: ['22023', '42501', 'P0002'].includes(r.error.code ?? '') ? r.error.message : 'Something went wrong. Please try again.' };
  revalidatePath('/builder/operations'); return { ok: true, message };
}
export async function requeueMessageAction(id: string): Promise<OpsResult> { return retry('message', id); }
export async function retryLeadEventAction(id: string): Promise<OpsResult> { return retry('lead', id); }
export async function retryRunAction(id: string): Promise<OpsResult> { return retry('run', id); }
export async function retryPaymentAction(id: string): Promise<OpsResult> { return retry('payment', id); }
