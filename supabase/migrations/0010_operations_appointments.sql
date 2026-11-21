-- 0010: Business Operations foundation + Appointments. 0001-0009 are untouched.
--
-- Operations modules (appointments, inventory, billing) are OPTIONAL and generic: nothing industry specific is seeded. Whether a module is enabled, and its
-- rules, live in the versioned workspace configuration under `operations` (so they use the Builder's drafts, publishing, history and rollback). Master data
-- (appointment types, staff hours, products, taxes...) is ordinary organization data. Disabling a module never deletes anything: writes are refused,
-- reads keep working, and re-enabling restores the module.
--
-- Config validation: the 0006 validator is renamed to validate_workspace_definition_core and a wrapper with the original name also validates `operations`,
-- so every existing caller (create/save/publish/restore) is covered without touching earlier migrations. The data-protection check is wrapped the same way.
create extension if not exists btree_gist;

-- ---------- config: validation ----------
alter function public.validate_workspace_definition(jsonb) rename to validate_workspace_definition_core;
alter function public.workspace_check_data_protection(uuid, jsonb) rename to workspace_check_data_protection_core;

-- custom fields of an operations module use the SAME field rules as custom modules: validated by running them through the core validator
create or replace function public.ops_validate_fields(p jsonb) returns void language plpgsql stable set search_path = '' as $$
begin
  if p is null then return; end if;
  if jsonb_typeof(p) is distinct from 'array' or jsonb_array_length(p) > 15 then raise exception 'Custom fields must be a list of at most 15.' using errcode = '22023'; end if;
  perform public.validate_workspace_definition_core(jsonb_build_object('schemaVersion', 1,
    'modules', jsonb_build_array(jsonb_build_object('key', 'overview', 'label', 'Overview', 'status', 'active'), jsonb_build_object('key', 'leads', 'label', 'Leads', 'status', 'active')),
    'objects', jsonb_build_array(jsonb_build_object('key', 'ops', 'label', 'Ops', 'fields', p)), 'pipeline', jsonb_build_object('stages', jsonb_build_array('a', 'b'))));
end $$;

create or replace function public.ops_validate(p jsonb) returns void language plpgsql stable set search_path = '' as $$
declare o jsonb := p->'operations'; m jsonb; t jsonb; v_keys text[] := '{}';
begin
  if o is null then return; end if;
  if jsonb_typeof(o) is distinct from 'object' or exists (select 1 from jsonb_object_keys(o) x where x not in ('appointments','inventory','billing')) then
    raise exception 'The operations settings are invalid.' using errcode = '22023'; end if;

  m := o->'appointments';
  if m is not null then
    if jsonb_typeof(m) is distinct from 'object' or exists (select 1 from jsonb_object_keys(m) x where x not in ('enabled','timezone','enforce_working_hours','fields'))
       or jsonb_typeof(m->'enabled') is distinct from 'boolean' or (m ? 'enforce_working_hours' and jsonb_typeof(m->'enforce_working_hours') is distinct from 'boolean') then
      raise exception 'The appointments settings are invalid.' using errcode = '22023'; end if;
    if m ? 'timezone' and (jsonb_typeof(m->'timezone') is distinct from 'string' or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = m->>'timezone')) then
      raise exception 'The appointments time zone is not a valid IANA name (for example Asia/Kolkata).' using errcode = '22023'; end if;
    perform public.ops_validate_fields(m->'fields');
  end if;

  m := o->'inventory';
  if m is not null then
    if jsonb_typeof(m) is distinct from 'object' or exists (select 1 from jsonb_object_keys(m) x where x not in ('enabled','allow_negative_stock','track_batches','track_expiry','block_expired','fields'))
       or jsonb_typeof(m->'enabled') is distinct from 'boolean'
       or exists (select 1 from unnest(array['allow_negative_stock','track_batches','track_expiry','block_expired']) k where m ? k and jsonb_typeof(m->k) is distinct from 'boolean') then
      raise exception 'The inventory settings are invalid.' using errcode = '22023'; end if;
    if coalesce((m->>'track_expiry')::boolean, false) and not coalesce((m->>'track_batches')::boolean, false) then raise exception 'Expiry tracking needs batch tracking.' using errcode = '22023'; end if;
    perform public.ops_validate_fields(m->'fields');
  end if;

  m := o->'billing';
  if m is not null then
    if jsonb_typeof(m) is distinct from 'object' or exists (select 1 from jsonb_object_keys(m) x where x not in ('enabled','currency','invoice_prefix','credit_note_prefix','default_due_days','taxes'))
       or jsonb_typeof(m->'enabled') is distinct from 'boolean'
       or (m ? 'currency' and (jsonb_typeof(m->'currency') is distinct from 'string' or m->>'currency' !~ '^[A-Z]{3}$'))
       or (m ? 'invoice_prefix' and (jsonb_typeof(m->'invoice_prefix') is distinct from 'string' or m->>'invoice_prefix' !~ '^[A-Z0-9]{1,8}$'))
       or (m ? 'credit_note_prefix' and (jsonb_typeof(m->'credit_note_prefix') is distinct from 'string' or m->>'credit_note_prefix' !~ '^[A-Z0-9]{1,8}$'))
       or (m ? 'default_due_days' and (jsonb_typeof(m->'default_due_days') is distinct from 'number' or m->>'default_due_days' !~ '^[0-9]{1,3}$' or (m->>'default_due_days')::int > 365)) then
      raise exception 'The billing settings are invalid.' using errcode = '22023'; end if;
    if m ? 'taxes' then
      if jsonb_typeof(m->'taxes') is distinct from 'array' or jsonb_array_length(m->'taxes') > 10 then raise exception 'Taxes must be a list of at most 10.' using errcode = '22023'; end if;
      for t in select * from jsonb_array_elements(m->'taxes') loop
        if jsonb_typeof(t) is distinct from 'object' or exists (select 1 from jsonb_object_keys(t) x where x not in ('key','name','rate'))
           or coalesce(t->>'key', '') !~ '^[a-z][a-z0-9_]{0,19}$' or char_length(btrim(coalesce(t->>'name', ''))) not between 1 and 40
           or jsonb_typeof(t->'rate') is distinct from 'string' or t->>'rate' !~ '^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$' then
          raise exception 'Every tax needs a key, a name and a rate between 0 and 100 given as text (for example "18" or "5.5").' using errcode = '22023'; end if;
        if t->>'key' = any(v_keys) then raise exception 'Duplicate tax "%".', t->>'key' using errcode = '22023'; end if;
        v_keys := array_append(v_keys, t->>'key');
      end loop;
    end if;
  end if;
