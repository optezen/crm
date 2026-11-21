-- 0013: Operations <-> Automation Engine and AI assistant. 0001-0012 are untouched (0007/0009 functions are replaced with CREATE OR REPLACE).
--
-- The two contract-only triggers (appointment.created, payment.received) and the new operations events become real, publishable triggers now that their
-- handlers and data exist: a workflow on them can only be PUBLISHED while the matching operations module is enabled in the published configuration.
-- Condition/template fields: appointment.*, inventory.*, invoice.*, payment.* (see automation_path_ok). Actions available for these triggers are the generic
-- ones (notify event_actor, wait, request_integration webhook); lead/task actions stay limited to lead/task triggers.

create or replace function public.automation_scope(p_event text) returns text language sql immutable set search_path = '' as $$
  select case when p_event like 'lead.%' then 'lead' when p_event like 'task.%' then 'task' when p_event like 'record.%' then 'record'
    when p_event like 'appointment.%' then 'appointment' when p_event like 'inventory.%' then 'inventory' when p_event like 'invoice.%' or p_event like 'credit_note.%' then 'invoice' when p_event like 'payment.%' then 'payment' else 'none' end;
$$;
create or replace function public.automation_ops_module(p_event text) returns text language sql immutable set search_path = '' as $$
  select case public.automation_scope(p_event) when 'appointment' then 'appointments' when 'inventory' then 'inventory' when 'invoice' then 'billing' when 'payment' then 'billing' end;
$$;
create or replace function public.automation_path_ok(p_path text, p_scope text) returns boolean language sql immutable set search_path = '' as $$
  select p_path ~ '^(lead|task|record|appointment|inventory|invoice|payment)\.[a-z][a-z0-9_]{0,39}$'
     and ((p_path like 'lead.%' and p_scope in ('lead','task')) or (p_path like 'task.%' and p_scope = 'task') or (p_path like 'record.%' and p_scope = 'record')
       or (p_path like 'appointment.%' and p_scope = 'appointment') or (p_path like 'inventory.%' and p_scope = 'inventory') or (p_path like 'invoice.%' and p_scope in ('invoice','payment')) or (p_path like 'payment.%' and p_scope = 'payment'));
$$;

