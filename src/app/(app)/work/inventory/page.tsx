import { getWorkspaceState } from '../../../../lib/workspace/service';
import { supabaseServer } from '../../../../lib/supabase/server';
import { batches, locations, movements, productDetails, productFlags, products, stockLevels, suppliers } from '../../../../lib/operations/service';
import { opsManage } from '../../../../lib/operations/ops';
import { OpsGate } from '../../../../components/OpsGate';
import { Card } from '../../../../components/ui/Card';
import { Notice } from '../../../../components/ui/Notice';
import { LocalTime } from '../../../../components/ui/LocalTime';
import { OpForm, type OpField } from '../../../../components/OpForm';
import { ProductEditor } from '../../../../components/ProductEditor';

export default async function Inventory() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  return <OpsGate module="inventory" config={s.config} role={s.role}>{await Body(s)}</OpsGate>;
}
async function Body(s: Extract<Awaited<ReturnType<typeof getWorkspaceState>>, { status: 'ready' }>) {
  const db = await supabaseServer(), org = s.organizationId, cfg = s.config.operations?.inventory ?? { enabled: true }, manage = opsManage(s.role);
  const [locs, sups, prods, levels, lots, moves, flags, details] = await Promise.all([locations(db, org), suppliers(db, org), products(db, org), stockLevels(db, org), batches(db, org), movements(db, org), productFlags(db, org), productDetails(db, org)]);
  const customFields = s.config.operations?.inventory?.fields ?? [];
  const pname = new Map(prods.map(p => [p.product_id, `${p.name} (${p.sku})`])), lname = new Map(locs.map(l => [l.id, l.name])), lot = new Map(lots.map(b => [b.id, b]));
  const activeProds = prods.filter(p => p.active), activeLocs = locs.filter(l => l.active);
  const prodOpts: [string, string][] = activeProds.map(p => [p.product_id, `${p.name} (${p.sku})`]), locOpts: [string, string][] = activeLocs.map(l => [l.id, l.name]);
  const lotOpts: [string, string][] = lots.map(b => [b.id, `${pname.get(b.product_id) ?? ''} · lot ${b.lot_code}${b.expiry_date ? ` · exp ${b.expiry_date}` : ''}`]);
  const f = (...x: OpField[]) => x;
  const low = prods.filter(p => p.active && p.low_stock);
  return <div className="stack">
    <div className="top"><div><span className="eyebrow">Optizen Work mode</span><h1>Inventory</h1><p className="muted">Every change is a line in an immutable stock ledger. Negative stock is {cfg.allow_negative_stock ? 'allowed' : 'not allowed'} · batch tracking {cfg.track_batches ? 'on' : 'off'}{cfg.track_batches ? ` · expiry ${cfg.track_expiry ? 'on' : 'off'}` : ''}.</p></div></div>
    {low.length > 0 && <Notice title={`${low.length} product${low.length === 1 ? '' : 's'} at or below the low-stock level`}>{low.map(p => `${p.name}: ${p.on_hand} ${p.unit} (level ${p.low_stock_threshold})`).join(' · ')}</Notice>}
    <Card title="Stock on hand"><div className="table-wrap" role="region" aria-label="Stock on hand" tabIndex={0}><table><thead><tr><th scope="col">Product</th><th scope="col">On hand</th><th scope="col">Low-stock level</th></tr></thead>
      <tbody>{prods.map(p => <tr key={p.product_id}><td>{p.name} <span className="muted">{p.sku}</span>{!p.active && <span className="badge done"> inactive</span>}</td><td>{p.on_hand} {p.unit}{p.low_stock && <span className="badge late"> low</span>}</td><td>{p.low_stock_threshold ?? '—'}</td></tr>)}</tbody></table>{prods.length === 0 && <p className="empty">No products yet. {manage ? 'Add one below.' : 'A manager can add products.'}</p>}</div></Card>
    <Card title="By location and lot"><div className="table-wrap" role="region" aria-label="Stock by location" tabIndex={0}><table><thead><tr><th scope="col">Product</th><th scope="col">Location</th><th scope="col">Lot</th><th scope="col">Expiry</th><th scope="col">Quantity</th></tr></thead>
      <tbody>{levels.map((l, i) => <tr key={i}><td>{pname.get(l.product_id)}</td><td>{lname.get(l.location_id)}</td><td>{l.batch_id ? lot.get(l.batch_id)?.lot_code : '—'}</td><td>{l.batch_id ? lot.get(l.batch_id)?.expiry_date ?? '—' : '—'}</td><td>{l.quantity}</td></tr>)}</tbody></table>{levels.length === 0 && <p className="empty">No stock yet.</p>}</div></Card>
    <Card title="Use stock" description="Record stock used while doing work. Batch-tracked products are taken first-expiry-first-out. Not enough stock is refused.">
      <OpForm fn="stock_consume" fixed={{ p_ref_type: null, p_ref_id: null }} fields={f({ name: 'p_product', label: 'Product', type: 'select', required: true, options: prodOpts }, { name: 'p_location', label: 'Location', type: 'select', required: true, options: locOpts }, { name: 'p_qty', label: 'Quantity', type: 'number', required: true, step: '0.001' },
        { name: 'p_batch', label: 'Specific lot (optional)', type: 'select', options: lotOpts }, { name: 'p_reason', label: 'Note' })} submit="Use stock" message="Stock used." /></Card>
    {manage && <>
      <Card title="Receive stock" description="Supplier and purchase reference are kept on the ledger line.">
        <OpForm fn="stock_receive" fields={f({ name: 'p_product', label: 'Product', type: 'select', required: true, options: prodOpts }, { name: 'p_location', label: 'Location', type: 'select', required: true, options: locOpts }, { name: 'p_qty', label: 'Quantity', type: 'number', required: true, step: '0.001' },
          { name: 'p_lot', label: 'Lot code (batch-tracked products)' }, { name: 'p_expiry', label: 'Expiry date', type: 'date' }, { name: 'p_supplier', label: 'Supplier', type: 'select', options: sups.filter(x => x.active).map(x => [x.id, x.name]) }, { name: 'p_purchase_ref', label: 'Purchase reference' }, { name: 'p_reason', label: 'Note' })} submit="Receive" message="Stock received." /></Card>
      <Card title="Adjust stock (count)" description="Enter the quantity you counted; Optizen records the difference. A reason is required.">
        <OpForm fn="stock_adjust" fields={f({ name: 'p_product', label: 'Product', type: 'select', required: true, options: prodOpts }, { name: 'p_location', label: 'Location', type: 'select', required: true, options: locOpts }, { name: 'p_batch', label: 'Lot (batch-tracked products)', type: 'select', options: lotOpts },
          { name: 'p_counted', label: 'Counted quantity', type: 'number', required: true, step: '0.001' }, { name: 'p_reason', label: 'Reason', required: true })} submit="Adjust" message="Stock adjusted." /></Card>
      <Card title="Transfer between locations">
        <OpForm fn="stock_transfer" fields={f({ name: 'p_product', label: 'Product', type: 'select', required: true, options: prodOpts }, { name: 'p_from', label: 'From', type: 'select', required: true, options: locOpts }, { name: 'p_to', label: 'To', type: 'select', required: true, options: locOpts },
          { name: 'p_batch', label: 'Lot (batch-tracked products)', type: 'select', options: lotOpts }, { name: 'p_qty', label: 'Quantity', type: 'number', required: true, step: '0.001' }, { name: 'p_reason', label: 'Note' })} submit="Transfer" message="Transferred." /></Card>
      <Card title="Setup" description="Products, locations and suppliers. Nothing is pre-filled: define what your business keeps.">
        <div className="stack">
          <ProductEditor fields={customFields} batchesAllowed={cfg.track_batches === true} />
          {details.length > 0 && <div className="stack" style={{ gap: 6 }}><strong>Edit products</strong>{details.map(p => <ProductEditor key={`${p.id}-${JSON.stringify(p.custom)}-${p.name}`} product={p} fields={customFields} batchesAllowed={cfg.track_batches === true} />)}</div>}
          <OpForm fn="inventory_location_save" fixed={{ p_id: null, p_active: true }} fields={f({ name: 'p_name', label: 'Location name', required: true })} submit="Add location" message="Location added." />
          <OpForm fn="supplier_save" fixed={{ p_id: null, p_active: true }} fields={f({ name: 'p_name', label: 'Supplier name', required: true }, { name: 'p_reference', label: 'Account / reference' }, { name: 'p_notes', label: 'Notes' })} submit="Add supplier" message="Supplier added." /></div></Card></>}
    <Card title="Recent movements (ledger)"><div className="table-wrap" role="region" aria-label="Stock ledger" tabIndex={0}><table><thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Product</th><th scope="col">Location</th><th scope="col">Change</th><th scope="col">Balance</th><th scope="col">Note</th></tr></thead>
      <tbody>{moves.map(m => <tr key={m.seq}><td><LocalTime iso={m.created_at} /></td><td>{m.kind.replace('_', ' ')}</td><td>{pname.get(m.product_id)}</td><td>{lname.get(m.location_id)}</td><td>{m.quantity_delta}</td><td>{m.balance_after}</td><td>{m.reason ?? m.purchase_reference ?? ''}</td></tr>)}</tbody></table>{moves.length === 0 && <p className="empty">No movements yet.</p>}</div></Card>
  </div>;
}
