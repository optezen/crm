import Link from 'next/link';
import { getWorkspaceState } from '../../../lib/workspace/service';
import { supabaseServer } from '../../../lib/supabase/server';
import { listDashboards } from '../../../lib/analytics/service';
import { Card } from '../../../components/ui/Card';

export default async function Dashboards() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const all = await listDashboards(await supabaseServer(), s.organizationId); const mine = all.filter(d => d.visibility === 'personal'), shared = all.filter(d => d.visibility === 'organization');
  const list = (l: typeof all) => l.length === 0 ? <p className="muted">None yet.</p> : l.map(d => <div className="task" key={d.id}><div className="row"><Link href={`/dashboards/${d.id}`}><strong>{d.name}</strong></Link>{d.owner_id === s.userId && <span className="tag">yours</span>}</div>{d.description && <span className="muted">{d.description}</span>}</div>);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Dashboards</h1><p className="muted">Build your own views from real workspace data. Every number is computed from your records when the page opens, under your permissions.</p></div><Link className="btn primary" href="/dashboards/new">New dashboard</Link></div>
    <Card title="Shared with the organization">{list(shared)}</Card><Card title="Only you">{list(mine)}</Card>
    <p className="muted">Prefer a ready-made view? <Link href="/reports">Open the report library</Link>, or ask Optizen AI to prepare a dashboard for you.</p>
  </div>;
}
