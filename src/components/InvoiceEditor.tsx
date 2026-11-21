'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { callOps } from '../app/(app)/work/ops-actions';
import type { TaxConfig } from '../lib/workspace/types';

export type EditorLine = { description: string; quantity: string; unit_price: string; discount_type: '' | 'percent' | 'amount'; discount_value: string; tax_keys: string[] };
const blankLine = (): EditorLine => ({ description: '', quantity: '1', unit_price: '', discount_type: '', discount_value: '', tax_keys: [] });

/** Draft editor. It sends quantities, prices, discounts and tax KEYS only; every amount shown on the saved draft is computed by the database. */
export function InvoiceEditor({ id, initial, taxes, leads }: { id: string | null; initial: { leadId: string; currency: string; dueDate: string; notes: string; lines: EditorLine[] }; taxes: TaxConfig[]; leads: { id: string; name: string }[] }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [lead, setLead] = useState(initial.leadId), [currency, setCurrency] = useState(initial.currency), [due, setDue] = useState(initial.dueDate), [notes, setNotes] = useState(initial.notes), [lines, setLines] = useState<EditorLine[]>(initial.lines.length ? initial.lines : [blankLine()]);
  const set = (i: number, p: Partial<EditorLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const save = () => start(async () => {
    const payload = lines.map(l => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, ...(l.discount_type ? { discount_type: l.discount_type, discount_value: l.discount_value } : {}), tax_keys: l.tax_keys }));
    const r = await callOps('invoice_save_draft', { p_id: id, p_lead: lead || null, p_contact: null, p_currency: currency || null, p_due_date: due || null, p_notes: notes || null, p_lines: payload }, 'Draft saved. Totals below are calculated by the server.');
    setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) { if (!id && typeof r.data === 'string') router.push(`/work/billing/${r.data}`); else router.refresh(); }
  });
  return <div className="stack" style={{ gap: 16 }}>
    <div className="form-grid">
      <div className="field"><label htmlFor="inv-lead">Customer (lead)</label><select id="inv-lead" className="input" value={lead} onChange={e => setLead(e.target.value)}><option value="">— none —</option>{leads.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
      <div className="field"><label htmlFor="inv-cur">Currency</label><input id="inv-cur" className="input" maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></div>
      <div className="field"><label htmlFor="inv-due">Due date (optional)</label><input id="inv-due" className="input" type="date" value={due} onChange={e => setDue(e.target.value)} /></div>
      <div className="field wide"><label htmlFor="inv-notes">Notes</label><textarea id="inv-notes" className="input" maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></div></div>
    {lines.map((l, i) => <div key={i} className="stack" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
      <div className="inline">
        <div className="field" style={{ flex: 2 }}><label htmlFor={`l-d-${i}`}>Description</label><input id={`l-d-${i}`} className="input" maxLength={200} value={l.description} onChange={e => set(i, { description: e.target.value })} /></div>
        <div className="field"><label htmlFor={`l-q-${i}`}>Qty</label><input id={`l-q-${i}`} className="input" style={{ width: 90 }} inputMode="decimal" value={l.quantity} onChange={e => set(i, { quantity: e.target.value })} /></div>
        <div className="field"><label htmlFor={`l-p-${i}`}>Unit price</label><input id={`l-p-${i}`} className="input" style={{ width: 120 }} inputMode="decimal" value={l.unit_price} onChange={e => set(i, { unit_price: e.target.value })} /></div></div>
      <div className="inline">
        <div className="field"><label htmlFor={`l-t-${i}`}>Discount</label><select id={`l-t-${i}`} className="input" value={l.discount_type} onChange={e => set(i, { discount_type: e.target.value as EditorLine['discount_type'] })}><option value="">None</option><option value="percent">Percent</option><option value="amount">Amount</option></select></div>
        {l.discount_type && <div className="field"><label htmlFor={`l-v-${i}`}>Value</label><input id={`l-v-${i}`} className="input" style={{ width: 100 }} inputMode="decimal" value={l.discount_value} onChange={e => set(i, { discount_value: e.target.value })} /></div>}
        {taxes.map(t => <label key={t.key} className="row" style={{ gap: 6 }}><input type="checkbox" checked={l.tax_keys.includes(t.key)} onChange={e => set(i, { tax_keys: e.target.checked ? [...l.tax_keys, t.key] : l.tax_keys.filter(k => k !== t.key) })} /> {t.name} ({t.rate}%)</label>)}
        <button type="button" className="btn" disabled={lines.length <= 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove line</button></div></div>)}
    <div className="row"><button type="button" className="btn" disabled={lines.length >= 100} onClick={() => setLines([...lines, blankLine()])}>Add line</button>
      <button type="button" className="btn primary" disabled={pending} onClick={save}>{pending ? 'Saving…' : 'Save draft'}</button>{msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}</div>
    {taxes.length === 0 && <p className="muted">No taxes are configured. Add them in Builder → Business operations → Billing.</p>}
  </div>;
}
