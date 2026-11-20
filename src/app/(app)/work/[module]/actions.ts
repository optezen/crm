'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getRecordsContext } from '../../../../lib/records/context';
import { createRecord, updateRecord } from '../../../../lib/records/service';
import { findModule, parseRecordForm } from '../../../../lib/records/validate';
import type { FormState } from '../../../../components/ui/ActionForm';

// The organization and the record type come from the signed-in user's membership and the live configuration, never from the form.
// The module key in the form is only a lookup key into that configuration; the database re-checks everything.
async function parse(f: FormData) {
  const c = await getRecordsContext(); if (!c) return { error: 'Your session has ended. Please sign in again.' } as const;
  const key = String(f.get('module') ?? '');
  const m = findModule(c.config, key); if (!m) return { error: 'This module is not available.' } as const;
  const input = parseRecordForm(m.object, n => f.get(n)); if (!input.ok) return { error: input.error } as const;
  return { c, key, input: input.value } as const;
}

export async function createRecordAction(_: FormState, f: FormData): Promise<FormState> {
  const p = await parse(f); if ('error' in p) return { error: p.error };
  const r = await createRecord(p.c, p.key, p.input); if (!r.ok) return { error: r.error };
  revalidatePath(`/work/${p.key}`);
  redirect(`/work/${p.key}/${r.value.id}`);
}
export async function updateRecordAction(_: FormState, f: FormData): Promise<FormState> {
  const p = await parse(f); if ('error' in p) return { error: p.error };
  const r = await updateRecord(p.c, p.key, String(f.get('recordId') ?? ''), p.input); if (!r.ok) return { error: r.error };
  revalidatePath(`/work/${p.key}`, 'layout');
  return { ok: 'Saved.' };
}
