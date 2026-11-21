// Data access for the day-to-day screens. Everything is read as the signed-in user through functions/views that apply row-level security, scopes and field masking.
import type { SupabaseClient } from '@supabase/supabase-js';

type Err = { code?: string; message: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const fail = (e: Err): { ok: false; error: string } => ({ ok: false, error: ['22023', '42501', 'P0002', '23505'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.' });

export type Home = { role: string; today: string; tasks: { id: string; title: string; due: string; lead_id: string; lead: string | null; overdue: boolean }[]; open_tasks: number; overdue_tasks: number;
  leads: { id: string; name: string; stage: string; updated_at: string }[]; my_leads: number; unassigned_leads: number; appointments_enabled: boolean; appointments: { id: string; starts_at: string; status: string; type: string; contact: string | null }[];
  unread: number; notifications: { id: string; title: string; body: string | null; link: string | null; created_at: string; category: string }[]; members: number; leads_total: number };
export async function homeSummary(db: SupabaseClient, org: string, tz: string): Promise<Result<Home>> {
  const { data, error } = await db.rpc('home_summary', { p_org: org, p_tz: tz }); return error ? fail(error) : { ok: true, value: data as Home };
}
export type SearchItem = { type: 'lead' | 'task' | 'appointment' | 'invoice' | 'record'; id: string; title: string; subtitle: string; link: string };
export async function globalSearch(db: SupabaseClient, org: string, q: string, types: string[] | null, page: number, size = 20): Promise<Result<{ items: SearchItem[]; hasMore: boolean }>> {
  const { data, error } = await db.rpc('global_search', { p_org: org, p_q: q, p_types: types, p_limit: size, p_offset: Math.max(0, (page - 1) * size) });
  return error ? fail(error) : { ok: true, value: { items: (data as { items: SearchItem[] }).items, hasMore: !!(data as { has_more: boolean }).has_more } };
}
export type InviteRow = { id: string; email: string; role: string; status: 'pending' | 'accepted' | 'revoked'; expires_at: string; created_at: string; accepted_at: string | null; custom_role_id: string | null };
export async function listInvitations(db: SupabaseClient, org: string): Promise<Result<InviteRow[]>> {
  const { data, error } = await db.from('invitations').select('id, email, role, status, expires_at, created_at, accepted_at, custom_role_id').eq('organization_id', org).order('created_at', { ascending: false }).limit(50);
  return error ? fail(error) : { ok: true, value: data as InviteRow[] };
}
export async function memberNames(db: SupabaseClient, org: string): Promise<Record<string, string>> { const { data } = await db.rpc('member_names', { p_org: org }); return (data as Record<string, string> | null) ?? {}; }
export type Prefs = { task_assigned: boolean; lead_assigned: boolean; task_overdue: boolean; automation: boolean };
export async function notificationPrefs(db: SupabaseClient, org: string): Promise<Prefs> {
  const { data } = await db.from('notification_prefs').select('task_assigned, lead_assigned, task_overdue, automation').eq('organization_id', org).maybeSingle();
  return (data as Prefs | null) ?? { task_assigned: true, lead_assigned: true, task_overdue: true, automation: true };
}
export const categoryLabel: Record<string, string> = { task_assigned: 'Task assigned', lead_assigned: 'Lead assigned', task_overdue: 'Overdue', automation: 'Automation' };
