// Plan executor. Two explicit phases, each safe to re-run:
//   draft:   saves the accepted steps as DRAFTS (one workspace-configuration draft for all configuration steps, one automation draft per workflow). Nothing is live.
//   publish: makes them live in dependency order (configuration -> workflows -> roles -> dashboards) as the approving user, so every database check and permission applies.
// Every step's state and any ids it created are stored in the database before moving on, so a crash, a failed step or a double click is recoverable: finished steps are
// skipped, dependents of a failed step are skipped with the reason, and a lease prevents two runners at once. Configuration steps are one transaction (one draft, one publish).
import { validateConfig } from '../workspace/schema.ts';
import type { WorkspaceConfig } from '../workspace/types.ts';
import { applyOps, type Op } from './config-ops.ts';
import { CONFIG_KINDS, type StepKind } from './plan.ts';
import type { Rpc } from './tools.ts';

export type PlanStepRow = { key: string; kind: StepKind; title: string; args: Record<string, unknown>; depends_on: string[]; decision: 'pending' | 'accepted' | 'rejected'; state: 'pending' | 'drafted' | 'applied' | 'failed' | 'skipped'; result: Record<string, unknown> | null; error: string | null; attempts: number };
export type PlanRow = { id: string; title: string; summary: string | null; status: string; phase: string | null; base_revision: number | null; run_options: Record<string, unknown> };
export type RunCtx = { org: string; rpc: Rpc; loadConfigs: () => Promise<{ published: WorkspaceConfig; publishedRevision: number; draft: WorkspaceConfig | null }> };
export type RunResult = { ok: boolean; status: string; message: string; steps: PlanStepRow[] };
type Err = { code?: string; message: string };
const safe = (e: Err) => (['22023', '23505', '42501', 'P0002'].includes(e.code ?? '') ? e.message : 'Something went wrong. Please try again.');

const toOp = (s: PlanStepRow): Op => {
  const a = s.args as Record<string, never>;
  switch (s.kind) {
    case 'module': return { op: 'add_module', module_label: String(a.module_label), fields: a.fields };
    case 'fields': return { op: 'add_fields', module_key: String(a.module_key), fields: a.fields };
    case 'layout': return { op: 'set_layout', module_key: String(a.module_key), layout: a.layout };
    case 'pipeline': return { op: 'set_pipeline', pipeline: (s.args as { pipeline: never }).pipeline };
    default: return { op: (s.args as { enabled?: boolean }).enabled === false ? 'disable_module' : 'enable_module', operations_module: String(a.module) as 'billing' };
  }
};

async function load(c: RunCtx, plan: string): Promise<{ plan: PlanRow; steps: PlanStepRow[] } | null> {
  const r = await c.rpc('ai_plan_get', { p_org: c.org, p_plan: plan }); return r.error ? null : (r.data as { plan: PlanRow; steps: PlanStepRow[] });
}

