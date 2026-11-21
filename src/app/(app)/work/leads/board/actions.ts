'use server';
import { revalidatePath } from 'next/cache';
import { getCrmContext } from '../../../../../lib/crm/context';
import { setStage } from '../../../../../lib/crm/service';

/** Moves a lead to a stage. Everything is decided by the database (crm_set_stage): the stage must exist, the caller may edit the lead, and the stage's transition requirements must hold. */
export async function moveLeadAction(leadId: string, stage: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const c = await getCrmContext(); if (!c) return { ok: false, error: 'Your session has ended. Please sign in again.' };
  const r = await setStage(c, leadId, stage); if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/work', 'layout'); return { ok: true };
}