end $$;

create or replace function public.validate_workspace_definition(p jsonb) returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.validate_workspace_definition_core(p);
  perform public.ops_validate(p);
end $$;

-- custom fields that already exist in the LIVE configuration cannot be removed or retyped (hide them instead), so stored values never become unreadable
create or replace function public.ops_check_protection(p_org uuid, p_new jsonb) returns void language plpgsql stable security definer set search_path = '' as $$
declare v_cur jsonb := public.workspace_live_definition(p_org); k text; f jsonb; nf jsonb;
begin
  foreach k in array array['appointments','inventory'] loop
    for f in select e.value from jsonb_array_elements(coalesce(v_cur #> array['operations', k, 'fields'], '[]'::jsonb)) e loop
      select e.value into nf from jsonb_array_elements(coalesce(p_new #> array['operations', k, 'fields'], '[]'::jsonb)) e where e.value->>'key' = f->>'key';
      if nf is null then raise exception 'The % custom field "%" cannot be removed; hide it instead.', k, f->>'label' using errcode = '22023'; end if;
      if nf->>'kind' <> f->>'kind' then raise exception 'The type of the % custom field "%" cannot change; hide it and add a new field.', k, f->>'label' using errcode = '22023'; end if;
    end loop;
  end loop;
end $$;
create or replace function public.workspace_check_data_protection(p_org uuid, p_new jsonb) returns void language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.workspace_check_data_protection_core(p_org, p_new);
  perform public.ops_check_protection(p_org, p_new);
end $$;

-- ---------- config: runtime helpers ----------
create or replace function public.ops_config(p_org uuid, p_module text) returns jsonb language sql stable security definer set search_path = '' as $$
  select definition #> array['operations', p_module] from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
$$;
-- caller's role, after checking membership AND that the module is enabled in the published configuration
create or replace function public.ops_require(p_org uuid, p_module text) returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org);
begin
  if coalesce((public.ops_config(p_org, p_module)->>'enabled')::boolean, false) is not true then
    raise exception 'The % module is not enabled for this organization.', p_module using errcode = '22023'; end if;
  return v_role;
end $$;
create or replace function public.ops_custom(p_org uuid, p_module text, p_input jsonb, p_existing jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_fields jsonb := coalesce(public.ops_config(p_org, p_module)->'fields', '[]'::jsonb);
begin
  if jsonb_array_length(v_fields) = 0 then
    if coalesce(p_input, '{}'::jsonb) <> '{}'::jsonb then raise exception 'This module has no custom fields configured.' using errcode = '22023'; end if;
    return coalesce(p_existing, '{}'::jsonb);
  end if;
  return public.record_validate(jsonb_build_object('fields', v_fields), coalesce(p_input, '{}'::jsonb), coalesce(p_existing, '{}'::jsonb));
end $$;

-- ---------- appointments: master data ----------
create table public.appointment_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80), duration_minutes integer not null check (duration_minutes between 5 and 1440),
  active boolean not null default true, created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index appointment_types_name_uq on public.appointment_types (organization_id, lower(name));

-- weekly working hours as minutes since local midnight; one staff member cannot have overlapping intervals on a weekday
create table public.staff_hours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, user_id uuid not null, weekday smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_minute integer not null check (start_minute between 0 and 1439), end_minute integer not null check (end_minute between 1 and 1440), check (end_minute > start_minute),
  foreign key (organization_id, user_id) references public.organization_members (organization_id, user_id) on delete cascade,
  exclude using gist (organization_id with =, user_id with =, weekday with =, int4range(start_minute, end_minute) with &&)
);
create table public.staff_time_off (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, user_id uuid not null, starts_at timestamptz not null, ends_at timestamptz not null, check (ends_at > starts_at), reason text check (char_length(reason) <= 200),
  created_by uuid not null, created_at timestamptz not null default now(),
  foreign key (organization_id, user_id) references public.organization_members (organization_id, user_id) on delete cascade
);
create index staff_time_off_idx on public.staff_time_off (organization_id, user_id, starts_at);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type_id uuid not null, staff_id uuid, contact_id uuid, lead_id uuid,
  starts_at timestamptz not null, ends_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','confirmed','completed','cancelled','no_show')),
  notes text check (char_length(notes) <= 2000), custom jsonb not null default '{}'::jsonb check (jsonb_typeof(custom) = 'object' and octet_length(custom::text) <= 10000),
  cancel_reason text check (char_length(cancel_reason) <= 500), reschedule_count integer not null default 0,
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz, cancelled_at timestamptz,
  check (ends_at > starts_at and ends_at - starts_at <= interval '24 hours'),
  unique (id, organization_id),
  foreign key (type_id, organization_id) references public.appointment_types (id, organization_id),
  foreign key (organization_id, staff_id) references public.organization_members (organization_id, user_id),
  foreign key (contact_id, organization_id) references public.contacts (id, organization_id),
  foreign key (lead_id, organization_id) references public.leads (id, organization_id),
  -- THE booking-consistency guarantee: no staff member can hold two live appointments that overlap, whatever the application does or however requests race
  constraint appointments_no_staff_overlap exclude using gist (organization_id with =, staff_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (staff_id is not null and status in ('scheduled','confirmed'))
);
create index appointments_org_start_idx on public.appointments (organization_id, starts_at);
create index appointments_staff_idx on public.appointments (organization_id, staff_id, starts_at);
create index appointments_contact_idx on public.appointments (contact_id) where contact_id is not null;

create table public.appointment_log (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  organization_id uuid not null, appointment_id uuid not null, action text not null check (action in ('created','confirmed','rescheduled','cancelled','completed','no_show','notes')),
  from_status text, to_status text, from_start timestamptz, to_start timestamptz, actor_id uuid, note text check (char_length(note) <= 500), created_at timestamptz not null default now(),
  foreign key (appointment_id, organization_id) references public.appointments (id, organization_id) on delete cascade
);
create index appointment_log_idx on public.appointment_log (appointment_id, seq);
create or replace function public.ops_append_only() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.organization_id) then return old; end if; -- cascade from deleting the organization
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger appointment_log_protect before update or delete on public.appointment_log for each row execute function public.ops_append_only();

alter table public.appointment_types enable row level security; alter table public.staff_hours enable row level security; alter table public.staff_time_off enable row level security;
alter table public.appointments enable row level security; alter table public.appointment_log enable row level security;
create policy appointment_types_read on public.appointment_types for select to authenticated using (public.is_org_member(organization_id));
create policy staff_hours_read on public.staff_hours for select to authenticated using (public.is_org_member(organization_id));
create policy staff_time_off_read on public.staff_time_off for select to authenticated using (public.is_org_member(organization_id));
create policy appointments_read on public.appointments for select to authenticated using (public.is_org_member(organization_id));
create policy appointment_log_read on public.appointment_log for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.appointment_types, public.staff_hours, public.staff_time_off, public.appointments, public.appointment_log from anon, authenticated;
grant select on public.appointment_types, public.staff_hours, public.staff_time_off, public.appointments, public.appointment_log to authenticated;

-- ---------- appointments: rules ----------
create or replace function public.appointment_check_slot(p_org uuid, p_staff uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid) returns void language plpgsql stable security definer set search_path = '' as $$
declare v_cfg jsonb := public.ops_config(p_org, 'appointments'); v_tz text := coalesce(v_cfg->>'timezone', 'UTC'); v_ls timestamp; v_le timestamp; v_ms int; v_me int;
begin
  if p_staff is null then return; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_staff) then raise exception 'The staff member must belong to this organization.' using errcode = '22023'; end if;
  if coalesce((v_cfg->>'enforce_working_hours')::boolean, true) then
    v_ls := p_start at time zone v_tz; v_le := p_end at time zone v_tz;
    v_ms := extract(hour from v_ls)::int * 60 + extract(minute from v_ls)::int; v_me := extract(hour from v_le)::int * 60 + extract(minute from v_le)::int;
    if v_ls::date <> v_le::date or not exists (select 1 from public.staff_hours h where h.organization_id = p_org and h.user_id = p_staff and h.weekday = extract(dow from v_ls)::int and h.start_minute <= v_ms and h.end_minute >= v_me) then
      raise exception 'That time is outside the staff member''s working hours.' using errcode = '22023'; end if;
  end if;
  if exists (select 1 from public.staff_time_off t where t.organization_id = p_org and t.user_id = p_staff and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_start, p_end, '[)')) then
    raise exception 'The staff member is on time off then.' using errcode = '22023'; end if;
  if exists (select 1 from public.appointments a where a.organization_id = p_org and a.staff_id = p_staff and a.status in ('scheduled','confirmed') and (p_exclude is null or a.id <> p_exclude)
             and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_start, p_end, '[)')) then
    raise exception 'This staff member already has an appointment at that time.' using errcode = '23P01'; end if;
