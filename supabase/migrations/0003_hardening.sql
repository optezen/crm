-- 0003: security hardening found in audit of 0001/0002. 0001 and 0002 are left untouched (they may already be applied).
-- Findings addressed:
--  F1 Supabase default privileges give anon/authenticated ALL on new public tables; only RLS stood between clients and writes.
--  F2 `revoke ... from public` does not remove the explicit anon EXECUTE grant on public functions.
--  F3 create_organization trusted the client-supplied definition and allowed unlimited organizations per user.
--  F4 Published configuration versions and audit events were not actually immutable (service_role / future policies).
--  F5 No index for the per-user membership lookup the app runs on every request.

-- F1: least privilege. Clients may only SELECT (through RLS); all writes go through reviewed functions.
revoke all on public.organizations, public.organization_members, public.workspace_configuration_versions, public.audit_events from anon, authenticated;
grant select on public.organizations, public.organization_members, public.workspace_configuration_versions, public.audit_events to authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- F2
revoke execute on function public.is_org_member(uuid) from anon;
revoke execute on function public.create_organization(text, text, jsonb) from anon;

-- F5
create index if not exists organization_members_user_idx on public.organization_members (user_id);

-- Data-shape guards (defense in depth; the app validates too).
alter table public.organizations add constraint organizations_name_len check (char_length(name) between 2 and 80);
alter table public.workspace_configuration_versions add constraint config_definition_shape check (
  jsonb_typeof(definition) = 'object' and definition->'schemaVersion' = to_jsonb(schema_version) and octet_length(definition::text) <= 200000);

-- F3: validated, rate-limited organization creation. Owner always comes from auth.uid().
create or replace function public.create_organization(p_name text, p_industry text, p_definition jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_org uuid; v_def jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if char_length(v_name) not between 2 and 80 then raise exception 'invalid organization name' using errcode = '22023'; end if;
  if p_industry is null or p_industry not in ('clinic','salon','scrap') then raise exception 'invalid industry' using errcode = '22023'; end if;
  if p_definition is null or jsonb_typeof(p_definition) <> 'object'
     or p_definition->'schemaVersion' is distinct from to_jsonb(1) or octet_length(p_definition::text) > 200000 then
    raise exception 'invalid workspace definition' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext(v_uid::text)); -- serialize so the limit below cannot be raced
  if (select count(*) from public.organization_members where user_id = v_uid and role = 'owner') >= 5 then
    raise exception 'organization limit reached' using errcode = '54000';
  end if;
  -- name/industry stored in the definition always agree with the validated columns
  v_def := jsonb_set(jsonb_set(p_definition, '{businessName}', to_jsonb(v_name)), '{industryTemplate}', to_jsonb(p_industry));

  insert into public.organizations (name, industry_template) values (v_name, p_industry) returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.workspace_configuration_versions (organization_id, revision, status, definition, created_by) values (v_org, 1, 'published', v_def, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name) values (v_org, v_uid, 'organization.created');
  return v_org;
end $$;
revoke all on function public.create_organization(text, text, jsonb) from public, anon;
grant execute on function public.create_organization(text, text, jsonb) to authenticated;

-- F4: immutability that holds even for service_role. Cascades from deleting the organization are still allowed.
create or replace function public.protect_published_config() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'published' and exists (select 1 from public.organizations where id = old.organization_id) then
      raise exception 'published configuration versions are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status = 'published' and (new.definition is distinct from old.definition or new.revision <> old.revision
     or new.organization_id <> old.organization_id or new.status not in ('published','archived')) then
    raise exception 'published configuration versions are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger config_versions_protect before update or delete on public.workspace_configuration_versions for each row execute function public.protect_published_config();

create or replace function public.protect_audit_events() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.organization_id) then return old; end if;
  raise exception 'audit events are append-only' using errcode = '42501';
end $$;
create trigger audit_events_protect before update or delete on public.audit_events for each row execute function public.protect_audit_events();
