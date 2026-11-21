'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { canBuild } from '../../../lib/workspace/resolve';
import { supabaseServer } from '../../../lib/supabase/server';
import { publishWorkflow, requeueRun, saveWorkflow, setWorkflowEnabled, discardWorkflowDraft, markNotificationsRead, setMemberActive } from '../../../lib/automation/service';

export type AutoResult = { ok: true; message: string; id?: string } | { ok: false; error: string };
// Organization and role come from the signed-in user's membership, never from the request; the database re-checks the role on every call.
type Db = Awaited<ReturnType<typeof supabaseServer>>;
async function ctx(): Promise<{ error: string } | { org: string; db: Db }> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  if (!canBuild(s.role)) return { error: 'Only owners and admins can manage automations.' };
  return { org: s.organizationId, db: await supabaseServer() };
}
const wrap = async (message: string, fn: (c: { org: string; db: Db }) => Promise<{ ok: true; value?: unknown } | { ok: false; error: string }>): Promise<AutoResult> => {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  const r = await fn(c); if (!r.ok) return r;
  revalidatePath('/automations', 'layout'); return { ok: true, message };
};
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

export async function saveAutomationAction(id: string | null, name: string, definition: unknown): Promise<AutoResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  if (id !== null && !uuid(id)) return { ok: false, error: 'Automation not found.' };
  const r = await saveWorkflow(c.db, c.org, id, name, definition); if (!r.ok) return r;
  revalidatePath('/automations', 'layout'); return { ok: true, message: 'Draft saved. It is not live until you publish it.', id: r.value.id };
}
export async function publishAutomationAction(id: string, enable: boolean): Promise<AutoResult> { return uuid(id) ? wrap(enable ? 'Published and enabled.' : 'Published (not enabled).', c => publishWorkflow(c.db, c.org, id, enable)) : { ok: false, error: 'Automation not found.' }; }
export async function setEnabledAction(id: string, enabled: boolean): Promise<AutoResult> { return uuid(id) ? wrap(enabled ? 'Enabled.' : 'Disabled. Queued and delayed work for it was cancelled.', c => setWorkflowEnabled(c.db, c.org, id, enabled)) : { ok: false, error: 'Automation not found.' }; }
export async function discardAutomationDraftAction(id: string): Promise<AutoResult> {
  if (!uuid(id)) return { ok: false, error: 'Automation not found.' };
  const r = await wrap('Draft discarded.', c => discardWorkflowDraft(c.db, c.org, id)); if (r.ok) redirect('/automations'); return r;
}
export async function requeueRunAction(runId: string): Promise<AutoResult> { return uuid(runId) ? wrap('Run queued again.', c => requeueRun(c.db, c.org, runId)) : { ok: false, error: 'Run not found.' }; }

export async function markReadAction(): Promise<void> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return;
  await markNotificationsRead(await supabaseServer()); revalidatePath('/', 'layout');
}
export async function setMemberActiveAction(userId: string, active: boolean): Promise<AutoResult> {
  const s = await getWorkspaceState(); if (s.status !== 'ready' || !canBuild(s.role) || !uuid(userId)) return { ok: false, error: 'Only owners and admins can manage the team.' };
  const r = await setMemberActive(await supabaseServer(), s.organizationId, userId, active); if (!r.ok) return r;
  revalidatePath('/team'); return { ok: true, message: active ? 'Activated.' : 'Deactivated.' };
}
