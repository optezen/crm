'use server';
import { revalidatePath } from 'next/cache';
import { getAiContext } from '../../../lib/ai/context';
import { applyProposal, type ProposalStep } from '../../../lib/ai/proposals';

export type ProposalView = { id: string; kind: 'module_config' | 'workflow'; title: string; payload: Record<string, unknown>; status: string };
export type ConversationRow = { id: string; title: string | null; updatedAt: string };
export type StoredMessage = { id: string; role: 'user' | 'assistant'; text: string; proposals: ProposalView[] };
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
  const props = ids.length ? (await c.db.from('ai_proposals').select('id, kind, title, payload, status').in('id', ids)).data ?? [] : [];
  return (data ?? []).map(m => ({ id: m.id, role: m.role, text: String((m.content as { text?: string }).text ?? ''), proposals: ((m.content as { proposals?: string[] }).proposals ?? []).map(p => props.find(x => x.id === p)).filter(Boolean) as ProposalView[] }));
}
export async function deleteConversationAction(id: string): Promise<void> {
  const c = await getAiContext(); if (!c || !UUID.test(id)) return;
  await c.db.rpc('ai_delete_conversation', { p_org: c.ctx.org, p_conv: id });
}
/** The ONLY way a proposal changes anything. It is a user click on a specific button; the model cannot reach this function. */
export async function applyProposalAction(id: string, step: ProposalStep): Promise<{ ok: boolean; message?: string; error?: string; status?: string }> {
  const c = await getAiContext(); if (!c) return { ok: false, error: 'Please sign in again.' };
  if (!UUID.test(id) || !['save_draft', 'publish', 'publish_enable', 'publish_disabled', 'reject'].includes(step)) return { ok: false, error: 'Invalid request.' };
  const r = await applyProposal(c.ctx, id, step);
  revalidatePath('/', 'layout');
  return r.ok ? { ok: true, message: r.message, status: r.status } : { ok: false, error: r.error };
}
