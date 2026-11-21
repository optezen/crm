import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { canBuild } from '../../../lib/workspace/resolve';
import { supabaseServer } from '../../../lib/supabase/server';
import { listRuns, listWorkflows } from '../../../lib/automation/service';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';
import { RunLog } from './RunLog';
import { StudioNav } from '../../../components/studio/StudioNav';

export default async function Automations() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Automations are limited to owners and admins">Ask an owner or admin to set up or review automations.</Notice>;
  const db = await supabaseServer();
  const [wf, runs] = await Promise.all([listWorkflows(db, s.organizationId), listRuns(db, s.organizationId, undefined, 20)]);
  return <div className="stack">
    <StudioNav current="workflows" />
    <div className="top"><div><span className="eyebrow">Optizen Automations</span><h1>Automations</h1><p className="muted">Do routine work automatically: assign new leads in rotation, create follow-up tasks, notify the team, update records. They run in the background, even when nobody is signed in.</p></div>
      <Link className="btn primary" href="/automations/new">Create automation</Link></div>
    <Notice title="Background worker required">Automations are processed by the Optizen automation worker (see docs/AUTOMATION.md). Until it is running in your deployment, enabled automations stay queued and nothing happens.</Notice>
    {!wf.ok && <Notice title="Automations could not be loaded">{wf.error}</Notice>}
    <Card title={`Your automations (${wf.ok ? wf.value.length : 0})`}>
      {wf.ok && wf.value.length === 0 && <p className="muted">None yet. Start with “Assign new leads in rotation and create a follow-up task”.</p>}
      {wf.ok && wf.value.map(w => <div className="task" key={w.id}><div className="row"><Link href={`/automations/${w.id}`}><strong>{w.name}</strong></Link>
        <span className={`badge ${w.enabled ? '' : 'done'}`}>{w.enabled ? 'Enabled' : w.publishedVersion ? 'Disabled' : 'Draft only'}</span>{w.publishedVersion && <span className="tag">v{w.publishedVersion}</span>}</div></div>)}
    </Card>
    <Card title="Recent runs" description="Execution history across all automations.">{runs.ok ? <RunLog runs={runs.value} showWorkflow /> : <p className="err">{runs.error}</p>}</Card>
  </div>;
}
