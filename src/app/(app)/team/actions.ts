'use server';
import { revalidatePath } from 'next/cache';
import { getCrmContext } from '../../../lib/crm/context';
import * as crm from '../../../lib/crm/service';
import type { FormState } from '../../../components/ui/ActionForm';

async function run(ok: string, fn: (c: NonNullable<Awaited<ReturnType<typeof getCrmContext>>>) => ReturnType<typeof crm.addMember>): Promise<FormState> {
  const c = await getCrmContext(); if (!c) return { error: 'Your session has ended. Please sign in again.' };
  const r = await fn(c); if (!r.ok) return { error: r.error };
  revalidatePath('/team'); return { ok };
}
export const addMemberAction = async (_: FormState, f: FormData) => run('Team member added.', c => crm.addMember(c, f.get('email'), f.get('role')));
export const setRoleAction = async (_: FormState, f: FormData) => run('Role updated.', c => crm.setMemberRole(c, String(f.get('userId') ?? ''), f.get('role')));
