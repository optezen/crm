-- 0012: Billing. 0001-0011 are untouched.
--
-- Financial integrity rules:
--   * Every amount is `numeric` (exact decimal) and every total is computed IN POSTGRESQL by billing_calc(); the browser only supplies quantities, prices,
--     discounts and tax KEYS. Rounding: line gross/discount/tax are each rounded to 2 decimals (half away from zero), invoice totals are sums of rounded lines,
--     so total = subtotal - discounts + taxes holds exactly. Taxes are exclusive and their rates come from the published configuration at issue time.
--   * An issued invoice is a frozen snapshot (lines, rates, bill-to details, totals): its row, lines and snapshot can never change. Corrections are new
--     ledger entries: payments, credit notes and refunds. Nothing is ever updated or deleted in the ledger tables.
--   * balance_due = SUM(invoice_ledger.amount) where invoice issued = +total, payment = -amount, credit note = -amount, refund = +amount.
--   * Payments are recorded manually by staff here. A payment provider adapter (Integration Hub, provider "payments") must post through the same internal
--     posting function (billing_apply_provider_payment, service role only); nothing in this file claims money was processed externally.
create table public.invoices (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','issued','cancelled')), number text,
  contact_id uuid, lead_id uuid, currency text not null check (currency ~ '^[A-Z]{3}$'), issue_date date, due_date date, notes text check (char_length(notes) <= 2000),
  subtotal numeric(18,2) not null default 0, discount_total numeric(18,2) not null default 0, tax_total numeric(18,2) not null default 0, total numeric(18,2) not null default 0,
  snapshot jsonb, issued_at timestamptz, issued_by uuid, cancelled_at timestamptz, created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id),
  check ((status = 'draft' and number is null and snapshot is null) or (status = 'issued' and number is not null and snapshot is not null and issue_date is not null) or status = 'cancelled'),
  check (total = subtotal - discount_total + tax_total and total >= 0),
  foreign key (contact_id, organization_id) references public.contacts (id, organization_id), foreign key (lead_id, organization_id) references public.leads (id, organization_id)
);
create unique index invoices_number_uq on public.invoices (organization_id, number) where number is not null;
create index invoices_org_idx on public.invoices (organization_id, status, created_at desc);
create index invoices_contact_idx on public.invoices (contact_id) where contact_id is not null;
create table public.invoice_lines (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, invoice_id uuid not null, position integer not null check (position between 1 and 100),
  description text not null check (char_length(description) between 1 and 200), product_id uuid,
  quantity numeric(14,3) not null check (quantity > 0), unit_price numeric(18,4) not null check (unit_price >= 0),
  discount_type text check (discount_type in ('percent','amount')), discount_value numeric(18,4) check (discount_value >= 0), tax_keys text[] not null default '{}',
  gross numeric(18,2) not null default 0, discount numeric(18,2) not null default 0, net numeric(18,2) not null default 0, tax numeric(18,2) not null default 0, line_total numeric(18,2) not null default 0, tax_detail jsonb not null default '[]'::jsonb,
  unique (invoice_id, position), foreign key (invoice_id, organization_id) references public.invoices (id, organization_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products (id, organization_id)
);
create table public.invoice_counters (organization_id uuid not null references public.organizations(id) on delete cascade, kind text not null check (kind in ('invoice','credit_note')), last_value bigint not null default 0, primary key (organization_id, kind));
create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity, organization_id uuid not null, invoice_id uuid not null,
  kind text not null check (kind in ('payment','refund')), amount numeric(18,2) not null check (amount > 0),
  method text not null check (method in ('cash','bank_transfer','card','upi','cheque','other')), reference text check (char_length(reference) <= 80), note text check (char_length(note) <= 300),
  source text not null default 'manual' check (source in ('manual','provider')), provider_connection_id uuid, provider_ref text check (char_length(provider_ref) <= 120), idempotency_key text check (char_length(idempotency_key) <= 80),
  received_at timestamptz not null default now(), recorded_by uuid, created_at timestamptz not null default now(),
  foreign key (invoice_id, organization_id) references public.invoices (id, organization_id)
);
create unique index invoice_payments_idem_uq on public.invoice_payments (organization_id, idempotency_key) where idempotency_key is not null;
create unique index invoice_payments_provider_uq on public.invoice_payments (provider_connection_id, provider_ref) where provider_ref is not null;
create index invoice_payments_invoice_idx on public.invoice_payments (invoice_id, seq);
create table public.credit_notes (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity, organization_id uuid not null, invoice_id uuid not null, number text not null,
  amount numeric(18,2) not null check (amount > 0), net_amount numeric(18,2) not null, tax_amount numeric(18,2) not null check (net_amount + tax_amount = amount),
  reason text not null check (char_length(reason) between 3 and 500), snapshot jsonb not null, issued_by uuid, issued_at timestamptz not null default now(),
  unique (organization_id, number), foreign key (invoice_id, organization_id) references public.invoices (id, organization_id)
);
create table public.invoice_ledger (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity, organization_id uuid not null, invoice_id uuid not null,
  kind text not null check (kind in ('invoice','payment','credit_note','refund')), amount numeric(18,2) not null check (amount <> 0), ref_id uuid not null, actor_id uuid, created_at timestamptz not null default now(),
  unique (kind, ref_id), foreign key (invoice_id, organization_id) references public.invoices (id, organization_id)
);
create index invoice_ledger_invoice_idx on public.invoice_ledger (invoice_id, seq);
create trigger invoice_payments_protect before update or delete on public.invoice_payments for each row execute function public.ops_append_only();
create trigger credit_notes_protect before update or delete on public.credit_notes for each row execute function public.ops_append_only();
create trigger invoice_ledger_protect before update or delete on public.invoice_ledger for each row execute function public.ops_append_only();

