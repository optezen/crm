import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { getVisualMeta, getWorkflow, listRuns, listTeam } from '../../../../lib/automation/service';
import { validateAutomation } from '../../../../lib/automation/validate';
import type { AutomationDefinition } from '../../../../lib/automation/types';
import { StudioNav } from '../../../../components/studio/StudioNav';
import { WorkflowStudio } from '../../../../components/studio/WorkflowStudio';
import { Card } from '../../../../components/ui/Card';
import { Notice } from '../../../../components/ui/Notice';
import { AutomationEditor } from '../AutomationEditor';
import { RunLog } from '../RunLog';

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

export default async function AutomationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const { id } = await params; const sp = await searchParams;
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Automations are limited to owners and admins">Ask an owner or admin to set up or review automations.</Notice>;
  const db = await supabaseServer(); const isNew = id === 'new';
  if (!isNew && !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [wf, team] = await Promise.all([isNew ? null : getWorkflow(db, s.organizationId, id), listTeam(db, s.organizationId)]);
  if (wf && !wf.ok) return <Notice title="Automation could not be loaded">{wf.error}</Notice>;
  if (wf && wf.ok && !wf.value) notFound();
  const w = wf && wf.ok ? wf.value : null;
  const meta = w ? await getVisualMeta(db, s.organizationId, w.id) : null;
  // An AI proposal this canvas was opened from. Everything is re-checked: the proposal must be this user's, in this organization, a workflow, and still open.
  let proposalId = typeof sp.proposal === 'string' && /^[0-9a-f-]{36}$/i.test(sp.proposal) ? sp.proposal : null; let initial: AutomationDefinition | null = null; let banner: string | null = null; let proposedName = '';
  if (proposalId) {
    const pr = await db.rpc('ai_get_proposal', { p_org: s.organizationId, p_proposal: proposalId });
    const p = pr.data as { kind: string; status: string; title: string; payload: { definition?: unknown; name?: string }; workflow_id: string | null } | null;
    if (pr.error || !p || p.kind !== 'workflow') { proposalId = null; banner = 'The AI proposal was not found, so this is a normal automation editor.'; }
    else if (isNew && p.status === 'draft_saved' && p.workflow_id) redirect(`/automations/${p.workflow_id}?proposal=${proposalId}`);
    else if (!['pending', 'draft_saved'].includes(p.status) || (!isNew && p.workflow_id !== id)) { proposalId = null; banner = 'That AI proposal was already handled or belongs to another automation.'; }
    else if (isNew) {
      const v = validateAutomation(p.payload.definition); proposedName = String(p.payload.name ?? p.title);
      const obj = v.ok ? v.value.trigger.object : undefined;
      if (!v.ok) { proposalId = null; banner = 'The AI proposal is no longer valid, so it was not loaded.'; }
      else if (obj && !s.config.objects.some(o => o.key === obj)) { initial = v.value; banner = `Stale proposal: it refers to the module “${obj}”, which is not in the live workspace. You can edit it, but it cannot be published until the module exists.`; }
      else { initial = v.value; banner = 'Proposed by Optizen AI. Nothing is saved yet: edit it on the canvas, then save the draft. Publishing is a separate step that needs your confirmation.'; }
    } else banner = 'This draft came from an Optizen AI proposal. Your edits here replace what the AI proposed; publishing is still your explicit action.';
  }
  const runs = w ? await listRuns(db, s.organizationId, w.id, 25) : null;
  const modules = s.config.objects.filter(o => s.config.modules.some(m => m.key === o.key && m.status === 'active') && o.key !== 'leads').map(o => ({ key: o.key, label: o.label, fields: o.fields.filter(f => !f.archived).map(f => ({ key: f.key, label: f.label })) }));
  const members = team.ok ? team.value.map(m => ({ id: m.userId, email: m.email, role: m.role, active: m.active })) : [];
  return <div className="stack">
    <StudioNav current="workflows" />
    <div className="top"><div><span className="eyebrow">Optizen Automations</span><h1>{w ? w.name : 'New automation'}</h1>
      <p className="muted">{w?.enabled ? 'Enabled.' : w?.publishedVersion ? 'Published but disabled.' : 'Not live yet.'} <a href="/automations">All automations</a> · {sp.view === 'list' ? <Link href={`/automations/${id}`}>Visual canvas</Link> : <Link href={`/automations/${id}?view=list`}>List view</Link>}</p></div></div>
    {sp.view === 'list' ? <AutomationEditor key={hash(JSON.stringify([w, members.length]))} id={w?.id ?? null} name={w?.name ?? ''} enabled={w?.enabled ?? false} publishedVersion={w?.publishedVersion ?? null} draft={w?.draft ?? null} published={w?.published ?? null} modules={modules} members={members} /> : meta && !meta.ok ? <Notice title="Automation could not be loaded">{meta.error}</Notice>
      : <WorkflowStudio id={w?.id ?? null} name={w?.name ?? proposedName} enabled={w?.enabled ?? false} publishedVersion={w?.publishedVersion ?? null} draft={w?.draft ?? null} published={w?.published ?? null} initial={initial}
          layout={meta && meta.ok ? meta.value.layout : null} token={w ? (meta && meta.ok ? meta.value.token : null) : null} modules={modules} members={members} proposalId={proposalId} banner={banner} />}
    {runs && <Card title="Execution history" description="Every run, with each step’s result. Failed runs can be retried.">{runs.ok ? <RunLog runs={runs.value} /> : <p className="err">{runs.error}</p>}</Card>}
  </div>;
}
