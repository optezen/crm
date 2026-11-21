-- 0011: Inventory. 0001-0010 are untouched.
--
-- Money-like integrity rules for stock:
--   * stock_levels.quantity is only ever changed by inv_apply(), which locks the (product, location, batch) row FOR UPDATE, updates it and appends a row to the
--     immutable stock_movements ledger in the same transaction. Multi-row operations (transfers, first-expiry-first-out consumption) lock rows in a fixed order,
--     so concurrent requests serialize instead of deadlocking or overselling.
--   * A trigger on stock_levels refuses negative quantities unless the published configuration explicitly allows them (operations.inventory.allow_negative_stock),
--     so even a bug in a function cannot oversell. inventory_reconcile() proves levels == sum(ledger).
--   * Every table carries organization_id and composite foreign keys, so a product, location or batch can never be combined with another organization's.
create table public.inventory_locations (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80), active boolean not null default true, created_by uuid not null, created_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index inventory_locations_name_uq on public.inventory_locations (organization_id, lower(name));
create table public.suppliers (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120), reference text check (char_length(reference) <= 80), notes text check (char_length(notes) <= 1000),
  active boolean not null default true, created_by uuid not null, created_at timestamptz not null default now(), unique (id, organization_id)
);
create unique index suppliers_name_uq on public.suppliers (organization_id, lower(name));
create table public.products (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  sku text not null check (sku ~ '^[A-Za-z0-9._-]{1,40}$'), name text not null check (char_length(name) between 1 and 120), unit text not null default 'unit' check (char_length(unit) between 1 and 16),
  track_batches boolean not null default false, low_stock_threshold numeric(18,3) check (low_stock_threshold >= 0), active boolean not null default true,
  custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and octet_length(custom::text) <= 10000),
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, organization_id)
);
create unique index products_sku_uq on public.products (organization_id, lower(sku));
create table public.stock_batches (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, product_id uuid not null, lot_code text not null check (char_length(lot_code) between 1 and 40),
  expiry_date date, supplier_id uuid, created_at timestamptz not null default now(), unique (id, organization_id), unique (product_id, lot_code),
  foreign key (product_id, organization_id) references public.products (id, organization_id), foreign key (supplier_id, organization_id) references public.suppliers (id, organization_id)
);
create table public.stock_levels (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, product_id uuid not null, location_id uuid not null, batch_id uuid,
  batch_key uuid generated always as (coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  quantity numeric(18,3) not null default 0, updated_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products (id, organization_id), foreign key (location_id, organization_id) references public.inventory_locations (id, organization_id),
  foreign key (batch_id, organization_id) references public.stock_batches (id, organization_id)
);
create unique index stock_levels_key_uq on public.stock_levels (product_id, location_id, batch_key);
create index stock_levels_org_idx on public.stock_levels (organization_id, product_id);
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity, organization_id uuid not null, product_id uuid not null, location_id uuid not null, batch_id uuid,
  kind text not null check (kind in ('receipt','adjustment','transfer_out','transfer_in','consumption')), quantity_delta numeric(18,3) not null check (quantity_delta <> 0), balance_after numeric(18,3) not null,
  supplier_id uuid, purchase_reference text check (char_length(purchase_reference) <= 80), reference_type text check (char_length(reference_type) <= 40), reference_id text check (char_length(reference_id) <= 80),
  transfer_id uuid, reason text check (char_length(reason) <= 300), actor_id uuid, created_at timestamptz not null default now(),
  foreign key (product_id, organization_id) references public.products (id, organization_id), foreign key (location_id, organization_id) references public.inventory_locations (id, organization_id),
  foreign key (batch_id, organization_id) references public.stock_batches (id, organization_id), foreign key (supplier_id, organization_id) references public.suppliers (id, organization_id)
);
create index stock_movements_org_idx on public.stock_movements (organization_id, seq desc);
create index stock_movements_product_idx on public.stock_movements (product_id, seq desc);
create trigger stock_movements_protect before update or delete on public.stock_movements for each row execute function public.ops_append_only();