create or replace function public.invoices_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or not exists (select 1 from public.organizations where id = old.organization_id) then return old; end if;
    raise exception 'Issued invoices cannot be deleted.' using errcode = '42501';
  end if;
  if old.status in ('issued','cancelled') then raise exception 'Issued and cancelled invoices are immutable. Use a credit note to correct an issued invoice.' using errcode = '42501'; end if;
  if new.status not in ('draft','issued','cancelled') or new.organization_id <> old.organization_id then raise exception 'Invalid invoice change.' using errcode = '42501'; end if;
  return new;
end $$;
create trigger invoices_guard_trg before update or delete on public.invoices for each row execute function public.invoices_guard();
create or replace function public.invoice_lines_guard() returns trigger language plpgsql set search_path = '' as $$
declare v_status text; v_inv uuid := coalesce(new.invoice_id, old.invoice_id);
begin
  select status into v_status from public.invoices where id = v_inv;
  if v_status is not null and v_status <> 'draft' then raise exception 'The lines of an issued invoice cannot change.' using errcode = '42501'; end if;
  return coalesce(new, old);
end $$;
create trigger invoice_lines_guard_trg before insert or update or delete on public.invoice_lines for each row execute function public.invoice_lines_guard();

alter table public.invoices enable row level security; alter table public.invoice_lines enable row level security; alter table public.invoice_counters enable row level security;
alter table public.invoice_payments enable row level security; alter table public.credit_notes enable row level security; alter table public.invoice_ledger enable row level security;
-- financial data is visible to owners, admins and managers only
create policy invoices_read on public.invoices for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
create policy invoice_lines_read on public.invoice_lines for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
create policy invoice_payments_read on public.invoice_payments for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
create policy credit_notes_read on public.credit_notes for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
create policy invoice_ledger_read on public.invoice_ledger for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
revoke all on public.invoices, public.invoice_lines, public.invoice_counters, public.invoice_payments, public.credit_notes, public.invoice_ledger from anon, authenticated;
grant select on public.invoices, public.invoice_lines, public.invoice_payments, public.credit_notes, public.invoice_ledger to authenticated;

create view public.invoice_balances with (security_invoker = true) as
  select i.organization_id, i.id as invoice_id, i.number, i.status, i.currency, i.total, i.due_date, i.contact_id,
    coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'payment'), 0)::numeric(18,2) as paid,
    coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'refund'), 0)::numeric(18,2) as refunded,
    coalesce((select sum(c.amount) from public.credit_notes c where c.invoice_id = i.id), 0)::numeric(18,2) as credited,
    coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0)::numeric(18,2) as balance_due,
    case when i.status <> 'issued' then i.status
         when coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0) < 0 then 'credit'
         when coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0) = 0 then 'paid'
         when exists (select 1 from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'payment') or exists (select 1 from public.credit_notes c where c.invoice_id = i.id) then 'partially_paid'
         else 'unpaid' end as payment_state,
    (i.status = 'issued' and i.due_date < current_date and coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0) > 0) as overdue
  from public.invoices i;
revoke all on public.invoice_balances from anon, authenticated; grant select on public.invoice_balances to authenticated;

