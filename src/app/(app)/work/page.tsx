import { getWorkspaceState } from '../../../lib/workspace/service';
import { Card } from '../../../components/ui/Card';
import { Notice } from '../../../components/ui/Notice';

export default async function Work() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Work mode</span><h1>{s.config.businessName}</h1><p className="muted">Your day-to-day workspace.</p></div></div>
    <Notice title="No live data yet">Record storage, AI assistance and reporting are not connected. Nothing here is sample data.</Notice>
    <div className="grid">
      <Card title="Pipeline" description="Stages from your template.">
        <ol style={{ margin: 0, paddingLeft: 20 }}>{s.config.pipeline.stages.map(x => <li key={x}>{x}</li>)}</ol>
      </Card>
      <Card title="Records" description="Types of information you track.">
        <ul style={{ margin: 0, paddingLeft: 20 }}>{s.config.objects.map(o => <li key={o.key}>{o.label}</li>)}</ul>
      </Card>
    </div>
  </div>;
}
