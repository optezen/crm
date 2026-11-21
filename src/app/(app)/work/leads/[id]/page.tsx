import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCrmContext, leadsModuleActive } from '../../../../../lib/crm/context';
import { getLead, isManager, listMembers } from '../../../../../lib/crm/service';
import { SOURCE_LABEL, type ActivityRow, type MemberRow } from '../../../../../lib/crm/types';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { LocalTime } from '../../../../../components/ui/LocalTime';
import { Card } from '../../../../../components/ui/Card';
import { Field } from '../../../../../components/ui/Field';
import { LeadFields } from '../LeadFields';
import { ConsentCard } from '../../../../../components/crm/ConsentCard';
import { getConsent } from '../../../../../lib/crm/consent';
import { addNoteAction, assignAction, completeTaskAction, createTaskAction, setConsentAction, setStageAction, updateLeadAction } from '../actions';

const fmtDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });

export default async function LeadDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCrmContext(); if (!ctx || !(await leadsModuleActive())) notFound();
  const [res, mem] = await Promise.all([getLead(ctx, id), listMembers(ctx)]);
  if (!res.ok) notFound();
  const { lead, activities, tasks } = res.value;
  const members: MemberRow[] = mem.ok ? mem.value : [];
  const manager = isManager(ctx.role);
  const name = (uid: string | null) => uid === null ? 'Unassigned' : uid === ctx.userId ? 'you' : members.find(m => m.userId === uid)?.email ?? 'a former member';
  const today = new Date().toISOString().slice(0, 10);
  const describe = (a: ActivityRow) => {
    const m = a.meta as Record<string, string | string[] | null>;
    switch (a.kind) {
      case 'created': return `Lead created (${m.stage}, ${SOURCE_LABEL[m.source as keyof typeof SOURCE_LABEL] ?? m.source})`;
      case 'updated': return `Details updated: ${(m.fields as string[]).join(', ')}`;
      case 'stage_changed': return `Stage changed: ${m.from} → ${m.to}`;
      case 'assigned': return m.to ? `Assigned to ${name(m.to as string)}` : 'Unassigned';
      case 'task_created': return `Follow-up added: ${a.body} (due ${fmtDate(m.due_date as string)}, owner ${name(m.owner_id as string)})`;
      case 'task_completed': return `Follow-up completed: ${m.title}. Outcome: ${a.body}`;
      default: return a.body ?? '';
    }
  };
  const consent = lead.contactHidden ? null : await getConsent(ctx, lead.contactId); // people who cannot see the contact cannot manage consent either
  const canClaim = !manager && lead.assignedTo === null;
  return <div className="stack">
    <div className="top"><div><Link className="muted" href="/work/leads">← All leads</Link><h1>{lead.fullName}</h1>
      <p className="muted"><span className="badge">{lead.stage}</span> · {SOURCE_LABEL[lead.source]} · assigned to {name(lead.assignedTo)}</p></div></div>

    <div className="grid">
      <Card title="Contact">
        <dl className="kv"><dt>Phone</dt><dd>{lead.contactHidden ? <span className="muted">Hidden by your role</span> : lead.phone ?? '—'}</dd><dt>Email</dt><dd>{lead.contactHidden ? <span className="muted">Hidden by your role</span> : lead.email ?? '—'}</dd><dt>Needs</dt><dd>{lead.summary ?? '—'}</dd></dl>
      </Card>
      <Card title="Pipeline and ownership">
        <div className="stack">
          <ActionForm action={setStageAction} submit="Update stage" className="inline">
            <input type="hidden" name="leadId" value={lead.id} />
            <div className="field"><label htmlFor="stage">Stage</label><select id="stage" name="stage" className="input" defaultValue={lead.stage}>{[...new Set([lead.stage, ...ctx.stages])].map(s => <option key={s}>{s}</option>)}</select></div>
          </ActionForm>
          {manager || canClaim
            ? <ActionForm action={assignAction} submit={manager ? 'Update assignment' : 'Assign to me'} className="inline">
                <input type="hidden" name="leadId" value={lead.id} />
                {manager
                  ? <div className="field"><label htmlFor="assigneeId">Assigned to</label><select id="assigneeId" name="assigneeId" className="input" defaultValue={lead.assignedTo ?? ''}><option value="">Unassigned</option>{members.map(m => <option key={m.userId} value={m.userId}>{m.userId === ctx.userId ? `Me (${m.email})` : m.email}</option>)}</select></div>
                  : <input type="hidden" name="assigneeId" value={ctx.userId} />}
              </ActionForm>
            : <p className="muted">Only managers can reassign this lead.</p>}
        </div>
      </Card>
    </div>

    {consent?.ok && <ConsentCard view={consent.value} contactId={lead.contactId} hasPhone={!!lead.phone} action={setConsentAction} />}

    <Card title="Edit details">
      <details><summary>Edit contact and lead details</summary>
        <ActionForm action={updateLeadAction} submit="Save changes">
          <input type="hidden" name="leadId" value={lead.id} />
          <LeadFields lead={lead} />
        </ActionForm></details>
    </Card>

    <Card title="Follow-up tasks" description="Each task has an owner and a due date; completing one records what happened.">
      {tasks.length === 0 && <p className="muted">No follow-ups yet.</p>}
      {tasks.map(t => <div className="task" key={t.id}>
        <div className="row"><strong>{t.title}</strong>
          {t.status === 'done' ? <span className="badge done">Done</span> : <span className={t.dueDate < today ? 'badge late' : 'badge'}>{t.dueDate < today ? 'Overdue · ' : 'Due '}{fmtDate(t.dueDate)}</span>}
          <span className="muted">Owner: {name(t.ownerId)}</span></div>
        {t.status === 'done'
          ? <p className="muted">Outcome: {t.outcome}{t.completedAt && <> · <LocalTime iso={t.completedAt} /></>}</p>
          : (manager || t.ownerId === ctx.userId) && <ActionForm action={completeTaskAction} submit="Complete" className="inline">
              <input type="hidden" name="taskId" value={t.id} />
              <Field id={`outcome-${t.id}`} name="outcome" label="Outcome" required maxLength={1000} placeholder="What happened?" />
            </ActionForm>}
      </div>)}
      <details style={{ marginTop: 16 }}><summary>Add a follow-up</summary>
        <ActionForm action={createTaskAction} submit="Add follow-up" resetOnSuccess>
          <input type="hidden" name="leadId" value={lead.id} />
          <div className="form-grid">
            <Field id="title" name="title" label="Task" required maxLength={200} />
            <Field id="dueDate" name="dueDate" label="Due date" type="date" required defaultValue={today} />
            <div className="field"><label htmlFor="ownerId">Owner</label><select id="ownerId" name="ownerId" className="input" defaultValue={ctx.userId}>{members.filter(m => manager || m.userId === ctx.userId).map(m => <option key={m.userId} value={m.userId}>{m.userId === ctx.userId ? `Me (${m.email})` : m.email}</option>)}</select></div>
          </div>
        </ActionForm></details>
    </Card>

    <Card title="Notes and activity">
      <div className="stack">
        <ActionForm action={addNoteAction} submit="Add note" resetOnSuccess>
          <input type="hidden" name="leadId" value={lead.id} />
          <div className="field"><label htmlFor="note">Note</label><textarea id="note" name="note" className="input" required maxLength={4000} /></div>
        </ActionForm>
        <ol className="timeline">{activities.map(a => <li key={a.id}>
          <small>{a.actorId ? name(a.actorId) === 'you' ? 'You' : name(a.actorId) : 'System'} · <LocalTime iso={a.createdAt} /></small>
          <p>{describe(a)}</p>
        </li>)}</ol>
      </div>
    </Card>
  </div>;
}