-- ---------- exact calculation (the only place totals are computed) ----------
create or replace function public.billing_calc(p_org uuid, p_lines jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg jsonb := public.ops_config(p_org, 'billing'); l jsonb; i int := 0; v_qty numeric; v_price numeric; v_gross numeric; v_disc numeric; v_dv numeric; v_net numeric; v_tax numeric; v_ltax numeric; v_td jsonb; v_key text; t jsonb;
  v_out jsonb := '[]'::jsonb; v_sub numeric := 0; v_dt numeric := 0; v_tt numeric := 0; v_total numeric := 0; v_sum jsonb := '{}'::jsonb; v_amt numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'An invoice needs between 1 and 100 lines.' using errcode = '22023'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    i := i + 1;
    if jsonb_typeof(l) is distinct from 'object' or exists (select 1 from jsonb_object_keys(l) k where k not in ('description','quantity','unit_price','discount_type','discount_value','tax_keys','product_id')) then
      raise exception 'Line % is invalid.', i using errcode = '22023'; end if;
    if char_length(btrim(coalesce(l->>'description', ''))) not between 1 and 200 then raise exception 'Line % needs a description of up to 200 characters.', i using errcode = '22023'; end if;
    if coalesce(l->>'quantity', '') !~ '^[0-9]{1,11}(\.[0-9]{1,3})?$' or (l->>'quantity')::numeric <= 0 then raise exception 'Line %: quantity must be greater than zero with at most 3 decimals.', i using errcode = '22023'; end if;
    if coalesce(l->>'unit_price', '') !~ '^[0-9]{1,14}(\.[0-9]{1,4})?$' then raise exception 'Line %: unit price must be zero or more with at most 4 decimals.', i using errcode = '22023'; end if;
    v_qty := (l->>'quantity')::numeric; v_price := (l->>'unit_price')::numeric; v_gross := round(v_qty * v_price, 2);
    v_disc := 0; v_dv := null;
    if l->>'discount_type' is not null then
      if l->>'discount_type' not in ('percent','amount') or coalesce(l->>'discount_value', '') !~ '^[0-9]{1,14}(\.[0-9]{1,4})?$' then raise exception 'Line %: invalid discount.', i using errcode = '22023'; end if;
      v_dv := (l->>'discount_value')::numeric;
      v_disc := case when l->>'discount_type' = 'percent' then round(v_gross * v_dv / 100, 2) else round(v_dv, 2) end;
      if (l->>'discount_type' = 'percent' and v_dv > 100) or v_disc > v_gross then raise exception 'Line %: the discount is larger than the line.', i using errcode = '22023'; end if;
    elsif l ? 'discount_value' then raise exception 'Line %: a discount value needs a discount type.', i using errcode = '22023'; end if;
    v_net := v_gross - v_disc; v_ltax := 0; v_td := '[]'::jsonb;
    if l ? 'tax_keys' then
      if jsonb_typeof(l->'tax_keys') is distinct from 'array' or jsonb_array_length(l->'tax_keys') > 5 then raise exception 'Line %: at most 5 taxes.', i using errcode = '22023'; end if;
      for v_key in select jsonb_array_elements_text(l->'tax_keys') loop
        select x into t from jsonb_array_elements(coalesce(v_cfg->'taxes', '[]'::jsonb)) x where x->>'key' = v_key;
        if t is null then raise exception 'Line %: the tax "%" is not configured.', i, v_key using errcode = '22023'; end if;
        if exists (select 1 from jsonb_array_elements(v_td) d where d->>'key' = v_key) then raise exception 'Line %: the tax "%" is listed twice.', i, v_key using errcode = '22023'; end if;
        v_tax := round(v_net * (t->>'rate')::numeric / 100, 2); v_ltax := v_ltax + v_tax;
        v_td := v_td || jsonb_build_object('key', v_key, 'name', t->>'name', 'rate', t->>'rate', 'amount', v_tax);
        v_sum := jsonb_set(v_sum, array[v_key], to_jsonb(coalesce((v_sum->>v_key)::numeric, 0) + v_tax));
      end loop;
    end if;
    v_sub := v_sub + v_gross; v_dt := v_dt + v_disc; v_tt := v_tt + v_ltax; v_total := v_total + v_net + v_ltax;
    v_out := v_out || jsonb_build_object('position', i, 'description', btrim(l->>'description'), 'product_id', l->>'product_id', 'quantity', v_qty, 'unit_price', v_price, 'discount_type', l->>'discount_type', 'discount_value', v_dv,
      'tax_keys', coalesce(l->'tax_keys', '[]'::jsonb), 'gross', v_gross, 'discount', v_disc, 'net', v_net, 'tax', v_ltax, 'line_total', v_net + v_ltax, 'tax_detail', v_td);
  end loop;
  return jsonb_build_object('lines', v_out, 'subtotal', v_sub, 'discount_total', v_dt, 'tax_total', v_tt, 'total', v_total,
    'tax_summary', coalesce((select jsonb_agg(jsonb_build_object('key', k.key, 'name', (select x->>'name' from jsonb_array_elements(v_cfg->'taxes') x where x->>'key' = k.key), 'rate', (select x->>'rate' from jsonb_array_elements(v_cfg->'taxes') x where x->>'key' = k.key), 'amount', k.value::numeric) order by k.key) from jsonb_each(v_sum) k), '[]'::jsonb));
end $$;

create or replace function public.invoice_payload(i public.invoices) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('invoice_id', i.id, 'number', i.number, 'status', i.status, 'currency', i.currency, 'total', i.total, 'contact_id', i.contact_id, 'lead_id', i.lead_id, 'due_date', i.due_date,
    'balance_due', coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0));
