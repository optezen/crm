'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { callOps } from '../app/(app)/work/ops-actions';
import type { FieldConfig } from '../lib/workspace/types';

export type ProductInitial = { id: string; sku: string; name: string; unit: string; track_batches: boolean; low_stock_threshold: string | null; active: boolean; custom: Record<string, unknown> };

/** Create / edit a product, including the custom fields configured for inventory in Builder. Values are validated by the database against the same field rules as custom modules. */
export function ProductEditor({ product, fields, batchesAllowed }: { product?: ProductInitial; fields: FieldConfig[]; batchesAllowed: boolean }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [sku, setSku] = useState(product?.sku ?? ''), [name, setName] = useState(product?.name ?? ''), [unit, setUnit] = useState(product?.unit ?? 'pcs'), [thr, setThr] = useState(product?.low_stock_threshold ?? ''), [batches, setBatches] = useState(product?.track_batches ?? false), [active, setActive] = useState(product?.active ?? true);
  const [custom, setCustom] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map(f => { const v = product?.custom[f.key]; return [f.key, f.kind === 'yes_no' ? v === true : v === undefined || v === null ? '' : String(v)]; })));
  const visible = fields.filter(f => !f.archived);
  const save = () => start(async () => {
    const c: Record<string, unknown> = {}; for (const f of visible) { const v = custom[f.key]; if (v === '' || v === undefined) continue; c[f.key] = f.kind === 'number' || f.kind === 'currency' ? Number(v) : v; }
    const r = await callOps('product_save', { p_id: product?.id ?? null, p_sku: sku, p_name: name, p_unit: unit, p_track_batches: batches, p_threshold: thr === '' ? null : thr, p_active: active, p_custom: visible.length || product ? c : null }, product ? 'Product saved.' : 'Product added.');
    setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) { if (!product) { setSku(''); setName(''); setThr(''); } router.refresh(); }
  });
  const body = <form className="stack" style={{ gap: 12 }} onSubmit={e => { e.preventDefault(); save(); }}>
    <div className="form-grid">
      <div className="field"><label htmlFor={`sku-${product?.id ?? 'n'}`}>SKU</label><input id={`sku-${product?.id ?? 'n'}`} className="input" required value={sku} maxLength={40} onChange={e => setSku(e.target.value)} /></div>
      <div className="field"><label htmlFor={`pn-${product?.id ?? 'n'}`}>Name</label><input id={`pn-${product?.id ?? 'n'}`} className="input" required value={name} maxLength={120} onChange={e => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor={`pu-${product?.id ?? 'n'}`}>Unit</label><input id={`pu-${product?.id ?? 'n'}`} className="input" value={unit} maxLength={16} onChange={e => setUnit(e.target.value)} /></div>
      <div className="field"><label htmlFor={`pt-${product?.id ?? 'n'}`}>Low-stock level</label><input id={`pt-${product?.id ?? 'n'}`} className="input" inputMode="decimal" value={thr} onChange={e => setThr(e.target.value)} /></div>
      {visible.map(f => <div className="field" key={f.key}><label htmlFor={`pc-${f.key}-${product?.id ?? 'n'}`}>{f.label}{f.required ? ' *' : ''}</label>
        {f.kind === 'choice' ? <select id={`pc-${f.key}-${product?.id ?? 'n'}`} className="input" value={String(custom[f.key] ?? '')} onChange={e => setCustom({ ...custom, [f.key]: e.target.value })}><option value="">—</option>{f.options?.map(o => <option key={o}>{o}</option>)}</select>
          : f.kind === 'yes_no' ? <input id={`pc-${f.key}-${product?.id ?? 'n'}`} type="checkbox" checked={custom[f.key] === true} onChange={e => setCustom({ ...custom, [f.key]: e.target.checked })} />
          : <input id={`pc-${f.key}-${product?.id ?? 'n'}`} className="input" type={f.kind === 'number' || f.kind === 'currency' ? 'number' : f.kind === 'date' ? 'date' : f.kind === 'email' ? 'email' : 'text'} step="any" value={String(custom[f.key] ?? '')} onChange={e => setCustom({ ...custom, [f.key]: e.target.value })} />}</div>)}</div>
    <div className="row">{batchesAllowed && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={batches} disabled={!!product} onChange={e => setBatches(e.target.checked)} /> Track lots / batches{product ? ' (fixed once created)' : ''}</label>}{product && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Active</label>}</div>
    <div className="row"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : product ? 'Save product' : 'Add product'}</button>{msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}</div></form>;
  return product ? <details><summary>Edit {product.name}</summary>{body}</details> : body;
}