create or replace function public.inventory_allows_negative(p_org uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((public.ops_config(p_org, 'inventory')->>'allow_negative_stock')::boolean, false);
$$;
create or replace function public.stock_levels_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.quantity < 0 and not public.inventory_allows_negative(new.organization_id) then raise exception 'Not enough stock.' using errcode = '22023'; end if;
  new.updated_at := now(); return new;
end $$;
create trigger stock_levels_guard_trg before insert or update on public.stock_levels for each row execute function public.stock_levels_guard();

alter table public.inventory_locations enable row level security; alter table public.suppliers enable row level security; alter table public.products enable row level security;
alter table public.stock_batches enable row level security; alter table public.stock_levels enable row level security; alter table public.stock_movements enable row level security;
create policy inventory_locations_read on public.inventory_locations for select to authenticated using (public.is_org_member(organization_id));
create policy suppliers_read on public.suppliers for select to authenticated using (public.is_org_member(organization_id));
create policy products_read on public.products for select to authenticated using (public.is_org_member(organization_id));
create policy stock_batches_read on public.stock_batches for select to authenticated using (public.is_org_member(organization_id));
create policy stock_levels_read on public.stock_levels for select to authenticated using (public.is_org_member(organization_id));
create policy stock_movements_read on public.stock_movements for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.inventory_locations, public.suppliers, public.products, public.stock_batches, public.stock_levels, public.stock_movements from anon, authenticated;
grant select on public.inventory_locations, public.suppliers, public.products, public.stock_batches, public.stock_levels, public.stock_movements to authenticated;

create view public.inventory_on_hand with (security_invoker = true) as
  select p.organization_id, p.id as product_id, p.sku, p.name, p.unit, p.active, p.low_stock_threshold, coalesce(sum(l.quantity), 0)::numeric(18,3) as on_hand,
         (p.low_stock_threshold is not null and coalesce(sum(l.quantity), 0) <= p.low_stock_threshold) as low_stock
  from public.products p left join public.stock_levels l on l.product_id = p.id and l.organization_id = p.organization_id group by p.id;
revoke all on public.inventory_on_hand from anon, authenticated; grant select on public.inventory_on_hand to authenticated;

-- ---------- the single place stock changes ----------
create or replace function public.inv_apply(p_org uuid, p_product uuid, p_location uuid, p_batch uuid, p_delta numeric, p_kind text, p_supplier uuid, p_purchase text, p_ref_type text, p_ref_id text, p_transfer uuid, p_reason text) returns numeric
language plpgsql security definer set search_path = '' as $$
declare v_level public.stock_levels; v_new numeric;
begin
  insert into public.stock_levels (organization_id, product_id, location_id, batch_id, quantity) values (p_org, p_product, p_location, p_batch, 0) on conflict (product_id, location_id, batch_key) do nothing;
  select * into v_level from public.stock_levels where product_id = p_product and location_id = p_location and batch_key = coalesce(p_batch, '00000000-0000-0000-0000-000000000000'::uuid) and organization_id = p_org for update;
  v_new := v_level.quantity + p_delta;
  update public.stock_levels set quantity = v_new where id = v_level.id; -- the guard trigger refuses a negative result unless the business rule allows it
  insert into public.stock_movements (organization_id, product_id, location_id, batch_id, kind, quantity_delta, balance_after, supplier_id, purchase_reference, reference_type, reference_id, transfer_id, reason, actor_id)
    values (p_org, p_product, p_location, p_batch, p_kind, p_delta, v_new, p_supplier, p_purchase, p_ref_type, p_ref_id, p_transfer, left(p_reason, 300), (select auth.uid()));
  return v_new;
end $$;

create or replace function public.inv_total(p_org uuid, p_product uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(quantity), 0) from public.stock_levels where organization_id = p_org and product_id = p_product;
$$;
-- emits inventory.low_stock when the product's total crosses DOWN through its threshold
create or replace function public.inv_check_low(p_org uuid, p_product uuid, p_before numeric) returns void language plpgsql security definer set search_path = '' as $$
declare p public.products; v_now numeric := public.inv_total(p_org, p_product);
begin
  select * into p from public.products where id = p_product and organization_id = p_org;
  if p.low_stock_threshold is not null and v_now <= p.low_stock_threshold and p_before > p.low_stock_threshold then
    perform public.crm_emit(p_org, 'inventory.low_stock', 'product', p.id, jsonb_build_object('product_id', p.id, 'sku', p.sku, 'name', p.name, 'on_hand', v_now, 'threshold', p.low_stock_threshold));
  end if;
end $$;

create or replace function public.inv_qty(p_qty numeric) returns numeric language plpgsql immutable set search_path = '' as $$
begin
  if p_qty is null or p_qty <= 0 or p_qty > 1000000000 or p_qty <> round(p_qty, 3) then raise exception 'Enter a quantity greater than zero with at most 3 decimals.' using errcode = '22023'; end if;
  return p_qty;
end $$;
create or replace function public.inv_product(p_org uuid, p_product uuid) returns public.products language plpgsql security definer set search_path = '' as $$
declare p public.products;
begin
  select * into p from public.products where id = p_product and organization_id = p_org;
  if not found then raise exception 'Product not found.' using errcode = 'P0002'; end if;
  if not p.active then raise exception 'This product is inactive.' using errcode = '22023'; end if;
  return p;
end $$;
create or replace function public.inv_location(p_org uuid, p_location uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.inventory_locations where id = p_location and organization_id = p_org and active) then raise exception 'Choose an active location.' using errcode = '22023'; end if;
end $$;

-- ---------- master data ----------
create or replace function public.inventory_location_save(p_org uuid, p_id uuid, p_name text, p_active boolean) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id uuid := p_id;
begin
  if public.ops_require(p_org, 'inventory') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can manage locations.' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 80 then raise exception 'Name the location (up to 80 characters).' using errcode = '22023'; end if;
  if v_id is null then insert into public.inventory_locations (organization_id, name, active, created_by) values (p_org, v_name, coalesce(p_active, true), (select auth.uid())) returning id into v_id;
  else update public.inventory_locations set name = v_name, active = coalesce(p_active, active) where id = v_id and organization_id = p_org; if not found then raise exception 'Location not found.' using errcode = 'P0002'; end if; end if;
  return v_id;
exception when unique_violation then raise exception 'A location with that name already exists.' using errcode = '23505';
end $$;
create or replace function public.supplier_save(p_org uuid, p_id uuid, p_name text, p_reference text, p_notes text, p_active boolean) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id uuid := p_id;
begin
  if public.ops_require(p_org, 'inventory') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can manage suppliers.' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 120 then raise exception 'Name the supplier (up to 120 characters).' using errcode = '22023'; end if;
  if v_id is null then insert into public.suppliers (organization_id, name, reference, notes, active, created_by) values (p_org, v_name, nullif(left(btrim(p_reference), 80), ''), nullif(left(btrim(p_notes), 1000), ''), coalesce(p_active, true), (select auth.uid())) returning id into v_id;
  else update public.suppliers set name = v_name, reference = nullif(left(btrim(p_reference), 80), ''), notes = nullif(left(btrim(p_notes), 1000), ''), active = coalesce(p_active, active) where id = v_id and organization_id = p_org; if not found then raise exception 'Supplier not found.' using errcode = 'P0002'; end if; end if;
  return v_id;
exception when unique_violation then raise exception 'A supplier with that name already exists.' using errcode = '23505';
end $$;
create or replace function public.product_save(p_org uuid, p_id uuid, p_sku text, p_name text, p_unit text, p_track_batches boolean, p_threshold numeric, p_active boolean, p_custom jsonb default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_cfg jsonb; v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id uuid := p_id; v_old public.products; v_unit text := coalesce(nullif(btrim(p_unit), ''), 'unit');
begin
  if public.ops_require(p_org, 'inventory') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can manage products.' using errcode = '42501'; end if;
  v_cfg := public.ops_config(p_org, 'inventory');
  if coalesce(p_sku, '') !~ '^[A-Za-z0-9._-]{1,40}$' or char_length(v_name) not between 1 and 120 or char_length(v_unit) > 16 then raise exception 'A product needs a SKU (letters, digits, . _ -), a name and a short unit.' using errcode = '22023'; end if;
  if p_threshold is not null and (p_threshold < 0 or p_threshold <> round(p_threshold, 3)) then raise exception 'The low-stock threshold must be zero or more with at most 3 decimals.' using errcode = '22023'; end if;
  if coalesce(p_track_batches, false) and not coalesce((v_cfg->>'track_batches')::boolean, false) then raise exception 'Batch tracking is not enabled in the inventory settings.' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.products (organization_id, sku, name, unit, track_batches, low_stock_threshold, active, custom, created_by)
      values (p_org, p_sku, v_name, v_unit, coalesce(p_track_batches, false), p_threshold, coalesce(p_active, true), public.ops_custom(p_org, 'inventory', p_custom, '{}'::jsonb), (select auth.uid())) returning id into v_id;
  else
    select * into v_old from public.products where id = v_id and organization_id = p_org for update; if not found then raise exception 'Product not found.' using errcode = 'P0002'; end if;
    if coalesce(p_track_batches, v_old.track_batches) <> v_old.track_batches and exists (select 1 from public.stock_movements where product_id = v_id) then raise exception 'Batch tracking cannot change once the product has stock movements.' using errcode = '22023'; end if;
    update public.products set sku = p_sku, name = v_name, unit = v_unit, track_batches = coalesce(p_track_batches, track_batches), low_stock_threshold = p_threshold, active = coalesce(p_active, active),
      custom = case when p_custom is null then custom else public.ops_custom(p_org, 'inventory', p_custom, custom) end, updated_at = now() where id = v_id;
  end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'product.saved', jsonb_build_object('product_id', v_id));
  return v_id;
exception when unique_violation then raise exception 'A product with that SKU already exists.' using errcode = '23505';
end $$;

-- ---------- stock operations ----------
create or replace function public.stock_receive(p_org uuid, p_product uuid, p_location uuid, p_qty numeric, p_lot text, p_expiry date, p_supplier uuid, p_purchase_ref text, p_reason text) returns numeric language plpgsql security definer set search_path = '' as $$
declare v_cfg jsonb; p public.products; v_batch uuid; v_before numeric; v_new numeric; v_lot text := nullif(btrim(coalesce(p_lot, '')), ''); b public.stock_batches;
begin
  if public.ops_require(p_org, 'inventory') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can receive stock.' using errcode = '42501'; end if;
  v_cfg := public.ops_config(p_org, 'inventory'); p := public.inv_product(p_org, p_product); perform public.inv_location(p_org, p_location); perform public.inv_qty(p_qty);
  if p_supplier is not null and not exists (select 1 from public.suppliers where id = p_supplier and organization_id = p_org) then raise exception 'Supplier not found.' using errcode = 'P0002'; end if;
  if p.track_batches then
    if v_lot is null or char_length(v_lot) > 40 then raise exception 'This product is batch-tracked: enter a lot code (up to 40 characters).' using errcode = '22023'; end if;
    if p_expiry is not null and not coalesce((v_cfg->>'track_expiry')::boolean, false) then raise exception 'Expiry dates are not enabled in the inventory settings.' using errcode = '22023'; end if;
    if p_expiry is not null and p_expiry < current_date then raise exception 'The expiry date is in the past.' using errcode = '22023'; end if;
    insert into public.stock_batches (organization_id, product_id, lot_code, expiry_date, supplier_id) values (p_org, p_product, v_lot, p_expiry, p_supplier) on conflict (product_id, lot_code) do nothing;
    select * into b from public.stock_batches where product_id = p_product and lot_code = v_lot and organization_id = p_org;
    if b.expiry_date is distinct from p_expiry then raise exception 'Lot "%" already exists with a different expiry date.', v_lot using errcode = '22023'; end if;
    v_batch := b.id;
  elsif v_lot is not null or p_expiry is not null then raise exception 'This product is not batch-tracked.' using errcode = '22023'; end if;
  v_before := public.inv_total(p_org, p_product);
  v_new := public.inv_apply(p_org, p_product, p_location, v_batch, p_qty, 'receipt', p_supplier, left(btrim(p_purchase_ref), 80), null, null, null, p_reason);
  perform public.crm_emit(p_org, 'inventory.stock_received', 'product', p_product, jsonb_build_object('product_id', p_product, 'sku', p.sku, 'location_id', p_location, 'batch_id', v_batch, 'quantity', p_qty, 'on_hand', public.inv_total(p_org, p_product), 'supplier_id', p_supplier, 'purchase_reference', left(btrim(p_purchase_ref), 80)));
  return v_new;
end $$;

-- sets a location/batch to the COUNTED quantity (the difference is computed under the row lock, so a stale screen cannot corrupt stock). A reason is mandatory.
create or replace function public.stock_adjust(p_org uuid, p_product uuid, p_location uuid, p_batch uuid, p_counted numeric, p_reason text) returns numeric language plpgsql security definer set search_path = '' as $$
declare p public.products; v_cur numeric; v_delta numeric; v_before numeric; v_new numeric;
begin
  if public.ops_require(p_org, 'inventory') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can adjust stock.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'Give a reason for the adjustment.' using errcode = '22023'; end if;
  if p_counted is null or p_counted < 0 or p_counted <> round(p_counted, 3) or p_counted > 1000000000 then raise exception 'Enter the counted quantity (zero or more, at most 3 decimals).' using errcode = '22023'; end if;
  p := public.inv_product(p_org, p_product); perform public.inv_location(p_org, p_location);
  if p.track_batches and p_batch is null then raise exception 'Choose the lot to adjust.' using errcode = '22023'; end if;
  if not p.track_batches and p_batch is not null then raise exception 'This product is not batch-tracked.' using errcode = '22023'; end if;
  if p_batch is not null and not exists (select 1 from public.stock_batches where id = p_batch and product_id = p_product and organization_id = p_org) then raise exception 'Lot not found.' using errcode = 'P0002'; end if;
  insert into public.stock_levels (organization_id, product_id, location_id, batch_id, quantity) values (p_org, p_product, p_location, p_batch, 0) on conflict (product_id, location_id, batch_key) do nothing;
  select quantity into v_cur from public.stock_levels where product_id = p_product and location_id = p_location and batch_key = coalesce(p_batch, '00000000-0000-0000-0000-000000000000'::uuid) and organization_id = p_org for update;
  v_delta := p_counted - v_cur; if v_delta = 0 then return v_cur; end if;
  v_before := public.inv_total(p_org, p_product);
  v_new := public.inv_apply(p_org, p_product, p_location, p_batch, v_delta, 'adjustment', null, null, null, null, null, p_reason);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'stock.adjusted', jsonb_build_object('product_id', p_product, 'location_id', p_location, 'batch_id', p_batch, 'delta', v_delta, 'reason', left(p_reason, 300)));
  perform public.crm_emit(p_org, 'inventory.stock_adjusted', 'product', p_product, jsonb_build_object('product_id', p_product, 'sku', p.sku, 'location_id', p_location, 'delta', v_delta, 'on_hand', public.inv_total(p_org, p_product)));
  if v_delta < 0 then perform public.inv_check_low(p_org, p_product, v_before); end if;
  return v_new;