$$;
create or replace function public.billing_next_number(p_org uuid, p_kind text) returns text language plpgsql security definer set search_path = '' as $$
declare v_cfg jsonb := public.ops_config(p_org, 'billing'); v_n bigint; v_prefix text;
begin
  insert into public.invoice_counters (organization_id, kind, last_value) values (p_org, p_kind, 0) on conflict do nothing;
  update public.invoice_counters set last_value = last_value + 1 where organization_id = p_org and kind = p_kind returning last_value into v_n; -- row lock: numbers are unique and gap-free
  v_prefix := case when p_kind = 'invoice' then coalesce(v_cfg->>'invoice_prefix', 'INV') else coalesce(v_cfg->>'credit_note_prefix', 'CN') end;
  return v_prefix || '-' || lpad(v_n::text, 5, '0');
end $$;

-- ---------- drafts and issuing ----------
create or replace function public.invoice_save_draft(p_org uuid, p_id uuid, p_contact uuid, p_lead uuid, p_currency text, p_due_date date, p_notes text, p_lines jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_cfg jsonb; v_calc jsonb; v_id uuid := p_id; v_cur text; v_contact uuid := p_contact; v_lead_contact uuid; v_status text; l jsonb; v_new boolean := false;
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can manage invoices.' using errcode = '42501'; end if;
  v_cfg := public.ops_config(p_org, 'billing'); v_cur := coalesce(nullif(btrim(p_currency), ''), v_cfg->>'currency', 'INR');
  if v_cur !~ '^[A-Z]{3}$' then raise exception 'Currency must be a 3-letter code.' using errcode = '22023'; end if;
  if p_lead is not null then
    select contact_id into v_lead_contact from public.leads where id = p_lead and organization_id = p_org; if not found then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
    if v_contact is not null and v_contact <> v_lead_contact then raise exception 'The lead belongs to a different contact.' using errcode = '22023'; end if; v_contact := v_lead_contact;
  end if;
  if v_contact is not null and not exists (select 1 from public.contacts where id = v_contact and organization_id = p_org) then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  if p_due_date is not null and (p_due_date < current_date - 365 or p_due_date > current_date + 1095) then raise exception 'Choose a due date within the next three years.' using errcode = '22023'; end if;
  v_calc := public.billing_calc(p_org, p_lines);
  for l in select * from jsonb_array_elements(v_calc->'lines') where nullif(value->>'product_id', '') is not null loop
    if not exists (select 1 from public.products where id = (l->>'product_id')::uuid and organization_id = p_org) then raise exception 'A line refers to a product that does not exist.' using errcode = 'P0002'; end if;
  end loop;
  if v_id is null then
    insert into public.invoices (organization_id, contact_id, lead_id, currency, due_date, notes, created_by) values (p_org, v_contact, p_lead, v_cur, p_due_date, nullif(left(btrim(coalesce(p_notes, '')), 2000), ''), v_uid) returning id into v_id; v_new := true;
  else
    select status into v_status from public.invoices where id = v_id and organization_id = p_org for update;
    if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
    if v_status <> 'draft' then raise exception 'Only drafts can be edited. Use a credit note to correct an issued invoice.' using errcode = '22023'; end if;
    delete from public.invoice_lines where invoice_id = v_id;
  end if;
  insert into public.invoice_lines (organization_id, invoice_id, position, description, product_id, quantity, unit_price, discount_type, discount_value, tax_keys, gross, discount, net, tax, line_total, tax_detail)
    select p_org, v_id, (x->>'position')::int, x->>'description', nullif(x->>'product_id', '')::uuid, (x->>'quantity')::numeric, (x->>'unit_price')::numeric, x->>'discount_type', (x->>'discount_value')::numeric,
      array(select jsonb_array_elements_text(x->'tax_keys')), (x->>'gross')::numeric, (x->>'discount')::numeric, (x->>'net')::numeric, (x->>'tax')::numeric, (x->>'line_total')::numeric, x->'tax_detail'
    from jsonb_array_elements(v_calc->'lines') x;
  update public.invoices set contact_id = v_contact, lead_id = p_lead, currency = v_cur, due_date = p_due_date, notes = nullif(left(btrim(coalesce(p_notes, '')), 2000), ''),
    subtotal = (v_calc->>'subtotal')::numeric, discount_total = (v_calc->>'discount_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric, total = (v_calc->>'total')::numeric, updated_at = now() where id = v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'invoice.draft_saved', jsonb_build_object('invoice_id', v_id));
  if v_new then perform public.crm_emit(p_org, 'invoice.created', 'invoice', v_id, jsonb_build_object('invoice_id', v_id, 'status', 'draft', 'currency', v_cur, 'total', (v_calc->>'total')::numeric, 'contact_id', v_contact)); end if;
  return v_id;
end $$;

create or replace function public.invoice_issue(p_org uuid, p_id uuid) returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); i public.invoices; v_calc jsonb; v_num text; v_cfg jsonb; v_lines jsonb; v_bill jsonb; c public.contacts; v_due date; v_snap jsonb; v_name text;
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can issue invoices.' using errcode = '42501'; end if;
  select * into i from public.invoices where id = p_id and organization_id = p_org for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if i.status <> 'draft' then raise exception 'This invoice was already issued or cancelled.' using errcode = '22023'; end if;
  select jsonb_agg(jsonb_build_object('description', description, 'quantity', quantity::text, 'unit_price', unit_price::text, 'discount_type', discount_type, 'discount_value', discount_value::text, 'tax_keys', to_jsonb(tax_keys), 'product_id', product_id) order by position) into v_lines
    from public.invoice_lines where invoice_id = p_id;
  if v_lines is null then raise exception 'Add at least one line before issuing.' using errcode = '22023'; end if;
  v_lines := (select jsonb_agg(jsonb_strip_nulls(x)) from jsonb_array_elements(v_lines) x);
  v_calc := public.billing_calc(p_org, v_lines); -- recomputed with the CURRENT tax rates: the issued totals never come from a stale draft
  if (v_calc->>'total')::numeric <= 0 then raise exception 'An invoice total must be greater than zero.' using errcode = '22023'; end if;
  v_cfg := public.ops_config(p_org, 'billing'); v_num := public.billing_next_number(p_org, 'invoice'); v_due := coalesce(i.due_date, current_date + coalesce((v_cfg->>'default_due_days')::int, 14));
  if i.contact_id is not null then select * into c from public.contacts where id = i.contact_id; end if;
  v_bill := jsonb_build_object('contact_id', i.contact_id, 'name', c.full_name, 'phone', c.phone, 'email', c.email);
  select definition->>'businessName' into v_name from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
  update public.invoice_lines l set gross = (x->>'gross')::numeric, discount = (x->>'discount')::numeric, net = (x->>'net')::numeric, tax = (x->>'tax')::numeric, line_total = (x->>'line_total')::numeric, tax_detail = x->'tax_detail'
    from jsonb_array_elements(v_calc->'lines') x where l.invoice_id = p_id and l.position = (x->>'position')::int;
  v_snap := jsonb_build_object('number', v_num, 'business', v_name, 'currency', i.currency, 'issue_date', current_date, 'due_date', v_due, 'bill_to', v_bill, 'lines', v_calc->'lines', 'tax_summary', v_calc->'tax_summary',
    'subtotal', v_calc->'subtotal', 'discount_total', v_calc->'discount_total', 'tax_total', v_calc->'tax_total', 'total', v_calc->'total', 'notes', i.notes, 'issued_by', v_uid, 'issued_at', now());
  update public.invoices set status = 'issued', number = v_num, issue_date = current_date, due_date = v_due, snapshot = v_snap, issued_at = now(), issued_by = v_uid, updated_at = now(),
    subtotal = (v_calc->>'subtotal')::numeric, discount_total = (v_calc->>'discount_total')::numeric, tax_total = (v_calc->>'tax_total')::numeric, total = (v_calc->>'total')::numeric where id = p_id returning * into i;
  insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id, actor_id) values (p_org, p_id, 'invoice', i.total, p_id, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'invoice.issued', jsonb_build_object('invoice_id', p_id, 'number', v_num, 'total', i.total));
  perform public.crm_emit(p_org, 'invoice.issued', 'invoice', p_id, public.invoice_payload(i));
  return v_num;
