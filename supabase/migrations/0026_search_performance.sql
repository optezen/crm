-- 0026: search performance. global_search ran every row of leads/tasks through row-level-security permission functions BEFORE applying the text filter
-- (about 2 s for 20,000 leads, 4 s with 60,000 tasks; measured by tests/concurrency/performance.test.mjs). search_candidates() finds matching ids with cheap raw filters (no per-row
-- permission functions) and global_search then applies exactly the same views, row security and field masking to those candidates, so WHAT a person can find is unchanged:
--  * the candidate filters are supersets of the original predicates (they test the raw values; the views only ever expose the same value or hide it);
--  * the function checks organization membership itself and returns only ids of the caller's own organization;
--  * candidates are ordered like the results (prefix match first, then name) and capped at 2000 per type, so a very broad query by someone who can see few rows could miss results
--    that sort after 2000 matches they cannot see (documented trade-off; narrower queries are unaffected).
create or replace function public.search_candidates(p_org uuid, p_like text, p_pre text, p_digits text, p_contact boolean, p_cap integer) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cap integer := least(greatest(coalesce(p_cap, 500), 1), 5000); v_role text := public.org_role(p_org); v_lead jsonb; v_task jsonb; v_appt jsonb; v_inv jsonb;
begin
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_lead from (select l.id from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id where l.organization_id = p_org
    and (lower(c.full_name) like p_like escape '\' or lower(coalesce(l.summary, '')) like p_like escape '\' or (p_contact and (lower(coalesce(c.email, '')) like p_like escape '\' or (char_length(p_digits) >= 4 and regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like '%' || p_digits || '%'))))
    order by (lower(c.full_name) like p_pre escape '\') desc, c.full_name, l.id limit v_cap) s;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_task from (select t.id from public.tasks t where t.organization_id = p_org and lower(t.title) like p_like escape '\' order by (lower(t.title) like p_pre escape '\') desc, t.title, t.id limit v_cap) s;
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_appt from (select a.id from public.appointments a join public.appointment_types ty on ty.id = a.type_id left join public.contacts ct on ct.id = a.contact_id where a.organization_id = p_org
    and (lower(ty.name) like p_like escape '\' or lower(coalesce(ct.full_name, '')) like p_like escape '\' or lower(coalesce(a.notes, '')) like p_like escape '\') order by a.starts_at desc, a.id limit v_cap) s;
  if v_role in ('owner','admin','manager') then
    select coalesce(jsonb_agg(id), '[]'::jsonb) into v_inv from (select i.id from public.invoices i left join public.contacts ct on ct.id = i.contact_id where i.organization_id = p_org and (lower(coalesce(i.number, '')) like p_like escape '\' or lower(coalesce(ct.full_name, '')) like p_like escape '\')
      order by (lower(coalesce(i.number, '')) like p_pre escape '\') desc, i.number, i.id limit v_cap) s;
  else v_inv := '[]'::jsonb; end if;
  return jsonb_build_object('lead', v_lead, 'task', v_task, 'appointment', v_appt, 'invoice', v_inv);
end $$;
revoke all on function public.search_candidates(uuid, text, text, text, boolean, integer) from public, anon; grant execute on function public.search_candidates(uuid, text, text, text, boolean, integer) to authenticated;

create or replace function public.global_search(p_org uuid, p_q text, p_types text[] default null, p_limit integer default 20, p_offset integer default 0) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_q text := btrim(coalesce(p_q, '')); v_like text; v_pre text; v_lim integer := least(greatest(coalesce(p_limit, 20), 1), 50); v_off integer := least(greatest(coalesce(p_offset, 0), 0), 1000); v_need integer := v_lim + v_off + 1; v_all boolean := p_types is null or cardinality(p_types) = 0;
  v_digits text; v_contact boolean; v_items jsonb; v_role text := public.org_role(p_org); v_def jsonb; v_cand jsonb; v_lead_ids uuid[]; v_task_ids uuid[]; v_appt_ids uuid[]; v_inv_ids uuid[];
begin
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  if char_length(v_q) < 2 then return jsonb_build_object('items', '[]'::jsonb, 'has_more', false); end if;
  if char_length(v_q) > 80 then raise exception 'Search for at most 80 characters.' using errcode = '22023'; end if;
  if not v_all and exists (select 1 from unnest(p_types) t where t not in ('lead','task','appointment','invoice','record')) then raise exception 'Unknown search type.' using errcode = '22023'; end if;
  v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'; v_pre := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g'); v_contact := char_length(v_digits) >= 4 or position('@' in v_q) > 0;
  select c.definition into v_def from public.workspace_configuration_versions c where c.organization_id = p_org and c.status = 'published' order by c.revision desc limit 1;
  -- candidates first (cheap raw filters, no per-row permission functions), then the SAME views and row security decide what this person may see, over the candidates only
  v_cand := public.search_candidates(p_org, v_like, v_pre, v_digits, v_contact, 2000);
  select coalesce(array_agg(x::uuid), '{}') into v_lead_ids from jsonb_array_elements_text(v_cand->'lead') x; select coalesce(array_agg(x::uuid), '{}') into v_task_ids from jsonb_array_elements_text(v_cand->'task') x;
  select coalesce(array_agg(x::uuid), '{}') into v_appt_ids from jsonb_array_elements_text(v_cand->'appointment') x; select coalesce(array_agg(x::uuid), '{}') into v_inv_ids from jsonb_array_elements_text(v_cand->'invoice') x;
  select coalesce(jsonb_agg(x order by (x->>'rank')::int, x->>'title'), '[]'::jsonb) into v_items from (
    select x from (select x from (
      select jsonb_build_object('type', 'lead', 'id', l.id, 'title', l.full_name, 'subtitle', l.stage || ' · ' || replace(l.source, '_', ' '), 'link', '/work/leads/' || l.id, 'rank', case when lower(l.full_name) like v_pre escape '\' then 0 else 1 end) x
      from public.crm_lead_list l where (v_all or 'lead' = any(p_types)) and l.organization_id = p_org and l.id = any(v_lead_ids)
        and (lower(l.full_name) like v_like escape '\' or lower(coalesce(l.summary, '')) like v_like escape '\' or (v_contact and (lower(coalesce(l.email, '')) like v_like escape '\' or (char_length(v_digits) >= 4 and regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'))))
        ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) a
    union all select x from (select x from (
      select jsonb_build_object('type', 'task', 'id', t.id, 'title', t.title, 'subtitle', coalesce(c.full_name, 'Lead') || ' · due ' || to_char(t.due_date, 'DD Mon') || case when t.status = 'done' then ' · done' else '' end, 'link', '/work/leads/' || t.lead_id, 'rank', case when lower(t.title) like v_pre escape '\' then 0 else 1 end) x
      from public.tasks t join public.leads l on l.id = t.lead_id join public.contacts c on c.id = l.contact_id where (v_all or 'task' = any(p_types)) and t.organization_id = p_org and t.id = any(v_task_ids) and lower(t.title) like v_like escape '\'   ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) b
    union all select x from (select x from (
      select jsonb_build_object('type', 'appointment', 'id', a.id, 'title', ty.name || coalesce(' · ' || ct.full_name, ''), 'subtitle', to_char(a.starts_at at time zone 'UTC', 'DD Mon YYYY HH24:MI') || ' UTC · ' || replace(a.status, '_', ' '), 'link', '/work/appointments/' || a.id, 'rank', case when lower(ty.name) like v_pre escape '\' or lower(coalesce(ct.full_name, '')) like v_pre escape '\' then 0 else 1 end) x
      from public.appointments a join public.appointment_types ty on ty.id = a.type_id left join public.contacts ct on ct.id = a.contact_id where (v_all or 'appointment' = any(p_types)) and a.organization_id = p_org and a.id = any(v_appt_ids)
        and (lower(ty.name) like v_like escape '\' or lower(coalesce(ct.full_name, '')) like v_like escape '\' or lower(coalesce(a.notes, '')) like v_like escape '\')   ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) c
    union all select x from (select x from (
      select jsonb_build_object('type', 'invoice', 'id', i.id, 'title', coalesce(i.number, 'Draft invoice'), 'subtitle', i.status || ' · ' || i.currency || ' ' || i.total || coalesce(' · ' || ct.full_name, ''), 'link', '/work/billing/' || i.id, 'rank', case when lower(coalesce(i.number, '')) like v_pre escape '\' then 0 else 1 end) x
      from public.invoices i left join public.contacts ct on ct.id = i.contact_id where (v_all or 'invoice' = any(p_types)) and i.organization_id = p_org and i.id = any(v_inv_ids) and v_role in ('owner','admin','manager') and (lower(coalesce(i.number, '')) like v_like escape '\' or lower(coalesce(ct.full_name, '')) like v_like escape '\')   ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) d
    union all select x from (select x from (
      select jsonb_build_object('type', 'record', 'id', r.id, 'title', coalesce((select r.data->>(f.value->>'key') from jsonb_array_elements(coalesce((select o.value->'fields' from jsonb_array_elements(coalesce(v_def->'objects', '[]'::jsonb)) o where o.value->>'key' = r.object_key), '[]'::jsonb)) f where f.value->>'kind' in ('text','choice') and coalesce(r.data->>(f.value->>'key'), '') <> '' limit 1), 'Record'),
        'subtitle', coalesce((select m.value->>'label' from jsonb_array_elements(coalesce(v_def->'modules', '[]'::jsonb)) m where m.value->>'key' = r.object_key), r.object_key), 'link', '/work/' || r.object_key || '/' || r.id, 'rank', 1) x
      from public.records_view r where (v_all or 'record' = any(p_types)) and r.organization_id = p_org and lower(coalesce(r.search_text, '')) like v_like escape '\'
      ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) e
  ) u;
  return jsonb_build_object('items', coalesce((select jsonb_agg(i) from (select i from jsonb_array_elements(v_items) with ordinality t(i, n) order by n offset v_off limit v_lim) z), '[]'::jsonb), 'has_more', jsonb_array_length(v_items) > v_off + v_lim);
end $$;

-- home page: the lead counts in one scan and the task counts in one scan (same numbers, far less work) (same numbers, a third of the work). Same signature and output as 0019.
create or replace function public.home_summary(p_org uuid, p_tz text default 'UTC') returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.org_role(p_org); v_tz text := case when exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then p_tz else 'UTC' end; v_today date := (now() at time zone v_tz)::date; v_appt boolean; v_total bigint; v_mine bigint; v_unassigned bigint; v_open bigint; v_overdue bigint;
begin
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  v_appt := exists (select 1 from public.workspace_configuration_versions c where c.organization_id = p_org and c.status = 'published' and (c.definition #>> '{operations,appointments,enabled}') = 'true');
  -- one pass over the leads this person may see instead of three: every row goes through the row-security permission functions, which is what costs time
  select count(*), count(*) filter (where due_date < v_today) into v_open, v_overdue from public.tasks where organization_id = p_org and owner_id = v_uid and status = 'open';
  select count(*), count(*) filter (where assigned_to = v_uid), count(*) filter (where assigned_to is null) into v_total, v_mine, v_unassigned from public.leads where organization_id = p_org;
  return jsonb_build_object('role', v_role, 'today', v_today,
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'due', t.due_date, 'lead_id', t.lead_id, 'lead', c.full_name, 'overdue', t.due_date < v_today) order by t.due_date, t.created_at) from (select * from public.tasks where organization_id = p_org and owner_id = v_uid and status = 'open' order by due_date, created_at limit 8) t left join public.leads l on l.id = t.lead_id left join public.contacts c on c.id = l.contact_id), '[]'::jsonb),
    'open_tasks', v_open,
    'overdue_tasks', v_overdue,
    'leads', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', c.full_name, 'stage', l.stage, 'updated_at', l.updated_at) order by l.updated_at desc) from (select * from public.leads where organization_id = p_org and assigned_to = v_uid order by updated_at desc limit 6) l join public.contacts c on c.id = l.contact_id), '[]'::jsonb),
    'my_leads', v_mine,
    'unassigned_leads', v_unassigned,
    'appointments_enabled', v_appt,
    'appointments', case when not v_appt then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'starts_at', a.starts_at, 'status', a.status, 'type', ty.name, 'contact', ct.full_name) order by a.starts_at) from (select * from public.appointments where organization_id = p_org and status in ('scheduled','confirmed') and (starts_at at time zone v_tz)::date = v_today and (v_role in ('owner','admin','manager') or staff_id = v_uid) order by starts_at limit 8) a join public.appointment_types ty on ty.id = a.type_id left join public.contacts ct on ct.id = a.contact_id), '[]'::jsonb) end,
    'unread', (select count(*) from public.notifications where organization_id = p_org and user_id = v_uid and read_at is null),
    'notifications', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'link', n.link, 'created_at', n.created_at, 'category', n.category) order by n.created_at desc) from (select * from public.notifications where organization_id = p_org and user_id = v_uid and read_at is null order by created_at desc limit 5) n), '[]'::jsonb),
    'members', (select count(*) from public.organization_members where organization_id = p_org),
    'leads_total', v_total);
end $$;
