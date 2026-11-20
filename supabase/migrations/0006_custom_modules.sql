-- 0006: custom modules. Owners define modules + fields in the Builder (versioned configuration, 0005); this adds the
-- generic record store those definitions drive, plus the data-protection rules that keep records safe when definitions change.
-- 0001-0005 are untouched (they may already be applied). Functions from 0005 are replaced with CREATE OR REPLACE.
--
-- Model: a custom module is a module (key K) + a record type (object) with the same key K. Records live in public.records,
-- scoped by organization_id + object_key, values in jsonb keyed by the FIELD KEY (stable). Renaming a field only changes its label,
-- hiding a field sets "archived": true; neither touches stored data. Removing a field/module/record type or changing a field's type
-- is refused while records still use it.
-- Permissions: every member can read, create records in active modules and edit records they created; owners/admins/managers edit any.

-- ---------- storage ----------
create table public.records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  object_key text not null check (object_key ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(object_key) <= 40),
  data jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 20000),
  search_text text not null default '' check (char_length(search_text) <= 4000),
  config_revision integer, -- revision of the published configuration the record was last written under
  created_by uuid not null, updated_by uuid not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index records_org_object_created_idx on public.records (organization_id, object_key, created_at desc, id);
create index records_data_gin_idx on public.records using gin (data jsonb_path_ops); -- equality filters on dropdown / checkbox values
create index audit_events_org_created_idx on public.audit_events (organization_id, created_at desc);

alter table public.records enable row level security;
create policy records_read on public.records for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.records from anon, authenticated;
grant select on public.records to authenticated; -- all writes go through record_create / record_update

