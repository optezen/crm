import { LEAD_SOURCES, SOURCE_LABEL, type LeadRow, type MemberRow } from '../../../../lib/crm/types';
import { Field } from '../../../../components/ui/Field';

export function LeadFields({ lead, stages, members, userId, manager }: { lead?: LeadRow; stages?: readonly string[]; members?: MemberRow[]; userId?: string; manager?: boolean }) {
  return <div className="form-grid">
    <Field id="fullName" name="fullName" label="Name" required maxLength={120} defaultValue={lead?.fullName} autoComplete="off" />
    <Field id="phone" name="phone" label="Phone" inputMode="tel" defaultValue={lead?.phone ?? ''} hint="Digits, optional leading +" />
    <Field id="email" name="email" label="Email" type="email" defaultValue={lead?.email ?? ''} />
    <div className="field"><label htmlFor="source">Source</label>
      <select id="source" name="source" className="input" defaultValue={lead?.source ?? 'phone'}>{LEAD_SOURCES.map(s => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}</select></div>
    {stages && <div className="field"><label htmlFor="stage">Stage</label>
      <select id="stage" name="stage" className="input" defaultValue={stages[0]}>{stages.map(s => <option key={s}>{s}</option>)}</select></div>}
    {members && <div className="field"><label htmlFor="assignedTo">Assigned to</label>
      <select id="assignedTo" name="assignedTo" className="input" defaultValue="">
        <option value="">Unassigned</option>
        {members.filter(m => manager || m.userId === userId).map(m => <option key={m.userId} value={m.userId}>{m.userId === userId ? `Me (${m.email})` : m.email}</option>)}
      </select></div>}
    <div className="field wide"><label htmlFor="summary">What do they need?</label>
      <textarea id="summary" name="summary" className="input" maxLength={2000} defaultValue={lead?.summary ?? ''} /></div>
  </div>;
}
