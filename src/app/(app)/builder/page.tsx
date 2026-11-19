import { getWorkspaceState } from '../../../lib/workspace/service';
import { canBuild } from '../../../lib/workspace/resolve';
import { Card } from '../../../components/ui/Card';
import { DataTable } from '../../../components/ui/DataTable';
import { Notice } from '../../../components/ui/Notice';

export default async function Builder() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (!canBuild(s.role)) return <Notice title="Builder is limited to owners and admins">Ask an owner or admin to change the workspace.</Notice>;
  const c = s.config;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Builder mode</span><h1>Workspace configuration</h1><p className="muted">The published definition your workspace runs on.</p></div></div>
    <Notice title="Read-only for now">Editing, AI drafting and publishing new versions are not built yet. This page shows the current published configuration.</Notice>
    <DataTable caption="Modules" rows={c.modules} empty="No modules." columns={[{ header: 'Module', cell: m => m.label }, { header: 'Status', cell: m => m.status === 'active' ? 'Active' : 'Planned' }]} />
    <DataTable caption="Record types" rows={c.objects} empty="No record types." columns={[{ header: 'Type', cell: o => o.label }, { header: 'Fields', cell: o => <span className="chips">{o.fields.map(f => <span className="chip" key={f.key}>{f.label}</span>)}</span> }]} />
    <Card title="Pipeline stages"><ol style={{ margin: 0, paddingLeft: 20 }}>{c.pipeline.stages.map(x => <li key={x}>{x}</li>)}</ol></Card>
  </div>;
}
