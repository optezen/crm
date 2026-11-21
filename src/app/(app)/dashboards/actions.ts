'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import type { Widget } from '../../../lib/analytics/types';

const UUID = /^[0-9a-f-]{36}$/i;
export type DashResult = { ok: true; id: string; version: number } | { ok: false; error: string };
// The organization comes from the user's membership. dashboard_save validates every widget query with the SAME grammar check that runs it, under THIS user's permissions.
export async function saveDashboardAction(id: string | null, v: { name: string; description: string; visibility: 'personal' | 'organization'; widgets: Widget[]; version: number | null }): Promise<DashResult> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { ok: false, error: 'Your session has ended. Please sign in again.' };
  if (id !== null && !UUID.test(id)) return { ok: false, error: 'Dashboard not found.' };
  const widgets = (Array.isArray(v.widgets) ? v.widgets : []).map(w => ({ type: w.type, title: w.title, query: w.query, w: w.w, h: w.h, ...(w.options && Object.keys(w.options).length ? { options: w.options } : {}) }));
  const { data, error } = await (await supabaseServer()).rpc('dashboard_save', { p_org: s.organizationId, p_id: id, p_name: v.name, p_description: v.description || null, p_visibility: v.visibility, p_widgets: widgets, p_version: v.version });
  if (error) return { ok: false, error: ['22023', '42501', 'P0002'].includes(error.code ?? '') ? error.message : 'Something went wrong. Please try again.' };
  revalidatePath('/dashboards', 'layout'); const r = data as { id: string; version: number }; return { ok: true, id: r.id, version: r.version };
}
export async function deleteDashboardAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const s = await getWorkspaceState(); if (s.status !== 'ready' || !UUID.test(id)) return { ok: false, error: 'Dashboard not found.' };
  const { error } = await (await supabaseServer()).rpc('dashboard_delete', { p_org: s.organizationId, p_id: id });
  if (error) return { ok: false, error: ['42501', 'P0002'].includes(error.code ?? '') ? error.message : 'Something went wrong.' };
  revalidatePath('/dashboards', 'layout'); return { ok: true };
}