end $$;

create or replace function public.invoice_cancel_draft(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can manage invoices.' using errcode = '42501'; end if;
  perform 1 from public.invoices where id = p_id and organization_id = p_org and status = 'draft' for update;
  if not found then raise exception 'Draft not found.' using errcode = 'P0002'; end if;
  update public.invoices set status = 'cancelled', cancelled_at = now() where id = p_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'invoice.draft_cancelled', jsonb_build_object('invoice_id', p_id));
end $$;

-- ---------- payments, credit notes, refunds ----------
create or replace function public.billing_balance(p_invoice uuid) returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.invoice_ledger where invoice_id = p_invoice;
$$;
-- the single posting path for money coming IN (manual entry and provider adapters both end here)
create or replace function public.billing_post_payment(p_org uuid, p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_note text, p_received timestamptz, p_source text, p_conn uuid, p_provider_ref text, p_key text, p_actor uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.invoices; v_id uuid; v_bal numeric; v_existing uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > 1000000000000 then raise exception 'Enter an amount greater than zero with at most 2 decimals.' using errcode = '22023'; end if;
  if p_method not in ('cash','bank_transfer','card','upi','cheque','other') then raise exception 'Choose a payment method.' using errcode = '22023'; end if;
  if p_received < now() - interval '2 years' or p_received > now() + interval '1 day' then raise exception 'The payment date is out of range.' using errcode = '22023'; end if;
  if p_key is not null then select id into v_existing from public.invoice_payments where organization_id = p_org and idempotency_key = p_key; if found then return v_existing; end if; end if; -- a repeated submit returns the first payment
  if p_provider_ref is not null then select id into v_existing from public.invoice_payments where provider_connection_id = p_conn and provider_ref = p_provider_ref; if found then return v_existing; end if; end if;
  select * into i from public.invoices where id = p_invoice and organization_id = p_org for update; -- serializes concurrent payments on one invoice
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if i.status <> 'issued' then raise exception 'Payments can only be recorded against issued invoices.' using errcode = '22023'; end if;
  v_bal := public.billing_balance(p_invoice);
  if p_amount > v_bal then raise exception 'The payment (%) is more than the outstanding amount (%).', p_amount, greatest(v_bal, 0) using errcode = '22023'; end if;
  insert into public.invoice_payments (organization_id, invoice_id, kind, amount, method, reference, note, source, provider_connection_id, provider_ref, idempotency_key, received_at, recorded_by)
    values (p_org, p_invoice, 'payment', p_amount, p_method, left(btrim(p_reference), 80), left(btrim(p_note), 300), p_source, p_conn, p_provider_ref, p_key, p_received, p_actor) returning id into v_id;
  insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id, actor_id) values (p_org, p_invoice, 'payment', -p_amount, v_id, p_actor);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, p_actor, 'payment.received', jsonb_build_object('invoice_id', p_invoice, 'payment_id', v_id, 'amount', p_amount, 'source', p_source));
  perform public.crm_emit(p_org, 'payment.received', 'payment', v_id, jsonb_build_object('payment_id', v_id, 'invoice_id', p_invoice, 'number', i.number, 'amount', p_amount, 'currency', i.currency, 'method', p_method, 'source', p_source, 'balance_due', v_bal - p_amount, 'contact_id', i.contact_id));
  if v_bal - p_amount = 0 then perform public.crm_emit(p_org, 'invoice.paid', 'invoice', p_invoice, public.invoice_payload(i)); end if;
  return v_id;
