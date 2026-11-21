import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { supabaseServer } from '../../../../lib/supabase/server';
import { loadCatalog, loadDashboard, runQuery } from '../../../../lib/analytics/service';
import { Chart } from '../../../../components/charts';
import { DashboardEditor } from '../../../../components/DashboardEditor';
import { Card } from '../../../../components/ui/Card';
import { Notice } from '../../../../components/ui/Notice';
import { StudioNav } from '../../../../components/studio/StudioNav';
import type { Widget } from '../../../../lib/analytics/types';

export default async function DashboardPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string; proposal?: string }> }) {
  const { id } = await params; const sp = await searchParams; const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const db = await supabaseServer(); const canShare = ['owner', 'admin', 'manager'].includes(s.role); const catalog = await loadCatalog(db, s.organizationId);
  if (!catalog) return <Notice title="Dashboards unavailable">The data catalog could not be loaded. Please try again.</Notice>;
  if (id === 'new') {
    // An AI dashboard proposal opened for visual editing. It must be this user's, in this organization, a dashboard, and still pending; it is re-validated on save by dashboard_save.
    let initial = { name: '', description: '', visibility: 'personal' as 'personal' | 'organization', version: null as number | null, widgets: [] as Widget[] }; let proposalId: string | null = null; let banner: string | null = null;
    if (sp.proposal && /^[0-9a-f-]{36}$/i.test(sp.proposal)) {
      const pr = await db.rpc('ai_get_proposal', { p_org: s.organizationId, p_proposal: sp.proposal }); const p = pr.data as { kind: string; status: string; title: string; payload: { name?: string; description?: string | null; visibility?: string; widgets?: Widget[] } } | null;
      if (pr.error || !p || p.kind !== 'dashboard') banner = 'The AI proposal was not found, so this is a blank dashboard.';
      else if (p.status !== 'pending') banner = 'That AI proposal was already handled. Find the dashboard in your list.';
      else { proposalId = sp.proposal; initial = { name: String(p.payload.name ?? p.title), description: p.payload.description ?? '', visibility: p.payload.visibility === 'organization' && canShare ? 'organization' : 'personal', version: null, widgets: Array.isArray(p.payload.widgets) ? p.payload.widgets : [] };
        banner = 'Proposed by Optizen AI. Nothing is saved yet: rearrange, resize and edit the widgets, then save. Each widget is checked against the data you are allowed to see when you save.'; }
    }
    return <div className="stack"><StudioNav current="dashboards" /><div className="top"><div><span className="eyebrow">Optizen Dashboards</span><h1>New dashboard</h1></div></div><DashboardEditor id={null} initial={initial} catalog={catalog} canShare={canShare} proposalId={proposalId} banner={banner} stages={s.config.pipeline.stages} /></div>;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const d = await loadDashboard(db, s.organizationId, id); if (!d) notFound();
  const canEdit = d.owner_id === s.userId || s.role === 'owner' || s.role === 'admin';
  if (sp.edit === '1' && canEdit) return <div className="stack"><StudioNav current="dashboards" /><div className="top"><div><span className="eyebrow">Edit dashboard</span><h1>{d.name}</h1></div><Link className="btn" href={`/dashboards/${id}`}>Cancel</Link></div><DashboardEditor id={id} initial={{ name: d.name, description: d.description ?? '', visibility: d.visibility, version: d.version, widgets: d.widgets }} catalog={catalog} canShare={canShare} stages={s.config.pipeline.stages} /></div>;
  const results = await Promise.all(d.widgets.map(w => runQuery(db, s.organizationId, w.query)));
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">{d.visibility === 'organization' ? 'Shared dashboard' : 'Personal dashboard'}</span><h1>{d.name}</h1>{d.description && <p className="muted">{d.description}</p>}</div><div className="row">{canEdit && <Link className="btn" href={`/dashboards/${id}?edit=1`}>Edit</Link>}<Link className="btn" href="/dashboards">All dashboards</Link></div></div>
    {d.widgets.length === 0 && <Notice title="This dashboard is empty">{canEdit ? 'Edit it to add widgets.' : 'Its owner has not added widgets yet.'}</Notice>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 16 }}>
      {d.widgets.map((w, i) => { const r = results[i]!; return <div key={w.id ?? i} style={{ gridColumn: `span ${Math.min(12, w.w)}`, minWidth: 0 }}><Card title={w.title} description={r.ok ? r.result.definition : undefined}>
        {r.ok ? <><Chart type={w.type} result={r.result} funnelOrder={w.type === 'funnel' && w.query.source === 'leads' && w.query.group_by?.[0]?.field === 'stage' ? s.config.pipeline.stages : undefined} />{r.result.truncated && <p className="muted" style={{ fontSize: 12 }}>Showing the first {r.result.row_count} rows.</p>}</>
          : <p className={r.code === 'forbidden' ? 'muted' : 'err'} role={r.code === 'forbidden' ? 'status' : 'alert'}>{r.code === 'forbidden' ? `You do not have access to this data. ${r.error}` : r.error}</p>}</Card></div>; })}
    </div></div>;
}
