-- 0005: universal workspaces. Optizen is one platform; "industry" is no longer a column the product depends on.
-- 0001-0004 are untouched (they may already be applied). This migration:
--   1. drops the three-industry restriction on organizations (legacy column kept, nullable, for existing rows),
--   2. adds a free-form business profile (description) and an optional preset (provenance only, never a restriction),
--   3. replaces create_organization(name, industry, definition) with create_workspace(name, description, preset, definition),
--   4. adds a server-side validator for workspace definitions (modules, pipeline, record types/fields),
--   5. adds the Builder lifecycle: save draft -> publish (new immutable revision) / discard, owners and admins only.
-- DEPLOY ORDER: apply this migration BEFORE deploying the app version that calls create_workspace.
-- The previous app version cannot onboard after this runs (create_organization is dropped); existing users are unaffected.

-- ---------- 1 + 2: organization profile ----------
alter table public.organizations drop constraint if exists organizations_industry_template_check;
alter table public.organizations alter column industry_template drop not null;
comment on column public.organizations.industry_template is 'DEPRECATED legacy discriminator. Kept so existing organizations keep their provenance; new workspaces leave it null and nothing reads it.';
alter table public.organizations add column if not exists description text;
alter table public.organizations add column if not exists preset text;
alter table public.organizations add constraint organizations_description_len check (char_length(description) <= 1000);
alter table public.organizations add constraint organizations_preset_fmt check (preset ~ '^[a-z0-9_-]{1,40}$');
update public.organizations set preset = industry_template where preset is null and industry_template is not null; -- preserve provenance of existing rows

-- ---------- 4: definition validator (shared by create / save draft / publish) ----------
-- Shape contract (schemaVersion 1): see docs/CONFIG_CONTRACT.md. The CRM engine needs the Overview and Leads modules
-- and a pipeline of 2-20 stages; everything else (extra modules, record types, fields) is free-form.
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
    if m->>'status' is null or m->>'status' not in ('active','planned') then raise exception 'Module "%" has an invalid status.', k using errcode = '22023'; end if;
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
      if f->>'kind' is null or f->>'kind' not in ('text','number','date','yes_no','choice') then raise exception 'Field "%" has an invalid type.', k using errcode = '22023'; end if;
      if f->>'kind' = 'choice' and (jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options') not between 1 and 30
         or exists (select 1 from jsonb_array_elements(f->'options') x where jsonb_typeof(x) is distinct from 'string' or char_length(x #>> '{}') not between 1 and 60)) then
        raise exception 'Choice field "%" needs between 1 and 30 options.', k using errcode = '22023'; end if;
    end loop;
  end loop;
end $$;

-- ---------- 3: create_workspace replaces create_organization ----------
drop function if exists public.create_organization(text, text, jsonb);
create or replace function public.create_workspace(p_name text, p_description text, p_preset text, p_definition jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v_name text := btrim(coalesce(p_name, ''));
  v_desc text := nullif(btrim(coalesce(p_description, '')), ''); v_preset text := nullif(btrim(coalesce(p_preset, '')), '');
  v_org uuid; v_def jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if char_length(v_name) not between 2 and 80 then raise exception 'invalid organization name' using errcode = '22023'; end if;
  if v_desc is not null and char_length(v_desc) > 1000 then raise exception 'The description must be at most 1000 characters.' using errcode = '22023'; end if;
  if v_preset is not null and v_preset !~ '^[a-z0-9_-]{1,40}$' then raise exception 'invalid preset' using errcode = '22023'; end if;
  perform public.validate_workspace_definition(p_definition);
  perform pg_advisory_xact_lock(hashtext(v_uid::text)); -- serialize so the limit below cannot be raced
  if (select count(*) from public.organization_members where user_id = v_uid and role = 'owner') >= 5 then
    raise exception 'organization limit reached' using errcode = '54000'; end if;
  -- profile fields stored in the definition always agree with the validated columns; the legacy discriminator is dropped
  v_def := (p_definition - 'industryTemplate' - 'description' - 'preset') || jsonb_build_object('businessName', v_name);
  if v_desc is not null then v_def := v_def || jsonb_build_object('description', v_desc); end if;
  if v_preset is not null then v_def := v_def || jsonb_build_object('preset', v_preset); end if;

  insert into public.organizations (name, description, preset) values (v_name, v_desc, v_preset) returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.workspace_configuration_versions (organization_id, revision, status, definition, created_by) values (v_org, 1, 'published', v_def, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name) values (v_org, v_uid, 'organization.created');
  return v_org;
end $$;

-- ---------- 5: Builder lifecycle (draft -> publish). One draft per organization. ----------
create unique index if not exists workspace_configuration_one_draft on public.workspace_configuration_versions (organization_id) where status = 'draft';

-- Drafts are visible to owners/admins only; published and archived versions stay visible to every member.
drop policy if exists config_read on public.workspace_configuration_versions;
create policy config_read on public.workspace_configuration_versions for select to authenticated using (
  public.is_org_member(organization_id) and (status <> 'draft' or public.org_role(organization_id) in ('owner','admin')));

create or replace function public.save_workspace_draft(p_org uuid, p_definition jsonb)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_name text; v_def jsonb; v_rev int;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform public.validate_workspace_definition(p_definition);
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  select name into v_name from public.organizations where id = p_org;
  v_def := (p_definition - 'industryTemplate') || jsonb_build_object('businessName', v_name); -- the organization name is not edited through the Builder
  update public.workspace_configuration_versions set definition = v_def, created_by = v_uid, created_at = now()
    where organization_id = p_org and status = 'draft' returning revision into v_rev;
  if v_rev is null then
    insert into public.workspace_configuration_versions (organization_id, revision, status, definition, created_by)
      values (p_org, (select coalesce(max(revision), 0) + 1 from public.workspace_configuration_versions where organization_id = p_org), 'draft', v_def, v_uid)
      returning revision into v_rev;
  end if;
  return v_rev;
end $$;

create or replace function public.discard_workspace_draft(p_org uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  delete from public.workspace_configuration_versions where organization_id = p_org and status = 'draft';
end $$;

-- Publishes the SAVED draft as the next immutable revision (what you previewed is exactly what goes live).
-- Guard: no lead may be left in a stage the new pipeline does not contain; move those leads first.
create or replace function public.publish_workspace_config(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_draft public.workspace_configuration_versions; v_stage text; v_n bigint;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  select * into v_draft from public.workspace_configuration_versions where organization_id = p_org and status = 'draft' for update;
  if not found then raise exception 'There is no saved draft to publish.' using errcode = '22023'; end if;
  perform public.validate_workspace_definition(v_draft.definition);
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

revoke all on function public.validate_workspace_definition(jsonb) from public, anon, authenticated;
revoke all on function public.create_workspace(text, text, text, jsonb), public.save_workspace_draft(uuid, jsonb), public.discard_workspace_draft(uuid), public.publish_workspace_config(uuid) from public, anon;
grant execute on function public.create_workspace(text, text, text, jsonb), public.save_workspace_draft(uuid, jsonb), public.discard_workspace_draft(uuid), public.publish_workspace_config(uuid) to authenticated;
