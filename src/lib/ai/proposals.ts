// Approval flow for assistant proposals. Called ONLY from user-initiated server actions (never from a tool). Each step re-validates the proposal and
// goes through the same database functions as the Builder / Automation Builder, which re-check owner/admin and validate again. Publishing is a separate,
// second explicit step, and it refuses when the saved draft no longer equals what the user approved.
import type { WorkspaceConfig } from '../workspace/types.ts';
import { validateConfig } from '../workspace/schema.ts';
import { validateAutomation } from '../automation/validate.ts';
import type { Rpc, ToolCtx } from './tools.ts';

export type ProposalStep = 'save_draft' | 'publish' | 'publish_enable' | 'publish_disabled' | 'reject' | 'save_dashboard';
export type Applied = { ok: true; message: string; status: string } | { ok: false; error: string };
type Proposal = { id: string; kind: 'module_config' | 'workflow' | 'dashboard'; title: string; payload: Record<string, unknown>; base_revision: number | null; status: string; workflow_id: string | null };
const safe = (e: { code?: string; message: string }) => (['22023', '23505', '42501', 'P0002'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.');
const norm = (c: WorkspaceConfig) => JSON.stringify({ ...c, businessName: '', industryTemplate: undefined });

export async function applyProposal(ctx: Pick<ToolCtx, 'org' | 'rpc' | 'loadConfigs'>, proposalId: string, step: ProposalStep): Promise<Applied> {
  const rpc: Rpc = ctx.rpc;
  const got = await rpc('ai_get_proposal', { p_org: ctx.org, p_proposal: proposalId });
  if (got.error || !got.data) return { ok: false, error: got.error ? safe(got.error) : 'Proposal not found.' };
  const p = got.data as Proposal;
  const setStatus = (status: string, result: unknown, wf?: string) => rpc('ai_set_proposal_status', { p_org: ctx.org, p_proposal: p.id, p_status: status, p_result: result, p_workflow: wf ?? null });
  const bad = (m: string): Applied => ({ ok: false, error: m });

  if (step === 'reject') { const r = await setStatus('rejected', null); return r.error ? bad(safe(r.error)) : { ok: true, status: 'rejected', message: 'Dismissed. Nothing was changed.' }; }

  if (p.kind === 'dashboard') {
    if (step !== 'save_dashboard') return bad('That action does not apply to this proposal.');
    if (p.status !== 'pending') return bad('This proposal was already handled.');
    // the Dashboard Builder service itself (dashboard_save) validates every widget query and checks the APPROVING user's permissions again
    const saved = await rpc('dashboard_save', { p_org: ctx.org, p_id: null, p_name: String(p.payload.name ?? p.title), p_description: (p.payload.description as string | null) ?? null, p_visibility: String(p.payload.visibility ?? 'personal'), p_widgets: p.payload.widgets, p_version: null });
    if (saved.error) return bad(safe(saved.error));
    const st = await setStatus('published', { dashboard_id: (saved.data as { id: string }).id }); if (st.error) return bad(safe(st.error));
    return { ok: true, status: 'published', message: 'Dashboard created. Open Dashboards to view and adjust it.' };
  }
  if (p.kind === 'module_config') {
    const cfgs = await ctx.loadConfigs();
    if (step === 'save_draft') {
      if (p.status !== 'pending') return bad('This proposal was already handled.');
      if (cfgs.publishedRevision !== p.base_revision) return bad('The workspace was published since this proposal was made. Ask the assistant again so it builds on the latest version.');
      const v = validateConfig(p.payload.config); if (!v.ok) return bad(`The proposal is no longer valid: ${v.errors[0]}`);
      const saved = await rpc('save_workspace_draft', { p_org: ctx.org, p_definition: v.value }); if (saved.error) return bad(safe(saved.error));
      const st = await setStatus('draft_saved', { draft_revision: saved.data }); if (st.error) return bad(safe(st.error));
      return { ok: true, status: 'draft_saved', message: 'Saved as a draft. It is NOT live yet. Review it in the Builder, or publish it from here when you are ready.' };
    }
    if (step === 'publish') {
      if (p.status !== 'draft_saved') return bad('Save the proposal as a draft first.');
      if (cfgs.publishedRevision !== p.base_revision) return bad('The workspace was published since this draft was prepared. Review the draft in the Builder instead.');
      const want = validateConfig(p.payload.config), have = cfgs.draft ? validateConfig(cfgs.draft) : null;
      if (!want.ok || !have || !have.ok || norm(want.value) !== norm(have.value)) return bad('The saved draft was changed after you approved this proposal. Review and publish it from the Builder instead.');
      const pub = await rpc('publish_workspace_config', { p_org: ctx.org }); if (pub.error) return bad(safe(pub.error));
      const st = await setStatus('published', { revision: pub.data }); if (st.error) return bad(safe(st.error));
      return { ok: true, status: 'published', message: `Published as version ${String(pub.data)}. You can roll back from the Builder's version history.` };
    }
    return bad('That action does not apply to this proposal.');
  }

  // workflow
  if (step === 'save_draft') {
    if (p.status !== 'pending') return bad('This proposal was already handled.');
    const v = validateAutomation(p.payload.definition); if (!v.ok) return bad(`The proposal is no longer valid: ${v.error}`);
    const saved = await rpc('automation_save_draft', { p_org: ctx.org, p_workflow: null, p_name: String(p.payload.name ?? p.title), p_definition: v.value }); if (saved.error) return bad(safe(saved.error));
    const st = await setStatus('draft_saved', { workflow_id: saved.data }, saved.data as string); if (st.error) return bad(safe(st.error));
    return { ok: true, status: 'draft_saved', message: 'Saved as an automation draft. It is NOT running. Publish it (enabled or disabled) when you are ready.' };
  }
  if (step === 'publish_enable' || step === 'publish_disabled') {
    if (p.status !== 'draft_saved' || !p.workflow_id) return bad('Save the proposal as a draft first.');
    const want = validateAutomation(p.payload.definition); const draft = await rpc('ai_get_workflow_draft', { p_org: ctx.org, p_proposal: p.id });
    if (draft.error) return bad(safe(draft.error));
    if (!want.ok || JSON.stringify(sortKeys(want.value)) !== JSON.stringify(sortKeys(draft.data))) return bad('The saved draft was changed after you approved this proposal. Review it in the Automation Builder instead.');
    const pub = await rpc('automation_publish', { p_org: ctx.org, p_workflow: p.workflow_id, p_enable: step === 'publish_enable' }); if (pub.error) return bad(safe(pub.error));
    const status = step === 'publish_enable' ? 'published' : 'published_disabled';
    const st = await setStatus(status, { version: pub.data }); if (st.error) return bad(safe(st.error));
    return { ok: true, status, message: step === 'publish_enable' ? 'Published and enabled. It runs for events from now on, as long as the automation worker is running.' : 'Published but disabled. Enable it from Automations when ready.' };
  }
  return bad('That action does not apply to this proposal.');
}
function sortKeys(v: unknown): unknown { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map(k => [k, sortKeys((v as Record<string, unknown>)[k])])); return v; }
