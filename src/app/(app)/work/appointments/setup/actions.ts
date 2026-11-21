'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../lib/supabase/server';
import { parseReminderForm } from '../../../../../lib/operations/reminder-form';
import type { FormState } from '../../../../../components/ui/ActionForm';

// The organization comes from the signed-in membership, never from the form; the database function re-checks that the caller is an owner or admin.
export async function saveReminderSettingsAction(_: FormState, f: FormData): Promise<FormState> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  if (s.role !== 'owner' && s.role !== 'admin') return { error: 'Only owners and admins can change reminder settings.' };
  const p = parseReminderForm(f); if (!p.ok) return { error: p.error };
  const r = await (await supabaseServer()).rpc('reminder_settings_save', { p_org: s.organizationId, ...p.value });
  if (r.error) return { error: ['22023', '42501'].includes(r.error.code ?? '') ? r.error.message : 'Something went wrong. Please try again.' };
  revalidatePath('/work/appointments/setup'); return { ok: 'Reminder settings saved. Upcoming appointments were rescheduled to match.' };
}
