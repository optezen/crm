import Link from 'next/link';
import { getWorkspaceState } from '../../../../lib/workspace/service';
import { supabaseServer } from '../../../../lib/supabase/server';
import { contactNames, invoiceBalances } from '../../../../lib/operations/service';
import { money } from '../../../../lib/operations/format';
import { OpsGate } from '../../../../components/OpsGate';
import { Card } from '../../../../components/ui/Card';

export default async function Billing() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  return <OpsGate module="billing" config={s.config} role={s.role}>{await Body(s)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>) {
  const db = await supabaseServer(); const list = await invoiceBalances(db, s.organizationId); const names = await contactNames(db, list.flatMap(i => (i.contact_id ? [i.contact_id] : [])));
  const issued = list.filter(i => i.status === 'issued'), out = new Map<string, number>(); for (const i of issued) if (Number(i.balance_due) > 0) out.set(i.currency, (out.get(i.currency) ?? 0) + Number(i.balance_due));
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Billing</h1><p className="muted">Amounts are calculated and stored in the database. Payments are recorded by your team; no payment provider is connected, so nothing here confirms an external payment.</p></div><Link className="btn primary" href="/work/billing/new">New invoice</Link></div>
    <Card title="Outstanding">{out.size === 0 ? <p className="muted">Nothing outstanding.</p> : <div className="row">{[...out].map(([c, v]) => <strong key={c}>{money(v, c)}</strong>)}<span className="muted">across {issued.filter(i => Number(i.balance_due) > 0).length} invoice(s), {issued.filter(i => i.overdue).length} overdue</span></div>}</Card>
    <Card title="Invoices"><div className="table-wrap" role="region" aria-label="Invoices" tabIndex={0}><table><thead><tr><th scope="col">Number</th><th scope="col">Customer</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col">Balance due</th><th scope="col">Due</th></tr></thead>
      <tbody>{list.map(i => <tr key={i.invoice_id}><td><Link href={`/work/billing/${i.invoice_id}`}>{i.number ?? 'Draft'}</Link></td><td>{i.contact_id ? names.get(i.contact_id) ?? '—' : '—'}</td>
        <td><span className={`badge ${i.overdue ? 'late' : i.payment_state === 'paid' ? '' : 'done'}`}>{i.overdue ? 'overdue' : i.payment_state.replace('_', ' ')}</span></td><td>{money(i.total, i.currency)}</td><td>{i.status === 'issued' ? money(i.balance_due, i.currency) : '—'}</td><td>{i.due_date ?? '—'}</td></tr>)}</tbody></table>{list.length === 0 && <p className="empty">No invoices yet.</p>}</div></Card>
  </div>;
}
