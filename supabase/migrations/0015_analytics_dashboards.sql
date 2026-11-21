-- 0015: Analytics, reporting, dashboards. 0001-0014 are untouched.
--
-- THE QUERY GRAMMAR (no SQL from users, the browser or the AI ever reaches the database):
--   {"source": "leads|tasks|appointments|stock_movements|inventory|batches|invoices|payments|records:<module key>",
--    "metric": {"agg": "count|count_distinct|sum|avg|min|max", "field": "<field>"},
--    "group_by": [{"field": "<field>", "bucket": "day|week|month"}],           -- at most 2; buckets only for date fields
--    "filters": [{"field": "<field>", "op": "eq|neq|in|gt|gte|lt|lte|contains|is_null|not_null", "value": ...}],   -- at most 10
--    "date": {"field": "<date field>", "range": "last_7_days|last_30_days|last_90_days|this_month|last_month|this_year|next_7_days|next_30_days|custom", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD"},
--    "tz": "<IANA zone>", "order": {"by": "value|group", "dir": "asc|desc"}, "limit": 1..100}
-- Every identifier comes from the whitelist in analytics_field_rows(); every value is cast and quoted with quote_literal. The query runs as the signed-in user
-- (SECURITY INVOKER), so row level security, record visibility scopes and location restrictions apply to every widget and every report; the module `view`
-- permission is checked explicitly for a clear error. Exports additionally need the module `export` permission and are audited.
-- Money is never mixed: a sum/avg/min/max over a money field must group by currency or filter to one currency. Quantities of different products are never added:
-- they must be grouped (or filtered) by product.

create or replace view public.analytics_batches with (security_invoker = true) as
  select b.organization_id, b.id as batch_id, p.sku, b.lot_code, b.expiry_date, coalesce(sum(l.quantity), 0)::numeric(18,3) as on_hand, (b.expiry_date - current_date) as days_to_expiry
  from public.stock_batches b join public.products p on p.id = b.product_id left join public.stock_levels l on l.batch_id = b.id group by b.id, p.sku;
revoke all on public.analytics_batches from anon, authenticated; grant select on public.analytics_batches to authenticated;

create or replace function public.analytics_user_label(p_org uuid, p_user uuid) returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if p_user is null then return null; end if;
  perform public.ai_ctx(p_org);
  return (select u.email::text from auth.users u join public.organization_members m on m.user_id = u.id where m.organization_id = p_org and m.user_id = p_user);
end $$;

-- ---------- the catalog: ONE definition of every source and field ----------
create or replace function public.analytics_source_info(p_org uuid, p_source text) returns table (from_sql text, module text, label text, extra_where text, product_field text) language plpgsql stable security invoker set search_path = '' as $$
declare v_key text;
begin
  return query select * from (values
    ('public.leads t left join lateral (select min(a.created_at) filter (where a.kind in (''note'',''task_created'',''task_completed'',''stage_changed'',''updated'') and coalesce(a.meta->>''automation'', '''') <> ''true'') as ft, min(a.created_at) filter (where a.kind = ''assigned'') as fa from public.lead_activities a where a.lead_id = t.id) x on true', 'leads', 'Leads', null::text, null::text),
    ('public.tasks t', 'tasks', 'Follow-up tasks', null, null),
    ('public.appointments t', 'appointments', 'Appointments', null, null),
    ('public.stock_movements t join public.products p on p.id = t.product_id join public.inventory_locations l on l.id = t.location_id', 'inventory', 'Stock movements', null, 'product'),
    ('public.inventory_on_hand t', 'inventory', 'Inventory levels', null, 'sku'),
    ('public.analytics_batches t', 'inventory', 'Batches and expiry', null, 'sku'),
    ('public.invoice_balances t join public.invoices i on i.id = t.invoice_id', 'billing', 'Invoices', null, null),
    ('public.invoice_payments t join public.invoices i on i.id = t.invoice_id', 'billing', 'Payments and refunds', null, null)
  ) v(f, m, l, w, pf) where (p_source, v.m) is not null and (
    (p_source = 'leads' and v.l = 'Leads') or (p_source = 'tasks' and v.l = 'Follow-up tasks') or (p_source = 'appointments' and v.l = 'Appointments') or (p_source = 'stock_movements' and v.l = 'Stock movements')
    or (p_source = 'inventory' and v.l = 'Inventory levels') or (p_source = 'batches' and v.l = 'Batches and expiry') or (p_source = 'invoices' and v.l = 'Invoices') or (p_source = 'payments' and v.l = 'Payments and refunds'));
  if p_source like 'records:%' then
    v_key := substr(p_source, 9);
    if v_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and exists (select 1 from public.workspace_configuration_versions c, jsonb_array_elements(c.definition->'modules') m where c.organization_id = p_org and c.status = 'published' and m.value->>'key' = v_key and m.value->>'status' = 'active')
       and v_key not in ('overview','leads') then
      return query select 'public.records t'::text, 'custom:' || v_key, (select o.value->>'label' from public.workspace_configuration_versions c, jsonb_array_elements(c.definition->'objects') o where c.organization_id = p_org and c.status = 'published' and o.value->>'key' = v_key order by c.revision desc limit 1),
        format('t.object_key = %L', v_key), null::text;
    end if;
  end if;
end $$;

create or replace function public.analytics_field_rows(p_org uuid, p_source text) returns table (field text, label text, expr text, ftype text, groupable boolean, filterable boolean, aggregatable boolean, money_fixed text, user_ref boolean)
language plpgsql stable security invoker set search_path = '' as $$
declare f jsonb; k text; v_def jsonb;
begin
  if p_source like 'records:%' then
    return query select * from (values ('created_at', 'Created', 't.created_at', 'timestamp', true, true, false, null::text, false), ('created_by', 'Created by', 't.created_by', 'uuid', true, true, false, null, true)) x;
    select c.definition into v_def from public.workspace_configuration_versions c where c.organization_id = p_org and c.status = 'published' order by c.revision desc limit 1;
    for f in select e.value from jsonb_array_elements(coalesce((select o.value->'fields' from jsonb_array_elements(coalesce(v_def->'objects', '[]'::jsonb)) o where o.value->>'key' = substr(p_source, 9)), '[]'::jsonb)) e loop
      continue when coalesce((f->>'archived')::boolean, false) or f->>'key' !~ '^[a-z][a-z0-9_]*$'; k := f->>'key';
      field := 'f_' || k; label := f->>'label';
      case f->>'kind'
        when 'text' then expr := format('(t.data->>%L)', k); ftype := 'text'; groupable := true; filterable := true; aggregatable := false; money_fixed := null;
        when 'choice' then expr := format('(t.data->>%L)', k); ftype := 'text'; groupable := true; filterable := true; aggregatable := false; money_fixed := null;
        when 'yes_no' then expr := format('((t.data->>%L)::boolean)', k); ftype := 'bool'; groupable := true; filterable := true; aggregatable := false; money_fixed := null;
        when 'number' then expr := format('((t.data->>%L)::numeric)', k); ftype := 'number'; groupable := false; filterable := true; aggregatable := true; money_fixed := null;
        when 'currency' then expr := format('((t.data->>%L)::numeric)', k); ftype := 'money'; groupable := false; filterable := true; aggregatable := true; money_fixed := coalesce(f->>'currency', 'INR');
        when 'date' then expr := format('((t.data->>%L)::date)', k); ftype := 'date'; groupable := true; filterable := true; aggregatable := true; money_fixed := null;
        else continue; -- phone and email values are personal data and are not available to analytics
      end case;
      user_ref := false; return next;
    end loop;
    return;
  end if;
  return query select v.f, v.l, v.e, v.t, v.g, v.fl, v.a, v.mf, v.u from (values
    ('leads', 'stage', 'Stage', 't.stage', 'text', true, true, false, null::text, false), ('leads', 'source', 'Lead source', 't.source', 'text', true, true, false, null, false), ('leads', 'assigned_to', 'Assigned to', 't.assigned_to', 'uuid', true, true, false, null, true),
    ('leads', 'created_at', 'Created', 't.created_at', 'timestamp', true, true, false, null, false), ('leads', 'is_assigned', 'Is assigned', '(t.assigned_to is not null)', 'bool', true, true, false, null, false),
    ('leads', 'hours_to_first_touch', 'Hours to first human touch', 'extract(epoch from (x.ft - t.created_at)) / 3600.0', 'number', false, true, true, null, false),
    ('leads', 'hours_to_assignment', 'Hours to assignment', 'extract(epoch from (x.fa - t.created_at)) / 3600.0', 'number', false, true, true, null, false),
    ('tasks', 'status', 'Status', 't.status', 'text', true, true, false, null, false), ('tasks', 'owner_id', 'Owner', 't.owner_id', 'uuid', true, true, false, null, true), ('tasks', 'completed_by', 'Completed by', 't.completed_by', 'uuid', true, true, false, null, true),
    ('tasks', 'created_at', 'Created', 't.created_at', 'timestamp', true, true, false, null, false), ('tasks', 'due_date', 'Due date', 't.due_date', 'date', true, true, true, null, false), ('tasks', 'completed_at', 'Completed', 't.completed_at', 'timestamp', true, true, false, null, false),
    ('tasks', 'is_overdue', 'Is overdue (open and past due)', '(t.status = ''open'' and t.due_date < current_date)', 'bool', true, true, false, null, false),
    ('tasks', 'hours_to_complete', 'Hours to complete', 'extract(epoch from (t.completed_at - t.created_at)) / 3600.0', 'number', false, true, true, null, false),
    ('appointments', 'status', 'Status', 't.status', 'text', true, true, false, null, false), ('appointments', 'type', 'Type', '(select ty.name from public.appointment_types ty where ty.id = t.type_id)', 'text', true, true, false, null, false),
    ('appointments', 'staff_id', 'Staff', 't.staff_id', 'uuid', true, true, false, null, true), ('appointments', 'starts_at', 'Starts', 't.starts_at', 'timestamp', true, true, false, null, false), ('appointments', 'created_at', 'Booked', 't.created_at', 'timestamp', true, true, false, null, false),
    ('appointments', 'duration_minutes', 'Duration (minutes)', 'extract(epoch from (t.ends_at - t.starts_at)) / 60.0', 'number', false, true, true, null, false), ('appointments', 'reschedule_count', 'Times rescheduled', 't.reschedule_count', 'number', false, true, true, null, false),
    ('stock_movements', 'kind', 'Kind', 't.kind', 'text', true, true, false, null, false), ('stock_movements', 'product', 'Product (SKU)', 'p.sku', 'text', true, true, false, null, false), ('stock_movements', 'location', 'Location', 'l.name', 'text', true, true, false, null, false),
    ('stock_movements', 'created_at', 'When', 't.created_at', 'timestamp', true, true, false, null, false), ('stock_movements', 'quantity_delta', 'Quantity change (signed)', 't.quantity_delta', 'number', false, true, true, null, false), ('stock_movements', 'quantity_abs', 'Quantity moved (absolute)', 'abs(t.quantity_delta)', 'number', false, true, true, null, false),
    ('inventory', 'sku', 'SKU', 't.sku', 'text', true, true, false, null, false), ('inventory', 'name', 'Product', 't.name', 'text', true, true, false, null, false), ('inventory', 'low_stock', 'Is low on stock', 't.low_stock', 'bool', true, true, false, null, false),
    ('inventory', 'on_hand', 'Quantity on hand', 't.on_hand', 'number', false, true, true, null, false), ('inventory', 'low_stock_threshold', 'Low-stock level', 't.low_stock_threshold', 'number', false, true, true, null, false),
    ('batches', 'sku', 'SKU', 't.sku', 'text', true, true, false, null, false), ('batches', 'lot_code', 'Lot', 't.lot_code', 'text', true, true, false, null, false), ('batches', 'expiry_date', 'Expiry date', 't.expiry_date', 'date', true, true, true, null, false),
    ('batches', 'on_hand', 'Quantity on hand', 't.on_hand', 'number', false, true, true, null, false), ('batches', 'days_to_expiry', 'Days until expiry', 't.days_to_expiry', 'number', false, true, true, null, false),
    ('invoices', 'status', 'Status', 't.status', 'text', true, true, false, null, false), ('invoices', 'payment_state', 'Payment state', 't.payment_state', 'text', true, true, false, null, false), ('invoices', 'currency', 'Currency', 't.currency', 'text', true, true, false, null, false),
    ('invoices', 'issue_date', 'Issue date', 'i.issue_date', 'date', true, true, true, null, false), ('invoices', 'due_date', 'Due date', 't.due_date', 'date', true, true, true, null, false), ('invoices', 'is_overdue', 'Is overdue', 't.overdue', 'bool', true, true, false, null, false),
    ('invoices', 'total', 'Invoiced amount', 't.total', 'money', false, true, true, null, false), ('invoices', 'paid', 'Paid so far', 't.paid', 'money', false, true, true, null, false), ('invoices', 'credited', 'Credited', 't.credited', 'money', false, true, true, null, false),
    ('invoices', 'refunded', 'Refunded', 't.refunded', 'money', false, true, true, null, false), ('invoices', 'balance_due', 'Outstanding balance', 't.balance_due', 'money', false, true, true, null, false),
    ('payments', 'kind', 'Kind (payment or refund)', 't.kind', 'text', true, true, false, null, false), ('payments', 'method', 'Method', 't.method', 'text', true, true, false, null, false), ('payments', 'source', 'Source (manual or provider)', 't.source', 'text', true, true, false, null, false),
    ('payments', 'currency', 'Currency', 'i.currency', 'text', true, true, false, null, false), ('payments', 'received_at', 'Received', 't.received_at', 'timestamp', true, true, false, null, false),
    ('payments', 'amount', 'Amount', 't.amount', 'money', false, true, true, null, false), ('payments', 'signed_amount', 'Net amount (refunds negative)', '(case when t.kind = ''refund'' then -t.amount else t.amount end)', 'money', false, true, true, null, false)
  ) v(s, f, l, e, t, g, fl, a, mf, u) where v.s = p_source;
end $$;

-- ---------- validation + SQL generation (identifiers from the whitelist only, values cast and quoted) ----------
create or replace function public.analytics_build(p_org uuid, p_q jsonb, p_max integer default 100) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_role text := public.ai_ctx(p_org); v_src text := p_q->>'source'; si record; v_agg text; fr record; v_mexpr text; v_gb jsonb; g jsonb; v_i int := 0; v_sel text := ''; v_grp text := ''; v_cols jsonb := '[]'::jsonb;
  v_where text := ''; flt jsonb; v_op text; v_val jsonb; v_tz text := coalesce(p_q->>'tz', 'UTC'); v_dt jsonb := p_q->'date'; v_from date; v_to date; v_today date; v_cond text; v_def text; v_order text; v_limit int; v_has_cur boolean := false; v_has_prod boolean := false;
  v_gfields text[] := '{}'; v_gexpr text; v_mlabel text; v_filter_defs text[] := '{}'; v_n int; x text; v_first_date boolean := false; v_lit text;
begin
  if jsonb_typeof(p_q) is distinct from 'object' or exists (select 1 from jsonb_object_keys(p_q) k where k not in ('source','metric','group_by','filters','date','tz','order','limit')) or octet_length(p_q::text) > 8000 then raise exception 'The query is invalid.' using errcode = '22023'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then raise exception 'Unknown time zone.' using errcode = '22023'; end if;
  select * into si from public.analytics_source_info(p_org, v_src); if not found then raise exception 'Unknown data source "%". Use the catalog for the available sources.', coalesce(v_src, '') using errcode = '22023'; end if;
  if not public.perm_ok(p_org, si.module, 'view') or (si.module = 'billing' and v_role not in ('owner','admin','manager')) then raise exception 'You do not have access to % data.', si.label using errcode = '42501'; end if;

  -- metric
  if jsonb_typeof(p_q->'metric') is distinct from 'object' or exists (select 1 from jsonb_object_keys(p_q->'metric') k where k not in ('agg','field')) or coalesce(p_q#>>'{metric,agg}', '') not in ('count','count_distinct','sum','avg','min','max') then raise exception 'Choose a metric: count, count_distinct, sum, avg, min or max.' using errcode = '22023'; end if;
  v_agg := p_q#>>'{metric,agg}';
  if v_agg = 'count' then
    if p_q#>'{metric}' ? 'field' then raise exception 'A count takes no field.' using errcode = '22023'; end if;
    v_mexpr := 'count(*)'; v_mlabel := 'Number of ' || lower(si.label);
  else
    select * into fr from public.analytics_field_rows(p_org, v_src) r where r.field = p_q#>>'{metric,field}';
    if not found then raise exception 'Unknown field "%" for %.', coalesce(p_q#>>'{metric,field}', ''), si.label using errcode = '22023'; end if;
    if v_agg in ('sum','avg') and fr.ftype not in ('number','money') then raise exception 'sum/avg need a numeric field; "%" is %.', fr.label, fr.ftype using errcode = '22023'; end if;
    if v_agg in ('min','max') and fr.ftype not in ('number','money','date') then raise exception 'min/max need a number or date field.' using errcode = '22023'; end if;
    if v_agg <> 'count_distinct' and not fr.aggregatable then raise exception '"%" cannot be aggregated.', fr.label using errcode = '22023'; end if;
    v_mexpr := case v_agg when 'count_distinct' then format('count(distinct %s)', fr.expr) when 'sum' then format('sum(%s)', fr.expr) when 'avg' then format('round(avg(%s)::numeric, 2)', fr.expr) else format('%s(%s)', v_agg, fr.expr) end;
    v_mlabel := initcap(replace(v_agg, '_', ' ')) || ' of ' || fr.label;
    if v_agg in ('sum','avg') and fr.ftype = 'number' and si.product_field is not null then v_has_prod := false; end if;
  end if;

  -- grouping
  v_gb := coalesce(p_q->'group_by', '[]'::jsonb);
  if jsonb_typeof(v_gb) is distinct from 'array' or jsonb_array_length(v_gb) > 2 then raise exception 'Group by at most two fields.' using errcode = '22023'; end if;
  for g in select * from jsonb_array_elements(v_gb) loop
    v_i := v_i + 1;
    if jsonb_typeof(g) is distinct from 'object' or exists (select 1 from jsonb_object_keys(g) k where k not in ('field','bucket')) then raise exception 'Invalid grouping.' using errcode = '22023'; end if;
    select * into fr from public.analytics_field_rows(p_org, v_src) r where r.field = g->>'field'; if not found or not fr.groupable then raise exception 'You cannot group by "%".', coalesce(g->>'field', '') using errcode = '22023'; end if;
    if g->>'field' = any(v_gfields) then raise exception 'Duplicate grouping.' using errcode = '22023'; end if; v_gfields := array_append(v_gfields, g->>'field');
    if fr.ftype in ('date','timestamp') then
      if coalesce(g->>'bucket', '') not in ('day','week','month') then raise exception 'Grouping by the date "%" needs a bucket: day, week or month.', fr.label using errcode = '22023'; end if;
      v_gexpr := case when fr.ftype = 'timestamp' then format('to_char(date_trunc(%L, (%s at time zone %L)), ''YYYY-MM-DD'')', g->>'bucket', fr.expr, v_tz) else format('to_char(date_trunc(%L, (%s)::timestamp), ''YYYY-MM-DD'')', g->>'bucket', fr.expr) end;
      if v_i = 1 then v_first_date := true; end if;
    else
      if g ? 'bucket' then raise exception 'Only dates can be bucketed.' using errcode = '22023'; end if; v_gexpr := fr.expr;
    end if;
    v_sel := v_sel || format('%s as g%s, ', v_gexpr, v_i); v_grp := v_grp || case when v_grp = '' then '' else ', ' end || v_gexpr;
    if fr.user_ref then v_sel := v_sel || format('public.analytics_user_label(%L::uuid, %s) as g%s_label, ', p_org, v_gexpr, v_i); end if;
    v_cols := v_cols || jsonb_build_object('key', 'g' || v_i, 'label', fr.label || coalesce(' (' || (g->>'bucket') || ')', ''), 'type', case when fr.ftype in ('date','timestamp') then 'date' else fr.ftype end, 'user', fr.user_ref);
    v_def := coalesce(v_def || ', ', '') || fr.label || coalesce(' by ' || (g->>'bucket'), '');
    if g->>'field' = 'currency' then v_has_cur := true; end if; if g->>'field' = si.product_field then v_has_prod := true; end if;
  end loop;

  -- filters
  if jsonb_typeof(coalesce(p_q->'filters', '[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(p_q->'filters', '[]'::jsonb)) > 10 then raise exception 'Use at most 10 filters.' using errcode = '22023'; end if;
  for flt in select * from jsonb_array_elements(coalesce(p_q->'filters', '[]'::jsonb)) loop
    if jsonb_typeof(flt) is distinct from 'object' or exists (select 1 from jsonb_object_keys(flt) k where k not in ('field','op','value')) then raise exception 'Invalid filter.' using errcode = '22023'; end if;
    select * into fr from public.analytics_field_rows(p_org, v_src) r where r.field = flt->>'field'; if not found or not fr.filterable then raise exception 'You cannot filter by "%".', coalesce(flt->>'field', '') using errcode = '22023'; end if;
    v_op := flt->>'op'; v_val := flt->'value';
    if coalesce(v_op, '') not in ('eq','neq','in','gt','gte','lt','lte','contains','is_null','not_null') then raise exception 'Unknown filter operator.' using errcode = '22023'; end if;
    if v_op in ('is_null','not_null') then
      if flt ? 'value' then raise exception 'is_null / not_null take no value.' using errcode = '22023'; end if;
      v_cond := format('%s is %snull', fr.expr, case when v_op = 'not_null' then 'not ' else '' end);
    else
      if not flt ? 'value' then raise exception 'The filter on "%" needs a value.', fr.label using errcode = '22023'; end if;
      if v_op = 'in' then
        if jsonb_typeof(v_val) is distinct from 'array' or jsonb_array_length(v_val) not between 1 and 20 then raise exception 'in needs a list of 1 to 20 values.' using errcode = '22023'; end if;
      elsif jsonb_typeof(v_val) not in ('string','number','boolean') then raise exception 'Invalid filter value.' using errcode = '22023'; end if;
      if fr.ftype = 'text' then
        if v_op not in ('eq','neq','in','contains') then raise exception 'Text fields support eq, neq, in and contains.' using errcode = '22023'; end if;
        if v_op = 'in' then
          if exists (select 1 from jsonb_array_elements(v_val) e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > 200) then raise exception 'Invalid filter value.' using errcode = '22023'; end if;
          v_cond := format('%s in (%s)', fr.expr, (select string_agg(quote_literal(e #>> '{}'), ', ') from jsonb_array_elements(v_val) e));
        else
          if jsonb_typeof(v_val) <> 'string' or char_length(v_val #>> '{}') > 200 then raise exception 'Invalid filter value.' using errcode = '22023'; end if;
          v_cond := case v_op when 'eq' then format('%s = %L', fr.expr, v_val #>> '{}') when 'neq' then format('%s is distinct from %L', fr.expr, v_val #>> '{}')
            else format('%s ilike %L', fr.expr, '%' || replace(replace(replace(v_val #>> '{}', '\', '\\'), '%', '\%'), '_', '\_') || '%') end;
        end if;
      elsif fr.ftype = 'uuid' then
        if v_op not in ('eq','neq','in') then raise exception 'Id fields support eq, neq and in.' using errcode = '22023'; end if;
        if v_op = 'in' then
          if exists (select 1 from jsonb_array_elements(v_val) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'Invalid id in filter.' using errcode = '22023'; end if;
          v_cond := format('%s in (%s)', fr.expr, (select string_agg(quote_literal(e #>> '{}') || '::uuid', ', ') from jsonb_array_elements(v_val) e));
        else
          v_lit := v_val #>> '{}';
          if v_lit = '$me' then v_cond := format('%s %s (select auth.uid())', fr.expr, case when v_op = 'eq' then '=' else 'is distinct from' end); -- "my records", resolved for whoever runs the query
          elsif v_lit !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid id in filter.' using errcode = '22023';
          else v_cond := format('%s %s %L::uuid', fr.expr, case when v_op = 'eq' then '=' else 'is distinct from' end, v_lit); end if;
        end if;
      elsif fr.ftype in ('number','money') then
        if v_op = 'contains' then raise exception 'contains is for text fields.' using errcode = '22023'; end if;
        if v_op = 'in' then
          if exists (select 1 from jsonb_array_elements(v_val) e where jsonb_typeof(e) <> 'number') then raise exception 'Invalid number in filter.' using errcode = '22023'; end if;
          v_cond := format('%s in (%s)', fr.expr, (select string_agg((e #>> '{}')::numeric::text, ', ') from jsonb_array_elements(v_val) e));
        else
          if jsonb_typeof(v_val) <> 'number' then raise exception 'Invalid number in filter.' using errcode = '22023'; end if;
          v_cond := format('%s %s %s', fr.expr, case v_op when 'eq' then '=' when 'neq' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end, (v_val #>> '{}')::numeric);
        end if;
      elsif fr.ftype in ('date','timestamp') then
        if v_op in ('in','contains') then raise exception 'Dates support eq, neq, gt, gte, lt and lte.' using errcode = '22023'; end if;
        v_lit := v_val #>> '{}'; if jsonb_typeof(v_val) <> 'string' or (v_lit <> 'today' and v_lit !~ '^\d{4}-\d{2}-\d{2}$') then raise exception 'Dates are YYYY-MM-DD or "today".' using errcode = '22023'; end if;
        v_cond := format('%s %s %s', case when fr.ftype = 'timestamp' then format('(%s at time zone %L)::date', fr.expr, v_tz) else format('(%s)::date', fr.expr) end, case v_op when 'eq' then '=' when 'neq' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,
          case when v_lit = 'today' then format('(now() at time zone %L)::date', v_tz) else quote_literal(v_lit) || '::date' end);
      else -- bool
        if v_op not in ('eq','neq') or jsonb_typeof(v_val) <> 'boolean' then raise exception 'Yes/no fields support eq and neq with true or false.' using errcode = '22023'; end if;
        v_cond := format('%s %s %s', fr.expr, case when v_op = 'eq' then 'is not distinct from' else 'is distinct from' end, v_val #>> '{}');
      end if;
      if flt->>'field' = 'currency' and v_op = 'eq' then v_has_cur := true; end if; if flt->>'field' = si.product_field and v_op = 'eq' then v_has_prod := true; end if;
    end if;
    v_where := v_where || ' and ' || v_cond; v_filter_defs := array_append(v_filter_defs, fr.label || ' ' || v_op);
  end loop;

  -- date range
  if v_dt is not null then
    if jsonb_typeof(v_dt) is distinct from 'object' or exists (select 1 from jsonb_object_keys(v_dt) k where k not in ('field','range','from','to')) then raise exception 'Invalid date range.' using errcode = '22023'; end if;
    select * into fr from public.analytics_field_rows(p_org, v_src) r where r.field = v_dt->>'field'; if not found or fr.ftype not in ('date','timestamp') then raise exception 'The date range needs a date field of this source.' using errcode = '22023'; end if;
    v_today := (now() at time zone v_tz)::date;
    case v_dt->>'range'
      when 'last_7_days' then v_from := v_today - 6; v_to := v_today + 1; when 'last_30_days' then v_from := v_today - 29; v_to := v_today + 1; when 'last_90_days' then v_from := v_today - 89; v_to := v_today + 1;
      when 'this_month' then v_from := date_trunc('month', v_today)::date; v_to := (date_trunc('month', v_today) + interval '1 month')::date; when 'last_month' then v_from := (date_trunc('month', v_today) - interval '1 month')::date; v_to := date_trunc('month', v_today)::date;
      when 'this_year' then v_from := date_trunc('year', v_today)::date; v_to := (date_trunc('year', v_today) + interval '1 year')::date; when 'next_7_days' then v_from := v_today; v_to := v_today + 8; when 'next_30_days' then v_from := v_today; v_to := v_today + 31;
      when 'custom' then
        if coalesce(v_dt->>'from', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(v_dt->>'to', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'A custom range needs from and to dates (YYYY-MM-DD).' using errcode = '22023'; end if;
        begin v_from := (v_dt->>'from')::date; v_to := (v_dt->>'to')::date + 1; exception when others then raise exception 'Invalid date.' using errcode = '22023'; end;
        if v_to <= v_from or v_to - v_from > 1830 then raise exception 'The date range must be between 1 day and 5 years.' using errcode = '22023'; end if;
      else raise exception 'Unknown date range.' using errcode = '22023';
    end case;
    v_where := v_where || case when fr.ftype = 'timestamp' then format(' and (%s at time zone %L) >= %L::timestamp and (%s at time zone %L) < %L::timestamp', fr.expr, v_tz, v_from, fr.expr, v_tz, v_to) else format(' and (%s) >= %L::date and (%s) < %L::date', fr.expr, v_from, fr.expr, v_to) end;
    v_def := coalesce(v_def, '');
  end if;

  -- cross-currency and cross-product safety
  if v_agg <> 'count' and v_agg <> 'count_distinct' then
    select * into fr from public.analytics_field_rows(p_org, v_src) r where r.field = p_q#>>'{metric,field}';
    if fr.ftype = 'money' and fr.money_fixed is null and not v_has_cur then raise exception 'Amounts in different currencies are never combined. Group by currency or filter to one currency.' using errcode = '22023'; end if;
    if fr.ftype = 'number' and si.product_field is not null and v_agg in ('sum','avg') and not v_has_prod then raise exception 'Quantities of different products are never added together. Group by % or filter to one product.', si.product_field using errcode = '22023'; end if;
  end if;

  -- order and limit
  v_limit := coalesce((p_q->>'limit')::int, case when p_max > 100 then p_max else 50 end); if v_limit not between 1 and greatest(100, p_max) then raise exception 'The limit must be between 1 and %.', greatest(100, p_max) using errcode = '22023'; end if; v_limit := least(v_limit, greatest(p_max, 1));
  if p_q ? 'order' then
    if jsonb_typeof(p_q->'order') is distinct from 'object' or coalesce(p_q#>>'{order,by}', '') not in ('value','group') or coalesce(p_q#>>'{order,dir}', 'desc') not in ('asc','desc') or (p_q#>>'{order,by}' = 'group' and v_i = 0) then raise exception 'Invalid order.' using errcode = '22023'; end if;
    v_order := case when p_q#>>'{order,by}' = 'value' then 'value ' else 'g1 ' end || coalesce(p_q#>>'{order,dir}', 'desc');
  else v_order := case when v_first_date then 'g1 asc' when v_i > 0 then 'value desc' else 'value desc' end; end if;
  v_cols := v_cols || jsonb_build_object('key', 'value', 'label', v_mlabel, 'type', case when v_agg in ('count','count_distinct') then 'count' else 'number' end);
  return jsonb_build_object('sql', format('select %s%s as value from %s where t.organization_id = %L::uuid%s%s%s%s order by %s limit %s', v_sel, v_mexpr, si.from_sql, p_org, coalesce(' and ' || si.extra_where, ''), v_where, '', case when v_grp = '' then '' else ' group by ' || v_grp end, v_order, v_limit),
    'columns', v_cols, 'module', si.module, 'source_label', si.label, 'definition', v_mlabel || ' · ' || si.label || case when v_def is not null then ' · grouped by ' || v_def else '' end || case when array_length(v_filter_defs, 1) > 0 then ' · filtered by ' || array_to_string(v_filter_defs, ', ') else '' end
      || case when v_dt is not null then ' · ' || replace(v_dt->>'range', '_', ' ') else '' end, 'grouped', v_i);
end $$;

create or replace function public.analytics_run(p_org uuid, p_q jsonb, p_max integer default 100) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_plan jsonb := public.analytics_build(p_org, p_q, p_max); v_rows jsonb;
begin
  perform set_config('statement_timeout', '8000', true);
  execute 'select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb) from (' || (v_plan->>'sql') || ') r' into v_rows;
  return jsonb_build_object('columns', v_plan->'columns', 'rows', v_rows, 'definition', v_plan->>'definition', 'row_count', jsonb_array_length(v_rows), 'source', v_plan->>'source_label', 'module', v_plan->>'module', 'truncated', jsonb_array_length(v_rows) >= least(coalesce((p_q->>'limit')::int, case when p_max > 100 then p_max else 50 end), greatest(p_max, 1)));
end $$;

create or replace function public.analytics_validate(p_org uuid, p_q jsonb) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v jsonb := public.analytics_build(p_org, p_q, 100);
begin return jsonb_build_object('definition', v->>'definition', 'columns', v->'columns', 'source', v->>'source_label', 'grouped', v->'grouped'); end $$;


-- Export: needs the module's `export` permission and is capped at 5000 rows (the widget/run path stays capped at 100 rows per query with no paging).
-- The function runs as the user (RLS applies), so it cannot write the audit row itself; the export route records it with analytics_export_log(), which
-- re-checks the same permission. Audit rows hold counts and the definition, never contents.
create or replace function public.analytics_export(p_org uuid, p_q jsonb) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_plan jsonb := public.analytics_build(p_org, p_q, 5000);
begin
  if not public.perm_ok_new(p_org, v_plan->>'module', 'export') or not public.perm_ok_new(p_org, 'reports', 'view') then raise exception 'Your role cannot export % data.', v_plan->>'source_label' using errcode = '42501'; end if;
  return public.analytics_run(p_org, p_q, 5000);
end $$;
create or replace function public.analytics_export_log(p_org uuid, p_source text, p_rows integer, p_definition text) returns void language plpgsql security definer set search_path = '' as $$
declare si record;
begin
  perform public.ai_ctx(p_org);
  select * into si from public.analytics_source_info(p_org, p_source);
  if not found or not public.perm_ok_new(p_org, si.module, 'export') then raise exception 'Your role cannot export that data.' using errcode = '42501'; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'report.exported', jsonb_build_object('source', si.label, 'rows', least(greatest(coalesce(p_rows, 0), 0), 5000), 'definition', left(p_definition, 300)));
end $$;

create or replace function public.analytics_catalog(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); s text; si record; v_out jsonb := '[]'::jsonb; v_srcs text[] := array['leads','tasks','appointments','stock_movements','inventory','batches','invoices','payments'];
begin
  for s in select unnest(v_srcs) union all select 'records:' || (m.value->>'key') from public.workspace_configuration_versions c, jsonb_array_elements(c.definition->'modules') m
      where c.organization_id = p_org and c.status = 'published' and m.value->>'status' = 'active' and m.value->>'key' not in ('overview','leads') and c.revision = (select max(revision) from public.workspace_configuration_versions where organization_id = p_org and status = 'published') loop
    select * into si from public.analytics_source_info(p_org, s); continue when not found;
    continue when not public.perm_ok(p_org, si.module, 'view') or (si.module = 'billing' and v_role not in ('owner','admin','manager'));
    v_out := v_out || jsonb_build_object('source', s, 'label', si.label, 'module', si.module, 'product_field', si.product_field,
      'fields', (select jsonb_agg(jsonb_build_object('field', r.field, 'label', r.label, 'type', r.ftype, 'groupable', r.groupable, 'filterable', r.filterable, 'aggregatable', r.aggregatable, 'money_fixed', r.money_fixed, 'user', r.user_ref) order by r.field) from public.analytics_field_rows(p_org, s) r));
  end loop;
  return jsonb_build_object('sources', v_out, 'aggregations', jsonb_build_array('count','count_distinct','sum','avg','min','max'), 'ranges', jsonb_build_array('last_7_days','last_30_days','last_90_days','this_month','last_month','this_year','next_7_days','next_30_days','custom'),
    'notes', jsonb_build_array('Amounts in different currencies are never combined: group by currency or filter to one.', 'Quantities of different products are never added: group by product.', 'Invoiced amounts (invoices) and collected money (payments) are different sources.'));
end $$;

-- ---------- dashboards ----------
create table public.dashboards (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, owner_id uuid not null,
  name text not null check (char_length(name) between 1 and 80), description text check (char_length(description) <= 300), visibility text not null default 'personal' check (visibility in ('personal','organization')),
  version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, organization_id)
);
create index dashboards_org_idx on public.dashboards (organization_id, visibility, updated_at desc);
create table public.dashboard_widgets (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, dashboard_id uuid not null, position integer not null check (position between 0 and 23),
  type text not null check (type in ('kpi','line','bar','pie','table','funnel')), title text not null check (char_length(title) between 1 and 80), query jsonb not null check (octet_length(query::text) <= 8000),
  w integer not null check (w between 1 and 12), h integer not null check (h between 1 and 12), options jsonb not null default '{}'::jsonb check (octet_length(options::text) <= 2000),
  unique (dashboard_id, position), foreign key (dashboard_id, organization_id) references public.dashboards (id, organization_id) on delete cascade
);
alter table public.dashboards enable row level security; alter table public.dashboard_widgets enable row level security;
create policy dashboards_read on public.dashboards for select to authenticated using (public.is_org_member(organization_id) and (visibility = 'organization' or owner_id = (select auth.uid())));
create policy perm_view on public.dashboards as restrictive for select to authenticated using (public.perm_ok(organization_id, 'dashboards', 'view'));
create policy dashboard_widgets_read on public.dashboard_widgets for select to authenticated using (exists (select 1 from public.dashboards d where d.id = dashboard_id));
revoke all on public.dashboards, public.dashboard_widgets from anon, authenticated; grant select on public.dashboards, public.dashboard_widgets to authenticated;

create or replace function public.dashboard_save(p_org uuid, p_id uuid, p_name text, p_description text, p_visibility text, p_widgets jsonb, p_version integer) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ai_ctx(p_org); d public.dashboards; v_id uuid := p_id; v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); w jsonb; i int := 0; v_g int; v_ver int; v_type text;
begin
  if char_length(v_name) not between 1 and 80 or p_visibility not in ('personal','organization') then raise exception 'A dashboard needs a name (up to 80 characters) and a visibility.' using errcode = '22023'; end if;
  if jsonb_typeof(p_widgets) is distinct from 'array' or jsonb_array_length(p_widgets) > 24 then raise exception 'A dashboard holds at most 24 widgets.' using errcode = '22023'; end if;
  if v_id is null then
    if not public.perm_ok(p_org, 'dashboards', 'create') then raise exception 'Your role cannot create dashboards.' using errcode = '42501'; end if;
    if (select count(*) from public.dashboards where organization_id = p_org and owner_id = v_uid) >= 50 then raise exception 'At most 50 dashboards per person.' using errcode = '22023'; end if;
  else
    select * into d from public.dashboards where id = v_id and organization_id = p_org for update; if not found then raise exception 'Dashboard not found.' using errcode = 'P0002'; end if;
    if d.visibility = 'personal' and d.owner_id <> v_uid then raise exception 'Dashboard not found.' using errcode = 'P0002'; end if;
    if not (d.owner_id = v_uid or v_role in ('owner','admin')) or not public.perm_ok(p_org, 'dashboards', 'edit') then raise exception 'Only the dashboard owner, an admin or the owner can change it.' using errcode = '42501'; end if;
    if p_version is not null and p_version <> d.version then raise exception 'This dashboard was changed by someone else. Reload and try again.' using errcode = '22023'; end if;
  end if;
  if p_visibility = 'organization' and (v_role not in ('owner','admin','manager') or not public.perm_ok_new(p_org, 'dashboards', 'approve')) then raise exception 'Only owners, admins and managers can share dashboards with the organization.' using errcode = '42501'; end if;
  for w in select * from jsonb_array_elements(p_widgets) loop
    if jsonb_typeof(w) is distinct from 'object' or exists (select 1 from jsonb_object_keys(w) k where k not in ('type','title','query','w','h','options')) then raise exception 'Widget % is invalid.', i + 1 using errcode = '22023'; end if;
    v_type := w->>'type';
    if v_type not in ('kpi','line','bar','pie','table','funnel') or char_length(btrim(coalesce(w->>'title', ''))) not between 1 and 80 or coalesce(w->>'w', '') !~ '^([1-9]|1[0-2])$' or coalesce(w->>'h', '') !~ '^([1-9]|1[0-2])$' then raise exception 'Widget % needs a type, a title and a size of 1-12 by 1-12.', i + 1 using errcode = '22023'; end if;
    v_g := (public.analytics_validate(p_org, w->'query')->>'grouped')::int; -- the SAME validation (and permission check) as running the query
    if (v_type = 'kpi' and v_g <> 0) or (v_type in ('line','bar','pie','funnel') and v_g <> 1) or (v_type = 'line' and (w#>>'{query,group_by,0,bucket}') is null) then raise exception 'Widget "%": a % widget needs %.', w->>'title', v_type, case v_type when 'kpi' then 'no grouping' when 'line' then 'one date grouping with a bucket' else 'exactly one grouping' end using errcode = '22023'; end if;
    i := i + 1;
  end loop;
  if v_id is null then insert into public.dashboards (organization_id, owner_id, name, description, visibility) values (p_org, v_uid, v_name, nullif(left(btrim(p_description), 300), ''), p_visibility) returning id, version into v_id, v_ver;
  else update public.dashboards set name = v_name, description = nullif(left(btrim(p_description), 300), ''), visibility = p_visibility, version = version + 1, updated_at = now() where id = v_id returning version into v_ver; end if;
  delete from public.dashboard_widgets where dashboard_id = v_id;
  i := 0; for w in select * from jsonb_array_elements(p_widgets) loop
    insert into public.dashboard_widgets (organization_id, dashboard_id, position, type, title, query, w, h, options) values (p_org, v_id, i, w->>'type', btrim(w->>'title'), w->'query', (w->>'w')::int, (w->>'h')::int, coalesce(w->'options', '{}'::jsonb)); i := i + 1;
  end loop;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'dashboard.saved', jsonb_build_object('dashboard_id', v_id, 'widgets', jsonb_array_length(p_widgets), 'visibility', p_visibility));
  return jsonb_build_object('id', v_id, 'version', v_ver);
end $$;
create or replace function public.dashboard_delete(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); d public.dashboards;
begin
  select * into d from public.dashboards where id = p_id and organization_id = p_org; if not found or (d.visibility = 'personal' and d.owner_id <> (select auth.uid())) then raise exception 'Dashboard not found.' using errcode = 'P0002'; end if;
  if not (d.owner_id = (select auth.uid()) or v_role in ('owner','admin')) or not public.perm_ok(p_org, 'dashboards', 'archive') then raise exception 'Only the dashboard owner, an admin or the owner can delete it.' using errcode = '42501'; end if;
  delete from public.dashboards where id = p_id; insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'dashboard.deleted', jsonb_build_object('dashboard_id', p_id, 'name', d.name));
end $$;

-- AI dashboard proposals: a third proposal kind. Applying one is a human click that runs dashboard_save as that person (so their permissions apply).
alter table public.ai_proposals drop constraint if exists ai_proposals_kind_check;
alter table public.ai_proposals add constraint ai_proposals_kind_check check (kind in ('module_config','workflow','dashboard'));

create or replace function public.ai_set_proposal_status(p_org uuid, p_proposal uuid, p_status text, p_result jsonb, p_workflow uuid default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.ai_proposals;
begin
  if public.ai_ctx(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can apply proposals.' using errcode = '42501'; end if;
  select * into p from public.ai_proposals where id = p_proposal and organization_id = p_org and user_id = v_uid for update;
  if not found then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  if p.created_at < now() - interval '7 days' and p.status = 'pending' then raise exception 'This proposal is older than 7 days. Ask for it again.' using errcode = '22023'; end if;
  if not ((p.kind = 'dashboard' and p.status = 'pending' and p_status in ('published','rejected')) or (p.kind <> 'dashboard' and p.status = 'pending' and p_status in ('draft_saved','rejected')) or (p.status = 'draft_saved' and p_status in ('published','rejected') and p.kind = 'module_config')
       or (p.status = 'draft_saved' and p_status in ('published','published_disabled','rejected') and p.kind = 'workflow')) then
    raise exception 'This proposal cannot move from % to %.', p.status, p_status using errcode = '22023'; end if;
  update public.ai_proposals set status = p_status, result = coalesce(p_result, result), workflow_id = coalesce(p_workflow, workflow_id), decided_at = now() where id = p_proposal;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.proposal_' || p_status, jsonb_build_object('proposal_id', p_proposal, 'kind', p.kind));
end $$;

create or replace function public.ai_create_proposal(p_org uuid, p_conv uuid, p_kind text, p_title text, p_payload jsonb, p_base_revision integer) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  if public.ai_ctx(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can change the workspace configuration, automations or dashboards through the assistant.' using errcode = '42501'; end if;
  if p_kind not in ('module_config','workflow','dashboard') or char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 then raise exception 'Invalid proposal.' using errcode = '22023'; end if;
  if p_conv is not null and not exists (select 1 from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = v_uid) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if (select count(*) from public.ai_proposals where organization_id = p_org and user_id = v_uid and status = 'pending') >= 20 then raise exception 'Too many pending proposals. Apply or dismiss some first.' using errcode = '22023'; end if;
  insert into public.ai_proposals (organization_id, user_id, conversation_id, kind, title, payload, base_revision) values (p_org, v_uid, p_conv, p_kind, btrim(p_title), p_payload, p_base_revision) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.proposal_created', jsonb_build_object('proposal_id', v_id, 'kind', p_kind));
  return v_id;
end $$;

-- ---------- privileges ----------
revoke all on function public.analytics_user_label(uuid, uuid) from public, anon;
grant execute on function public.analytics_user_label(uuid, uuid) to authenticated; -- called by analytics queries running as the user; members only, same data as the team list
revoke all on function public.analytics_source_info(uuid, text), public.analytics_field_rows(uuid, text), public.analytics_build(uuid, jsonb, integer), public.analytics_run(uuid, jsonb, integer), public.analytics_validate(uuid, jsonb),
  public.analytics_export(uuid, jsonb), public.analytics_export_log(uuid, text, integer, text), public.analytics_catalog(uuid), public.dashboard_save(uuid, uuid, text, text, text, jsonb, integer), public.dashboard_delete(uuid, uuid) from public, anon;
grant execute on function public.analytics_source_info(uuid, text), public.analytics_field_rows(uuid, text), public.analytics_build(uuid, jsonb, integer), public.analytics_run(uuid, jsonb, integer), public.analytics_validate(uuid, jsonb),
  public.analytics_export(uuid, jsonb), public.analytics_export_log(uuid, text, integer, text), public.analytics_catalog(uuid), public.dashboard_save(uuid, uuid, text, text, text, jsonb, integer), public.dashboard_delete(uuid, uuid) to authenticated;
