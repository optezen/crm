import Link from 'next/link';
import { getCrmContext } from '../../../../../lib/crm/context';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { listMembers, stageCounts } from '../../../../../lib/crm/service';
import { KanbanBoard, type BoardLead } from '../../../../../components/studio/KanbanBoard';
import { Notice } from '../../../../../components/ui/Notice';

export default async function LeadBoard() {
  const c = await getCrmContext(); const s = await getWorkspaceState(); if (!c || s.status !== 'ready') return null;
  // Only non-personal columns are read: the board never needs phone or email.
  const [rows, counts, members] = await Promise.all([
    c.db.from('crm_lead_list').select('id, stage, full_name, source, summary, assigned_to, open_tasks').eq('organization_id', c.organizationId).order('updated_at', { ascending: false }).limit(300),
    stageCounts(c), listMembers(c)]);
  if (rows.error) return <Notice title="The board could not load">Something went wrong. Please try again.</Notice>;
  const who = new Map((members.ok ? members.value : []).map(m => [m.userId, m.email.split('@')[0]!]));
  const leads: BoardLead[] = rows.data.map(r => ({ id: r.id, stage: r.stage, fullName: r.full_name, source: r.source, summary: r.summary, assignee: r.assigned_to ? who.get(r.assigned_to) ?? 'a colleague' : null, openTasks: r.open_tasks }));
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Lead board</h1><p className="muted">Drag a card to another stage, or use its Move menu. <Link href="/work/leads">Back to the list</Link></p></div></div>
    <KanbanBoard stages={s.config.pipeline.stages} settings={s.config.pipeline.stageSettings ?? {}} leads={leads} totals={counts.ok ? counts.value : {}} />
  </div>;
}