end $$;

create or replace function public.stock_transfer(p_org uuid, p_product uuid, p_from uuid, p_to uuid, p_batch uuid, p_qty numeric, p_reason text) returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.products; v_tid uuid := gen_random_uuid(); v_exp date;
begin
  if public.ops_require(p_org, 'inventory') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can transfer stock.' using errcode = '42501'; end if;
  p := public.inv_product(p_org, p_product); perform public.inv_location(p_org, p_from); perform public.inv_location(p_org, p_to); perform public.inv_qty(p_qty);
  if p_from = p_to then raise exception 'Choose two different locations.' using errcode = '22023'; end if;
  if p.track_batches and p_batch is null then raise exception 'Choose the lot to transfer.' using errcode = '22023'; end if;
  if not p.track_batches and p_batch is not null then raise exception 'This product is not batch-tracked.' using errcode = '22023'; end if;
  if p_batch is not null then
    select expiry_date into v_exp from public.stock_batches where id = p_batch and product_id = p_product and organization_id = p_org; if not found then raise exception 'Lot not found.' using errcode = 'P0002'; end if;
    if v_exp is not null and v_exp < current_date and coalesce((public.ops_config(p_org, 'inventory')->>'block_expired')::boolean, true) then raise exception 'That lot has expired.' using errcode = '22023'; end if;
  end if;
  -- lock order: ascending location id, so two opposite transfers cannot deadlock
  if p_from < p_to then
    perform public.inv_apply(p_org, p_product, p_from, p_batch, -p_qty, 'transfer_out', null, null, null, null, v_tid, p_reason);
    perform public.inv_apply(p_org, p_product, p_to, p_batch, p_qty, 'transfer_in', null, null, null, null, v_tid, p_reason);
  else
    perform public.inv_apply(p_org, p_product, p_to, p_batch, p_qty, 'transfer_in', null, null, null, null, v_tid, p_reason);
    perform public.inv_apply(p_org, p_product, p_from, p_batch, -p_qty, 'transfer_out', null, null, null, null, v_tid, p_reason);
  end if;
  perform public.crm_emit(p_org, 'inventory.stock_transferred', 'product', p_product, jsonb_build_object('product_id', p_product, 'sku', p.sku, 'from_location_id', p_from, 'to_location_id', p_to, 'quantity', p_qty, 'transfer_id', v_tid));
  return v_tid;
