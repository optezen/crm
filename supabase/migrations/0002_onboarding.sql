-- Onboarding write path. Clients cannot insert into organizations/members directly (no policies);
-- this function derives the owner from auth.uid(). Review before applying to production.
create or replace function public.create_organization(p_name text, p_industry text, p_definition jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_org uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if length(trim(p_name)) not between 2 and 80 then raise exception 'invalid name'; end if;
  insert into public.organizations (name, industry_template) values (trim(p_name), p_industry) returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.workspace_configuration_versions (organization_id, revision, status, definition, created_by)
    values (v_org, 1, 'published', p_definition, v_uid);
  insert into public.audit_events (organization_id, actor_id, event_name) values (v_org, v_uid, 'organization.created');
  return v_org;
end $$;
revoke all on function public.create_organization(text, text, jsonb) from public;
grant execute on function public.create_organization(text, text, jsonb) to authenticated;