export async function runPlan(c: RunCtx, planId: string, phase: 'draft' | 'publish', options: { enableWorkflows?: boolean } = {}): Promise<RunResult> {
  const begun = await c.rpc('ai_plan_begin', { p_org: c.org, p_plan: planId, p_phase: phase, p_options: options });
  if (begun.error) return { ok: false, status: 'error', message: safe(begun.error), steps: [] };
  const b = begun.data as { ok: boolean; reason?: string };
  if (!b.ok) { const cur = await load(c, planId); return { ok: false, status: b.reason ?? 'refused', steps: cur?.steps ?? [], message: ({ busy: 'This plan is already being applied. Wait a moment and reload.', wrong_state: phase === 'publish' ? 'Save the accepted steps as drafts first.' : 'This plan was already drafted.', nothing_accepted: 'Accept at least one step first.', applied: 'This plan was already applied.', rejected: 'This plan was dismissed.', stale: 'This plan is stale. Ask the assistant again.' } as Record<string, string>)[b.reason ?? ''] ?? 'This plan cannot be run now.' }; }

  const snap = await load(c, planId); if (!snap) { await c.rpc('ai_plan_end', { p_org: c.org, p_plan: planId, p_status: 'partially_applied' }); return { ok: false, status: 'error', message: 'The plan could not be loaded.', steps: [] }; }
  const { plan } = snap; let steps = snap.steps; const accepted = () => steps.filter(s => s.decision === 'accepted');
  const set = async (key: string, state: PlanStepRow['state'], result: Record<string, unknown> | null, error: string | null) => { await c.rpc('ai_plan_step_set', { p_org: c.org, p_plan: planId, p_step: key, p_state: state, p_result: result, p_error: error }); steps = steps.map(s => (s.key === key ? { ...s, state, result: result ?? s.result, error } : s)); };
  const bad = (s: PlanStepRow) => s.depends_on.some(d => { const x = steps.find(y => y.key === d); return x && x.decision === 'accepted' && (x.state === 'failed' || x.state === 'skipped'); });
  const skipBlocked = async () => { for (const s of accepted()) if ((s.state === 'pending' || s.state === 'drafted') && bad(s)) await set(s.key, 'skipped', null, 'Skipped because a step it depends on failed.'); };
  const finish = async (status: string, message: string): Promise<RunResult> => { await c.rpc('ai_plan_end', { p_org: c.org, p_plan: planId, p_status: status }); return { ok: status === 'drafted' || status === 'applied', status, message, steps }; };
  let cfgs = await c.loadConfigs();

  // ---- draft: configuration steps (all-or-nothing) ----
  const cfgSteps = () => accepted().filter(s => (CONFIG_KINDS as readonly string[]).includes(s.kind));
  const needDraft = () => cfgSteps().filter(s => s.state === 'pending' || s.state === 'failed');
  const draftConfig = async (): Promise<boolean> => {
    const todo = needDraft(); if (!todo.length) return true;
    if (plan.base_revision !== null && cfgs.publishedRevision !== plan.base_revision) { for (const s of todo) await set(s.key, 'failed', null, 'The workspace was published after this plan was made.'); await skipBlocked(); return false; }
    const base = cfgs.draft ?? cfgs.published; const all = cfgSteps();
    const r = applyOps(base, cfgs.published, all.map(toOp));
    let config: WorkspaceConfig | null = r.ok ? r.value.config : null;
    if (!r.ok) {
      // a crash after the save but before the steps were marked: the draft already holds every created module, so there is nothing left to do
      const holds = (s: PlanStepRow) => { const o = cfgs.draft?.objects.find(x => x.key === String(s.args.module_key)); const want = ((s.args.fields as { label: string }[] | undefined) ?? []).map(f => f.label.trim().toLowerCase()); return !!o && want.every(l => o.fields.some(f => f.label.toLowerCase() === l)); };
      if (cfgs.draft && all.some(s => s.kind === 'module') && all.filter(s => s.kind === 'module').every(holds)) { for (const s of todo) await set(s.key, 'drafted', { recovered: true }, null); return true; }
      for (const s of todo) await set(s.key, 'failed', null, r.error.slice(0, 480)); await skipBlocked(); return false;
    }
    const v = validateConfig(config); if (!v.ok) { for (const s of todo) await set(s.key, 'failed', null, v.errors[0]!.slice(0, 480)); await skipBlocked(); return false; }
    const meta = await c.rpc('workspace_draft_token', { p_org: c.org }); if (meta.error) { for (const s of todo) await set(s.key, 'failed', null, safe(meta.error)); await skipBlocked(); return false; }
    const m = meta.data as { token: string; published: number | null };
    const saved = await c.rpc('save_workspace_visual', { p_org: c.org, p_definition: v.value, p_expected_token: m.token, p_expected_published: m.published });
    if (saved.error) { for (const s of todo) await set(s.key, 'failed', null, safe(saved.error).slice(0, 480)); await skipBlocked(); return false; }
    for (const s of all) if (s.state !== 'applied') await set(s.key, 'drafted', { draft_saved: true }, null);
    cfgs = await c.loadConfigs(); return true;
  };
  const draftWorkflows = async () => {
    for (const s of accepted().filter(x => x.kind === 'workflow' && (x.state === 'pending' || x.state === 'failed'))) {
      if (bad(s)) { await set(s.key, 'skipped', null, 'Skipped because a step it depends on failed.'); continue; }
      const a = s.args as { name: string; definition: unknown };
      const r = await c.rpc('automation_save_draft', { p_org: c.org, p_workflow: (s.result?.workflow_id as string | undefined) ?? null, p_name: a.name, p_definition: a.definition });
      if (r.error) await set(s.key, 'failed', null, safe(r.error)); else await set(s.key, 'drafted', { workflow_id: r.data }, null);
    }
  };

  const pendingDraft = () => accepted().some(s => (s.state === 'pending' || s.state === 'failed') && ((CONFIG_KINDS as readonly string[]).includes(s.kind) || s.kind === 'workflow'));
  if (phase === 'draft' || pendingDraft()) {
    await draftConfig(); await skipBlocked(); await draftWorkflows();
    if (phase === 'draft') {
      const problems = accepted().some(s => s.state === 'failed' || s.state === 'skipped');
      return await finish(problems ? 'partially_applied' : 'drafted', problems ? 'Some steps could not be drafted. Nothing is live. Fix them or run the draft step again to retry only the failed ones.' : 'Saved as drafts. Nothing is live yet. Review or edit the drafts in the visual editors, then publish when ready.');
    }
  }

  // ---- publish ----
  const mustPublish = accepted().filter(s => s.state !== 'applied');
  if (!mustPublish.length) return await finish('applied', 'Everything accepted is already applied.');
  const cfgDrafted = cfgSteps().filter(s => s.state === 'drafted');
  if (cfgDrafted.length) {
    if (plan.base_revision !== null && cfgs.publishedRevision !== plan.base_revision) { for (const s of cfgDrafted) await set(s.key, 'failed', null, 'The workspace was published after this plan was made. Review the draft in the Builder instead.'); }
    else if (!cfgs.draft) { for (const s of cfgDrafted) await set(s.key, 'failed', null, 'The saved draft is missing. Run the draft step again.'); }
    else {
      const pub = await c.rpc('publish_workspace_config', { p_org: c.org });
      if (pub.error) {
        const now = await c.loadConfigs(); const already = !now.draft && now.publishedRevision !== cfgs.publishedRevision && cfgDrafted.filter(s => s.kind === 'module').every(s => { const o = now.published.objects.find(x => x.key === String(s.args.module_key)); return !!o && ((s.args.fields as { label: string }[] | undefined) ?? []).every(f => o.fields.some(x => x.label.toLowerCase() === f.label.trim().toLowerCase())); });
        if (already) for (const s of cfgDrafted) await set(s.key, 'applied', { recovered: true }, null); else for (const s of cfgDrafted) await set(s.key, 'failed', null, safe(pub.error).slice(0, 480));
      } else for (const s of cfgDrafted) await set(s.key, 'applied', { revision: pub.data }, null);
      cfgs = await c.loadConfigs();
    }
    await skipBlocked();
  }
  for (const s of accepted().filter(x => x.kind === 'workflow' && x.state === 'drafted')) {
    if (bad(s) || s.depends_on.some(d => { const x = steps.find(y => y.key === d); return x && x.decision === 'accepted' && x.state !== 'applied'; })) { await set(s.key, 'skipped', null, 'Skipped because a step it depends on is not applied.'); continue; }
    const r = await c.rpc('automation_publish', { p_org: c.org, p_workflow: s.result?.workflow_id, p_enable: options.enableWorkflows === true });
    if (r.error) await set(s.key, 'failed', { ...s.result }, safe(r.error)); else await set(s.key, 'applied', { ...s.result, version: r.data, enabled: options.enableWorkflows === true }, null);
  }
  for (const s of accepted().filter(x => x.kind === 'role' && x.state !== 'applied')) {
    if (bad(s)) { await set(s.key, 'skipped', null, 'Skipped because a step it depends on failed.'); continue; }
    const a = s.args as { name: string; base: string; permissions: unknown; scopes: unknown };
    const r = await c.rpc('role_save', { p_org: c.org, p_id: null, p_name: a.name, p_base: a.base, p_permissions: a.permissions, p_scopes: a.scopes, p_location_restricted: false });
    if (r.error) await set(s.key, 'failed', null, safe(r.error)); else await set(s.key, 'applied', { role_id: r.data }, null);
  }
  for (const s of accepted().filter(x => x.kind === 'dashboard' && x.state !== 'applied')) {
    if (bad(s) || s.depends_on.some(d => { const x = steps.find(y => y.key === d); return x && x.decision === 'accepted' && x.state !== 'applied'; })) { await set(s.key, 'skipped', null, 'Skipped because a step it depends on is not applied.'); continue; }
    const a = s.args as { name: string; description: string | null; visibility: string; widgets: unknown };
    const r = await c.rpc('dashboard_save', { p_org: c.org, p_id: null, p_name: a.name, p_description: a.description, p_visibility: a.visibility, p_widgets: a.widgets, p_version: null });
    if (r.error) await set(s.key, 'failed', null, safe(r.error)); else await set(s.key, 'applied', { dashboard_id: (r.data as { id: string }).id }, null);
  }
  const all = accepted().every(s => s.state === 'applied');
  return await finish(all ? 'applied' : 'partially_applied', all ? 'Applied. Everything you accepted is now live.' : 'Some steps were applied and some were not. Applied steps are kept; fix the cause and press Resume to retry only the rest.');
}
