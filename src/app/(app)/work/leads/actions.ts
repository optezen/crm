'use server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCrmContext } from '../../../../lib/crm/context';
import * as crm from '../../../../lib/crm/service';
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
