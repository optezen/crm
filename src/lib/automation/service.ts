import type { SupabaseClient } from '@supabase/supabase-js';
import { validateAutomation } from './validate.ts';
import type { AutomationDefinition, Result, RunRow, WorkflowRow } from './types.ts';

type Err = { code?: string; message: string };
const dbError = (e: Err): { ok: false; error: string } => ({ ok: false, error: ['22023', '23505', '42501', 'P0002'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.' });

export async function listWorkflows(db: SupabaseClient, org: string): Promise<Result<WorkflowRow[]>> {
  const { data, error } = await db.from('automation_workflows').select('id, name, enabled, published_version, updated_at').eq('organization_id', org).order('created_at', { ascending: false }).limit(50);
  return error ? dbError(error) : { ok: true, value: data.map(w => ({ id: w.id, name: w.name, enabled: w.enabled, publishedVersion: w.published_version, updatedAt: w.updated_at })) };
}

export type WorkflowDetail = { id: string; name: string; enabled: boolean; publishedVersion: number | null; draft: AutomationDefinition | null; published: AutomationDefinition | null };
export async function getWorkflow(db: SupabaseClient, org: string, id: string): Promise<Result<WorkflowDetail | null>> {
  const w = await db.from('automation_workflows').select('id, name, enabled, published_version').eq('organization_id', org).eq('id', id).maybeSingle();
  if (w.error) return dbError(w.error); if (!w.data) return { ok: true, value: null };
  const v = await db.from('automation_workflow_versions').select('version, status, definition').eq('workflow_id', id).in('status', ['draft', 'published']);
  if (v.error) return dbError(v.error);
  const def = (s: string) => (v.data.find(x => x.status === s)?.definition as AutomationDefinition | undefined) ?? null;
  return { ok: true, value: { id: w.data.id, name: w.data.name, enabled: w.data.enabled, publishedVersion: w.data.published_version, draft: def('draft'), published: def('published') } };
}

export async function listRuns(db: SupabaseClient, org: string, workflowId?: string, limit = 25): Promise<Result<(RunRow & { workflowId: string; workflowName: string })[]>> {
  let q = db.from('automation_runs').select('id, workflow_id, status, attempts, step_index, next_attempt_at, last_error, created_at, finished_at, version_id').eq('organization_id', org).order('created_at', { ascending: false }).limit(limit);
  if (workflowId) q = q.eq('workflow_id', workflowId);
  const r = await q; if (r.error) return dbError(r.error);
  const ids = r.data.map(x => x.id); if (!ids.length) return { ok: true, value: [] };
  const [steps, wfs, vers] = await Promise.all([
    db.from('automation_steps').select('run_id, step_index, action_type, status, result, error').in('run_id', ids).order('step_index'),
    db.from('automation_workflows').select('id, name').eq('organization_id', org).in('id', [...new Set(r.data.map(x => x.workflow_id))]),
    db.from('automation_workflow_versions').select('id, version').in('id', [...new Set(r.data.map(x => x.version_id))]),
  ]);
  if (steps.error) return dbError(steps.error);
  const name = new Map((wfs.data ?? []).map(w => [w.id, w.name])), ver = new Map((vers.data ?? []).map(v => [v.id, v.version]));
  return { ok: true, value: r.data.map(x => ({ id: x.id, workflowId: x.workflow_id, workflowName: name.get(x.workflow_id) ?? 'Automation', status: x.status, attempts: x.attempts, stepIndex: x.step_index, nextAttemptAt: x.next_attempt_at, lastError: x.last_error, createdAt: x.created_at, finishedAt: x.finished_at, version: ver.get(x.version_id) ?? 0,
    steps: steps.data.filter(s => s.run_id === x.id).map(s => ({ stepIndex: s.step_index, actionType: s.action_type, status: s.status, result: s.result, error: s.error })) })) };
}

export async function saveWorkflow(db: SupabaseClient, org: string, id: string | null, name: unknown, raw: unknown): Promise<Result<{ id: string }>> {
  const v = validateAutomation(raw); if (!v.ok) return v;
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) return { ok: false, error: 'Name the automation (up to 80 characters).' };
  const { data, error } = await db.rpc('automation_save_draft', { p_org: org, p_workflow: id, p_name: name.trim(), p_definition: v.value });
  return error ? dbError(error) : { ok: true, value: { id: data as string } };
}
const call = async (db: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<Result<null>> => { const { error } = await db.rpc(fn, args); return error ? dbError(error) : { ok: true, value: null }; };
export const publishWorkflow = (db: SupabaseClient, org: string, id: string, enable: boolean) => call(db, 'automation_publish', { p_org: org, p_workflow: id, p_enable: enable });
export const setWorkflowEnabled = (db: SupabaseClient, org: string, id: string, enabled: boolean) => call(db, 'automation_set_enabled', { p_org: org, p_workflow: id, p_enabled: enabled });
export const discardWorkflowDraft = (db: SupabaseClient, org: string, id: string) => call(db, 'automation_discard_draft', { p_org: org, p_workflow: id });
export const requeueRun = (db: SupabaseClient, org: string, run: string) => call(db, 'automation_requeue_run', { p_org: org, p_run: run });
export const setMemberActive = (db: SupabaseClient, org: string, user: string, active: boolean) => call(db, 'set_member_active', { p_org: org, p_user: user, p_active: active });
export const markNotificationsRead = (db: SupabaseClient) => call(db, 'notifications_mark_read', { p_ids: null });

export type NotificationRow = { id: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string };
export async function listNotifications(db: SupabaseClient, org: string, limit = 50): Promise<Result<NotificationRow[]>> {
  const { data, error } = await db.from('notifications').select('id, title, body, link, read_at, created_at').eq('organization_id', org).order('created_at', { ascending: false }).limit(limit);
  return error ? dbError(error) : { ok: true, value: data.map(n => ({ id: n.id, title: n.title, body: n.body, link: n.link, readAt: n.read_at, createdAt: n.created_at })) };
}
export async function unreadCount(db: SupabaseClient, org: string): Promise<number> {
  const { count } = await db.from('notifications').select('id', { count: 'exact', head: true }).eq('organization_id', org).is('read_at', null);
  return count ?? 0;
}
export async function listTeam(db: SupabaseClient, org: string): Promise<Result<{ userId: string; role: string; email: string; active: boolean }[]>> {
  const { data, error } = await db.rpc('team_list_members', { p_org: org });
  return error ? dbError(error) : { ok: true, value: (data as { user_id: string; role: string; email: string; active: boolean }[]).map(m => ({ userId: m.user_id, role: m.role, email: m.email, active: m.active })) };
}

// ---- visual builder: layout metadata + optimistic concurrency (migration 0017) ----
import type { Layout } from '../builder/workflowGraph.ts';
export const CONFLICT = 'changed since you opened it';
export async function getVisualMeta(db: SupabaseClient, org: string, id: string): Promise<Result<{ layout: Layout | null; token: string }>> {
  const [l, t] = await Promise.all([db.from('automation_layouts').select('layout').eq('organization_id', org).eq('workflow_id', id).maybeSingle(), db.rpc('automation_draft_token', { p_org: org, p_workflow: id })]);
  if (l.error) return dbError(l.error); if (t.error) return dbError(t.error);
  return { ok: true, value: { layout: (l.data?.layout as Layout | undefined) ?? null, token: t.data as string } };
}
export async function saveVisual(db: SupabaseClient, org: string, id: string | null, name: unknown, raw: unknown, layout: Layout | null, token: string | null, basePublished: number | null): Promise<Result<{ id: string; token: string }>> {
  const v = validateAutomation(raw); if (!v.ok) return v;
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) return { ok: false, error: 'Name the automation (up to 80 characters).' };
  const { data, error } = await db.rpc('automation_save_visual', { p_org: org, p_workflow: id, p_name: name.trim(), p_definition: v.value, p_layout: layout, p_expected_token: token, p_expected_published: basePublished });
  return error ? dbError(error) : { ok: true, value: data as { id: string; token: string } };
}
