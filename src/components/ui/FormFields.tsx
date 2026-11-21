import { sectionRuns } from '../../lib/builder/forms';
import type { FieldConfig } from '../../lib/workspace/types';
import type { RecordValue } from '../../lib/records/types';
import { FieldInput } from './FieldInput';

/** The ONE renderer of a custom-module form. Work Mode uses it for new/edit, and the Form Builder preview uses it too, so a preview is the real form. */
export function FormFields({ fields, values, disabled, idPrefix = '' }: { fields: FieldConfig[]; values?: Record<string, RecordValue | undefined>; disabled?: boolean; idPrefix?: string }) {
  const runs = sectionRuns(fields);
  return <div className="stack" style={{ gap: 20 }}>{runs.map((r, i) => <fieldset key={`${i}-${r.section}`} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    {r.section && <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{r.section}</legend>}
    <div className="form-grid">{r.fields.map(f => <FieldInput key={f.key} field={f} value={values?.[f.key]} disabled={disabled} idPrefix={idPrefix} />)}</div></fieldset>)}</div>;
}
