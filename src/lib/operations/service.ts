// Read helpers for the operations screens. Every read runs as the signed-in user, so row level security decides what comes back (financial tables: managers+ only).
import type { SupabaseClient } from '@supabase/supabase-js';

type Db = SupabaseClient;
const must = <T>(r: { data: T | null; error: { message: string } | null }, fallback: T): T => (r.error ? fallback : r.data ?? fallback);

export type Member = { id: string; email: string; role: string };
export async function members(db: Db, org: string): Promise<Member[]> {
  const { data } = await db.rpc('team_list_members', { p_org: org });
  return ((data as { user_id: string; email: string; role: string }[] | null) ?? []).map(m => ({ id: m.user_id, email: m.email, role: m.role }));
}

export const appointmentTypes = async (db: Db, org: string) => must(await db.from('appointment_types').select('id, name, duration_minutes, active').eq('organization_id', org).order('name'), []) as { id: string; name: string; duration_minutes: number; active: boolean }[];
export const staffHours = async (db: Db, org: string) => must(await db.from('staff_hours').select('user_id, weekday, start_minute, end_minute').eq('organization_id', org).order('weekday').order('start_minute'), []) as { user_id: string; weekday: number; start_minute: number; end_minute: number }[];
export const timeOff = async (db: Db, org: string) => must(await db.from('staff_time_off').select('id, user_id, starts_at, ends_at, reason').eq('organization_id', org).gte('ends_at', new Date().toISOString()).order('starts_at').limit(100), []) as { id: string; user_id: string; starts_at: string; ends_at: string; reason: string | null }[];
export type AppointmentRow = { id: string; type_id: string; staff_id: string | null; contact_id: string | null; lead_id: string | null; starts_at: string; ends_at: string; status: string; notes: string | null; custom: Record<string, unknown>; cancel_reason: string | null; reschedule_count: number; created_by: string };
export async function appointmentsBetween(db: Db, org: string, from: string, to: string, staff?: string) {
  let q = db.from('appointments').select('id, type_id, staff_id, contact_id, lead_id, starts_at, ends_at, status, notes, custom, cancel_reason, reschedule_count, created_by').eq('organization_id', org).gte('starts_at', from).lt('starts_at', to).order('starts_at').limit(500);
  if (staff) q = q.eq('staff_id', staff);
  return must(await q, []) as AppointmentRow[];
}
export const appointment = async (db: Db, org: string, id: string) => (await db.from('appointments').select('id, type_id, staff_id, contact_id, lead_id, starts_at, ends_at, status, notes, custom, cancel_reason, reschedule_count, created_by').eq('organization_id', org).eq('id', id).maybeSingle()).data as AppointmentRow | null;
export const appointmentLog = async (db: Db, org: string, id: string) => must(await db.from('appointment_log').select('action, from_status, to_status, from_start, to_start, actor_id, note, created_at').eq('organization_id', org).eq('appointment_id', id).order('seq'), []) as { action: string; from_status: string | null; to_status: string | null; from_start: string | null; to_start: string | null; actor_id: string | null; note: string | null; created_at: string }[];
export async function freeSlots(db: Db, org: string, staff: string, type: string, date: string): Promise<{ slot_start: string; slot_end: string }[]> {
  const { data } = await db.rpc('appointment_free_slots', { p_org: org, p_staff: staff, p_type: type, p_date: date }); return (data as { slot_start: string; slot_end: string }[] | null) ?? [];
}
export const contactNames = async (db: Db, ids: string[]) => ids.length ? new Map((must(await db.from('contacts').select('id, full_name').in('id', ids), []) as { id: string; full_name: string }[]).map(c => [c.id, c.full_name])) : new Map<string, string>();
export const recentLeads = async (db: Db, org: string) => must(await db.from('crm_lead_list').select('id, full_name').eq('organization_id', org).order('created_at', { ascending: false }).limit(50), []) as { id: string; full_name: string }[];

