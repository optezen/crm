'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { canBuild } from '../../../lib/workspace/resolve';
import { supabaseServer } from '../../../lib/supabase/server';
import { CONFLICT, publishWorkflow, saveVisual } from '../../../lib/automation/service';
import type { Layout } from '../../../lib/builder/workflowGraph';

export type VisualResult = { ok: true; message: string; id?: string; token?: string } | { ok: false; error: string; conflict?: boolean };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
type Db = Awaited<ReturnType<typeof supabaseServer>>;
async function ctx(): Promise<{ error: string } | { org: string; db: Db }> {
  const s = await getWorkspaceState();
  if (s.status !== 'ready') return { error: 'Your session has ended. Please sign in again.' };
  if (!canBuild(s.role)) return { error: 'Only owners and admins can manage automations.' };
  return { org: s.organizationId, db: await supabaseServer() };
}
type Link = { id: string; status: string; kind: string } | null;
/** A proposal this canvas was opened from. The organization/user checks live in the database (ai_get_proposal / ai_set_proposal_status). */
async function link(c: { org: string; db: Db }, proposalId: string | null): Promise<Link> {
  if (!proposalId || !uuid(proposalId)) return null;
  const r = await c.db.rpc('ai_get_proposal', { p_org: c.org, p_proposal: proposalId }); const d = r.data as { id: string; status: string; kind: string } | null;
  return !r.error && d && d.kind === 'workflow' ? d : null;
}

/** Saves the draft the canvas produced (definition + layout). The definition is re-validated here and in the database; layout is cosmetic. */
export async function saveVisualAction(input: { id: string | null; name: string; definition: unknown; layout: Layout; token: string | null; basePublished: number | null; proposalId: string | null }): Promise<VisualResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  if (input.id !== null && !uuid(input.id)) return { ok: false, error: 'Automation not found.' };
  const prop = await link(c, input.proposalId);
  if (input.proposalId && !prop) return { ok: false, error: 'The AI proposal this came from is no longer available. Save without it by reopening the automation.' };
  if (prop && !['pending', 'draft_saved'].includes(prop.status)) return { ok: false, error: 'That AI proposal was already handled. Reopen the automation from the list.' };
  const r = await saveVisual(c.db, c.org, input.id, input.name, input.definition, input.layout, input.token, input.basePublished);
  if (!r.ok) return { ok: false, error: r.error, conflict: r.error.includes(CONFLICT) };
  if (prop && prop.status === 'pending') {
    const st = await c.db.rpc('ai_set_proposal_status', { p_org: c.org, p_proposal: prop.id, p_status: 'draft_saved', p_result: { workflow_id: r.value.id, edited_visually: true }, p_workflow: r.value.id });
    if (st.error) return { ok: false, error: 'Saved the draft, but the proposal could not be marked: ' + st.error.message };
  }
  revalidatePath('/automations', 'layout');
  return { ok: true, message: 'Draft saved. It is not live until you publish it.', id: r.value.id, token: r.value.token };
}
export async function publishVisualAction(id: string, enable: boolean, proposalId: string | null): Promise<VisualResult> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  if (!uuid(id)) return { ok: false, error: 'Automation not found.' };
  const prop = await link(c, proposalId);
  const r = await publishWorkflow(c.db, c.org, id, enable); if (!r.ok) return { ok: false, error: r.error };
  if (prop && prop.status === 'draft_saved') await c.db.rpc('ai_set_proposal_status', { p_org: c.org, p_proposal: prop.id, p_status: enable ? 'published' : 'published_disabled', p_result: { published_visually: true }, p_workflow: id });
  revalidatePath('/automations', 'layout');
  return { ok: true, message: enable ? 'Published and enabled.' : 'Published (not enabled).' };
}

/** Saves an UNFINISHED canvas (any graph, valid or not) apart from drafts. It can never be published or run: to go live it must be completed, saved as a normal draft and published. */
export async function saveWipAction(input: { id: string | null; workflowId: string | null; name: string; graph: unknown }): Promise<{ ok: true; id: string; message: string } | { ok: false; error: string }> {
  const c = await ctx(); if ('error' in c) return { ok: false, error: c.error };
  if (input.id !== null && !uuid(input.id)) return { ok: false, error: 'Unfinished workflow not found.' }; if (input.workflowId !== null && !uuid(input.workflowId)) return { ok: false, error: 'Automation not found.' };
  const r = await c.db.rpc('automation_wip_save', { p_org: c.org, p_id: input.id, p_workflow: input.workflowId, p_name: String(input.name ?? '').slice(0, 80) || 'Unfinished workflow', p_graph: input.graph });
  if (r.error) return { ok: false, error: ['22023', '42501', 'P0002'].includes(r.error.code ?? '') ? r.error.message : 'Something went wrong. Please try again.' };
  revalidatePath('/automations', 'layout'); return { ok: true, id: r.data as string, message: 'Unfinished work saved. It is not an automation yet and cannot run or be published.' };
}
export async function deleteWipAction(id: string): Promise<{ ok: boolean }> {
  const c = await ctx(); if ('error' in c || !uuid(id)) return { ok: false };
  const r = await c.db.rpc('automation_wip_delete', { p_org: c.org, p_id: id }); revalidatePath('/automations', 'layout'); return { ok: !r.error };
}
