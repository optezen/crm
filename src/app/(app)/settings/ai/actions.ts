'use server';
import { revalidatePath } from 'next/cache';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { supabaseServer } from '../../../../lib/supabase/server';

export type SettingsResult = { ok: true; message: string } | { ok: false; error: string };
const num = (v: FormDataEntryValue | null) => { const s = typeof v === 'string' ? v.trim() : ''; if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : NaN; };
/** Owner-only (re-checked by the database). Empty optional fields mean "no limit" / "no price". */
export async function saveAiSettingsAction(_: SettingsResult | null, f: FormData): Promise<SettingsResult> {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return { ok: false, error: 'Your session has ended. Please sign in again.' };
  if (s.role !== 'owner') return { ok: false, error: 'Only the owner can change AI settings.' };
  const daily = num(f.get('daily')), hourly = num(f.get('hourly')), monthly = num(f.get('monthly')), perUser = num(f.get('perUser')), pin = num(f.get('priceIn')), pout = num(f.get('priceOut'));
  if ([daily, hourly, monthly, perUser, pin, pout].some(x => Number.isNaN(x)) || daily === null || hourly === null) return { ok: false, error: 'Enter valid numbers. Daily and hourly limits are required.' };
  const cur = String(f.get('currency') ?? 'USD').trim().toUpperCase();
  const { error } = await (await supabaseServer()).rpc('ai_set_limits_v2', { p_org: s.organizationId, p_enabled: f.get('enabled') === 'on', p_daily: daily, p_hourly: hourly, p_monthly: monthly, p_per_user: perUser, p_in_price: pin, p_out_price: pout, p_currency: cur });
  if (error) return { ok: false, error: ['22023', '42501'].includes(error.code ?? '') ? error.message : 'Something went wrong. Please try again.' };
  revalidatePath('/settings/ai'); return { ok: true, message: 'Saved.' };
}