export const locations = async (db: Db, org: string) => must(await db.from('inventory_locations').select('id, name, active').eq('organization_id', org).order('name'), []) as { id: string; name: string; active: boolean }[];
export const suppliers = async (db: Db, org: string) => must(await db.from('suppliers').select('id, name, reference, active').eq('organization_id', org).order('name'), []) as { id: string; name: string; reference: string | null; active: boolean }[];
export const products = async (db: Db, org: string) => must(await db.from('inventory_on_hand').select('product_id, sku, name, unit, active, low_stock_threshold, on_hand, low_stock').eq('organization_id', org).order('name'), []) as { product_id: string; sku: string; name: string; unit: string; active: boolean; low_stock_threshold: string | null; on_hand: string; low_stock: boolean }[];
export const productFlags = async (db: Db, org: string) => new Map((must(await db.from('products').select('id, track_batches').eq('organization_id', org), []) as { id: string; track_batches: boolean }[]).map(p => [p.id, p.track_batches]));
export const stockLevels = async (db: Db, org: string) => must(await db.from('stock_levels').select('product_id, location_id, batch_id, quantity').eq('organization_id', org).neq('quantity', 0), []) as { product_id: string; location_id: string; batch_id: string | null; quantity: string }[];
export const batches = async (db: Db, org: string) => must(await db.from('stock_batches').select('id, product_id, lot_code, expiry_date').eq('organization_id', org), []) as { id: string; product_id: string; lot_code: string; expiry_date: string | null }[];
export const movements = async (db: Db, org: string, limit = 30) => must(await db.from('stock_movements').select('seq, product_id, location_id, batch_id, kind, quantity_delta, balance_after, purchase_reference, reason, created_at').eq('organization_id', org).order('seq', { ascending: false }).limit(limit), []) as { seq: number; product_id: string; location_id: string; batch_id: string | null; kind: string; quantity_delta: string; balance_after: string; purchase_reference: string | null; reason: string | null; created_at: string }[];

export type InvoiceBalance = { invoice_id: string; number: string | null; status: string; currency: string; total: string; due_date: string | null; contact_id: string | null; paid: string; refunded: string; credited: string; balance_due: string; payment_state: string; overdue: boolean };
export const invoiceBalances = async (db: Db, org: string, limit = 100) => must(await db.from('invoice_balances').select('invoice_id, number, status, currency, total, due_date, contact_id, paid, refunded, credited, balance_due, payment_state, overdue').eq('organization_id', org).limit(limit), []) as InvoiceBalance[];
export async function invoiceDetail(db: Db, org: string, id: string) {
  const [inv, lines, pays, cns, ledger, bal] = await Promise.all([
    db.from('invoices').select('id, status, number, contact_id, lead_id, currency, issue_date, due_date, notes, subtotal, discount_total, tax_total, total, snapshot').eq('organization_id', org).eq('id', id).maybeSingle(),
    db.from('invoice_lines').select('position, description, quantity, unit_price, discount_type, discount_value, tax_keys, gross, discount, net, tax, line_total').eq('invoice_id', id).order('position'),
    db.from('invoice_payments').select('id, kind, amount, method, reference, note, source, received_at').eq('invoice_id', id).order('seq'),
    db.from('credit_notes').select('number, amount, net_amount, tax_amount, reason, issued_at').eq('invoice_id', id).order('seq'),
    db.from('invoice_ledger').select('kind, amount, created_at').eq('invoice_id', id).order('seq'),
    db.from('invoice_balances').select('balance_due, payment_state, paid, refunded, credited, overdue').eq('invoice_id', id).maybeSingle(),
  ]);
  return { invoice: inv.data as Record<string, unknown> | null, lines: (lines.data ?? []) as Record<string, unknown>[], payments: (pays.data ?? []) as Record<string, unknown>[], creditNotes: (cns.data ?? []) as Record<string, unknown>[], ledger: (ledger.data ?? []) as Record<string, unknown>[], balance: bal.data as Record<string, string | boolean> | null };
}
