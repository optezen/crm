'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';

// The only operations RPCs the screens may call. The organization comes from the user's membership (never from the request); the database re-checks the
// role and the enabled module on every call, and computes every total itself.
const ALLOWED = new Set(['appointment_type_save', 'staff_hours_set', 'staff_time_off_add', 'staff_time_off_remove', 'appointment_create', 'appointment_reschedule', 'appointment_cancel', 'appointment_confirm', 'appointment_finish', 'appointment_set_notes',
  'inventory_location_save', 'supplier_save', 'product_save', 'stock_receive', 'stock_adjust', 'stock_transfer', 'stock_consume', 'invoice_save_draft', 'invoice_issue', 'invoice_cancel_draft', 'payment_record', 'credit_note_issue', 'refund_record']);
export type OpsResult = { ok: true; message: string; data?: unknown } | { ok: false; error: string };
const SAFE = ['22023', '23505', '23P01', '42501', 'P0002'];

export async function callOps(fn: string, args: Record<string, unknown>, message = 'Saved.'): Promise<OpsResult> {
  if (!ALLOWED.has(fn)) return { ok: false, error: 'Unsupported operation.' };
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { ok: false, error: 'Your session has ended. Please sign in again.' };
  if (typeof args !== 'object' || args === null || Array.isArray(args) || Object.keys(args).some(k => !/^p_[a-z_]+$/.test(k) || k === 'p_org')) return { ok: false, error: 'Invalid request.' };
  const { data, error } = await (await supabaseServer()).rpc(fn, { ...args, p_org: s.organizationId });
  if (error) return { ok: false, error: SAFE.includes(error.code ?? '') ? error.message : 'Something went wrong. Please try again.' };
  revalidatePath('/work', 'layout');
  return { ok: true, message, data };
}
