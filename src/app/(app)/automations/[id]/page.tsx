import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { canBuild } from '../../../../lib/workspace/resolve';
import { supabaseServer } from '../../../../lib/supabase/server';
import { getWorkflow, listRuns, listTeam } from '../../../../lib/automation/service';
import { Card } from '../../../../components/ui/Card';
import { Notice } from '../../../../components/ui/Notice';
import { AutomationEditor } from '../AutomationEditor';
import { RunLog } from '../RunLog';

const hash = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return String(h); };

export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Automations are limited to owners and admins">Ask an owner or admin to set up or review automations.</Notice>;
  const db = await supabaseServer(); const isNew = id === 'new';
  if (!isNew && !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [wf, team] = await Promise.all([isNew ? null : getWorkflow(db, s.organizationId, id), listTeam(db, s.organizationId)]);
  if (wf && !wf.ok) return <Notice title="Automation could not be loaded">{wf.error}</Notice>;
  if (wf && wf.ok && !wf.value) notFound();
  const w = wf && wf.ok ? wf.value : null;
  const runs = w ? await listRuns(db, s.organizationId, w.id, 25) : null;
  const modules = s.config.objects.filter(o => s.config.modules.some(m => m.key === o.key && m.status === 'active') && o.key !== 'leads').map(o => ({ key: o.key, label: o.label, fields: o.fields.filter(f => !f.archived).map(f => ({ key: f.key, label: f.label })) }));
  const members = team.ok ? team.value.map(m => ({ id: m.userId, email: m.email, role: m.role, active: m.active })) : [];
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Automations</span><h1>{w ? w.name : 'New automation'}</h1>
      <p className="muted">{w?.enabled ? 'Enabled.' : w?.publishedVersion ? 'Published but disabled.' : 'Not live yet.'} <a href="/automations">All automations</a></p></div></div>
    <AutomationEditor key={hash(JSON.stringify([w, members.length]))} id={w?.id ?? null} name={w?.name ?? ''} enabled={w?.enabled ?? false} publishedVersion={w?.publishedVersion ?? null} draft={w?.draft ?? null} published={w?.published ?? null} modules={modules} members={members} />
    {runs && <Card title="Execution history" description="Every run, with each step’s result. Failed runs can be retried.">{runs.ok ? <RunLog runs={runs.value} /> : <p className="err">{runs.error}</p>}</Card>}
  </div>;
}