end $$;

-- consumption is open to every member (staff use stock while doing their work). Batch-tracked products are drawn first-expiry-first-out unless a lot is named.
create or replace function public.stock_consume(p_org uuid, p_product uuid, p_location uuid, p_qty numeric, p_batch uuid, p_ref_type text, p_ref_id text, p_reason text) returns numeric language plpgsql security definer set search_path = '' as $$
declare p public.products; v_cfg jsonb; v_left numeric := p_qty; v_before numeric; r record; v_take numeric; v_avail numeric; v_block boolean;
begin
  perform public.ops_require(p_org, 'inventory'); v_cfg := public.ops_config(p_org, 'inventory'); v_block := coalesce((v_cfg->>'block_expired')::boolean, true);
  p := public.inv_product(p_org, p_product); perform public.inv_location(p_org, p_location); perform public.inv_qty(p_qty);
  v_before := public.inv_total(p_org, p_product);
  if not p.track_batches then
    if p_batch is not null then raise exception 'This product is not batch-tracked.' using errcode = '22023'; end if;
    perform public.inv_apply(p_org, p_product, p_location, null, -p_qty, 'consumption', null, null, left(p_ref_type, 40), left(p_ref_id, 80), null, p_reason);
  else
    -- rows are visited in a fixed order (earliest expiry first, then lot) and locked as they are consumed
    select coalesce(sum(l.quantity), 0) into v_avail from public.stock_levels l join public.stock_batches b on b.id = l.batch_id
      where l.organization_id = p_org and l.product_id = p_product and l.location_id = p_location and (p_batch is null or l.batch_id = p_batch) and l.quantity > 0 and (not v_block or b.expiry_date is null or b.expiry_date >= current_date);
    if v_avail < p_qty then raise exception 'Not enough usable stock (available: %).', v_avail using errcode = '22023'; end if;
    for r in select l.batch_id, b.lot_code from public.stock_levels l join public.stock_batches b on b.id = l.batch_id
             where l.organization_id = p_org and l.product_id = p_product and l.location_id = p_location and (p_batch is null or l.batch_id = p_batch) and l.quantity > 0 and (not v_block or b.expiry_date is null or b.expiry_date >= current_date)
             order by b.expiry_date nulls last, b.lot_code, b.id loop
      exit when v_left <= 0;
      select quantity into v_take from public.stock_levels where product_id = p_product and location_id = p_location and batch_key = r.batch_id for update; -- re-read under lock
      v_take := least(v_take, v_left); continue when v_take <= 0;
      perform public.inv_apply(p_org, p_product, p_location, r.batch_id, -v_take, 'consumption', null, null, left(p_ref_type, 40), left(p_ref_id, 80), null, p_reason); v_left := v_left - v_take;
    end loop;
    if v_left > 0 then raise exception 'Not enough usable stock (another request used it first).' using errcode = '22023'; end if;
  end if;
  perform public.crm_emit(p_org, 'inventory.stock_consumed', 'product', p_product, jsonb_build_object('product_id', p_product, 'sku', p.sku, 'location_id', p_location, 'quantity', p_qty, 'on_hand', public.inv_total(p_org, p_product), 'reference_type', left(p_ref_type, 40), 'reference_id', left(p_ref_id, 80)));
  perform public.inv_check_low(p_org, p_product, v_before);
  return public.inv_total(p_org, p_product);