end $$;

create or replace function public.payment_record(p_org uuid, p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_note text, p_received timestamptz default null, p_key text default null) returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can record payments.' using errcode = '42501'; end if;
  return public.billing_post_payment(p_org, p_invoice, p_amount, p_method, p_reference, p_note, coalesce(p_received, now()), 'manual', null, null, nullif(btrim(p_key), ''), (select auth.uid()));
end $$;

-- inert until a payment provider exists (the "payments" Integration Hub provider cannot be connected yet): requires a CONNECTED payments connection of the SAME organization
create or replace function public.billing_apply_provider_payment(p_connection uuid, p_invoice uuid, p_amount numeric, p_currency text, p_provider_ref text, p_method text) returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; i public.invoices;
begin
  select * into c from public.integration_connections where id = p_connection and provider = 'payments' and status = 'connected';
  if not found then raise exception 'There is no connected payments provider.' using errcode = '22023'; end if;
  select * into i from public.invoices where id = p_invoice and organization_id = c.organization_id;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if i.currency <> p_currency then raise exception 'The payment currency does not match the invoice.' using errcode = '22023'; end if;
  if coalesce(p_provider_ref, '') = '' then raise exception 'A provider reference is required.' using errcode = '22023'; end if;
  return public.billing_post_payment(c.organization_id, p_invoice, p_amount, p_method, p_provider_ref, 'provider', now(), 'provider', c.id, p_provider_ref, null, null);
