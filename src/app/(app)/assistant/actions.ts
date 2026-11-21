'use server';
import { revalidatePath } from 'next/cache';
import { getAiContext } from '../../../lib/ai/context';
import { applyProposal, type ProposalStep } from '../../../lib/ai/proposals';
import { runPlan } from '../../../lib/ai/planRun';
import type { PlanView } from '../../../lib/ai/cards';

export type ProposalView = { id: string; kind: 'module_config' | 'workflow' | 'dashboard' | 'operation'; title: string; payload: Record<string, unknown>; status: string; workflow_id?: string | null };
export type ConversationRow = { id: string; title: string | null; updatedAt: string };
export type StoredMessage = { id: string; role: 'user' | 'assistant'; text: string; proposals: ProposalView[]; plans?: PlanView[] };
const UUID = /^[0-9a-f-]{36}$/i;

export async function listConversationsAction(): Promise<ConversationRow[]> {
  const c = await getAiContext(); if (!c) return [];
  const { data } = await c.db.from('ai_conversations').select('id, title, updated_at').eq('organization_id', c.ctx.org).order('updated_at', { ascending: false }).limit(30); // RLS: only the signed-in user's own
  return (data ?? []).map(r => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}
export async function loadConversationAction(id: string): Promise<StoredMessage[]> {
  const c = await getAiContext(); if (!c || !UUID.test(id)) return [];
  const { data } = await c.db.from('ai_messages').select('id, role, content, seq').eq('organization_id', c.ctx.org).eq('conversation_id', id).order('seq').limit(100);
  const ids = [...new Set((data ?? []).flatMap(m => ((m.content as { proposals?: string[] }).proposals ?? [])))];
  const props = ids.length ? (await c.db.from('ai_proposals').select('id, kind, title, payload, status, workflow_id').in('id', ids)).data ?? [] : [];
  const planIds = [...new Set((data ?? []).flatMap(m => ((m.content as { plans?: string[] }).plans ?? [])))]; const planViews = new Map((await Promise.all(planIds.map(async id => [id, await planOf(c, id)] as const))).filter(([, v]) => v) as [string, PlanView][]);
  return (data ?? []).map(m => ({ id: m.id, role: m.role, text: String((m.content as { text?: string }).text ?? ''), proposals: ((m.content as { proposals?: string[] }).proposals ?? []).map(p => props.find(x => x.id === p)).filter(Boolean) as ProposalView[], plans: ((m.content as { plans?: string[] }).plans ?? []).map(id => planViews.get(id)).filter(Boolean) as PlanView[] }));
}
export async function deleteConversationAction(id: string): Promise<void> {
  const c = await getAiContext(); if (!c || !UUID.test(id)) return;
  await c.db.rpc('ai_delete_conversation', { p_org: c.ctx.org, p_conv: id });
}
/** The ONLY way a proposal changes anything. It is a user click on a specific button; the model cannot reach this function. */
export async function applyProposalAction(id: string, step: ProposalStep): Promise<{ ok: boolean; message?: string; error?: string; status?: string }> {
  const c = await getAiContext(); if (!c) return { ok: false, error: 'Please sign in again.' };
  if (!UUID.test(id) || !['save_draft', 'publish', 'publish_enable', 'publish_disabled', 'reject', 'save_dashboard', 'confirm'].includes(step)) return { ok: false, error: 'Invalid request.' };
  const r = await applyProposal(c.ctx, id, step);
  revalidatePath('/', 'layout');
  return r.ok ? { ok: true, message: r.message, status: r.status } : { ok: false, error: r.error };
}

// ---------- multi-step plans (the author only; every step re-checks owner/admin in the database) ----------
const planOf = async (c: NonNullable<Awaited<ReturnType<typeof getAiContext>>>, id: string): Promise<PlanView | null> => { const r = await c.ctx.rpc('ai_plan_get', { p_org: c.ctx.org, p_plan: id }); return r.error ? null : (r.data as PlanView); };
export async function getPlanAction(planId: string): Promise<PlanView | null> { const c = await getAiContext(); return c && UUID.test(planId) ? planOf(c, planId) : null; }
export async function planDecideAction(planId: string, step: string, decision: 'accepted' | 'rejected' | 'pending'): Promise<{ ok: boolean; error?: string; plan?: PlanView | null }> {
  const c = await getAiContext(); if (!c || !UUID.test(planId) || !/^[a-z][a-z0-9_]{0,29}$/.test(step)) return { ok: false, error: 'Invalid request.' };
  const r = await c.ctx.rpc('ai_plan_decide', { p_org: c.ctx.org, p_plan: planId, p_step: step, p_decision: decision });
  if (r.error) return { ok: false, error: ['22023', '42501', 'P0002'].includes(r.error.code ?? '') ? r.error.message : 'Something went wrong.' };
  return { ok: true, plan: await planOf(c, planId) };
}
/** phase "draft" saves drafts only; phase "publish" makes them live (the UI asks for explicit confirmation first). Re-runnable: finished steps are skipped. */
export async function planRunAction(planId: string, phase: 'draft' | 'publish', enableWorkflows = false): Promise<{ ok: boolean; message: string; plan: PlanView | null }> {
  const c = await getAiContext(); if (!c || !UUID.test(planId) || (phase !== 'draft' && phase !== 'publish')) return { ok: false, message: 'Invalid request.', plan: null };
  const r = await runPlan({ org: c.ctx.org, rpc: c.ctx.rpc, loadConfigs: c.ctx.loadConfigs }, planId, phase, { enableWorkflows: enableWorkflows === true });
  revalidatePath('/', 'layout'); return { ok: r.ok, message: r.message, plan: await planOf(c, planId) };
}
export async function dismissPlanAction(planId: string): Promise<{ ok: boolean; plan: PlanView | null }> {
  const c = await getAiContext(); if (!c || !UUID.test(planId)) return { ok: false, plan: null };
  const r = await c.ctx.rpc('ai_plan_end', { p_org: c.ctx.org, p_plan: planId, p_status: 'rejected' }); return { ok: !r.error, plan: await planOf(c, planId) };
}