-- ---------- definition validator (replaces 0005): adds field kinds phone/email/currency, required/archived/currency attributes, archived modules ----------
create or replace function public.validate_workspace_definition(p jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare m jsonb; o jsonb; f jsonb; k text; v_mods text[] := '{}'; v_objs text[] := '{}'; v_fields text[]; v_n int;
begin
  if p is null or jsonb_typeof(p) is distinct from 'object' or p->'schemaVersion' is distinct from to_jsonb(1) or octet_length(p::text) > 200000 then
    raise exception 'Invalid workspace definition.' using errcode = '22023'; end if;

  if jsonb_typeof(p->'modules') is distinct from 'array' or jsonb_array_length(p->'modules') > 40 then
    raise exception 'Modules must be a list of at most 40.' using errcode = '22023'; end if;
  for m in select * from jsonb_array_elements(p->'modules') loop
    k := case when jsonb_typeof(m) = 'object' and jsonb_typeof(m->'key') = 'string' then m->>'key' end;
    if k is null or k !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(k) > 40 then raise exception 'Every module needs a short key (letters, digits, dashes).' using errcode = '22023'; end if;
    if k = any(v_mods) then raise exception 'Duplicate module "%".', k using errcode = '22023'; end if;
    v_mods := array_append(v_mods, k);
    if jsonb_typeof(m->'label') is distinct from 'string' or char_length(btrim(m->>'label')) not between 1 and 60 then raise exception 'Module "%" needs a name of up to 60 characters.', k using errcode = '22023'; end if;
    if m->>'status' is null or m->>'status' not in ('active','planned','archived') then raise exception 'Module "%" has an invalid status.', k using errcode = '22023'; end if;
  end loop;
  if not exists (select 1 from jsonb_array_elements(p->'modules') x where x->>'key' = 'overview' and x->>'status' = 'active')
     or not exists (select 1 from jsonb_array_elements(p->'modules') x where x->>'key' = 'leads' and x->>'status' = 'active') then
    raise exception 'The Overview and Leads modules are required and must be active.' using errcode = '22023'; end if;

  if jsonb_typeof(p#>'{pipeline,stages}') is distinct from 'array' or jsonb_array_length(p#>'{pipeline,stages}') not between 2 and 20 then
    raise exception 'The pipeline needs between 2 and 20 stages.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_array_elements(p#>'{pipeline,stages}') s where jsonb_typeof(s) is distinct from 'string' or char_length(s #>> '{}') not between 1 and 80 or (s #>> '{}') <> btrim(s #>> '{}')) then
    raise exception 'Each pipeline stage needs a name of up to 80 characters.' using errcode = '22023'; end if;
  select count(distinct s #>> '{}') into v_n from jsonb_array_elements(p#>'{pipeline,stages}') s;
  if v_n <> jsonb_array_length(p#>'{pipeline,stages}') then raise exception 'Pipeline stage names must be unique.' using errcode = '22023'; end if;

  if jsonb_typeof(p->'objects') is distinct from 'array' or jsonb_array_length(p->'objects') > 20 then raise exception 'Record types must be a list of at most 20.' using errcode = '22023'; end if;
  for o in select * from jsonb_array_elements(p->'objects') loop
    k := case when jsonb_typeof(o) = 'object' and jsonb_typeof(o->'key') = 'string' then o->>'key' end;
    if k is null or k !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or char_length(k) > 40 then raise exception 'Every record type needs a short key.' using errcode = '22023'; end if;
    if k = any(v_objs) then raise exception 'Duplicate record type "%".', k using errcode = '22023'; end if;
    v_objs := array_append(v_objs, k);
    if jsonb_typeof(o->'label') is distinct from 'string' or char_length(btrim(o->>'label')) not between 1 and 60 then raise exception 'Record type "%" needs a name of up to 60 characters.', k using errcode = '22023'; end if;
    if jsonb_typeof(o->'fields') is distinct from 'array' or jsonb_array_length(o->'fields') > 30 then raise exception 'Record type "%" can have at most 30 fields.', k using errcode = '22023'; end if;
    v_fields := '{}';
    for f in select * from jsonb_array_elements(o->'fields') loop
      k := case when jsonb_typeof(f) = 'object' and jsonb_typeof(f->'key') = 'string' then f->>'key' end;
      if k is null or k !~ '^[a-z][a-z0-9_]*$' or char_length(k) > 40 then raise exception 'Every field needs a short key.' using errcode = '22023'; end if;
      if k = any(v_fields) then raise exception 'Duplicate field "%".', k using errcode = '22023'; end if;
      v_fields := array_append(v_fields, k);
      if jsonb_typeof(f->'label') is distinct from 'string' or char_length(btrim(f->>'label')) not between 1 and 60 then raise exception 'Field "%" needs a name of up to 60 characters.', k using errcode = '22023'; end if;
      if f->>'kind' is null or f->>'kind' not in ('text','number','date','yes_no','choice','phone','email','currency') then raise exception 'Field "%" has an invalid type.', k using errcode = '22023'; end if;
      if jsonb_exists(f, 'required') and jsonb_typeof(f->'required') is distinct from 'boolean' then raise exception 'Field "%" has an invalid required setting.', k using errcode = '22023'; end if;
      if jsonb_exists(f, 'archived') and jsonb_typeof(f->'archived') is distinct from 'boolean' then raise exception 'Field "%" has an invalid hidden setting.', k using errcode = '22023'; end if;
      if jsonb_exists(f, 'currency') and (jsonb_typeof(f->'currency') is distinct from 'string' or f->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Field "%" needs a 3-letter currency code such as INR.', k using errcode = '22023'; end if;
      if f->>'kind' = 'choice' and (jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options') not between 1 and 30
         or exists (select 1 from jsonb_array_elements(f->'options') x where jsonb_typeof(x) is distinct from 'string' or char_length(x #>> '{}') not between 1 and 60)) then
        raise exception 'Dropdown field "%" needs between 1 and 30 options.', k using errcode = '22023'; end if;
    end loop;
  end loop;
end $$;

-- ---------- record validation (the real gate; the app mirrors it for friendly errors) ----------
create or replace function public.record_validate(p_obj jsonb, p_input jsonb, p_existing jsonb) returns jsonb language plpgsql stable set search_path = '' as $$
declare v_out jsonb := coalesce(p_existing, '{}'::jsonb); k text; v jsonb; f jsonb; s text; n numeric; l text;
begin
  if p_input is null or jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Invalid record data.' using errcode = '22023'; end if;
  for k, v in select e.key, e.value from jsonb_each(p_input) e loop
    select e.value into f from jsonb_array_elements(p_obj->'fields') e where e.value->>'key' = k;
    if f is null then raise exception 'Unknown field "%".', k using errcode = '22023'; end if;
    l := f->>'label';
    if coalesce((f->>'archived')::boolean, false) then raise exception 'The field "%" is hidden and cannot be edited.', l using errcode = '22023'; end if;
    if jsonb_typeof(v) = 'null' or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '') then v_out := v_out - k; continue; end if; -- empty clears the value
    case f->>'kind'
      when 'text' then
        if jsonb_typeof(v) <> 'string' then raise exception '"%" must be text.', l using errcode = '22023'; end if;
        s := btrim(v #>> '{}'); if char_length(s) > 2000 then raise exception '"%" must be at most 2000 characters.', l using errcode = '22023'; end if;
        v := to_jsonb(s);
      when 'number', 'currency' then
        if jsonb_typeof(v) <> 'number' then raise exception '"%" must be a number.', l using errcode = '22023'; end if;
        n := (v #>> '{}')::numeric;
        if abs(n) >= 1e15 then raise exception '"%" is too large.', l using errcode = '22023'; end if;
        if f->>'kind' = 'currency' and n * 100 <> round(n * 100) then raise exception '"%" can have at most 2 decimal places.', l using errcode = '22023'; end if;
      when 'date' then
        if jsonb_typeof(v) <> 'string' then raise exception '"%" must be a date.', l using errcode = '22023'; end if;
        s := btrim(v #>> '{}');
        begin
          if s !~ '^\d{4}-\d{2}-\d{2}$' or extract(year from s::date) not between 1900 and 2200 then raise exception 'x'; end if;
        exception when others then raise exception '"%" must be a valid date (YYYY-MM-DD).', l using errcode = '22023'; end;
        v := to_jsonb(s);
      when 'choice' then
        if jsonb_typeof(v) <> 'string' then raise exception '"%" must be one of the listed options.', l using errcode = '22023'; end if;
        s := btrim(v #>> '{}');
        -- a value already stored on the record stays valid even if its option was later removed from the list
        if not (coalesce(f->'options', '[]'::jsonb) @> to_jsonb(s)) and (p_existing->k) is distinct from to_jsonb(s) then raise exception '"%" must be one of the listed options.', l using errcode = '22023'; end if;
        v := to_jsonb(s);
      when 'yes_no' then
        if jsonb_typeof(v) <> 'boolean' then raise exception '"%" must be yes or no.', l using errcode = '22023'; end if;
      when 'phone' then
        if jsonb_typeof(v) <> 'string' then raise exception '"%" must be a phone number.', l using errcode = '22023'; end if;
        s := regexp_replace(v #>> '{}', '[\s().-]', '', 'g');
        if s !~ '^\+?[0-9]{7,15}$' then raise exception '"%" must be a valid phone number (7 to 15 digits, optional leading +).', l using errcode = '22023'; end if;
        v := to_jsonb(s);
      when 'email' then
        if jsonb_typeof(v) <> 'string' then raise exception '"%" must be an email address.', l using errcode = '22023'; end if;
        s := lower(btrim(v #>> '{}'));
        if char_length(s) > 254 or s !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception '"%" must be a valid email address.', l using errcode = '22023'; end if;
        v := to_jsonb(s);
      else raise exception 'Unsupported field type.' using errcode = '22023';
    end case;
    v_out := v_out || jsonb_build_object(k, v);
  end loop;
  for f in select e.value from jsonb_array_elements(p_obj->'fields') e loop
    if coalesce((f->>'required')::boolean, false) and not coalesce((f->>'archived')::boolean, false) and not jsonb_exists(v_out, f->>'key') then
      raise exception '"%" is required.', f->>'label' using errcode = '22023'; end if;
  end loop;
  if octet_length(v_out::text) > 20000 then raise exception 'This record is too large.' using errcode = '22023'; end if;
  return v_out;
end $$;

create or replace function public.record_search_text(p jsonb) returns text language sql immutable set search_path = '' as $$
  select lower(left(coalesce(string_agg(e.value #>> '{}', ' '), ''), 4000)) from jsonb_each(p) e where jsonb_typeof(e.value) in ('string','number');
$$;

-- Resolves the LIVE definition of one record type of an active, non-core module; "Module not found." otherwise (also for archived/planned modules).
create or replace function public.record_object(p_org uuid, p_object text, out o_def jsonb, out o_revision int) language plpgsql stable security definer set search_path = '' as $$
declare v_ver public.workspace_configuration_versions;
begin
  select * into v_ver from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
  select e.value into o_def from jsonb_array_elements(v_ver.definition->'objects') e where e.value->>'key' = p_object;
  if o_def is null or p_object in ('overview','leads')
     or not exists (select 1 from jsonb_array_elements(v_ver.definition->'modules') m where m.value->>'key' = p_object and m.value->>'status' = 'active') then
    raise exception 'Module not found.' using errcode = 'P0002'; end if;
  o_revision := v_ver.revision;
end $$;

-- ---------- record write API ----------
create or replace function public.record_create(p_org uuid, p_object text, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_obj jsonb; v_rev int; v_data jsonb; v_id uuid;
begin
  select o_def, o_revision into v_obj, v_rev from public.record_object(p_org, p_object);
  v_data := public.record_validate(v_obj, p_data, '{}'::jsonb);
  insert into public.records (organization_id, object_key, data, search_text, config_revision, created_by, updated_by)
    values (p_org, p_object, v_data, public.record_search_text(v_data), v_rev, v_uid, v_uid) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'record.created', jsonb_build_object('object', p_object, 'record_id', v_id));
  perform public.crm_emit(p_org, 'record.created', 'record', v_id, jsonb_build_object('object', p_object));
  return v_id;
end $$;

create or replace function public.record_update(p_org uuid, p_record uuid, p_data jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_rec public.records; v_obj jsonb; v_rev int; v_data jsonb; v_changed jsonb;
begin
  select * into v_rec from public.records where id = p_record and organization_id = p_org for update;
  if not found then raise exception 'Record not found.' using errcode = 'P0002'; end if;
  if v_role not in ('owner','admin','manager') and v_rec.created_by <> v_uid then raise exception 'You can only edit records you created.' using errcode = '42501'; end if;
  select o_def, o_revision into v_obj, v_rev from public.record_object(p_org, v_rec.object_key);
  v_data := public.record_validate(v_obj, p_data, v_rec.data);
  select coalesce(jsonb_agg(t.k order by t.k), '[]'::jsonb) into v_changed from (
    select e.key k from jsonb_each(v_data) e where v_rec.data->e.key is distinct from e.value
    union select e.key from jsonb_each(v_rec.data) e where not jsonb_exists(v_data, e.key)) t;
  if jsonb_array_length(v_changed) = 0 then return; end if;
  update public.records set data = v_data, search_text = public.record_search_text(v_data), config_revision = v_rev, updated_by = v_uid, updated_at = now() where id = p_record;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'record.updated', jsonb_build_object('object', v_rec.object_key, 'record_id', p_record, 'fields', v_changed));
  perform public.crm_emit(p_org, 'record.updated', 'record', p_record, jsonb_build_object('object', v_rec.object_key, 'fields', v_changed));
end $$;

-- ---------- data protection for configuration changes ----------
create or replace function public.workspace_live_definition(p_org uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select definition from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
$$;
create or replace function public.workspace_has_records(p_org uuid, p_object text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.records where organization_id = p_org and object_key = p_object);
$$;
create or replace function public.workspace_has_field_data(p_org uuid, p_object text, p_field text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.records where organization_id = p_org and object_key = p_object and jsonb_exists(data, p_field));
$$;

-- Strict guard used by publish: nothing records depend on may disappear or change type. Hide (archive) instead.
create or replace function public.workspace_check_data_protection(p_org uuid, p_new jsonb) returns void language plpgsql stable security definer set search_path = '' as $$
declare v_cur jsonb := public.workspace_live_definition(p_org); o jsonb; f jsonb; n jsonb; nf jsonb;
begin
  for o in select e.value from jsonb_array_elements(coalesce(v_cur->'objects', '[]'::jsonb)) e loop
    if not public.workspace_has_records(p_org, o->>'key') then continue; end if;
    select e.value into n from jsonb_array_elements(p_new->'objects') e where e.value->>'key' = o->>'key';
    if n is null then raise exception 'Records exist in "%". Hide the module instead of removing it.', o->>'label' using errcode = '22023'; end if;
    for f in select e.value from jsonb_array_elements(o->'fields') e loop
      if not public.workspace_has_field_data(p_org, o->>'key', f->>'key') then continue; end if;
      select e.value into nf from jsonb_array_elements(n->'fields') e where e.value->>'key' = f->>'key';
      if nf is null then raise exception 'Records already have data in the field "%" of "%". Hide the field instead of removing it.', f->>'label', o->>'label' using errcode = '22023'; end if;
      if nf->>'kind' <> f->>'kind' then raise exception 'The type of "%" in "%" cannot change because records already use it. Hide it and add a new field.', f->>'label', o->>'label' using errcode = '22023'; end if;
    end loop;
  end loop;
end $$;

-- Repairs an arbitrary definition (e.g. an older revision being restored) so it satisfies the guard above:
-- re-adds record types/fields that hold data (as hidden) and keeps the live field type where records use the field.
create or replace function public.workspace_protect_data(p_org uuid, p_def jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_cur jsonb := public.workspace_live_definition(p_org); v_def jsonb := p_def; o jsonb; f jsonb; n jsonb; nf jsonb; v_fields jsonb;
begin
  for o in select e.value from jsonb_array_elements(coalesce(v_cur->'objects', '[]'::jsonb)) e loop
    if not public.workspace_has_records(p_org, o->>'key') then continue; end if;
    select e.value into n from jsonb_array_elements(v_def->'objects') e where e.value->>'key' = o->>'key';
    if n is null then
      v_def := jsonb_set(v_def, '{objects}', coalesce(v_def->'objects', '[]'::jsonb) || jsonb_build_array(o));
    else
      v_fields := coalesce(n->'fields', '[]'::jsonb);
      for f in select e.value from jsonb_array_elements(o->'fields') e loop
        if not public.workspace_has_field_data(p_org, o->>'key', f->>'key') then continue; end if;
        select e.value into nf from jsonb_array_elements(v_fields) e where e.value->>'key' = f->>'key';
        if nf is null then v_fields := v_fields || jsonb_build_array(f || '{"archived": true}'::jsonb);
        elsif nf->>'kind' <> f->>'kind' then
          v_fields := (select jsonb_agg(case when e.value->>'key' = f->>'key' then f else e.value end order by e.ord) from jsonb_array_elements(v_fields) with ordinality e(value, ord));
        end if;
      end loop;
      v_def := jsonb_set(v_def, '{objects}', (select jsonb_agg(case when e.value->>'key' = o->>'key' then n || jsonb_build_object('fields', v_fields) else e.value end order by e.ord)
                                               from jsonb_array_elements(v_def->'objects') with ordinality e(value, ord)));
    end if;
    if not exists (select 1 from jsonb_array_elements(v_def->'modules') m where m.value->>'key' = o->>'key') then
      v_def := jsonb_set(v_def, '{modules}', (v_def->'modules') || jsonb_build_array(jsonb_build_object('key', o->>'key', 'label', o->>'label', 'status', 'archived')));
    end if;
  end loop;
  return v_def;
end $$;

-- ---------- Builder lifecycle (replaces 0005 versions: adds audit rows and the data-protection guard; adds rollback) ----------
create or replace function public.save_workspace_draft(p_org uuid, p_definition jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_name text; v_def jsonb; v_rev int;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform public.validate_workspace_definition(p_definition);
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  select name into v_name from public.organizations where id = p_org;
  v_def := (p_definition - 'industryTemplate') || jsonb_build_object('businessName', v_name);
  update public.workspace_configuration_versions set definition = v_def, created_by = v_uid, created_at = now()
    where organization_id = p_org and status = 'draft' returning revision into v_rev;
  if v_rev is null then
    insert into public.workspace_configuration_versions (organization_id, revision, status, definition, created_by)
      values (p_org, (select coalesce(max(revision), 0) + 1 from public.workspace_configuration_versions where organization_id = p_org), 'draft', v_def, v_uid)
      returning revision into v_rev;
  end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'workspace.draft_saved', jsonb_build_object('revision', v_rev));
  return v_rev;
end $$;

create or replace function public.discard_workspace_draft(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  delete from public.workspace_configuration_versions where organization_id = p_org and status = 'draft';
  insert into public.audit_events (organization_id, actor_id, event_name) values (p_org, (select auth.uid()), 'workspace.draft_discarded');
end $$;

create or replace function public.publish_workspace_config(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_draft public.workspace_configuration_versions; v_stage text; v_n bigint;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  select * into v_draft from public.workspace_configuration_versions where organization_id = p_org and status = 'draft' for update;
  if not found then raise exception 'There is no saved draft to publish.' using errcode = '22023'; end if;
  perform public.validate_workspace_definition(v_draft.definition);
  perform public.workspace_check_data_protection(p_org, v_draft.definition);
  select l.stage, count(*) into v_stage, v_n from public.leads l
    where l.organization_id = p_org and not coalesce(v_draft.definition#>'{pipeline,stages}' @> to_jsonb(l.stage), false)
    group by l.stage order by count(*) desc limit 1;
  if v_stage is not null then
    raise exception '% lead(s) are still in the stage "%", which the new pipeline removes. Move them to another stage first.', v_n, v_stage using errcode = '22023'; end if;
  update public.workspace_configuration_versions set status = 'archived' where organization_id = p_org and status = 'published';
  update public.workspace_configuration_versions set status = 'published' where id = v_draft.id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'workspace.published', jsonb_build_object('revision', v_draft.revision));
  perform public.crm_emit(p_org, 'workspace.published', 'workspace', p_org, jsonb_build_object('revision', v_draft.revision));
  return v_draft.revision;
end $$;

-- Rollback: loads an earlier revision into the draft (history is never rewritten). Anything records depend on is kept (hidden if the old
-- revision lacked it), so the restored draft can always be reviewed and published.
create or replace function public.restore_workspace_revision(p_org uuid, p_revision integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_old jsonb; v_rev int;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  select definition into v_old from public.workspace_configuration_versions where organization_id = p_org and revision = p_revision and status in ('published','archived');
  if v_old is null then raise exception 'That version does not exist.' using errcode = '22023'; end if;
  v_rev := public.save_workspace_draft(p_org, public.workspace_protect_data(p_org, v_old));
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'workspace.restore_requested', jsonb_build_object('from_revision', p_revision, 'draft_revision', v_rev));
  return v_rev;
end $$;

-- ---------- privileges ----------
revoke all on function public.record_validate(jsonb, jsonb, jsonb), public.record_search_text(jsonb), public.record_object(uuid, text),
  public.workspace_live_definition(uuid), public.workspace_has_records(uuid, text), public.workspace_has_field_data(uuid, text, text),
  public.workspace_check_data_protection(uuid, jsonb), public.workspace_protect_data(uuid, jsonb), public.validate_workspace_definition(jsonb) from public, anon, authenticated;
revoke all on function public.record_create(uuid, text, jsonb), public.record_update(uuid, uuid, jsonb), public.restore_workspace_revision(uuid, integer),
  public.save_workspace_draft(uuid, jsonb), public.discard_workspace_draft(uuid), public.publish_workspace_config(uuid) from public, anon;
grant execute on function public.record_create(uuid, text, jsonb), public.record_update(uuid, uuid, jsonb), public.restore_workspace_revision(uuid, integer),
  public.save_workspace_draft(uuid, jsonb), public.discard_workspace_draft(uuid), public.publish_workspace_config(uuid) to authenticated;