end $$;

create or replace function public.credit_note_issue(p_org uuid, p_invoice uuid, p_amount numeric, p_reason text) returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); i public.invoices; v_credited numeric; v_tax_credited numeric; v_tax numeric; v_net numeric; v_num text; v_id uuid; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin') then raise exception 'Only owners and admins can issue credit notes.' using errcode = '42501'; end if;
  if char_length(v_reason) < 3 then raise exception 'Give a reason for the credit note.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter an amount greater than zero with at most 2 decimals.' using errcode = '22023'; end if;
  select * into i from public.invoices where id = p_invoice and organization_id = p_org for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if i.status <> 'issued' then raise exception 'Credit notes apply to issued invoices.' using errcode = '22023'; end if;
  select coalesce(sum(amount), 0), coalesce(sum(tax_amount), 0) into v_credited, v_tax_credited from public.credit_notes where invoice_id = p_invoice;
  if p_amount > i.total - v_credited then raise exception 'A credit note cannot exceed what is left to credit on the invoice (%).', i.total - v_credited using errcode = '22023'; end if;
  -- tax is reversed in proportion; the final credit takes the exact remainder so net + tax of all credit notes never exceeds the invoice
  v_tax := case when p_amount = i.total - v_credited then i.tax_total - v_tax_credited else round(p_amount * i.tax_total / i.total, 2) end; v_net := p_amount - v_tax;
  v_num := public.billing_next_number(p_org, 'credit_note');
  insert into public.credit_notes (organization_id, invoice_id, number, amount, net_amount, tax_amount, reason, snapshot, issued_by)
    values (p_org, p_invoice, v_num, p_amount, v_net, v_tax, v_reason, jsonb_build_object('invoice_number', i.number, 'currency', i.currency, 'invoice_total', i.total, 'amount', p_amount, 'net_amount', v_net, 'tax_amount', v_tax, 'reason', v_reason), v_uid) returning id into v_id;
  insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id, actor_id) values (p_org, p_invoice, 'credit_note', -p_amount, v_id, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'credit_note.issued', jsonb_build_object('credit_note_id', v_id, 'invoice_id', p_invoice, 'amount', p_amount, 'reason', left(v_reason, 200)));
  perform public.crm_emit(p_org, 'credit_note.issued', 'credit_note', v_id, jsonb_build_object('credit_note_id', v_id, 'invoice_id', p_invoice, 'number', v_num, 'invoice_number', i.number, 'amount', p_amount, 'currency', i.currency, 'balance_due', public.billing_balance(p_invoice), 'contact_id', i.contact_id));
  return v_num;
end $$;

