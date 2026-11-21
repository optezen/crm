import { randomUUID } from 'node:crypto';
import { notFound } from 'next/navigation';
import { getWorkspaceState } from '../../../../../lib/workspace/service';
import { supabaseServer } from '../../../../../lib/supabase/server';
import { contactNames, invoiceDetail, recentLeads } from '../../../../../lib/operations/service';
import { OpsGate } from '../../../../../components/OpsGate';
import { Card } from '../../../../../components/ui/Card';
import { LocalTime } from '../../../../../components/ui/LocalTime';
import { OpButton, OpForm } from '../../../../../components/OpForm';
import { InvoiceEditor, type EditorLine } from '../../../../../components/InvoiceEditor';
import { money } from '../../../../../lib/operations/format';

const METHODS: [string, string][] = [['cash', 'Cash'], ['bank_transfer', 'Bank transfer'], ['card', 'Card (recorded manually)'], ['upi', 'UPI (recorded manually)'], ['cheque', 'Cheque'], ['other', 'Other']];
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (id !== 'new' && !/^[0-9a-f-]{36}$/i.test(id)) notFound();
  return <OpsGate module="billing" config={s.config} role={s.role}>{await Body(s, id)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>, id: string) {
  const db = await supabaseServer(), org = s.organizationId, cfg = s.config.operations?.billing ?? { enabled: true }, taxes = cfg.taxes ?? [], leads = (await recentLeads(db, org)).map(l => ({ id: l.id, name: l.full_name }));
  const blank = { leadId: '', currency: cfg.currency ?? 'INR', dueDate: '', notes: '', lines: [] as EditorLine[] };
  if (id === 'new') return <div className="stack"><div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>New invoice</h1></div></div><Card title="Draft"><InvoiceEditor id={null} initial={blank} taxes={taxes} leads={leads} /></Card></div>;
  const d = await invoiceDetail(db, org, id); if (!d.invoice) notFound();
  const i = d.invoice as Record<string, string | null>; const cur = String(i.currency); const names = await contactNames(db, i.contact_id ? [String(i.contact_id)] : []);
  const lineTable = <div className="table-wrap" role="region" aria-label="Invoice lines" tabIndex={0}><table><thead><tr><th scope="col">#</th><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Discount</th><th scope="col">Tax</th><th scope="col">Total</th></tr></thead>
    <tbody>{d.lines.map(l => <tr key={String(l.position)}><td>{String(l.position)}</td><td>{String(l.description)}</td><td>{String(l.quantity)}</td><td>{money(String(l.unit_price), cur)}</td><td>{money(String(l.discount), cur)}</td><td>{money(String(l.tax), cur)}</td><td>{money(String(l.line_total), cur)}</td></tr>)}</tbody></table></div>;
  const totals = <div className="stack" style={{ gap: 4 }}><span>Subtotal {money(String(i.subtotal), cur)}</span><span>Discounts −{money(String(i.discount_total), cur)}</span><span>Tax {money(String(i.tax_total), cur)}</span><strong>Total {money(String(i.total), cur)}</strong></div>;
  if (i.status === 'draft') {
    const initial = { leadId: String(i.lead_id ?? ''), currency: cur, dueDate: String(i.due_date ?? ''), notes: String(i.notes ?? ''), lines: d.lines.map(l => ({ description: String(l.description), quantity: String(l.quantity), unit_price: String(l.unit_price), discount_type: (l.discount_type ?? '') as EditorLine['discount_type'], discount_value: l.discount_value == null ? '' : String(l.discount_value), tax_keys: (l.tax_keys as string[]) ?? [] })) };
    return <div className="stack"><div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Draft invoice</h1><p className="muted">Not issued: nothing is owed yet and it can still be edited.</p></div></div>
      <Card title="Draft"><InvoiceEditor id={id} initial={initial} taxes={taxes} leads={leads} /></Card>
      <Card title="Calculated totals (saved draft)" description="Computed by the database with exact decimal arithmetic. Tax rates are fixed again when you issue.">{lineTable}{totals}</Card>
      <Card title="Issue"><div className="row"><OpButton fn="invoice_issue" args={{ p_id: id }} label="Issue invoice" kind="primary" confirmText="Issue this invoice? It gets a number and can no longer be edited; corrections use credit notes." message="Issued." /><OpButton fn="invoice_cancel_draft" args={{ p_id: id }} label="Cancel draft" confirmText="Cancel this draft?" redirectTo={() => '/work/billing'} message="Draft cancelled." /></div></Card></div>;
  }
  const b = d.balance ?? {}; const owed = Number(b.balance_due ?? 0); const admin = s.role === 'owner' || s.role === 'admin';
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Invoice</span><h1>{i.number}</h1><p className="muted">{i.status === 'cancelled' ? 'Cancelled draft' : <>Issued <LocalTime iso={String((d.invoice as { snapshot?: { issued_at?: string } }).snapshot?.issued_at ?? i.issue_date)} /> · due {i.due_date} · {names.get(String(i.contact_id)) ?? 'No customer'}</>}</p></div>
      <span className={`badge ${b.overdue ? 'late' : ''}`}>{b.overdue ? 'overdue' : String(b.payment_state ?? '').replace('_', ' ')}</span></div>
    <Card title="Invoice (frozen snapshot)" description="An issued invoice never changes. Corrections are credit notes and refunds.">{lineTable}{totals}{i.status === 'issued' && <div><a className="btn" href={`/api/billing/invoices/${id}/pdf`}>Download PDF</a> <span className="muted" style={{ fontSize: 12 }}>Generated from the issued snapshot; downloads are logged.</span></div>}</Card>
    <Card title="Balance"><div className="stack" style={{ gap: 4 }}><span>Paid {money(String(b.paid ?? 0), cur)} · Credited {money(String(b.credited ?? 0), cur)} · Refunded {money(String(b.refunded ?? 0), cur)}</span><strong>{owed >= 0 ? `Outstanding ${money(owed, cur)}` : `Owed to customer ${money(-owed, cur)}`}</strong></div></Card>
    {i.status === 'issued' && owed > 0 && <Card title="Record a payment" description="Records money your team received. It does not charge anyone. Partial payments are fine; you cannot record more than is outstanding.">
      <OpForm fn="payment_record" fixed={{ p_invoice: id, p_key: randomUUID(), p_received: null }} fields={[{ name: 'p_amount', label: 'Amount', type: 'number', required: true, step: '0.01', defaultValue: owed.toFixed(2) }, { name: 'p_method', label: 'Method', type: 'select', required: true, options: METHODS, defaultValue: 'cash' }, { name: 'p_reference', label: 'Reference' }, { name: 'p_note', label: 'Note' }]} submit="Record payment" message="Payment recorded." /></Card>}
    {i.status === 'issued' && admin && <Card title="Credit note" description="Reduces what the customer owes (tax is reversed proportionally). Owners and admins only.">
      <OpForm fn="credit_note_issue" fixed={{ p_invoice: id }} fields={[{ name: 'p_amount', label: 'Credit amount (incl. tax)', type: 'number', required: true, step: '0.01' }, { name: 'p_reason', label: 'Reason', required: true }]} submit="Issue credit note" message="Credit note issued." /></Card>}
    {i.status === 'issued' && admin && owed < 0 && <Card title="Refund" description="Return money the customer is owed after a credit note. Recorded only; Optizen does not send money.">
      <OpForm fn="refund_record" fixed={{ p_invoice: id, p_key: randomUUID() }} fields={[{ name: 'p_amount', label: 'Amount', type: 'number', required: true, step: '0.01', defaultValue: (-owed).toFixed(2) }, { name: 'p_method', label: 'Method', type: 'select', required: true, options: METHODS, defaultValue: 'bank_transfer' }, { name: 'p_reference', label: 'Reference' }, { name: 'p_reason', label: 'Reason', required: true }]} submit="Record refund" message="Refund recorded." /></Card>}
    <Card title="Ledger"><div className="table-wrap" role="region" aria-label="Ledger" tabIndex={0}><table><thead><tr><th scope="col">When</th><th scope="col">Entry</th><th scope="col">Effect on balance</th></tr></thead><tbody>{d.ledger.map((l, k) => <tr key={k}><td><LocalTime iso={String(l.created_at)} /></td><td>{String(l.kind).replace('_', ' ')}</td><td>{money(String(l.amount), cur)}</td></tr>)}</tbody></table></div>
      {d.creditNotes.length > 0 && <p className="muted">Credit notes: {d.creditNotes.map(c => `${c.number} (${money(String(c.amount), cur)}: ${c.reason})`).join(' · ')}</p>}
      {d.payments.length > 0 && <p className="muted">Payments: {d.payments.map(p => `${p.kind} ${money(String(p.amount), cur)} ${String(p.method).replace('_', ' ')}${p.reference ? ` (${p.reference})` : ''} [${p.source}]`).join(' · ')}</p>}</Card>
  </div>;
}
