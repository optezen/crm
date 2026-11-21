-- 0016: Operations fixes and stricter reconciliation. 0001-0015 are untouched. Nothing here edits historical rows: the reconcile functions only REPORT.
--
-- 1. Time zones: staff_time_off_add_local() takes WALL-CLOCK times and interprets them in the ORGANIZATION time zone (operations.appointments.timezone), instead of
--    whatever time zone the browser happened to use. The older timestamptz function is unchanged.
-- 2. Stricter reconciliation (read-only, managers and above):
--    inventory_reconcile_v2: levels vs ledger, negative levels where not allowed, broken running balances, unbalanced transfers, batch/product tracking mismatches.
--    billing_reconcile_v2: ledger vs documents, missing/orphan ledger rows, drafts with ledger entries, snapshot vs row totals, line totals vs invoice totals, credit-note tax overrun.
-- 3. invoice_pdf_access(): the single, audited way the PDF route reads an issued invoice's immutable snapshot.
create or replace function public.staff_time_off_add_local(p_org uuid, p_user uuid, p_start_local timestamp, p_end_local timestamp, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_tz text := coalesce(public.ops_config(p_org, 'appointments')->>'timezone', 'UTC');
begin
  if public.ops_require(p_org, 'appointments') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can record time off.' using errcode = '42501'; end if;
  return public.staff_time_off_add(p_org, p_user, p_start_local at time zone v_tz, p_end_local at time zone v_tz, p_reason);
end $$;

create or replace function public.inventory_reconcile_v2(p_org uuid) returns table (problem text, product_id uuid, location_id uuid, batch_id uuid, detail text) language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can reconcile stock.' using errcode = '42501'; end if;
  return query
    select 'level_differs_from_ledger', coalesce(l.product_id, m.product_id), coalesce(l.location_id, m.location_id), coalesce(l.batch_id, m.batch_id), format('level %s, ledger %s', coalesce(l.quantity, 0), coalesce(m.q, 0))
    from (select * from public.stock_levels where organization_id = p_org) l
    full join (select s.product_id, s.location_id, s.batch_id, sum(s.quantity_delta) q from public.stock_movements s where s.organization_id = p_org group by 1, 2, 3) m on m.product_id = l.product_id and m.location_id = l.location_id and m.batch_id is not distinct from l.batch_id
    where coalesce(l.quantity, 0) <> coalesce(m.q, 0)
    union all
    select 'negative_level', l.product_id, l.location_id, l.batch_id, format('quantity %s', l.quantity) from public.stock_levels l where l.organization_id = p_org and l.quantity < 0 and not public.inventory_allows_negative(p_org)
    union all
    select 'broken_running_balance', r.product_id, r.location_id, r.batch_id, format('movement %s: balance_after %s, expected %s', r.seq, r.balance_after, r.running)
    from (select s.seq, s.product_id, s.location_id, s.batch_id, s.balance_after, sum(s.quantity_delta) over (partition by s.product_id, s.location_id, s.batch_id order by s.seq) running from public.stock_movements s where s.organization_id = p_org) r where r.balance_after <> r.running
    union all
    select 'unbalanced_transfer', null::uuid, null::uuid, null::uuid, format('transfer %s nets %s', t.transfer_id, t.net) from (select transfer_id, sum(quantity_delta) net from public.stock_movements where organization_id = p_org and transfer_id is not null group by 1) t where t.net <> 0
    union all
    select 'batch_tracking_mismatch', s.product_id, s.location_id, s.batch_id, format('movement %s', s.seq) from public.stock_movements s join public.products p on p.id = s.product_id where s.organization_id = p_org and (p.track_batches <> (s.batch_id is not null));
end $$;

create or replace function public.billing_reconcile_v2(p_org uuid) returns table (problem text, invoice_id uuid, detail text) language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can reconcile billing.' using errcode = '42501'; end if;
  return query
    select 'ledger_differs_from_documents', i.id, format('ledger %s, documents %s', b.l, i.total - b.p + b.r - b.c)
    from public.invoices i cross join lateral (select coalesce((select sum(x.amount) from public.invoice_ledger x where x.invoice_id = i.id), 0) l, coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'payment'), 0) p,
      coalesce((select sum(p.amount) from public.invoice_payments p where p.invoice_id = i.id and p.kind = 'refund'), 0) r, coalesce((select sum(c.amount) from public.credit_notes c where c.invoice_id = i.id), 0) c) b
    where i.organization_id = p_org and i.status = 'issued' and b.l <> i.total - b.p + b.r - b.c
    union all
    select 'issued_without_invoice_entry', i.id, 'no ledger row of kind invoice' from public.invoices i where i.organization_id = p_org and i.status = 'issued' and not exists (select 1 from public.invoice_ledger l where l.invoice_id = i.id and l.kind = 'invoice')
    union all
    select 'ledger_on_unissued_invoice', i.id, 'a draft or cancelled invoice has ledger entries' from public.invoices i where i.organization_id = p_org and i.status <> 'issued' and exists (select 1 from public.invoice_ledger l where l.invoice_id = i.id)
    union all
    select 'payment_without_ledger_entry', p.invoice_id, format('%s %s', p.kind, p.id) from public.invoice_payments p where p.organization_id = p_org and not exists (select 1 from public.invoice_ledger l where l.ref_id = p.id and l.kind = p.kind)
    union all
    select 'ledger_entry_without_document', l.invoice_id, format('%s %s', l.kind, l.ref_id) from public.invoice_ledger l where l.organization_id = p_org and l.kind in ('payment','refund') and not exists (select 1 from public.invoice_payments p where p.id = l.ref_id and p.kind = l.kind)
    union all
    select 'ledger_entry_without_document', l.invoice_id, format('credit_note %s', l.ref_id) from public.invoice_ledger l where l.organization_id = p_org and l.kind = 'credit_note' and not exists (select 1 from public.credit_notes c where c.id = l.ref_id)
    union all
    select 'snapshot_differs_from_invoice', i.id, format('snapshot %s, invoice %s', i.snapshot->>'total', i.total) from public.invoices i where i.organization_id = p_org and i.status = 'issued' and (i.snapshot->>'total')::numeric <> i.total
    union all
    select 'lines_differ_from_invoice', i.id, format('lines %s, invoice %s', s.t, i.total) from public.invoices i cross join lateral (select coalesce(sum(il.line_total), 0) t from public.invoice_lines il where il.invoice_id = i.id) s where i.organization_id = p_org and i.status = 'issued' and s.t <> i.total
    union all
    select 'credit_notes_exceed_invoice', i.id, format('credited %s of %s', c.a, i.total) from public.invoices i cross join lateral (select coalesce(sum(cn.amount), 0) a, coalesce(sum(cn.tax_amount), 0) t from public.credit_notes cn where cn.invoice_id = i.id) c where i.organization_id = p_org and (c.a > i.total or c.t > i.tax_total);
