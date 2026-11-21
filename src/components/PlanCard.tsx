'use client';
// Combined preview of a multi-step plan: accept/reject each step, save the accepted steps as drafts, edit them in the visual editors, then publish in a second explicit step.
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { dismissPlanAction, planDecideAction, planRunAction } from '../app/(app)/assistant/actions';
import type { PlanView } from '../lib/ai/cards';

const KIND: Record<string, string> = { module: 'Module', fields: 'Fields', layout: 'Form layout', pipeline: 'Pipeline', ops_module: 'Business module', workflow: 'Workflow', dashboard: 'Dashboard', role: 'Role' };
const STATE: Record<string, string> = { pending: 'Not applied', drafted: 'Saved as draft', applied: 'Live', failed: 'Failed', skipped: 'Skipped' };
const STATUS: Record<string, string> = { proposed: 'Waiting for your approval', applying: 'Applying…', drafted: 'Drafts saved (not live)', applied: 'Applied', partially_applied: 'Partly applied', rejected: 'Dismissed', stale: 'Out of date' };

function editLink(planId: string, s: PlanView['steps'][number], steps: PlanView['steps']): { href: string; label: string } | null {
  if (s.decision !== 'accepted') return null;
  if (['module', 'fields', 'layout'].includes(s.kind) && ['drafted', 'applied'].includes(s.state)) return { href: '/builder/forms', label: 'Edit in the form builder' };
  if (s.kind === 'pipeline' && ['drafted', 'applied'].includes(s.state)) return { href: '/builder/pipeline', label: 'Edit in the pipeline builder' };
  if (s.kind === 'workflow' && s.result?.workflow_id) return { href: `/automations/${String(s.result.workflow_id)}`, label: 'Open on the canvas' };
  if (s.kind === 'dashboard' && s.state === 'pending' && s.depends_on.every(d => steps.find(x => x.key === d)?.state === 'applied' || steps.find(x => x.key === d)?.decision !== 'accepted')) return { href: `/dashboards/new?plan=${planId}&step=${s.key}`, label: 'Edit in the dashboard editor' };
  if (s.kind === 'dashboard' && s.result?.dashboard_id) return { href: `/dashboards/${String(s.result.dashboard_id)}`, label: 'Open dashboard' };
  return null;
}
export function PlanCard({ initial }: { initial: PlanView }) {
  const [v, setV] = useState(initial); const [pending, start] = useTransition(); const [note, setNote] = useState<{ ok: boolean; text: string }>(); const [enable, setEnable] = useState(false);
  const { plan, steps } = v; const open = plan.status === 'proposed'; const anyAccepted = steps.some(s => s.decision === 'accepted');
  const decide = (key: string, d: 'accepted' | 'rejected') => start(async () => { const r = await planDecideAction(plan.id, key, d); if (r.ok && r.plan) setV(r.plan); else setNote({ ok: false, text: r.error ?? 'Could not update the step.' }); });
  const run = (phase: 'draft' | 'publish') => start(async () => { const r = await planRunAction(plan.id, phase, enable); if (r.plan) setV(r.plan); setNote({ ok: r.ok, text: r.message }); });
  const canPublish = ['drafted', 'partially_applied'].includes(plan.status) && steps.some(s => s.decision === 'accepted' && s.state !== 'applied');
  const canDraft = (plan.status === 'proposed' && anyAccepted) || (plan.status === 'partially_applied' && steps.some(s => s.state === 'failed' && ['module', 'fields', 'layout', 'pipeline', 'ops_module', 'workflow'].includes(s.kind)));
  return <div className="ai-proposal" role="group" aria-label={`Plan: ${plan.title}`}>
    <div className="row"><strong>Plan: {plan.title}</strong><span className="badge">{STATUS[plan.status] ?? plan.status}</span></div>
    {plan.summary && <p className="muted">{plan.summary}</p>}
    <ol style={{ paddingLeft: 18, margin: '6px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {steps.map(s => { const link = editLink(plan.id, s, steps); return <li key={s.key} style={{ opacity: s.decision === 'rejected' ? .55 : 1 }}>
        <div className="row" style={{ gap: 6 }}><strong>{s.title}</strong><span className="tag">{KIND[s.kind] ?? s.kind}</span>{s.decision === 'accepted' && plan.status !== 'proposed' && <span className="tag">{STATE[s.state]}</span>}{s.decision === 'rejected' && <span className="tag">Rejected</span>}</div>
        {s.depends_on.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Needs: {s.depends_on.join(', ')}</div>}
        <details><summary style={{ fontSize: 12, fontWeight: 400 }}>What it does</summary><pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, maxHeight: 160, overflow: 'auto' }}>{summarize(s)}</pre></details>
        {s.error && <div className="err" role="alert">{s.error}</div>}
        <div className="row" style={{ gap: 6 }}>
          {open && (s.decision === 'accepted' ? <button type="button" className="btn" disabled={pending} onClick={() => decide(s.key, 'rejected')}>Reject</button> : <button type="button" className="btn" disabled={pending} onClick={() => decide(s.key, 'accepted')}>Accept</button>)}
          {link && <Link className="btn" href={link.href}>{link.label}</Link>}</div></li>; })}
    </ol>
    {open && <p className="muted" style={{ fontSize: 12 }}>Accepting a step also needs the steps it depends on. Rejecting one rejects what depends on it.</p>}
    <div className="row">
      {canDraft && <button type="button" className="btn primary" disabled={pending || !anyAccepted} onClick={() => run('draft')}>{plan.status === 'partially_applied' ? 'Retry failed steps (drafts)' : 'Approve: save accepted steps as drafts'}</button>}
      {canPublish && <><label className="row" style={{ gap: 6 }}><input type="checkbox" checked={enable} onChange={e => setEnable(e.target.checked)} /> Enable workflows when published</label>
        <button type="button" className="btn primary" disabled={pending} onClick={() => { if (confirm(`Publish the accepted steps now? Configuration and workflows go live${enable ? ' (workflows ENABLED)' : ' (workflows stay disabled)'}, roles and dashboards are created.`)) run('publish'); }}>{plan.status === 'partially_applied' ? 'Resume publishing' : 'Publish accepted steps'}</button></>}
      {(open || plan.status === 'drafted') && <button type="button" className="btn" disabled={pending} onClick={() => start(async () => { const r = await dismissPlanAction(plan.id); if (r.plan) setV(r.plan); })}>Dismiss</button>}
    </div>
    {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'ok' : 'err'}>{note.text}</p>}
  </div>;
}
function summarize(s: PlanView['steps'][number]): string {
  const a = s.args as Record<string, unknown>;
  if (s.kind === 'module') return `Create the module “${a.module_label}”. Fields: ${((a.fields as { label: string; kind: string }[]) ?? []).map(f => `${f.label} (${f.kind})`).join(', ')}`;
  if (s.kind === 'fields') return `Add to ${a.module_key}: ${((a.fields as { label: string; kind: string }[]) ?? []).map(f => `${f.label} (${f.kind})`).join(', ')}`;
  if (s.kind === 'layout') return `Form layout of ${a.module_key}:\n${JSON.stringify(a.layout, null, 1)}`;
  if (s.kind === 'pipeline') return `Pipeline: ${JSON.stringify(a.pipeline)}`;
  if (s.kind === 'ops_module') return `${a.enabled === false ? 'Turn off' : 'Turn on'} ${a.module}`;
  if (s.kind === 'workflow') return `Workflow “${a.name}”:\n${JSON.stringify((a.definition as object), null, 1)}`;
  if (s.kind === 'dashboard') return `Dashboard “${a.name}” with ${((a.widgets as unknown[]) ?? []).length} widget(s):\n${((a.widgets as { title: string; type: string }[]) ?? []).map(w => `• ${w.title} (${w.type})`).join('\n')}`;
  return `Role “${a.name}” based on ${a.base}. Restrictions: ${JSON.stringify(a.permissions)}. It is not assigned to anyone.`;
}
