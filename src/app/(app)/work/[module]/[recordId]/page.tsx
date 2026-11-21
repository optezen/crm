import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getRecordsContext } from '../../../../../lib/records/context';
import { canEditRecord, getRecord } from '../../../../../lib/records/service';
import { activeFields, findModule, formatValue } from '../../../../../lib/records/validate';
import { ActionForm } from '../../../../../components/ui/ActionForm';
import { Card } from '../../../../../components/ui/Card';
import { FormFields } from '../../../../../components/ui/FormFields';
import { LocalTime } from '../../../../../components/ui/LocalTime';
import { updateRecordAction } from '../actions';

export default async function RecordDetail({ params }: { params: Promise<{ module: string; recordId: string }> }) {
  const { module, recordId } = await params;
  const ctx = await getRecordsContext(); if (!ctx) return null;
  const m = findModule(ctx.config, module); if (!m) notFound();
  const res = await getRecord(ctx, module, recordId); if (!res.ok) notFound();
  const rec = res.value, fields = activeFields(m.object), hidden = m.object.fields.filter(f => f.archived && f.key in rec.data);
  const editable = canEditRecord(ctx, rec);
  return <div className="stack">
    <div className="top"><div><Link className="muted" href={`/work/${module}`}>← {m.module.label}</Link><h1>{formatValue(fields[0] ?? m.object.fields[0]!, rec.data[(fields[0] ?? m.object.fields[0]!).key]) || m.module.label}</h1>
      <p className="muted">Added <LocalTime iso={rec.createdAt} /> · last updated <LocalTime iso={rec.updatedAt} /></p></div></div>
    <Card title="Details" description={editable ? undefined : 'You can view this record but only its creator, managers, admins and owners can edit it.'}>
      {editable
        ? <ActionForm action={updateRecordAction} submit="Save changes"><input type="hidden" name="module" value={module} /><input type="hidden" name="recordId" value={rec.id} />
            <FormFields fields={fields} values={rec.data} /></ActionForm>
        : <dl className="kv">{fields.map(f => <><dt key={`t${f.key}`}>{f.label}</dt><dd key={`d${f.key}`}>{formatValue(f, rec.data[f.key]) || '—'}</dd></>)}</dl>}
    </Card>
    {hidden.length > 0 && <Card title="Hidden fields" description="These fields were hidden in Builder. Their values are kept and can be restored by showing the field again.">
      <dl className="kv">{hidden.map(f => <><dt key={`t${f.key}`}>{f.label}</dt><dd key={`d${f.key}`}>{formatValue(f, rec.data[f.key])}</dd></>)}</dl></Card>}
  </div>;
}