create or replace function public.automation_validate(p jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare
  v_event text; v_scope text; c jsonb; a jsonb; t text; v_idx int := 0; v_n int; r text; v_scalar boolean;
  v_events text[] := array['record.created','record.updated','lead.created','lead.assigned','task.created','task.completed','appointment.created','appointment.rescheduled','appointment.cancelled','appointment.completed','inventory.low_stock','inventory.stock_received','inventory.stock_adjusted','inventory.stock_consumed','inventory.stock_transferred','invoice.created','invoice.issued','invoice.paid','payment.received','payment.refunded','credit_note.issued'];
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' or octet_length(p::text) > 30000 or not public.automation_keys_ok(p, array['trigger','match','actions']) then
    raise exception 'The automation definition is invalid.' using errcode = '22023'; end if;
  -- trigger
  if not public.automation_keys_ok(p->'trigger', array['event','object']) or jsonb_typeof(p->'trigger'->'event') is distinct from 'string' or (p->'trigger'->>'event') <> all(v_events) then
    raise exception 'Choose a trigger.' using errcode = '22023'; end if;
  v_event := p->'trigger'->>'event'; v_scope := public.automation_scope(v_event);
  if p->'trigger' ? 'object' and (v_scope <> 'record' or jsonb_typeof(p->'trigger'->'object') is distinct from 'string' or p->'trigger'->>'object' !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(p->'trigger'->>'object') > 40) then
    raise exception 'Only record triggers can be limited to a module.' using errcode = '22023'; end if;
  -- conditions
  if p ? 'match' then
    if not public.automation_keys_ok(p->'match', array['op','conditions']) or coalesce(p->'match'->>'op', 'and') not in ('and','or')
       or jsonb_typeof(coalesce(p->'match'->'conditions', '[]'::jsonb)) is distinct from 'array' or jsonb_array_length(coalesce(p->'match'->'conditions', '[]'::jsonb)) > 20 then
      raise exception 'The conditions are invalid (at most 20, combined with and/or).' using errcode = '22023'; end if;
    for c in select * from jsonb_array_elements(coalesce(p->'match'->'conditions', '[]'::jsonb)) loop
      if not public.automation_keys_ok(c, array['field','op','value']) or jsonb_typeof(c->'field') is distinct from 'string' or not public.automation_path_ok(c->>'field', v_scope) then
        raise exception 'A condition refers to a field that this trigger does not provide.' using errcode = '22023'; end if;
      if jsonb_typeof(c->'op') is distinct from 'string' or c->>'op' not in ('eq','neq','contains','empty','not_empty','gt','lt','before','after') then
        raise exception 'A condition has an unknown comparison.' using errcode = '22023'; end if;
      if c->>'op' in ('empty','not_empty') then
        if c ? 'value' then raise exception 'Empty / not empty conditions take no value.' using errcode = '22023'; end if;
      else
        if coalesce(jsonb_typeof(c->'value'), '') not in ('string','number','boolean') or char_length(c->'value' #>> '{}') > 200 then
          raise exception 'Every condition needs a value of up to 200 characters.' using errcode = '22023'; end if;
        if c->>'op' in ('gt','lt') and public.automation_num(c->'value' #>> '{}') is null then raise exception 'Greater / less than needs a number.' using errcode = '22023'; end if;
        if c->>'op' in ('before','after') and public.automation_date(c->'value' #>> '{}') is null then raise exception 'Before / after needs a date (YYYY-MM-DD) or "today".' using errcode = '22023'; end if;
      end if;
    end loop;
  end if;
  -- actions
  if jsonb_typeof(p->'actions') is distinct from 'array' or jsonb_array_length(p->'actions') not between 1 and 10 then
    raise exception 'Add between 1 and 10 actions.' using errcode = '22023'; end if;
  for a in select * from jsonb_array_elements(p->'actions') loop
    v_idx := v_idx + 1; t := case when jsonb_typeof(a) = 'object' and jsonb_typeof(a->'type') = 'string' then a->>'type' end;
    if t is null then raise exception 'Action % is invalid.', v_idx using errcode = '22023'; end if;
    case t
      when 'update_record' then
        if v_scope <> 'record' or not public.automation_keys_ok(a, array['type','field','value']) or coalesce(a->>'field', '') !~ '^[a-z][a-z0-9_]{0,39}$'
           or coalesce(jsonb_typeof(a->'value'), '') not in ('string','number','boolean') or char_length(a->'value' #>> '{}') > 1000 then
          raise exception 'Action %: update a field of the triggering record (record triggers only).', v_idx using errcode = '22023'; end if;
      when 'assign_lead' then
        if v_scope not in ('lead','task') or not public.automation_keys_ok(a, array['type','user_id']) or coalesce(a->>'user_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'Action %: choose the team member to assign (lead or task triggers only).', v_idx using errcode = '22023'; end if;
      when 'assign_round_robin' then
        if v_scope not in ('lead','task') or not public.automation_keys_ok(a, array['type','roles','only_if_unassigned'])
           or (a ? 'only_if_unassigned' and jsonb_typeof(a->'only_if_unassigned') is distinct from 'boolean')
           or (a ? 'roles' and (jsonb_typeof(a->'roles') is distinct from 'array' or jsonb_array_length(a->'roles') not between 1 and 3
                or exists (select 1 from jsonb_array_elements(a->'roles') x where jsonb_typeof(x) is distinct from 'string' or (x #>> '{}') not in ('employee','manager','admin')))) then
          raise exception 'Action %: round-robin needs roles from employee, manager, admin (lead or task triggers only).', v_idx using errcode = '22023'; end if;
      when 'create_task' then
        if v_scope not in ('lead','task') or not public.automation_keys_ok(a, array['type','title','due_in_days','owner'])
           or jsonb_typeof(a->'title') is distinct from 'string' or char_length(btrim(a->>'title')) not between 1 and 200
           or jsonb_typeof(a->'due_in_days') is distinct from 'number' or (a->>'due_in_days') !~ '^[0-9]{1,3}$' or (a->>'due_in_days')::int > 365
           or coalesce(a->>'owner', '') !~ '^(lead_assignee|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
          raise exception 'Action %: a task needs a title, a deadline of 0-365 days and an owner (lead or task triggers only).', v_idx using errcode = '22023'; end if;
      when 'update_task_status' then
        if v_scope <> 'task' or not public.automation_keys_ok(a, array['type','status','outcome']) or coalesce(a->>'status', '') not in ('done','open')
           or (a->>'status' = 'done' and (jsonb_typeof(a->'outcome') is distinct from 'string' or char_length(btrim(a->>'outcome')) not between 1 and 1000))
           or (a->>'status' = 'open' and a ? 'outcome') then
          raise exception 'Action %: update the triggering task (task triggers only); completing needs an outcome.', v_idx using errcode = '22023'; end if;
      when 'notify' then
        r := a->>'recipient';
        if not public.automation_keys_ok(a, array['type','recipient','title','body']) or coalesce(r, '') !~ '^(lead_assignee|task_owner|event_actor|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
           or (r = 'lead_assignee' and v_scope not in ('lead','task')) or (r = 'task_owner' and v_scope <> 'task')
           or jsonb_typeof(a->'title') is distinct from 'string' or char_length(btrim(a->>'title')) not between 1 and 120
           or (a ? 'body' and (jsonb_typeof(a->'body') is distinct from 'string' or char_length(a->>'body') > 500)) then
          raise exception 'Action %: choose who to notify and write a title.', v_idx using errcode = '22023'; end if;
      when 'wait' then
        if not public.automation_keys_ok(a, array['type','minutes','until_field']) or (a ? 'minutes') = (a ? 'until_field')
           or (a ? 'minutes' and (jsonb_typeof(a->'minutes') is distinct from 'number' or (a->>'minutes') !~ '^[0-9]{1,6}$' or (a->>'minutes')::int not between 1 and 525600))
           or (a ? 'until_field' and (jsonb_typeof(a->'until_field') is distinct from 'string' or not public.automation_path_ok(a->>'until_field', v_scope))) then
          raise exception 'Action %: wait for 1 to 525600 minutes, or until a date field.', v_idx using errcode = '22023'; end if;
      when 'request_integration' then
        if not public.automation_keys_ok(a, array['type','channel','message','to']) or coalesce(a->>'channel', '') not in ('whatsapp','sms','email','webhook')
           or jsonb_typeof(a->'message') is distinct from 'string' or char_length(btrim(a->>'message')) not between 1 and 1000
           or (a ? 'to' and (a->>'to' is distinct from 'lead_contact' or v_scope not in ('lead','task')))
           or (a->>'channel' in ('whatsapp','sms','email') and not (a ? 'to')) then
          raise exception 'Action %: an external message needs a channel, a message and (for whatsapp/sms/email) the lead contact as recipient.', v_idx using errcode = '22023'; end if;
      else raise exception 'Action % has an unknown type.', v_idx using errcode = '22023';
    end case;
  end loop;
end $$;

create or replace function public.automation_publish(p_org uuid, p_workflow uuid, p_enable boolean) returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v public.automation_workflow_versions; v_live jsonb; v_obj jsonb; a jsonb; v_ev text;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  perform 1 from public.automation_workflows where id = p_workflow and organization_id = p_org for update;
  if not found then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
  select * into v from public.automation_workflow_versions where workflow_id = p_workflow and status = 'draft';
  if not found then raise exception 'There is no draft to publish.' using errcode = '22023'; end if;
  perform public.automation_validate(v.definition);
  v_ev := v.definition #>> '{trigger,event}';
  if public.automation_ops_module(v_ev) is not null and coalesce((public.ops_config(p_org, public.automation_ops_module(v_ev))->>'enabled')::boolean, false) is not true then
    raise exception 'Enable the % module in the Builder (and publish it) before publishing automations that use "%".', public.automation_ops_module(v_ev), v_ev using errcode = '22023'; end if;
  if public.automation_scope(v_ev) = 'record' then
    v_live := public.workspace_live_definition(p_org);
    if v.definition #>> '{trigger,object}' is not null and not exists (select 1 from jsonb_array_elements(v_live->'objects') o where o.value->>'key' = v.definition #>> '{trigger,object}') then
      raise exception 'The module "%" does not exist in the published workspace configuration.', v.definition #>> '{trigger,object}' using errcode = '22023'; end if;
    for a in select * from jsonb_array_elements(v.definition->'actions') where value->>'type' = 'update_record' loop
      if v.definition #>> '{trigger,object}' is null then raise exception 'Updating a record requires choosing the module in the trigger.' using errcode = '22023'; end if;
      select o.value into v_obj from jsonb_array_elements(v_live->'objects') o where o.value->>'key' = v.definition #>> '{trigger,object}';
      if not exists (select 1 from jsonb_array_elements(v_obj->'fields') f where f.value->>'key' = a->>'field' and coalesce((f.value->>'archived')::boolean, false) = false) then
        raise exception 'The field "%" does not exist (or is hidden) in that module.', a->>'field' using errcode = '22023'; end if;
    end loop;
  end if;
  update public.automation_workflow_versions set status = 'archived' where workflow_id = p_workflow and status = 'published';
  update public.automation_workflow_versions set status = 'published', published_by = v_uid, published_at = now() where id = v.id;
  update public.automation_workflows set published_version = v.version, updated_at = now(), enabled = coalesce(p_enable, false),
    enabled_at = case when coalesce(p_enable, false) then now() else enabled_at end where id = p_workflow;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'automation.published', jsonb_build_object('workflow_id', p_workflow, 'version', v.version, 'enabled', coalesce(p_enable, false)));
  return v.version;
end $$;

create or replace function public.automation_context(ev public.domain_events) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := jsonb_build_object('event', (ev.payload - 'automation') || jsonb_build_object('name', ev.event_name, 'actor_id', ev.actor_id, 'aggregate_id', ev.aggregate_id));
        v_t public.tasks; v_lead uuid; v_data jsonb; v_ld jsonb; v_ap public.appointments; v_inv public.invoices; v_pay public.invoice_payments; v_cn public.credit_notes;
begin
  if ev.aggregate_type = 'lead' then v_lead := ev.aggregate_id;
  elsif ev.aggregate_type = 'task' then
    select * into v_t from public.tasks where id = ev.aggregate_id and organization_id = ev.organization_id;
    if found then v_lead := v_t.lead_id;
      v := v || jsonb_build_object('task', jsonb_build_object('id', v_t.id, 'lead_id', v_t.lead_id, 'title', v_t.title, 'owner_id', v_t.owner_id, 'due_date', v_t.due_date, 'status', v_t.status, 'outcome', v_t.outcome)); end if;
  elsif ev.aggregate_type = 'record' then
    select data into v_data from public.records where id = ev.aggregate_id and organization_id = ev.organization_id;
    if v_data is not null then v := v || jsonb_build_object('record', v_data); end if;
  elsif ev.aggregate_type = 'appointment' then
    select * into v_ap from public.appointments where id = ev.aggregate_id and organization_id = ev.organization_id;
    if found then v := v || jsonb_build_object('appointment', jsonb_build_object('id', v_ap.id, 'status', v_ap.status, 'starts_at', v_ap.starts_at, 'ends_at', v_ap.ends_at, 'staff_id', v_ap.staff_id, 'contact_id', v_ap.contact_id,
      'type', (select t.name from public.appointment_types t where t.id = v_ap.type_id), 'reschedule_count', v_ap.reschedule_count)); end if;
  elsif ev.aggregate_type = 'product' then
    v := v || jsonb_build_object('inventory', ev.payload - 'automation');
  elsif ev.aggregate_type = 'invoice' then
    select * into v_inv from public.invoices where id = ev.aggregate_id and organization_id = ev.organization_id;
    if found then v := v || jsonb_build_object('invoice', public.invoice_payload(v_inv)); end if;
  elsif ev.aggregate_type = 'payment' then
    select * into v_pay from public.invoice_payments where id = ev.aggregate_id and organization_id = ev.organization_id;
    if found then select * into v_inv from public.invoices where id = v_pay.invoice_id;
      v := v || jsonb_build_object('payment', jsonb_build_object('id', v_pay.id, 'amount', v_pay.amount, 'method', v_pay.method, 'kind', v_pay.kind, 'source', v_pay.source, 'currency', v_inv.currency, 'balance_due', public.billing_balance(v_pay.invoice_id)),
        'invoice', public.invoice_payload(v_inv)); end if;
  elsif ev.aggregate_type = 'credit_note' then
    select * into v_cn from public.credit_notes where id = ev.aggregate_id and organization_id = ev.organization_id;
    if found then select * into v_inv from public.invoices where id = v_cn.invoice_id; v := v || jsonb_build_object('invoice', public.invoice_payload(v_inv), 'credit_note', jsonb_build_object('id', v_cn.id, 'number', v_cn.number, 'amount', v_cn.amount)); end if;
  end if;
  if v_lead is not null then
    select jsonb_build_object('id', l.id, 'stage', l.stage, 'source', l.source, 'summary', l.summary, 'assigned_to', l.assigned_to,
      'full_name', c.full_name, 'phone', c.phone, 'email', c.email, 'created_at', l.created_at) into v_ld
      from public.leads l join public.contacts c on c.id = l.contact_id where l.id = v_lead and l.organization_id = ev.organization_id;
    if v_ld is not null then v := v || jsonb_build_object('lead', v_ld); end if;
  end if;
  return v;
end $$;

-- =====================================================================================================================
-- AI assistant: authorized READ-ONLY tools for the operations modules (SECURITY INVOKER: row level security and the role checks decide what is returned)
-- =====================================================================================================================
create or replace function public.ai_tool_operations_status(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); d jsonb;
begin
  select definition into d from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
  return jsonb_build_object('viewer_role', v_role,
    'appointments', jsonb_build_object('enabled', coalesce((d #>> '{operations,appointments,enabled}')::boolean, false), 'timezone', d #>> '{operations,appointments,timezone}',
      'types', (select count(*) from public.appointment_types where organization_id = p_org and active), 'staff_with_hours', (select count(distinct user_id) from public.staff_hours where organization_id = p_org)),
    'inventory', jsonb_build_object('enabled', coalesce((d #>> '{operations,inventory,enabled}')::boolean, false), 'allow_negative_stock', coalesce((d #>> '{operations,inventory,allow_negative_stock}')::boolean, false),
      'track_batches', coalesce((d #>> '{operations,inventory,track_batches}')::boolean, false), 'products', (select count(*) from public.products where organization_id = p_org and active), 'locations', (select count(*) from public.inventory_locations where organization_id = p_org and active)),
    'billing', case when v_role in ('owner','admin','manager') then jsonb_build_object('enabled', coalesce((d #>> '{operations,billing,enabled}')::boolean, false), 'currency', d #>> '{operations,billing,currency}',
        'taxes', coalesce((select jsonb_agg(jsonb_build_object('name', t.value->>'name', 'rate', t.value->>'rate')) from jsonb_array_elements(coalesce(d #> '{operations,billing,taxes}', '[]'::jsonb)) t), '[]'::jsonb)) 
      else jsonb_build_object('enabled', coalesce((d #>> '{operations,billing,enabled}')::boolean, false), 'note', 'Billing details are visible to owners, admins and managers.') end);
end $$;

create or replace function public.ai_tool_list_appointments(p_org uuid, p_from timestamptz, p_to timestamptz, p_staff text, p_status text, p_limit integer, p_offset integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_uid uuid := (select auth.uid()); v_from timestamptz := coalesce(p_from, now() - interval '7 days'); v_to timestamptz := coalesce(p_to, v_from + interval '37 days');
  v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25); v_off int := least(greatest(coalesce(p_offset, 0), 0), 10000); v_items jsonb; v_total int;
begin
  if v_to <= v_from or v_to - v_from > interval '92 days' then raise exception 'Choose a date range of at most 92 days.' using errcode = '22023'; end if;
  select coalesce(jsonb_agg(x.j order by x.starts_at, x.id), '[]'::jsonb), coalesce(max(x.total), 0) into v_items, v_total from (
    select jsonb_build_object('id', a.id, 'type', t.name, 'staff', public.ai_email(p_org, a.staff_id), 'contact', c.full_name, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'status', a.status, 'notes', public.ai_text(a.notes, 200, false)) j,
      a.starts_at, a.id, count(*) over () total
    from public.appointments a join public.appointment_types t on t.id = a.type_id left join public.contacts c on c.id = a.contact_id
    where a.organization_id = p_org and a.starts_at >= v_from and a.starts_at < v_to and (p_status is null or a.status = p_status)
      and (p_staff is null or (p_staff = 'me' and a.staff_id = v_uid) or (p_staff ~ '^[0-9a-f]{8}-' and a.staff_id = (case when p_staff ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_staff::uuid end)))
    order by a.starts_at, a.id limit v_limit offset v_off) x;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_off, 'has_more', v_off + jsonb_array_length(v_items) < v_total, 'range_from', v_from, 'range_to', v_to,
    'module_enabled', coalesce((select (d.definition #>> '{operations,appointments,enabled}')::boolean from public.workspace_configuration_versions d where d.organization_id = p_org and d.status = 'published' order by d.revision desc limit 1), false), 'items', v_items);
end $$;

create or replace function public.ai_tool_inventory_status(p_org uuid, p_search text, p_low_only boolean, p_limit integer, p_offset integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25); v_off int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_search text := replace(replace(replace(left(btrim(coalesce(p_search, '')), 80), '\', '\\'), '%', '\%'), '_', '\_'); v_items jsonb; v_total int;
begin
  select coalesce(jsonb_agg(x.j order by x.name, x.pid), '[]'::jsonb), coalesce(max(x.total), 0) into v_items, v_total from (
    select jsonb_build_object('product_id', o.product_id, 'sku', o.sku, 'name', public.ai_text(o.name, 120, true), 'unit', o.unit, 'on_hand', o.on_hand, 'low_stock_threshold', o.low_stock_threshold, 'low_stock', o.low_stock,
        'batch_tracked', p.track_batches, 'expiring_within_30_days', (select count(*) from public.stock_batches b join public.stock_levels l on l.batch_id = b.id where b.product_id = o.product_id and l.quantity > 0 and b.expiry_date is not null and b.expiry_date <= current_date + 30)) j,
      o.name, o.product_id pid, count(*) over () total
    from public.inventory_on_hand o join public.products p on p.id = o.product_id
    where o.organization_id = p_org and o.active and (not coalesce(p_low_only, false) or o.low_stock) and (v_search = '' or o.name ilike '%' || v_search || '%' or o.sku ilike '%' || v_search || '%')
    order by o.name, o.product_id limit v_limit offset v_off) x;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_off, 'has_more', v_off + jsonb_array_length(v_items) < v_total, 'items', v_items);
end $$;

create or replace function public.ai_tool_stock_movements(p_org uuid, p_product uuid, p_limit integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25);
begin
  return jsonb_build_object('limit', v_limit, 'items', coalesce((select jsonb_agg(jsonb_build_object('at', m.created_at, 'kind', m.kind, 'quantity_change', m.quantity_delta, 'balance_after', m.balance_after, 'location', l.name, 'lot', b.lot_code,
      'purchase_reference', public.ai_text(m.purchase_reference, 80, false), 'reason', public.ai_text(m.reason, 200, false)) order by m.seq desc)
    from (select * from public.stock_movements where organization_id = p_org and (p_product is null or product_id = p_product) order by seq desc limit v_limit) m
    join public.inventory_locations l on l.id = m.location_id left join public.stock_batches b on b.id = m.batch_id), '[]'::jsonb));
end $$;

create or replace function public.ai_tool_list_invoices(p_org uuid, p_state text, p_limit integer, p_offset integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25); v_off int := least(greatest(coalesce(p_offset, 0), 0), 10000); v_items jsonb; v_total int;
begin
  if v_role not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can view invoices.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb), coalesce(max(x.total), 0) into v_items, v_total from (
    select jsonb_build_object('id', b.invoice_id, 'number', b.number, 'status', b.status, 'payment_state', b.payment_state, 'currency', b.currency, 'total', b.total, 'paid', b.paid, 'credited', b.credited, 'refunded', b.refunded,
        'balance_due', b.balance_due, 'due_date', b.due_date, 'overdue', b.overdue, 'customer', c.full_name) j, i.created_at, i.id, count(*) over () total
    from public.invoice_balances b join public.invoices i on i.id = b.invoice_id left join public.contacts c on c.id = b.contact_id
    where b.organization_id = p_org and (p_state is null or b.payment_state = p_state or b.status = p_state) order by i.created_at desc, i.id limit v_limit offset v_off) x;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_off, 'has_more', v_off + jsonb_array_length(v_items) < v_total, 'items', v_items,
    'note', 'Amounts come from the invoice ledger. "paid" means payments recorded by staff in Optizen; no payment provider is connected.');
end $$;

create or replace function public.ai_tool_billing_summary(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org);
begin
  if v_role not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can view billing.' using errcode = '42501'; end if;
  return jsonb_build_object('by_currency', coalesce((select jsonb_agg(jsonb_build_object('currency', s.currency, 'issued_invoices', s.n, 'invoiced_total', s.invoiced, 'outstanding', s.outstanding, 'overdue_amount', s.overdue_amount, 'overdue_invoices', s.overdue_n, 'credit_owed_to_customers', s.credit)) 
    from (select b.currency, count(*) n, sum(b.total) invoiced, coalesce(sum(b.balance_due) filter (where b.balance_due > 0), 0) outstanding, coalesce(sum(b.balance_due) filter (where b.overdue), 0) overdue_amount,
      count(*) filter (where b.overdue) overdue_n, coalesce(-sum(b.balance_due) filter (where b.balance_due < 0), 0) credit from public.invoice_balances b where b.organization_id = p_org and b.status = 'issued' group by b.currency) s), '[]'::jsonb),
    'drafts', (select count(*) from public.invoices where organization_id = p_org and status = 'draft'),
    'note', 'Computed from the ledger of invoices issued in Optizen. Payments are manual records; nothing here confirms money was processed by an external provider.');
end $$;

revoke all on function public.automation_scope(text), public.automation_ops_module(text), public.automation_path_ok(text, text) from public, anon, authenticated;
revoke all on function public.ai_tool_operations_status(uuid), public.ai_tool_list_appointments(uuid, timestamptz, timestamptz, text, text, integer, integer), public.ai_tool_inventory_status(uuid, text, boolean, integer, integer),
  public.ai_tool_stock_movements(uuid, uuid, integer), public.ai_tool_list_invoices(uuid, text, integer, integer), public.ai_tool_billing_summary(uuid) from public, anon;
grant execute on function public.ai_tool_operations_status(uuid), public.ai_tool_list_appointments(uuid, timestamptz, timestamptz, text, text, integer, integer), public.ai_tool_inventory_status(uuid, text, boolean, integer, integer),
  public.ai_tool_stock_movements(uuid, uuid, integer), public.ai_tool_list_invoices(uuid, text, integer, integer), public.ai_tool_billing_summary(uuid) to authenticated;
