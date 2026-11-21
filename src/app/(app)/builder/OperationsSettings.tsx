'use client';
import { useState } from 'react';
import { Card } from '../../../components/ui/Card';
import { FieldsEditor } from './BuilderEditor';
import { OPS_DEFAULTS, OPS_MODULES } from '../../../lib/operations/ops';
import type { FieldConfig, ObjectConfig, OperationsConfig, OpsModuleKey, TaxConfig, WorkspaceConfig } from '../../../lib/workspace/types';

/** Enable / configure the optional operations modules. Edits go into the SAME configuration draft as everything else (review, publish, version history, rollback). */
export function OperationsSettings({ cfg, published, onChange }: { cfg: WorkspaceConfig; published: WorkspaceConfig; onChange: (ops: OperationsConfig | undefined) => void }) {
  const ops = cfg.operations ?? {};
  const [tax, setTax] = useState<TaxConfig>({ key: '', name: '', rate: '' });
  const put = <K extends OpsModuleKey>(k: K, patch: Partial<NonNullable<OperationsConfig[K]>>) => onChange({ ...ops, [k]: { ...(ops[k] ?? OPS_DEFAULTS[k]), ...patch } });
  const toggle = (k: OpsModuleKey, enabled: boolean) => (ops[k] ? put(k, { enabled } as never) : enabled ? onChange({ ...ops, [k]: { ...OPS_DEFAULTS[k] } }) : undefined);
  const fieldObj = (k: 'appointments' | 'inventory', label: string): ObjectConfig => ({ key: k, label, fields: ops[k]?.fields ?? [] });
  const setFields = (k: 'appointments' | 'inventory', o: ObjectConfig) => put(k, { fields: o.fields.length ? (o.fields as FieldConfig[]) : undefined } as never);
  const pubFields = (k: 'appointments' | 'inventory', label: string): ObjectConfig | undefined => (published.operations?.[k]?.fields?.length ? { key: k, label, fields: published.operations[k]!.fields! } : undefined);
  const a = ops.appointments, inv = ops.inventory, bil = ops.billing;
  const check = (label: string, v: boolean | undefined, on: (b: boolean) => void, hint?: string) => <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={v === true} onChange={e => on(e.target.checked)} /> {label}{hint && <span className="muted"> — {hint}</span>}</label>;
  return <Card title="Business operations" description="Optional modules for any business. Turning one off hides it and stops new entries; nothing is deleted, and turning it back on restores it. Changes are part of the draft below: review, publish, and roll back like any other change.">
    <div className="stack" style={{ gap: 20 }}>
      {OPS_MODULES.map(m => { const cur = ops[m.key]; return <div key={m.key} className="stack" style={{ gap: 10 }}>
        <div className="row"><strong>{m.label}</strong>{check('Enabled', cur?.enabled, b => toggle(m.key, b))}<span className="muted">{m.blurb}</span></div>
        {m.key === 'appointments' && a?.enabled && <div className="stack" style={{ gap: 8 }}>
          <div className="inline"><div className="field"><label htmlFor="ap-tz">Time zone (IANA)</label><input id="ap-tz" className="input" value={a.timezone ?? 'UTC'} onChange={e => put('appointments', { timezone: e.target.value })} placeholder="Asia/Kolkata" /></div>
            {check('Only allow bookings inside staff working hours', a.enforce_working_hours !== false, b => put('appointments', { enforce_working_hours: b }))}</div>
          <details><summary>Custom appointment fields ({(a.fields ?? []).filter(f => !f.archived).length})</summary><FieldsEditor obj={fieldObj('appointments', 'Appointments')} pub={pubFields('appointments', 'Appointments')} onChange={o => setFields('appointments', o)} /></details></div>}
        {m.key === 'inventory' && inv?.enabled && <div className="stack" style={{ gap: 8 }}>
          {check('Allow negative stock', inv.allow_negative_stock, b => put('inventory', { allow_negative_stock: b }), 'only for products without batch tracking; off is safer')}
          {check('Track lots / batches', inv.track_batches, b => put('inventory', { track_batches: b, ...(b ? {} : { track_expiry: false }) }))}
          {inv.track_batches && check('Track expiry dates', inv.track_expiry, b => put('inventory', { track_expiry: b }))}
          {inv.track_expiry && check('Block expired lots from use', inv.block_expired !== false, b => put('inventory', { block_expired: b }))}
          <details><summary>Custom product fields ({(inv.fields ?? []).filter(f => !f.archived).length})</summary><FieldsEditor obj={fieldObj('inventory', 'Products')} pub={pubFields('inventory', 'Products')} onChange={o => setFields('inventory', o)} /></details></div>}
        {m.key === 'billing' && bil?.enabled && <div className="stack" style={{ gap: 8 }}>
          <div className="form-grid">
            <div className="field"><label htmlFor="b-cur">Default currency</label><input id="b-cur" className="input" maxLength={3} value={bil.currency ?? 'INR'} onChange={e => put('billing', { currency: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label htmlFor="b-pre">Invoice prefix</label><input id="b-pre" className="input" maxLength={8} value={bil.invoice_prefix ?? 'INV'} onChange={e => put('billing', { invoice_prefix: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label htmlFor="b-cn">Credit note prefix</label><input id="b-cn" className="input" maxLength={8} value={bil.credit_note_prefix ?? 'CN'} onChange={e => put('billing', { credit_note_prefix: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label htmlFor="b-due">Default payment terms (days)</label><input id="b-due" className="input" type="number" min={0} max={365} value={bil.default_due_days ?? 14} onChange={e => put('billing', { default_due_days: Number(e.target.value) })} /></div></div>
          <strong>Taxes (added on top of the line amount)</strong>
          {(bil.taxes ?? []).map(t => <div className="inline" key={t.key}><span>{t.name} · {t.rate}%</span><span className="muted">key {t.key}</span><button type="button" className="btn" onClick={() => put('billing', { taxes: (bil.taxes ?? []).filter(x => x.key !== t.key) })}>Remove</button></div>)}
          <div className="inline"><div className="field"><input className="input" aria-label="Tax name" placeholder="Name, e.g. GST 18%" value={tax.name} maxLength={40} onChange={e => setTax({ ...tax, name: e.target.value, key: e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 't$1').slice(0, 20) })} /></div>
            <div className="field"><input className="input" style={{ width: 110 }} aria-label="Tax rate percent" placeholder="Rate %" inputMode="decimal" value={tax.rate} onChange={e => setTax({ ...tax, rate: e.target.value })} /></div>
            <button type="button" className="btn" disabled={!tax.name.trim() || !/^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/.test(tax.rate) || !tax.key || (bil.taxes ?? []).some(x => x.key === tax.key) || (bil.taxes ?? []).length >= 10} onClick={() => { put('billing', { taxes: [...(bil.taxes ?? []), { key: tax.key, name: tax.name.trim(), rate: tax.rate }] }); setTax({ key: '', name: '', rate: '' }); }}>Add tax</button></div>
          <p className="muted">Issued invoices keep the rates they were issued with. Changing a rate affects only new invoices.</p></div>}
      </div>; })}
    </div></Card>;
}
