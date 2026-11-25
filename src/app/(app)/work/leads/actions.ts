'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCrmContext } from '../../../../lib/crm/context';
import * as crm from '../../../../lib/crm/service';
import { leadsFromCsv } from '../../../../lib/crm/csv';
import { setConsent } from '../../../../lib/crm/consent';
import type { Result } from '../../../../lib/crm/types';
import type { FormState } from '../../../../components/ui/ActionForm';

const body = (f: FormData) => Object.fromEntries(f.entries());
const str = (f: FormData, k: string) => (typeof f.get(k) === 'string' ? (f.get(k) as string) : '');
// The organization is never read from the form: getCrmContext() derives it from the signed-in user's membership.
async function run(f: FormData, ok: string, fn: (c: NonNullable<Awaited<ReturnType<typeof getCrmContext>>>) => Promise<Result<unknown>>): Promise<FormState> {
  const c = await getCrmContext(); if (!c) return { error: 'Your session has ended. Please sign in again.' };
  const r = await fn(c); if (!r.ok) return { error: r.error };
  revalidatePath('/work', 'layout');
  return { ok };
}

export async function createLeadAction(_: FormState, f: FormData): Promise<FormState> {
  const c = await getCrmContext(); if (!c) return { error: 'Your session has ended. Please sign in again.' };
  const r = await crm.createLead(c, body(f)); if (!r.ok) return { error: r.error };
  revalidatePath('/work', 'layout');
  redirect(`/work/leads/${r.value.id}`);
}
export const updateLeadAction = async (_: FormState, f: FormData) => run(f, 'Saved.', c => crm.updateLead(c, str(f, 'leadId'), body(f)));
export const setStageAction = async (_: FormState, f: FormData) => run(f, 'Stage updated.', c => crm.setStage(c, str(f, 'leadId'), f.get('stage')));
export const assignAction = async (_: FormState, f: FormData) => run(f, 'Assignment updated.', c => crm.assignLead(c, str(f, 'leadId'), str(f, 'assigneeId') || null));
export const addNoteAction = async (_: FormState, f: FormData) => run(f, 'Note added.', c => crm.addNote(c, str(f, 'leadId'), f.get('note')));
export const createTaskAction = async (_: FormState, f: FormData) => run(f, 'Follow-up added.', c => crm.createTask(c, body(f)));
export const completeTaskAction = async (_: FormState, f: FormData) => run(f, 'Task completed.', c => crm.completeTask(c, str(f, 'taskId'), f.get('outcome')));
export const setConsentAction = async (_: FormState, f: FormData) => run(f, 'Consent saved.', c => setConsent(c, str(f, 'contactId'), f.get('status'), f.get('note'), f.get('confirm') === 'on'));

/** Bulk import: every row goes through the same createLead path as the form (validation, dedupe, RLS, activity log, automation events). 10 at a time. */
export async function importLeadsAction(_: FormState, f: FormData): Promise<FormState> {
  const c = await getCrmContext(); if (!c) return { error: 'Your session has ended. Please sign in again.' };
  const file = f.get('file'); if (!(file instanceof File) || file.size === 0) return { error: 'Choose a CSV file.' };
  if (file.size > 2_000_000) return { error: 'That file is too large (2 MB maximum).' };
  const p = leadsFromCsv(await file.text()); if (!p.ok) return { error: p.error };
  let created = 0; const failed: string[] = [];
  for (let i = 0; i < p.rows.length; i += 10) await Promise.all(p.rows.slice(i, i + 10).map(async r => {
    const x = await crm.createLead(c, r.data); if (x.ok) created++; else failed.push(`row ${r.line}: ${x.error}`);
  }));
  revalidatePath('/work', 'layout');
  if (created === 0) return { error: `No leads were imported. ${failed.slice(0, 5).join(' · ')}` };
  return { ok: `Imported ${created} lead${created === 1 ? '' : 's'}.${failed.length ? ` ${failed.length} skipped (${failed.sort().slice(0, 5).join(' · ')}${failed.length > 5 ? ' …' : ''}).` : ''}` };
}
