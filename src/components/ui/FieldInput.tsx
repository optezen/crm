import type { FieldConfig } from '../../lib/workspace/types';
import type { RecordValue } from '../../lib/records/types';

/** One input for one configured field. Used by the record form and by the Builder's form preview. Names are `f_<fieldKey>`. */
export function FieldInput({ field, value, disabled, idPrefix = '' }: { field: FieldConfig; value?: RecordValue; disabled?: boolean; idPrefix?: string }) {
  const id = `${idPrefix}f_${field.key}`, name = `f_${field.key}`;
  const label = field.kind === 'currency' ? `${field.label} (${field.currency ?? 'INR'})` : field.label;
  const required = field.required && field.kind !== 'yes_no';
  const common = { id, name, disabled, required };
  if (field.kind === 'yes_no') return <div className="field"><label className="row" htmlFor={id} style={{ gap: 8 }}><input id={id} name={name} type="checkbox" disabled={disabled} defaultChecked={value === true} /> {label}</label>{field.required && <span className="hint">Required field: tick it only when it applies.</span>}</div>;
  return <div className="field"><label htmlFor={id}>{label}{field.required && <span aria-hidden> *</span>}</label>
    {field.kind === 'choice'
      ? <select {...common} className="input" defaultValue={typeof value === 'string' ? value : ''}>
          <option value="">{required ? 'Choose…' : '—'}</option>
          {value !== undefined && typeof value === 'string' && !(field.options ?? []).includes(value) && <option value={value}>{value} (no longer listed)</option>}
          {(field.options ?? []).map(o => <option key={o}>{o}</option>)}</select>
      : <input {...common} className="input" defaultValue={value === undefined ? '' : String(value)}
          type={{ text: 'text', number: 'number', currency: 'number', date: 'date', phone: 'tel', email: 'email', yes_no: 'checkbox', choice: 'text' }[field.kind]}
          step={field.kind === 'currency' ? '0.01' : field.kind === 'number' ? 'any' : undefined} maxLength={field.kind === 'text' ? 2000 : undefined} autoComplete="off" />}
  </div>;
}