end $$;

create or replace function public.appointment_payload(a public.appointments, p_extra jsonb default '{}'::jsonb) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('appointment_id', a.id, 'type_id', a.type_id, 'type', (select t.name from public.appointment_types t where t.id = a.type_id), 'staff_id', a.staff_id, 'contact_id', a.contact_id,
    'lead_id', a.lead_id, 'starts_at', a.starts_at, 'ends_at', a.ends_at, 'status', a.status) || coalesce(p_extra, '{}'::jsonb);
$$;
create or replace function public.appointment_can_manage(a public.appointments, p_role text, p_uid uuid) returns boolean language sql immutable set search_path = '' as $$
  select p_role in ('owner','admin','manager') or a.staff_id = p_uid or a.created_by = p_uid or a.staff_id is null;
$$;
create or replace function public.appointment_lock(p_org uuid, p_id uuid) returns public.appointments language plpgsql security definer set search_path = '' as $$
declare a public.appointments;
begin
  select * into a from public.appointments where id = p_id and organization_id = p_org for update;
  if not found then raise exception 'Appointment not found.' using errcode = 'P0002'; end if;
  return a;
end $$;

-- ---------- appointments: write API ----------
create or replace function public.appointment_type_save(p_org uuid, p_id uuid, p_name text, p_duration integer, p_active boolean) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id uuid := p_id;
begin
  if public.ops_require(p_org, 'appointments') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can manage appointment types.' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 80 or p_duration not between 5 and 1440 then raise exception 'An appointment type needs a name and a duration of 5 to 1440 minutes.' using errcode = '22023'; end if;
  if v_id is null then insert into public.appointment_types (organization_id, name, duration_minutes, active, created_by) values (p_org, v_name, p_duration, coalesce(p_active, true), v_uid) returning id into v_id;
  else update public.appointment_types set name = v_name, duration_minutes = p_duration, active = coalesce(p_active, active), updated_at = now() where id = v_id and organization_id = p_org;
    if not found then raise exception 'Appointment type not found.' using errcode = 'P0002'; end if; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'appointment_type.saved', jsonb_build_object('type_id', v_id));
  return v_id;
