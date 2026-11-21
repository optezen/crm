'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';

const UUID = /^[0-9a-f-]{36}$/i;
export async function setReadAction(id: string | null, read: boolean): Promise<{ ok: boolean }> {
  if (id !== null && !UUID.test(id)) return { ok: false };
  const r = await (await supabaseServer()).rpc('notifications_set_read', { p_ids: id === null ? null : [id], p_read: read }); revalidatePath('/', 'layout'); return { ok: !r.error };
}
export type PrefState = { error?: string; ok?: string } | null;
/** Per-person, per-organization preferences. They only decide which IN-APP notifications are created or shown. */
export async function savePrefsAction(_: PrefState, f: FormData): Promise<PrefState> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  const on = (k: string) => f.get(k) === 'on';
  const r = await (await supabaseServer()).rpc('notification_prefs_save', { p_org: s.organizationId, p_task_assigned: on('task_assigned'), p_lead_assigned: on('lead_assigned'), p_task_overdue: on('task_overdue'), p_automation: on('automation') });
  if (r.error) return { error: 'Could not save. Please try again.' }; revalidatePath('/notifications'); revalidatePath('/account'); return { ok: 'Saved.' };
}
export async function saveProfileAction(_: PrefState, f: FormData): Promise<PrefState> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  const r = await (await supabaseServer()).rpc('profile_save', { p_name: String(f.get('name') ?? '') });
  if (r.error) return { error: r.error.code === '22023' ? r.error.message : 'Could not save. Please try again.' }; revalidatePath('/', 'layout'); return { ok: 'Saved.' };
}
