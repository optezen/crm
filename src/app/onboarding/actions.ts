'use server';
import { redirect } from 'next/navigation';
import { createWorkspace, getWorkspaceState } from '../../lib/workspace/service';
import { aiConfigured, draftWorkspace } from '../../lib/workspace/ai';
import { validateOnboarding } from '../../lib/workspace/schema';
import type { Result, SetupChoice, WorkspaceConfig } from '../../lib/workspace/types';
import { supabaseServer } from '../../lib/supabase/server';
import { providerFor } from '../../lib/ai/anthropic';
import { onboardingTurn, type OnboardingMessage, type OnboardingResult, type StarterProposal } from '../../lib/ai/onboarding';

export async function createWorkspaceAction(name: string, description: string, choice: SetupChoice): Promise<{ error: string }> {
  const r = await createWorkspace({ name, description, choice }); // re-validated and rebuilt server-side
  if (!r.ok) return { error: r.error };
  redirect('/work');
}

/** AI-assisted draft. Requires a signed-in user (so the API key cannot be used anonymously) and a configured key. Returns a DRAFT only. */
export async function aiDraftAction(name: string, description: string): Promise<Result<WorkspaceConfig>> {
  const s = await getWorkspaceState();
  if (s.status !== 'no-organization' && s.status !== 'ready') return { ok: false, error: 'Sign in to use AI drafting.' };
  if (!aiConfigured()) return { ok: false, error: 'AI drafting is not configured on this deployment.' };
  const v = validateOnboarding({ name, description });
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0]! };
  return draftWorkspace(v.value, { apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.OPTIZEN_AI_MODEL });
}

/** One turn of the optional conversational setup. Signed-in users only, metered per user per day (atomic), and it can only ever return a PROPOSAL or a question. */
export async function onboardingChatAction(name: string, description: string, transcript: OnboardingMessage[]): Promise<OnboardingResult> {
  const s = await getWorkspaceState();
  if (s.status !== 'no-organization' && s.status !== 'ready') return { type: 'error', code: 'forbidden', message: 'Sign in to use AI setup help.' };
  const provider = providerFor(); if (!provider) return { type: 'error', code: 'not_configured', message: 'AI setup help is not configured on this deployment. Choose a blank workspace or a starting point instead.' };
  if (!Array.isArray(transcript) || transcript.length > 30 || transcript.some(m => !m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string' || m.text.length > 2000)) return { type: 'error', code: 'invalid_message', message: 'That message is too long.' };
  const db = await supabaseServer();
  const gate = (await db.rpc('ai_onboarding_reserve', { p_daily_calls: 30 })).data as { allowed?: boolean; reason?: string; id?: string } | null;
  if (!gate?.allowed || !gate.id) return { type: 'error', code: 'budget', message: gate?.reason ?? 'AI setup help is not available right now.' };
  const r = await onboardingTurn(provider, { name: String(name).slice(0, 80), description: String(description).slice(0, 1000), transcript });
  await db.rpc('ai_onboarding_settle', { p_id: gate.id, p_in: r.usage.in, p_out: r.usage.out, p_status: r.type === 'error' ? 'error' : 'ok' });
  const { usage: _u, ...out } = r; void _u; return out;
}

/** Creates the workspace from an approved proposal. Workflows are saved as DRAFTS only (never enabled); dashboards are created for the owner. Anything that cannot be added is reported, never hidden. */
export async function createWithProposalAction(name: string, description: string, proposal: StarterProposal, include: { workflows: number[]; dashboards: number[] }): Promise<{ error: string }> {
  const r = await createWorkspace({ name, description, choice: { kind: 'draft', definition: proposal?.config } });
  if (!r.ok) return { error: r.error };
  const db = await supabaseServer(); const failed: string[] = [];
  for (const i of include.workflows ?? []) { const w = proposal.workflows?.[i]; if (!w) continue; const x = await db.rpc('automation_save_draft', { p_org: r.organizationId, p_workflow: null, p_name: w.name.slice(0, 80), p_definition: w.definition }); if (x.error) failed.push(`workflow “${w.name}”`); }
  for (const i of include.dashboards ?? []) { const d = proposal.dashboards?.[i]; if (!d) continue; const x = await db.rpc('dashboard_save', { p_org: r.organizationId, p_id: null, p_name: d.name.slice(0, 80), p_description: null, p_visibility: 'personal', p_widgets: d.widgets, p_version: null }); if (x.error) failed.push(`dashboard “${d.name}”`); }
  redirect(failed.length ? `/work?setup_incomplete=${encodeURIComponent(failed.join(', ').slice(0, 300))}` : '/work');
}