-- a refund returns money to the customer, and only up to what the customer is OWED (a credit balance created by credit notes), never more than they actually paid
create or replace function public.refund_record(p_org uuid, p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_reason text, p_key text default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); i public.invoices; v_bal numeric; v_net_cash numeric; v_id uuid; v_existing uuid; v_reason text := btrim(coalesce(p_reason, ''));
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin') then raise exception 'Only owners and admins can record refunds.' using errcode = '42501'; end if;
  if char_length(v_reason) < 3 then raise exception 'Give a reason for the refund.' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then raise exception 'Enter an amount greater than zero with at most 2 decimals.' using errcode = '22023'; end if;
  if p_method not in ('cash','bank_transfer','card','upi','cheque','other') then raise exception 'Choose a refund method.' using errcode = '22023'; end if;
  if nullif(btrim(p_key), '') is not null then select id into v_existing from public.invoice_payments where organization_id = p_org and idempotency_key = btrim(p_key); if found then return v_existing; end if; end if;
  select * into i from public.invoices where id = p_invoice and organization_id = p_org for update;
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  if i.status <> 'issued' then raise exception 'Refunds apply to issued invoices.' using errcode = '22023'; end if;
  v_bal := public.billing_balance(p_invoice);
  select coalesce(sum(case when kind = 'payment' then amount else -amount end), 0) into v_net_cash from public.invoice_payments where invoice_id = p_invoice;
  if p_amount > greatest(-v_bal, 0) then raise exception 'There is only % owed to the customer on this invoice (issue a credit note first).', greatest(-v_bal, 0) using errcode = '22023'; end if;
  if p_amount > v_net_cash then raise exception 'A refund cannot exceed the money actually received (%).', v_net_cash using errcode = '22023'; end if;
  insert into public.invoice_payments (organization_id, invoice_id, kind, amount, method, reference, note, source, idempotency_key, recorded_by) values (p_org, p_invoice, 'refund', p_amount, p_method, left(btrim(p_reference), 80), left(v_reason, 300), 'manual', nullif(btrim(p_key), ''), v_uid) returning id into v_id;
  insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id, actor_id) values (p_org, p_invoice, 'refund', p_amount, v_id, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'payment.refunded', jsonb_build_object('invoice_id', p_invoice, 'payment_id', v_id, 'amount', p_amount, 'reason', left(v_reason, 200)));
  perform public.crm_emit(p_org, 'payment.refunded', 'payment', v_id, jsonb_build_object('payment_id', v_id, 'invoice_id', p_invoice, 'number', i.number, 'amount', p_amount, 'currency', i.currency, 'method', p_method, 'balance_due', v_bal + p_amount, 'contact_id', i.contact_id));
  return v_id;
end $$;

-- the ledger must equal the documents; returns problems (none when healthy)
create or replace function public.billing_reconcile(p_org uuid) returns table (invoice_id uuid, ledger_balance numeric, expected_balance numeric) language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can reconcile billing.' using errcode = '42501'; end if;
  return query
    select i.id, coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0),
      i.total - coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'payment'), 0) + coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'refund'), 0)
      - coalesce((select sum(c.amount) from public.credit_notes c where c.invoice_id = i.id), 0)
    from public.invoices i where i.organization_id = p_org and i.status = 'issued'
      and coalesce((select sum(l.amount) from public.invoice_ledger l where l.invoice_id = i.id), 0) <>
        i.total - coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'payment'), 0) + coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'refund'), 0)
        - coalesce((select sum(c.amount) from public.credit_notes c where c.invoice_id = i.id), 0);
end $$;

revoke all on function public.invoices_guard(), public.invoice_lines_guard(), public.billing_calc(uuid, jsonb), public.invoice_payload(public.invoices), public.billing_next_number(uuid, text), public.billing_balance(uuid),
  public.billing_post_payment(uuid, uuid, numeric, text, text, text, timestamptz, text, uuid, text, text, uuid) from public, anon, authenticated;
revoke all on function public.billing_apply_provider_payment(uuid, uuid, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.billing_apply_provider_payment(uuid, uuid, numeric, text, text, text) to service_role;
revoke all on function public.invoice_save_draft(uuid, uuid, uuid, uuid, text, date, text, jsonb), public.invoice_issue(uuid, uuid), public.invoice_cancel_draft(uuid, uuid),
  public.payment_record(uuid, uuid, numeric, text, text, text, timestamptz, text), public.credit_note_issue(uuid, uuid, numeric, text), public.refund_record(uuid, uuid, numeric, text, text, text, text), public.billing_reconcile(uuid) from public, anon;
grant execute on function public.invoice_save_draft(uuid, uuid, uuid, uuid, text, date, text, jsonb), public.invoice_issue(uuid, uuid), public.invoice_cancel_draft(uuid, uuid),
  public.payment_record(uuid, uuid, numeric, text, text, text, timestamptz, text), public.credit_note_issue(uuid, uuid, numeric, text), public.refund_record(uuid, uuid, numeric, text, text, text, text), public.billing_reconcile(uuid) to authenticated;
