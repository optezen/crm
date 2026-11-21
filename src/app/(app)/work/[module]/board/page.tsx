import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRecordsContext } from '../../../../../lib/records/context';
import { findModule, activeFields } from '../../../../../lib/records/validate';
import { KanbanBoard, type BoardCard } from '../../../../../components/studio/KanbanBoard';
import { Notice } from '../../../../../components/ui/Notice';
import { moveRecordAction } from './actions';

/** A board for any custom module that has a dropdown field: one column per option (plus "No value"). Reads only what the user may see (records_view). */
export default async function ModuleBoard({ params, searchParams }: { params: Promise<{ module: string }>; searchParams: Promise<{ field?: string }> }) {
  const { module } = await params; const sp = await searchParams;
  const c = await getRecordsContext(); if (!c) return null; const m = findModule(c.config, module); if (!m) notFound();
  const choices = activeFields(m.object).filter(f => f.kind === 'choice');
  if (!choices.length) return <Notice title="No board for this module">A board needs a dropdown field to group by. An owner or admin can add one in the Form Builder.</Notice>;
  const field = choices.find(f => f.key === sp.field) ?? choices[0]!;
  const { data, error } = await c.db.from('records_view').select('id, data').eq('organization_id', c.organizationId).eq('object_key', m.object.key).order('updated_at', { ascending: false }).limit(300);
  if (error) return <Notice title="The board could not load">Something went wrong. Please try again.</Notice>;
  const NONE = 'No value'; const first = activeFields(m.object).find(f => f.kind === 'text') ?? activeFields(m.object)[0];
  const cards: BoardCard[] = (data ?? []).map(r => { const d = r.data as Record<string, unknown>; return { id: r.id, stage: String(d?.[field.key] ?? '') || NONE, title: String((first && d?.[first.key]) ?? 'Record') || 'Record', meta: '', summary: null, href: `/work/${module}/${r.id}` }; });
  const stages = [...(field.options ?? []), NONE];
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>{m.module.label} board</h1><p className="muted">Grouped by <strong>{field.label}</strong>. Drag a card or use its Move menu. <Link href={`/work/${module}`}>Back to the list</Link></p></div></div>
    {choices.length > 1 && <form method="get" className="row"><label htmlFor="field">Group by</label><select id="field" name="field" className="input" defaultValue={field.key}>{choices.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}</select><button className="btn">Apply</button></form>}
    <KanbanBoard stages={stages} cards={cards} noun="record" move={(id, st) => moveRecordAction(module, field.key, id, st === NONE ? '' : st)} />
  </div>;
}