end $$;

-- proves the ledger and the levels agree (managers and above); returns the mismatches (none when healthy)
create or replace function public.inventory_reconcile(p_org uuid) returns table (product_id uuid, location_id uuid, batch_id uuid, level_quantity numeric, ledger_quantity numeric) language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can reconcile stock.' using errcode = '42501'; end if;
  return query
    select coalesce(l.product_id, m.product_id), coalesce(l.location_id, m.location_id), coalesce(l.batch_id, m.batch_id), coalesce(l.quantity, 0), coalesce(m.q, 0)
    from (select * from public.stock_levels where organization_id = p_org) l
    full join (select s.product_id, s.location_id, s.batch_id, sum(s.quantity_delta) q from public.stock_movements s where s.organization_id = p_org group by 1, 2, 3) m
      on m.product_id = l.product_id and m.location_id = l.location_id and m.batch_id is not distinct from l.batch_id
    where coalesce(l.quantity, 0) <> coalesce(m.q, 0);
end $$;

revoke all on function public.inventory_allows_negative(uuid), public.stock_levels_guard(), public.inv_apply(uuid, uuid, uuid, uuid, numeric, text, uuid, text, text, text, uuid, text), public.inv_total(uuid, uuid),
  public.inv_check_low(uuid, uuid, numeric), public.inv_qty(numeric), public.inv_product(uuid, uuid), public.inv_location(uuid, uuid) from public, anon, authenticated;
revoke all on function public.inventory_location_save(uuid, uuid, text, boolean), public.supplier_save(uuid, uuid, text, text, text, boolean), public.product_save(uuid, uuid, text, text, text, boolean, numeric, boolean, jsonb),
  public.stock_receive(uuid, uuid, uuid, numeric, text, date, uuid, text, text), public.stock_adjust(uuid, uuid, uuid, uuid, numeric, text), public.stock_transfer(uuid, uuid, uuid, uuid, uuid, numeric, text),
  public.stock_consume(uuid, uuid, uuid, numeric, uuid, text, text, text), public.inventory_reconcile(uuid) from public, anon;
grant execute on function public.inventory_location_save(uuid, uuid, text, boolean), public.supplier_save(uuid, uuid, text, text, text, boolean), public.product_save(uuid, uuid, text, text, text, boolean, numeric, boolean, jsonb),
  public.stock_receive(uuid, uuid, uuid, numeric, text, date, uuid, text, text), public.stock_adjust(uuid, uuid, uuid, uuid, numeric, text), public.stock_transfer(uuid, uuid, uuid, uuid, uuid, numeric, text),
  public.stock_consume(uuid, uuid, uuid, numeric, uuid, text, text, text), public.inventory_reconcile(uuid) to authenticated;