exception when unique_violation then raise exception 'An appointment type with that name already exists.' using errcode = '23505';
end $$;

create or replace function public.staff_hours_set(p_org uuid, p_user uuid, p_hours jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare h jsonb; v_s int; v_e int;
begin
  if public.ops_require(p_org, 'appointments') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can set working hours.' using errcode = '42501'; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_user) then raise exception 'Team member not found.' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_hours) is distinct from 'array' or jsonb_array_length(p_hours) > 21 then raise exception 'Working hours must be a list of at most 21 intervals.' using errcode = '22023'; end if;
  delete from public.staff_hours where organization_id = p_org and user_id = p_user;
  for h in select * from jsonb_array_elements(p_hours) loop
    if coalesce(h->>'weekday', '') !~ '^[0-6]$' or coalesce(h->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(h->>'end', '') !~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' then
      raise exception 'Each interval needs a weekday (0 = Sunday) and start/end as HH:MM.' using errcode = '22023'; end if;
    v_s := split_part(h->>'start', ':', 1)::int * 60 + split_part(h->>'start', ':', 2)::int; v_e := split_part(h->>'end', ':', 1)::int * 60 + split_part(h->>'end', ':', 2)::int;
    if v_e <= v_s then raise exception 'An interval must end after it starts.' using errcode = '22023'; end if;
    insert into public.staff_hours (organization_id, user_id, weekday, start_minute, end_minute) values (p_org, p_user, (h->>'weekday')::smallint, v_s, v_e);
  end loop;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'staff_hours.set', jsonb_build_object('user_id', p_user));
exception when exclusion_violation then raise exception 'Working-hour intervals on the same day must not overlap.' using errcode = '22023';
end $$;

create or replace function public.staff_time_off_add(p_org uuid, p_user uuid, p_start timestamptz, p_end timestamptz, p_reason text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_clash int;
begin
  if public.ops_require(p_org, 'appointments') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can record time off.' using errcode = '42501'; end if;
  if p_end <= p_start or p_end - p_start > interval '366 days' then raise exception 'Time off must end after it starts and last at most a year.' using errcode = '22023'; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_user) then raise exception 'Team member not found.' using errcode = 'P0002'; end if;
  insert into public.staff_time_off (organization_id, user_id, starts_at, ends_at, reason, created_by) values (p_org, p_user, p_start, p_end, left(btrim(p_reason), 200), (select auth.uid())) returning id into v_id;
  select count(*) into v_clash from public.appointments a where a.organization_id = p_org and a.staff_id = p_user and a.status in ('scheduled','confirmed') and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_start, p_end, '[)');
  return jsonb_build_object('id', v_id, 'existing_appointments_affected', v_clash); -- existing bookings are NOT cancelled automatically: the caller decides
