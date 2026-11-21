'use server';
import { revalidatePath } from 'next/cache';
import { getRecordsContext } from '../../../../../lib/records/context';
import { updateRecord } from '../../../../../lib/records/service';
import { findModule } from '../../../../../lib/records/validate';

/** Moves a record by changing ONE dropdown field. The field comes from the live configuration (never the request), the value must be one of its options (or empty for "none"),
 * and the normal record update runs: record_validate, permissions (own records / managers) and history all apply. */
export async function moveRecordAction(moduleKey: string, fieldKey: string, recordId: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await getRecordsContext(); if (!c) return { ok: false, error: 'Your session has ended. Please sign in again.' };
  const m = findModule(c.config, moduleKey); const f = m?.object.fields.find(x => x.key === fieldKey && x.kind === 'choice' && !x.archived);
  if (!m || !f) return { ok: false, error: 'This board is not available.' };
  if (value !== '' && !(f.options ?? []).includes(value)) return { ok: false, error: `"${value}" is not an option of ${f.label}.` };
  const r = await updateRecord(c, moduleKey, recordId, { [fieldKey]: value }); if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(`/work/${moduleKey}`, 'layout'); return { ok: true };
}
