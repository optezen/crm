import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { DataTable } from '../../../../components/ui/DataTable';

export default async function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  const mod = s.config.modules.find(m => m.key === module && m.status === 'active');
  if (!mod) notFound(); // planned or unknown modules have no page
  const obj = s.config.objects.find(o => o.key === module);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Work mode</span><h1>{mod.label}</h1></div></div>
    {obj
      ? <DataTable caption={`${obj.label} records`} columns={obj.fields.map(f => ({ header: f.label, cell: () => null }))} rows={[]} empty={`No ${obj.label.toLowerCase()} yet. Record entry arrives in a later release.`} />
      : <p className="muted">{mod.label} is part of your workspace layout. Its screens are not built yet.</p>}
  </div>;
}