end $$;
create or replace function public.staff_time_off_remove(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.ops_require(p_org, 'appointments') not in ('owner','admin','manager') then raise exception 'Only owners, admins and managers can record time off.' using errcode = '42501'; end if;
  delete from public.staff_time_off where id = p_id and organization_id = p_org;
  if not found then raise exception 'Time off not found.' using errcode = 'P0002'; end if;
end $$;

create or replace function public.appointment_create(p_org uuid, p_type uuid, p_staff uuid, p_contact uuid, p_lead uuid, p_start timestamptz, p_notes text, p_custom jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ops_require(p_org, 'appointments'); t public.appointment_types; a public.appointments; v_contact uuid := p_contact; v_lead_contact uuid;
begin
  select * into t from public.appointment_types where id = p_type and organization_id = p_org and active;
  if not found then raise exception 'Choose an active appointment type.' using errcode = '22023'; end if;
  if p_start is null or p_start < now() - interval '1 day' or p_start > now() + interval '2 years' then raise exception 'Choose a start time within the next two years (back-dating is limited to one day).' using errcode = '22023'; end if;
  if p_lead is not null then
    select contact_id into v_lead_contact from public.leads where id = p_lead and organization_id = p_org;
    if not found then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
    if v_contact is not null and v_contact <> v_lead_contact then raise exception 'The lead belongs to a different contact.' using errcode = '22023'; end if;
    v_contact := v_lead_contact;
  end if;
  if v_contact is not null and not exists (select 1 from public.contacts where id = v_contact and organization_id = p_org) then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  perform public.appointment_check_slot(p_org, p_staff, p_start, p_start + make_interval(mins => t.duration_minutes), null);
  insert into public.appointments (organization_id, type_id, staff_id, contact_id, lead_id, starts_at, ends_at, notes, custom, created_by)
    values (p_org, p_type, p_staff, v_contact, p_lead, p_start, p_start + make_interval(mins => t.duration_minutes), nullif(left(btrim(coalesce(p_notes, '')), 2000), ''), public.ops_custom(p_org, 'appointments', p_custom, '{}'::jsonb), v_uid) returning * into a;
  insert into public.appointment_log (organization_id, appointment_id, action, to_status, to_start, actor_id) values (p_org, a.id, 'created', a.status, a.starts_at, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'appointment.created', jsonb_build_object('appointment_id', a.id));
  perform public.crm_emit(p_org, 'appointment.created', 'appointment', a.id, public.appointment_payload(a));
  return a.id;
exception when exclusion_violation then raise exception 'This staff member already has an appointment at that time.' using errcode = '23P01';
end $$;

create or replace function public.appointment_reschedule(p_org uuid, p_id uuid, p_start timestamptz, p_staff uuid default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ops_require(p_org, 'appointments'); a public.appointments := public.appointment_lock(p_org, p_id); v_old public.appointments := a; v_dur interval; v_staff uuid;
begin
  if not public.appointment_can_manage(a, v_role, v_uid) then raise exception 'You can only change appointments you created or are assigned to.' using errcode = '42501'; end if;
  if a.status not in ('scheduled','confirmed') then raise exception 'Only scheduled or confirmed appointments can be rescheduled.' using errcode = '22023'; end if;
  if p_start is null or p_start < now() - interval '1 day' or p_start > now() + interval '2 years' then raise exception 'Choose a start time within the next two years.' using errcode = '22023'; end if;
  v_dur := a.ends_at - a.starts_at; v_staff := coalesce(p_staff, a.staff_id);
  if p_start = a.starts_at and v_staff is not distinct from a.staff_id then return; end if;
  perform public.appointment_check_slot(p_org, v_staff, p_start, p_start + v_dur, a.id);
  update public.appointments set starts_at = p_start, ends_at = p_start + v_dur, staff_id = v_staff, status = 'scheduled', reschedule_count = reschedule_count + 1, updated_at = now() where id = a.id returning * into a;
  insert into public.appointment_log (organization_id, appointment_id, action, from_status, to_status, from_start, to_start, actor_id) values (p_org, a.id, 'rescheduled', v_old.status, a.status, v_old.starts_at, a.starts_at, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'appointment.rescheduled', jsonb_build_object('appointment_id', a.id, 'from', v_old.starts_at, 'to', a.starts_at));
  perform public.crm_emit(p_org, 'appointment.rescheduled', 'appointment', a.id, public.appointment_payload(a, jsonb_build_object('previous_starts_at', v_old.starts_at, 'previous_staff_id', v_old.staff_id)));
exception when exclusion_violation then raise exception 'This staff member already has an appointment at that time.' using errcode = '23P01';
end $$;

create or replace function public.appointment_cancel(p_org uuid, p_id uuid, p_reason text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ops_require(p_org, 'appointments'); a public.appointments := public.appointment_lock(p_org, p_id);
begin
  if not public.appointment_can_manage(a, v_role, v_uid) then raise exception 'You can only cancel appointments you created or are assigned to.' using errcode = '42501'; end if;
  if a.status not in ('scheduled','confirmed') then raise exception 'Only scheduled or confirmed appointments can be cancelled.' using errcode = '22023'; end if;
  update public.appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), ''), updated_at = now() where id = a.id returning * into a;
  insert into public.appointment_log (organization_id, appointment_id, action, from_status, to_status, actor_id, note) values (p_org, a.id, 'cancelled', 'scheduled', 'cancelled', v_uid, left(p_reason, 500));
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'appointment.cancelled', jsonb_build_object('appointment_id', a.id));
  perform public.crm_emit(p_org, 'appointment.cancelled', 'appointment', a.id, public.appointment_payload(a, jsonb_build_object('reason', left(p_reason, 200))));
end $$;

create or replace function public.appointment_confirm(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ops_require(p_org, 'appointments'); a public.appointments := public.appointment_lock(p_org, p_id);
begin
  if not public.appointment_can_manage(a, v_role, v_uid) then raise exception 'You can only change appointments you created or are assigned to.' using errcode = '42501'; end if;
  if a.status <> 'scheduled' then raise exception 'Only a scheduled appointment can be confirmed.' using errcode = '22023'; end if;
  update public.appointments set status = 'confirmed', updated_at = now() where id = a.id;
  insert into public.appointment_log (organization_id, appointment_id, action, from_status, to_status, actor_id) values (p_org, a.id, 'confirmed', 'scheduled', 'confirmed', v_uid);
end $$;

-- completed / no-show: only the assigned staff member or a manager+, and only once the appointment has started
create or replace function public.appointment_finish(p_org uuid, p_id uuid, p_outcome text, p_notes text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ops_require(p_org, 'appointments'); a public.appointments := public.appointment_lock(p_org, p_id); v_prev text;
begin
  if p_outcome not in ('completed','no_show') then raise exception 'Outcome must be completed or no_show.' using errcode = '22023'; end if;
  if not (v_role in ('owner','admin','manager') or a.staff_id = v_uid) then raise exception 'Only the assigned staff member or a manager can close an appointment.' using errcode = '42501'; end if;
  if a.status not in ('scheduled','confirmed') then raise exception 'Only scheduled or confirmed appointments can be closed.' using errcode = '22023'; end if;
  if a.starts_at > now() then raise exception 'This appointment has not started yet.' using errcode = '22023'; end if;
  v_prev := a.status;
  update public.appointments set status = p_outcome, completed_at = case when p_outcome = 'completed' then now() end, notes = coalesce(nullif(left(btrim(coalesce(p_notes, '')), 2000), ''), notes), updated_at = now() where id = a.id returning * into a;
  insert into public.appointment_log (organization_id, appointment_id, action, from_status, to_status, actor_id) values (p_org, a.id, p_outcome, v_prev, p_outcome, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'appointment.' || p_outcome, jsonb_build_object('appointment_id', a.id));
  if p_outcome = 'completed' then perform public.crm_emit(p_org, 'appointment.completed', 'appointment', a.id, public.appointment_payload(a)); end if;
end $$;

create or replace function public.appointment_set_notes(p_org uuid, p_id uuid, p_notes text, p_custom jsonb default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ops_require(p_org, 'appointments'); a public.appointments := public.appointment_lock(p_org, p_id);
begin
  if not public.appointment_can_manage(a, v_role, v_uid) then raise exception 'You can only change appointments you created or are assigned to.' using errcode = '42501'; end if;
  update public.appointments set notes = nullif(left(btrim(coalesce(p_notes, '')), 2000), ''), custom = case when p_custom is null then custom else public.ops_custom(p_org, 'appointments', p_custom, custom) end, updated_at = now() where id = a.id;
  insert into public.appointment_log (organization_id, appointment_id, action, actor_id) values (p_org, a.id, 'notes', v_uid);
end $$;

-- free start times for one staff member on one LOCAL date (organization time zone), for the booking form
create or replace function public.appointment_free_slots(p_org uuid, p_staff uuid, p_type uuid, p_date date) returns table (slot_start timestamptz, slot_end timestamptz) language plpgsql stable security definer set search_path = '' as $$
declare v_tz text := coalesce(public.ops_config(p_org, 'appointments')->>'timezone', 'UTC'); v_dur int; h record; t timestamp; s timestamptz; e timestamptz; n int := 0;
begin
  perform public.ops_require(p_org, 'appointments');
  select duration_minutes into v_dur from public.appointment_types where id = p_type and organization_id = p_org and active;
  if v_dur is null then raise exception 'Choose an active appointment type.' using errcode = '22023'; end if;
  if p_date is null or p_date < current_date - 1 or p_date > current_date + 366 then raise exception 'Choose a date within the next year.' using errcode = '22023'; end if;
  for h in select sh.start_minute, sh.end_minute from public.staff_hours sh where sh.organization_id = p_org and sh.user_id = p_staff and sh.weekday = extract(dow from p_date)::int order by sh.start_minute loop
    t := p_date::timestamp + make_interval(mins => h.start_minute);
    while t + make_interval(mins => v_dur) <= p_date::timestamp + make_interval(mins => h.end_minute) and n < 200 loop
      s := t at time zone v_tz; e := (t + make_interval(mins => v_dur)) at time zone v_tz;
      if s > now() and not exists (select 1 from public.appointments a where a.organization_id = p_org and a.staff_id = p_staff and a.status in ('scheduled','confirmed') and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(s, e, '[)'))
         and not exists (select 1 from public.staff_time_off o where o.organization_id = p_org and o.user_id = p_staff and tstzrange(o.starts_at, o.ends_at, '[)') && tstzrange(s, e, '[)')) then
        slot_start := s; slot_end := e; n := n + 1; return next;
      end if;
      t := t + make_interval(mins => v_dur);
    end loop;
  end loop;
end $$;

-- ---------- privileges ----------
revoke all on function public.validate_workspace_definition_core(jsonb), public.workspace_check_data_protection_core(uuid, jsonb), public.ops_validate_fields(jsonb), public.ops_validate(jsonb),
  public.validate_workspace_definition(jsonb), public.ops_check_protection(uuid, jsonb), public.workspace_check_data_protection(uuid, jsonb), public.ops_config(uuid, text), public.ops_require(uuid, text),
  public.ops_custom(uuid, text, jsonb, jsonb), public.ops_append_only(), public.appointment_check_slot(uuid, uuid, timestamptz, timestamptz, uuid), public.appointment_payload(public.appointments, jsonb),
  public.appointment_can_manage(public.appointments, text, uuid), public.appointment_lock(uuid, uuid) from public, anon, authenticated;
revoke all on function public.appointment_type_save(uuid, uuid, text, integer, boolean), public.staff_hours_set(uuid, uuid, jsonb), public.staff_time_off_add(uuid, uuid, timestamptz, timestamptz, text),
  public.staff_time_off_remove(uuid, uuid), public.appointment_create(uuid, uuid, uuid, uuid, uuid, timestamptz, text, jsonb), public.appointment_reschedule(uuid, uuid, timestamptz, uuid),
  public.appointment_cancel(uuid, uuid, text), public.appointment_confirm(uuid, uuid), public.appointment_finish(uuid, uuid, text, text), public.appointment_set_notes(uuid, uuid, text, jsonb),
  public.appointment_free_slots(uuid, uuid, uuid, date) from public, anon;
grant execute on function public.appointment_type_save(uuid, uuid, text, integer, boolean), public.staff_hours_set(uuid, uuid, jsonb), public.staff_time_off_add(uuid, uuid, timestamptz, timestamptz, text),
  public.staff_time_off_remove(uuid, uuid), public.appointment_create(uuid, uuid, uuid, uuid, uuid, timestamptz, text, jsonb), public.appointment_reschedule(uuid, uuid, timestamptz, uuid),
  public.appointment_cancel(uuid, uuid, text), public.appointment_confirm(uuid, uuid), public.appointment_finish(uuid, uuid, text, text), public.appointment_set_notes(uuid, uuid, text, jsonb),
  public.appointment_free_slots(uuid, uuid, uuid, date) to authenticated;
