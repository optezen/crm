// WhatsApp consent for one contact. Reads go through row-level security; the only write is the consent_set database function, which re-checks membership, whether the
// caller may see the contact, and that an opt-in states how the customer agreed. The source is always "staff" here; imports and customer replies are system-only.
import { isUuid } from './validate.ts';
import type { CrmContext, Result } from './types.ts';

export type ConsentRecord = { status: 'opted_in' | 'opted_out'; source: string; note: string | null; updatedAt: string };
export type ConsentLogEntry = { status: 'opted_in' | 'opted_out'; source: string; note: string | null; createdAt: string };
export type ConsentView = { current: ConsentRecord | null; history: ConsentLogEntry[]; whatsappReady: boolean };

const SAFE = new Set(['22023', 'P0002']); // messages raised deliberately by our SQL
export async function getConsent(ctx: CrmContext, contactId: string): Promise<Result<ConsentView>> {
  if (!isUuid(contactId)) return { ok: false, error: 'Not found.' };
  const [c, l, w] = await Promise.all([
    ctx.db.from('messaging_consent').select('status, source, note, updated_at').eq('organization_id', ctx.organizationId).eq('contact_id', contactId).eq('channel', 'whatsapp').maybeSingle(),
    ctx.db.from('messaging_consent_log').select('status, source, note, created_at').eq('organization_id', ctx.organizationId).eq('contact_id', contactId).eq('channel', 'whatsapp').order('created_at', { ascending: false }).limit(5),
    ctx.db.from('integration_connections').select('id').eq('organization_id', ctx.organizationId).eq('provider', 'whatsapp').eq('status', 'connected').limit(1),
  ]);
  if (c.error || l.error) return { ok: false, error: 'Consent could not be loaded.' };
  return { ok: true, value: { current: c.data ? { status: c.data.status, source: c.data.source, note: c.data.note, updatedAt: c.data.updated_at } : null,
    history: (l.data ?? []).map(r => ({ status: r.status, source: r.source, note: r.note, createdAt: r.created_at })), whatsappReady: !w.error && (w.data?.length ?? 0) > 0 } };
}
export async function setConsent(ctx: CrmContext, contactId: string, status: unknown, note: unknown, confirmed: boolean): Promise<Result<null>> {
  if (!isUuid(contactId)) return { ok: false, error: 'Not found.' };
  if (status !== 'opted_in' && status !== 'opted_out') return { ok: false, error: 'Choose opted in or opted out.' };
  const n = typeof note === 'string' ? note.trim() : ''; if (n.length > 300) return { ok: false, error: 'Keep the note under 300 characters.' };
  if (status === 'opted_in' && !confirmed) return { ok: false, error: 'Confirm that the customer agreed to receive WhatsApp messages.' };
  if (status === 'opted_in' && n.length < 3) return { ok: false, error: 'Say how the customer agreed (for example "Asked on the phone on 22 Nov").' };
  const r = await ctx.db.rpc('consent_set', { p_org: ctx.organizationId, p_contact: contactId, p_status: status, p_source: 'staff', p_note: n || null });
  if (r.error) return { ok: false, error: SAFE.has(r.error.code ?? '') ? r.error.message : r.error.code === '42501' ? 'You do not have permission to do that.' : 'Something went wrong. Please try again.' };
  return { ok: true, value: null };
}
