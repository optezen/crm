import type { SupabaseClient } from '@supabase/supabase-js';
import type { Catalog, Dashboard, Query, QueryResult, Widget } from './types.ts';

export type RunOutcome = { ok: true; result: QueryResult } | { ok: false; code: 'forbidden' | 'invalid' | 'error'; error: string };
/** Runs one grammar query as the signed-in user. Refusals are explicit states ("no access"), never an empty or invented chart. */
export async function runQuery(db: SupabaseClient, org: string, query: Query): Promise<RunOutcome> {
  const { data, error } = await db.rpc('analytics_run', { p_org: org, p_q: query, p_max: 100 });
  if (!error) return { ok: true, result: data as QueryResult };
  if (error.code === '42501') return { ok: false, code: 'forbidden', error: error.message };
  if (error.code === '22023') return { ok: false, code: 'invalid', error: error.message };
  return { ok: false, code: 'error', error: 'The data could not be loaded right now.' };
}
export async function loadCatalog(db: SupabaseClient, org: string): Promise<Catalog | null> { const { data } = await db.rpc('analytics_catalog', { p_org: org }); return (data as Catalog | null) ?? null; }
export async function listDashboards(db: SupabaseClient, org: string) {
  const { data } = await db.from('dashboards').select('id, name, description, visibility, owner_id, version, updated_at').eq('organization_id', org).order('updated_at', { ascending: false }).limit(100);
  return (data ?? []) as { id: string; name: string; description: string | null; visibility: 'personal' | 'organization'; owner_id: string; version: number; updated_at: string }[];
}
export async function loadDashboard(db: SupabaseClient, org: string, id: string): Promise<Dashboard | null> {
  const d = await db.from('dashboards').select('id, name, description, visibility, owner_id, version').eq('organization_id', org).eq('id', id).maybeSingle(); if (!d.data) return null;
  const w = await db.from('dashboard_widgets').select('id, type, title, query, w, h, options, position').eq('dashboard_id', id).order('position');
  return { ...(d.data as Omit<Dashboard, 'widgets'>), widgets: (w.data ?? []).map(x => ({ id: x.id, type: x.type, title: x.title, query: x.query as Query, w: x.w, h: x.h, options: x.options })) as Widget[] };
}
