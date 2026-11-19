import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { getCrmContext } from '../../../lib/crm/context';
import { myOpenTasks, stageCounts } from '../../../lib/crm/service';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export default async function Work() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const leads = s.config.modules.some(m => m.key === 'leads' && m.status === 'active');
  const ctx = leads ? await getCrmContext() : null;
  const [counts, tasks] = ctx ? await Promise.all([stageCounts(ctx), myOpenTasks(ctx)]) : [null, null];
  const today = new Date().toISOString().slice(0, 10);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>{s.config.businessName}</h1><p className="muted">Your day-to-day workspace.</p></div></div>
    {(counts && !counts.ok) || (tasks && !tasks.ok) ? <Notice title="Some data could not be loaded">Please refresh the page.</Notice> : null}
    <div className="grid">
      <Card title="Pipeline" description={counts?.ok ? 'Leads you can see, by stage.' : 'Stages from your template.'}>
        <ol style={{ margin: 0, paddingLeft: 20 }}>{s.config.pipeline.stages.map(x => <li key={x}>{x}{counts?.ok && <> — <Link href={`/work/leads?stage=${encodeURIComponent(x)}`}>{counts.value[x] ?? 0}</Link></>}</li>)}</ol>
      </Card>
      {tasks?.ok
        ? <Card title="My follow-ups" description="Open tasks assigned to you, soonest first.">
            {tasks.value.length === 0 ? <p className="muted">Nothing due. You are all caught up.</p>
              : <ul style={{ margin: 0, paddingLeft: 20 }}>{tasks.value.map(t => <li key={t.id}>{t.leadName ? <Link href={`/work/leads/${t.leadId}`}>{t.title}</Link> : t.title}{t.leadName && ` · ${t.leadName}`} <span className={t.dueDate < today ? 'badge late' : 'badge'}>{fmtDate(t.dueDate)}</span></li>)}</ul>}
          </Card>
        : <Card title="Records" description="Types of information you track."><ul style={{ margin: 0, paddingLeft: 20 }}>{s.config.objects.map(o => <li key={o.key}>{o.label}</li>)}</ul></Card>}
    </div>
    <Notice title="AI assistance and reporting are not connected yet">Everything shown above is live data from your workspace; nothing is sample data.</Notice>
  </div>;
}