end $$;

-- the PDF route's only way in: manager+ with billing view permission, an ISSUED invoice, its frozen snapshot, and an audit row
create or replace function public.invoice_pdf_access(p_org uuid, p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org); i public.invoices;
begin
  if v_role not in ('owner','admin','manager') or not public.perm_ok(p_org, 'billing', 'view') then raise exception 'Only owners, admins and managers can download invoices.' using errcode = '42501'; end if;
  select * into i from public.invoices where id = p_id and organization_id = p_org;
  if not found or i.status <> 'issued' or not public.perm_scope_ok(p_org, 'billing', null, i.created_by) then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'invoice.pdf_downloaded', jsonb_build_object('invoice_id', i.id, 'number', i.number));
  return jsonb_build_object('number', i.number, 'snapshot', i.snapshot);
end $$;

revoke all on function public.staff_time_off_add_local(uuid, uuid, timestamp, timestamp, text), public.inventory_reconcile_v2(uuid), public.billing_reconcile_v2(uuid), public.invoice_pdf_access(uuid, uuid) from public, anon;
grant execute on function public.staff_time_off_add_local(uuid, uuid, timestamp, timestamp, text), public.inventory_reconcile_v2(uuid), public.billing_reconcile_v2(uuid), public.invoice_pdf_access(uuid, uuid) to authenticated;
