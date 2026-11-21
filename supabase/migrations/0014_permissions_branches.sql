-- 0014: Permissions engine (custom roles, module permissions, record visibility, branches / locations). 0001-0013 are untouched.
--
-- DESIGN: custom roles can only NARROW what their base role already allows; they can never widen it. A custom role is a base role (owner excluded) plus an overlay.
--   * organization_members.role keeps holding the member's EFFECTIVE BASE role (owner/admin/manager/employee), so every existing role check in every existing
--     function and policy keeps working unchanged. Assigning a custom role sets role = custom_role.base_role and custom_role_id = the overlay.
--   * The overlay is enforced in PostgreSQL by (1) RESTRICTIVE row level security policies (a restrictive policy is ANDed with the existing permissive ones, so
--     it can only remove rows): module `view` permission and record visibility scope (all / branch team / assigned / own), location restrictions for stock;
--     (2) BEFORE triggers that refuse create / edit / assign / archive / approve when the overlay denies it, whichever function performed the write; and
--     (3) explicit checks in the new reporting, export and dashboard functions, in integration management and in automation publish/execute.
--   * Members WITHOUT a custom role are not affected at all (perm_ok returns true immediately): existing customer behavior and data are preserved.
--   * Every lookup is scoped by organization and by auth.uid(): a role, branch or permission of one organization has no effect in another. System actors
--     (auth.uid() is null: the worker, integration principals) are governed by their own identity checks, not by member overlays.
create table public.branches (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80), active boolean not null default true, created_at timestamptz not null default now(), unique (id, organization_id)
);
create unique index branches_name_uq on public.branches (organization_id, lower(name));
create table public.member_branches (
  organization_id uuid not null, user_id uuid not null, branch_id uuid not null, primary key (organization_id, user_id, branch_id),
  foreign key (organization_id, user_id) references public.organization_members (organization_id, user_id) on delete cascade,
  foreign key (branch_id, organization_id) references public.branches (id, organization_id) on delete cascade
);
create table public.custom_roles (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40), base_role text not null check (base_role in ('admin','manager','employee')),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object' and octet_length(permissions::text) <= 20000),
  scopes jsonb not null default '{}'::jsonb check (jsonb_typeof(scopes) = 'object' and octet_length(scopes::text) <= 5000), location_restricted boolean not null default false,
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, organization_id)
);
create unique index custom_roles_name_uq on public.custom_roles (organization_id, lower(name));
alter table public.organization_members add column if not exists custom_role_id uuid;
alter table public.organization_members add constraint organization_members_custom_role_fk foreign key (custom_role_id, organization_id) references public.custom_roles (id, organization_id);
alter table public.inventory_locations add column if not exists branch_id uuid;
alter table public.inventory_locations add constraint inventory_locations_branch_fk foreign key (branch_id, organization_id) references public.branches (id, organization_id);

-- changing someone's base role through the old function clears a now-inconsistent overlay
create or replace function public.members_role_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.role is distinct from old.role and new.custom_role_id is not null and not exists (select 1 from public.custom_roles c where c.id = new.custom_role_id and c.organization_id = new.organization_id and c.base_role = new.role) then new.custom_role_id := null; end if;
  if new.role = 'owner' then new.custom_role_id := null; end if;
  return new;
end $$;
create trigger members_role_guard_trg before update on public.organization_members for each row execute function public.members_role_guard();

alter table public.branches enable row level security; alter table public.member_branches enable row level security; alter table public.custom_roles enable row level security;
create policy branches_read on public.branches for select to authenticated using (public.is_org_member(organization_id));
create policy member_branches_read on public.member_branches for select to authenticated using (user_id = (select auth.uid()) or public.org_role(organization_id) in ('owner','admin'));
create policy custom_roles_read on public.custom_roles for select to authenticated using (public.is_org_member(organization_id));
revoke all on public.branches, public.member_branches, public.custom_roles from anon, authenticated; grant select on public.branches, public.member_branches, public.custom_roles to authenticated;

-- ---------- permission model ----------
-- what a base role may do by default; custom roles are validated against this so they can never exceed it
create or replace function public.perm_default(p_role text, p_module text, p_action text) returns boolean language sql immutable set search_path = '' as $$
  select case
    when p_role in ('owner','admin') then true
    when p_role = 'manager' then case when p_module in ('integrations','automations','team') then p_action = 'view' else true end
    else case p_module
      when 'leads' then p_action in ('view','create','edit','assign') when 'tasks' then p_action in ('view','create','edit') when 'appointments' then p_action in ('view','create','edit')
      when 'inventory' then p_action in ('view','create') when 'billing' then false when 'dashboards' then p_action in ('view','create') when 'reports' then p_action = 'view'
      when 'integrations' then false when 'automations' then false when 'team' then false
      else p_action in ('view','create','edit') end
  end;
$$;
create or replace function public.perm_ok_for(p_org uuid, p_user uuid, p_module text, p_action text) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare m public.organization_members; cr public.custom_roles; v jsonb;
begin
  if p_user is null then return true; end if; -- system actors
  select * into m from public.organization_members where organization_id = p_org and user_id = p_user;
  if not found then return false; end if;
  if m.role = 'owner' or m.custom_role_id is null then return true; end if;
  select * into cr from public.custom_roles where id = m.custom_role_id and organization_id = p_org;
  if not found then return true; end if;
  v := cr.permissions #> array[p_module, p_action];
  if jsonb_typeof(v) = 'boolean' then return v::text::boolean and public.perm_default(m.role, p_module, p_action); end if;
  return public.perm_default(m.role, p_module, p_action);
end $$;
create or replace function public.perm_ok(p_org uuid, p_module text, p_action text) returns boolean language sql stable security definer set search_path = '' as $$
  select public.perm_ok_for(p_org, (select auth.uid()), p_module, p_action);
$$;
-- For capabilities that did not exist before this migration (export, dashboards sharing...): members WITHOUT a custom role get their base role's default, not "everything".
create or replace function public.perm_ok_new(p_org uuid, p_module text, p_action text) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare m public.organization_members;
begin
  if (select auth.uid()) is null then return true; end if;
  select * into m from public.organization_members where organization_id = p_org and user_id = (select auth.uid()); if not found then return false; end if;
  if m.role = 'owner' then return true; end if;
  if m.custom_role_id is null then return public.perm_default(m.role, p_module, p_action); end if;
  return public.perm_ok(p_org, p_module, p_action);
end $$;
create or replace function public.perm_team_member(p_org uuid, p_other uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select p_other is not null and exists (select 1 from public.member_branches a join public.member_branches b on b.organization_id = a.organization_id and b.branch_id = a.branch_id
    where a.organization_id = p_org and a.user_id = (select auth.uid()) and b.user_id = p_other);
$$;
-- record visibility: all / team (people who share a branch with me) / assigned (to me) / own (created by me)
create or replace function public.perm_scope_ok(p_org uuid, p_module text, p_assigned uuid, p_created uuid) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); cr public.custom_roles; m public.organization_members; v_scope text;
begin
  if v_uid is null then return true; end if;
  select * into m from public.organization_members where organization_id = p_org and user_id = v_uid;
  if not found then return false; end if;
  if m.role = 'owner' or m.custom_role_id is null then return true; end if;
  select * into cr from public.custom_roles where id = m.custom_role_id and organization_id = p_org;
  v_scope := coalesce(cr.scopes->>p_module, 'all');
  return case v_scope when 'all' then true when 'own' then p_created = v_uid when 'assigned' then p_assigned = v_uid or (p_assigned is null and p_created = v_uid)
    when 'team' then p_assigned = v_uid or p_created = v_uid or public.perm_team_member(p_org, p_assigned) or public.perm_team_member(p_org, p_created) else false end;
end $$;
-- stock locations: a location-restricted role only sees/uses locations of its own branches (and unassigned, shared locations)
create or replace function public.perm_location_ok(p_org uuid, p_location uuid) returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); m public.organization_members; v_restricted boolean; v_branch uuid;
begin
  if v_uid is null then return true; end if;
  select * into m from public.organization_members where organization_id = p_org and user_id = v_uid; if not found then return false; end if;
  if m.role = 'owner' or m.custom_role_id is null then return true; end if;
  select location_restricted into v_restricted from public.custom_roles where id = m.custom_role_id and organization_id = p_org;
  if not coalesce(v_restricted, false) then return true; end if;
  select branch_id into v_branch from public.inventory_locations where id = p_location and organization_id = p_org;
  return v_branch is null or exists (select 1 from public.member_branches b where b.organization_id = p_org and b.user_id = v_uid and b.branch_id = v_branch);
end $$;

-- ---------- restrictive read policies (can only remove rows) ----------
create policy perm_view on public.leads as restrictive for select to authenticated using (public.perm_ok(organization_id, 'leads', 'view') and public.perm_scope_ok(organization_id, 'leads', assigned_to, created_by));
create policy perm_view on public.contacts as restrictive for select to authenticated using (public.perm_ok(organization_id, 'leads', 'view'));
create policy perm_view on public.tasks as restrictive for select to authenticated using (public.perm_ok(organization_id, 'tasks', 'view') and public.perm_scope_ok(organization_id, 'tasks', owner_id, created_by));
create policy perm_view on public.records as restrictive for select to authenticated using (public.perm_ok(organization_id, 'custom:' || object_key, 'view') and public.perm_scope_ok(organization_id, 'custom:' || object_key, null, created_by));
create policy perm_view on public.appointments as restrictive for select to authenticated using (public.perm_ok(organization_id, 'appointments', 'view') and public.perm_scope_ok(organization_id, 'appointments', staff_id, created_by));
create policy perm_view on public.appointment_types as restrictive for select to authenticated using (public.perm_ok(organization_id, 'appointments', 'view'));
create policy perm_view on public.staff_hours as restrictive for select to authenticated using (public.perm_ok(organization_id, 'appointments', 'view'));
create policy perm_view on public.staff_time_off as restrictive for select to authenticated using (public.perm_ok(organization_id, 'appointments', 'view'));
create policy perm_view on public.appointment_log as restrictive for select to authenticated using (public.perm_ok(organization_id, 'appointments', 'view'));
create policy perm_view on public.products as restrictive for select to authenticated using (public.perm_ok(organization_id, 'inventory', 'view'));
create policy perm_view on public.suppliers as restrictive for select to authenticated using (public.perm_ok(organization_id, 'inventory', 'view'));
create policy perm_view on public.stock_batches as restrictive for select to authenticated using (public.perm_ok(organization_id, 'inventory', 'view'));
create policy perm_view on public.inventory_locations as restrictive for select to authenticated using (public.perm_ok(organization_id, 'inventory', 'view') and public.perm_location_ok(organization_id, id));
create policy perm_view on public.stock_levels as restrictive for select to authenticated using (public.perm_ok(organization_id, 'inventory', 'view') and public.perm_location_ok(organization_id, location_id));
create policy perm_view on public.stock_movements as restrictive for select to authenticated using (public.perm_ok(organization_id, 'inventory', 'view') and public.perm_location_ok(organization_id, location_id));
create policy perm_view on public.invoices as restrictive for select to authenticated using (public.perm_ok(organization_id, 'billing', 'view') and public.perm_scope_ok(organization_id, 'billing', null, created_by));
create policy perm_view on public.invoice_lines as restrictive for select to authenticated using (public.perm_ok(organization_id, 'billing', 'view') and exists (select 1 from public.invoices i where i.id = invoice_id));
create policy perm_view on public.invoice_payments as restrictive for select to authenticated using (public.perm_ok(organization_id, 'billing', 'view') and exists (select 1 from public.invoices i where i.id = invoice_id));
create policy perm_view on public.credit_notes as restrictive for select to authenticated using (public.perm_ok(organization_id, 'billing', 'view') and exists (select 1 from public.invoices i where i.id = invoice_id));
create policy perm_view on public.invoice_ledger as restrictive for select to authenticated using (public.perm_ok(organization_id, 'billing', 'view') and exists (select 1 from public.invoices i where i.id = invoice_id));
create policy perm_view on public.automation_workflows as restrictive for select to authenticated using (public.perm_ok(organization_id, 'automations', 'view'));
create policy perm_view on public.automation_runs as restrictive for select to authenticated using (public.perm_ok(organization_id, 'automations', 'view'));
create policy perm_view on public.integration_connections as restrictive for select to authenticated using (public.perm_ok(organization_id, 'integrations', 'view'));
create policy perm_view on public.integration_webhook_events as restrictive for select to authenticated using (public.perm_ok(organization_id, 'integrations', 'view'));
create policy perm_view on public.integration_errors as restrictive for select to authenticated using (public.perm_ok(organization_id, 'integrations', 'view'));

-- ---------- write guard: create / edit / assign / archive / approve, whichever function performs the write ----------
create or replace function public.perm_guard() returns trigger language plpgsql security definer set search_path = '' as $$
declare j_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end; j_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end; j jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_org uuid := (j->>'organization_id')::uuid; v_mod text; v_act text;
begin
  if (select auth.uid()) is null then return coalesce(new, old); end if; -- system actors
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = v_org) then return old; end if; -- cascade from deleting the organization
  v_mod := case tg_table_name when 'leads' then 'leads' when 'contacts' then 'leads' when 'tasks' then 'tasks' when 'appointments' then 'appointments' when 'products' then 'inventory' when 'stock_movements' then 'inventory'
    when 'invoices' then 'billing' when 'invoice_payments' then 'billing' when 'credit_notes' then 'billing' when 'records' then 'custom:' || (j->>'object_key') end;
  if tg_op = 'INSERT' then
    v_act := case when tg_table_name = 'credit_notes' then 'approve' when tg_table_name = 'invoice_payments' and j_new->>'kind' = 'refund' then 'approve' when tg_table_name = 'stock_movements' and j_new->>'kind' <> 'consumption' then 'edit' else 'create' end;
    if tg_table_name = 'stock_movements' and not public.perm_location_ok(v_org, (j_new->>'location_id')::uuid) then raise exception 'Your role cannot use that location.' using errcode = '42501'; end if;
  elsif tg_op = 'DELETE' then v_act := 'archive';
  else
    if (j_new - 'updated_at') = (j_old - 'updated_at') then return new; end if; -- touching updated_at is not an edit
    v_act := case when tg_table_name = 'leads' and j_new->>'assigned_to' is distinct from j_old->>'assigned_to' then 'assign' when tg_table_name = 'invoices' and j_new->>'status' = 'issued' and j_old->>'status' = 'draft' then 'approve'
      when tg_table_name = 'tasks' and j_new->>'owner_id' is distinct from j_old->>'owner_id' then 'assign' else 'edit' end;
  end if;
  if not public.perm_ok(v_org, v_mod, v_act) then raise exception 'Your role does not allow you to % in this module.', v_act using errcode = '42501'; end if;
  return coalesce(new, old);
end $$;
create trigger perm_guard_trg before insert or update or delete on public.leads for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert or update or delete on public.contacts for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert or update or delete on public.tasks for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert or update or delete on public.records for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert or update or delete on public.appointments for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert or update or delete on public.products for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert on public.stock_movements for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert or update or delete on public.invoices for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert on public.invoice_payments for each row execute function public.perm_guard();
create trigger perm_guard_trg before insert on public.credit_notes for each row execute function public.perm_guard();

-- ---------- roles, branches, assignments (owner/admin) ----------
create or replace function public.perm_actor_admin(p_org uuid) returns text language plpgsql stable security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org);
begin
  if v_role not in ('owner','admin') or not public.perm_ok(p_org, 'team', 'edit') then raise exception 'Only owners and admins can manage roles, branches and locations.' using errcode = '42501'; end if;
  return v_role;
end $$;

create or replace function public.role_validate(p_base text, p_perms jsonb, p_scopes jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare m text; a text; v jsonb;
begin
  if p_base not in ('admin','manager','employee') then raise exception 'A role is based on admin, manager or employee.' using errcode = '22023'; end if;
  if jsonb_typeof(p_perms) is distinct from 'object' or jsonb_typeof(p_scopes) is distinct from 'object' then raise exception 'Invalid role permissions.' using errcode = '22023'; end if;
  for m, v in select key, value from jsonb_each(p_perms) loop
    if m !~ '^(leads|tasks|appointments|inventory|billing|dashboards|reports|integrations|automations|team|custom:[a-z0-9]+(-[a-z0-9]+)*)$' or jsonb_typeof(v) is distinct from 'object' then raise exception 'Unknown module "%" in role permissions.', m using errcode = '22023'; end if;
    for a, v in select key, value from jsonb_each(p_perms->m) loop
      if a not in ('view','create','edit','archive','export','assign','approve') or jsonb_typeof(v) is distinct from 'boolean' then raise exception 'Invalid permission "%.%".', m, a using errcode = '22023'; end if;
      if v::text::boolean and not public.perm_default(p_base, m, a) then raise exception 'A role based on % cannot be granted "%" in "%": custom roles can only narrow their base role.', p_base, a, m using errcode = '22023'; end if;
    end loop;
  end loop;
  for m, v in select key, value from jsonb_each(p_scopes) loop
    if m !~ '^(leads|tasks|appointments|billing|custom:[a-z0-9]+(-[a-z0-9]+)*)$' or jsonb_typeof(v) is distinct from 'string' or (v #>> '{}') not in ('all','team','assigned','own') then raise exception 'Invalid visibility for "%".', m using errcode = '22023'; end if;
  end loop;
end $$;

create or replace function public.role_save(p_org uuid, p_id uuid, p_name text, p_base text, p_permissions jsonb, p_scopes jsonb, p_location_restricted boolean) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor text := public.perm_actor_admin(p_org); v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id uuid := p_id;
begin
  if char_length(v_name) not between 1 and 40 then raise exception 'Name the role (up to 40 characters).' using errcode = '22023'; end if;
  if p_base = 'admin' and v_actor <> 'owner' then raise exception 'Only the owner can create roles based on admin.' using errcode = '42501'; end if;
  perform public.role_validate(p_base, coalesce(p_permissions, '{}'::jsonb), coalesce(p_scopes, '{}'::jsonb));
  if (select count(*) from public.custom_roles where organization_id = p_org) >= 30 and v_id is null then raise exception 'At most 30 custom roles.' using errcode = '22023'; end if;
  if v_id is null then insert into public.custom_roles (organization_id, name, base_role, permissions, scopes, location_restricted, created_by) values (p_org, v_name, p_base, coalesce(p_permissions, '{}'::jsonb), coalesce(p_scopes, '{}'::jsonb), coalesce(p_location_restricted, false), (select auth.uid())) returning id into v_id;
  else
    if exists (select 1 from public.organization_members where custom_role_id = v_id and organization_id = p_org) and (select base_role from public.custom_roles where id = v_id and organization_id = p_org) <> p_base then raise exception 'The base role of a role in use cannot change. Create a new role instead.' using errcode = '22023'; end if;
    if (select base_role from public.custom_roles where id = v_id and organization_id = p_org) = 'admin' and v_actor <> 'owner' then raise exception 'Only the owner can change roles based on admin.' using errcode = '42501'; end if;
    update public.custom_roles set name = v_name, base_role = p_base, permissions = coalesce(p_permissions, '{}'::jsonb), scopes = coalesce(p_scopes, '{}'::jsonb), location_restricted = coalesce(p_location_restricted, false), updated_at = now() where id = v_id and organization_id = p_org;
    if not found then raise exception 'Role not found.' using errcode = 'P0002'; end if;
  end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'role.saved', jsonb_build_object('role_id', v_id));
  return v_id;
exception when unique_violation then raise exception 'A role with that name already exists.' using errcode = '23505';
end $$;
create or replace function public.role_delete(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.perm_actor_admin(p_org);
  if exists (select 1 from public.organization_members where custom_role_id = p_id and organization_id = p_org) then raise exception 'Move the members to another role first.' using errcode = '22023'; end if;
  delete from public.custom_roles where id = p_id and organization_id = p_org; if not found then raise exception 'Role not found.' using errcode = 'P0002'; end if;
end $$;
-- assign (or clear) a custom role. The member's effective base role is set from the custom role, so all older role checks stay consistent.
create or replace function public.member_assign_role(p_org uuid, p_user uuid, p_custom_role uuid, p_base_if_cleared text default 'employee') returns void language plpgsql security definer set search_path = '' as $$
declare v_actor text := public.perm_actor_admin(p_org); m public.organization_members; cr public.custom_roles;
begin
  select * into m from public.organization_members where organization_id = p_org and user_id = p_user; if not found then raise exception 'Team member not found.' using errcode = 'P0002'; end if;
  if m.role = 'owner' or p_user = (select auth.uid()) then raise exception 'You cannot change your own role or the owner''s role.' using errcode = '42501'; end if;
  if v_actor = 'admin' and m.role = 'admin' then raise exception 'Only owners can manage admins.' using errcode = '42501'; end if;
  if p_custom_role is null then
    if p_base_if_cleared not in ('admin','manager','employee') or (p_base_if_cleared = 'admin' and v_actor <> 'owner') then raise exception 'Choose the role the member returns to.' using errcode = '22023'; end if;
    update public.organization_members set custom_role_id = null, role = p_base_if_cleared where organization_id = p_org and user_id = p_user;
  else
    select * into cr from public.custom_roles where id = p_custom_role and organization_id = p_org; if not found then raise exception 'Role not found.' using errcode = 'P0002'; end if; -- a role of another organization is "not found"
    if cr.base_role = 'admin' and v_actor <> 'owner' then raise exception 'Only the owner can assign roles based on admin.' using errcode = '42501'; end if;
    update public.organization_members set role = cr.base_role, custom_role_id = cr.id where organization_id = p_org and user_id = p_user;
  end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'member.role_assigned', jsonb_build_object('user_id', p_user, 'custom_role_id', p_custom_role));
  perform public.crm_emit(p_org, 'member.role_changed', 'member', p_user, jsonb_build_object('custom_role_id', p_custom_role));
end $$;
create or replace function public.branch_save(p_org uuid, p_id uuid, p_name text, p_active boolean) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id uuid := p_id;
begin
  perform public.perm_actor_admin(p_org);
  if char_length(v_name) not between 1 and 80 then raise exception 'Name the branch (up to 80 characters).' using errcode = '22023'; end if;
  if v_id is null then insert into public.branches (organization_id, name, active) values (p_org, v_name, coalesce(p_active, true)) returning id into v_id;
  else update public.branches set name = v_name, active = coalesce(p_active, active) where id = v_id and organization_id = p_org; if not found then raise exception 'Branch not found.' using errcode = 'P0002'; end if; end if;
  return v_id;
exception when unique_violation then raise exception 'A branch with that name already exists.' using errcode = '23505';
end $$;
create or replace function public.member_branches_set(p_org uuid, p_user uuid, p_branches uuid[]) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.perm_actor_admin(p_org);
  if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_user) then raise exception 'Team member not found.' using errcode = 'P0002'; end if;
  if coalesce(array_length(p_branches, 1), 0) > 20 or exists (select 1 from unnest(coalesce(p_branches, '{}')) b where not exists (select 1 from public.branches x where x.id = b and x.organization_id = p_org)) then raise exception 'Unknown branch.' using errcode = '22023'; end if;
  delete from public.member_branches where organization_id = p_org and user_id = p_user;
  insert into public.member_branches (organization_id, user_id, branch_id) select p_org, p_user, b from unnest(coalesce(p_branches, '{}')) b;
end $$;
create or replace function public.location_branch_set(p_org uuid, p_location uuid, p_branch uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.perm_actor_admin(p_org);
  if p_branch is not null and not exists (select 1 from public.branches where id = p_branch and organization_id = p_org) then raise exception 'Unknown branch.' using errcode = '22023'; end if;
  update public.inventory_locations set branch_id = p_branch where id = p_location and organization_id = p_org; if not found then raise exception 'Location not found.' using errcode = 'P0002'; end if;
end $$;
-- directory for the roles screen (owner/admin)
create or replace function public.team_directory(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.perm_actor_admin(p_org);
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role, 'custom_role_id', m.custom_role_id, 'active', m.active,
    'branches', coalesce((select jsonb_agg(b.branch_id) from public.member_branches b where b.organization_id = p_org and b.user_id = m.user_id), '[]'::jsonb)) order by m.role, u.email)
    from public.organization_members m join auth.users u on u.id = m.user_id where m.organization_id = p_org), '[]'::jsonb);
end $$;
-- the caller's own effective permissions (for hiding buttons; the database still enforces everything)
create or replace function public.my_permissions(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare m public.organization_members; cr public.custom_roles; v_mod text; v_act text; v_out jsonb := '{}'::jsonb;
begin
  select * into m from public.organization_members where organization_id = p_org and user_id = (select auth.uid()); if not found then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  select * into cr from public.custom_roles where id = m.custom_role_id and organization_id = p_org;
  for v_mod in select unnest(array['leads','tasks','appointments','inventory','billing','dashboards','reports','integrations','automations','team']) loop
    v_out := v_out || jsonb_build_object(v_mod, (select jsonb_object_agg(a, public.perm_ok(p_org, v_mod, a)) from unnest(array['view','create','edit','archive','export','assign','approve']) a));
  end loop;
  return jsonb_build_object('role', m.role, 'custom_role', cr.name, 'permissions', v_out, 'location_restricted', coalesce(cr.location_restricted, false), 'scopes', coalesce(cr.scopes, '{}'::jsonb));
end $$;

-- ---------- existing sensitive operations now honour the overlay ----------
create or replace function public.integration_admin(p_org uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') or not public.perm_ok(p_org, 'integrations', 'edit') then raise exception 'Only owners and admins can manage connections.' using errcode = '42501'; end if;
end $$;
-- which permissions an automation needs from the person it acts as (its publisher). NULL = fine, otherwise the reason.
create or replace function public.perm_automation_ok(p_org uuid, p_user uuid, p_def jsonb) returns text language plpgsql stable security definer set search_path = '' as $$
declare a jsonb; v_mod text;
begin
  if not public.perm_ok_for(p_org, p_user, 'automations', 'edit') then return 'The publisher no longer has permission to run automations.'; end if;
  for a in select * from jsonb_array_elements(p_def->'actions') loop
    v_mod := null;
    case a->>'type'
      when 'assign_round_robin' then if not public.perm_ok_for(p_org, p_user, 'leads', 'assign') then return 'The publisher cannot assign leads.'; end if;
      when 'assign_lead' then if not public.perm_ok_for(p_org, p_user, 'leads', 'assign') then return 'The publisher cannot assign leads.'; end if;
      when 'create_task' then if not public.perm_ok_for(p_org, p_user, 'tasks', 'create') then return 'The publisher cannot create tasks.'; end if;
      when 'update_task_status' then if not public.perm_ok_for(p_org, p_user, 'tasks', 'edit') then return 'The publisher cannot edit tasks.'; end if;
      when 'update_record' then if not public.perm_ok_for(p_org, p_user, 'custom:' || coalesce(p_def #>> '{trigger,object}', ''), 'edit') then return 'The publisher cannot edit records of that module.'; end if;
      when 'request_integration' then if not public.perm_ok_for(p_org, p_user, 'integrations', 'edit') then return 'The publisher cannot request external messages.'; end if;
      else null;
    end case;
  end loop;
  return null;
end $$;

-- automation: the person an automation acts as must still hold the permissions its actions need (checked at publish and at every run)
create or replace function public.automation_publish(p_org uuid, p_workflow uuid, p_enable boolean) returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v public.automation_workflow_versions; v_live jsonb; v_obj jsonb; a jsonb; v_ev text;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  perform 1 from public.automation_workflows where id = p_workflow and organization_id = p_org for update;
  if not found then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
  select * into v from public.automation_workflow_versions where workflow_id = p_workflow and status = 'draft';
  if not found then raise exception 'There is no draft to publish.' using errcode = '22023'; end if;
  perform public.automation_validate(v.definition);
  if public.perm_automation_ok(p_org, v_uid, v.definition) is not null then raise exception '%', public.perm_automation_ok(p_org, v_uid, v.definition) using errcode = '42501'; end if;
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

create or replace function public.automation_execute(p_run uuid) returns text language plpgsql security definer set search_path = '' as $$
declare
  r public.automation_runs; v public.automation_workflow_versions; w public.automation_workflows; v_steps jsonb; v_res jsonb; v_state text; v_msg text; v_n int;
  v_permanent boolean; v_attempts int;
begin
  select * into r from public.automation_runs where id = p_run for update;
  if not found or r.status not in ('queued','waiting','retrying') then return coalesce(r.status, 'missing'); end if;
  select * into v from public.automation_workflow_versions where id = r.version_id;
  select * into w from public.automation_workflows where id = r.workflow_id;
  if not w.enabled then
    update public.automation_runs set status = 'cancelled', last_error = 'The automation was disabled.', finished_at = now() where id = r.id; return 'cancelled'; end if;
  -- the run acts as the person who published it: they must still be an active owner/admin
  if not exists (select 1 from public.organization_members where organization_id = r.organization_id and user_id = v.published_by and active and role in ('owner','admin')) or public.perm_automation_ok(r.organization_id, v.published_by, v.definition) is not null then
    update public.automation_runs set status = 'dead', last_error = coalesce(public.perm_automation_ok(r.organization_id, v.published_by, v.definition), 'The person who published this automation is no longer an active owner or admin. Republish it to continue.'), finished_at = now() where id = r.id; return 'dead'; end if;
  v_steps := v.definition->'actions'; v_n := jsonb_array_length(v_steps);
  while r.step_index < v_n loop
    begin
      v_res := public.automation_do(r, v_steps->r.step_index, r.step_index, v.published_by);
      insert into public.automation_steps (run_id, organization_id, step_index, action_type, status, attempts, result)
        values (r.id, r.organization_id, r.step_index, v_steps->r.step_index->>'type', 'succeeded', r.attempts + 1, v_res)
        on conflict (run_id, step_index) do update set status = 'succeeded', result = excluded.result, error = null, attempts = excluded.attempts, updated_at = now();
      r.step_index := r.step_index + 1;
      if v_res ? 'resume_at' then
        update public.automation_runs set status = 'waiting', step_index = r.step_index, attempts = 0, next_attempt_at = (v_res->>'resume_at')::timestamptz, last_error = null where id = r.id;
        return 'waiting'; end if;
      update public.automation_runs set step_index = r.step_index where id = r.id;
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
      v_permanent := v_state in ('22023','42501','P0002','23505','23503','23514','22P02','22007','22008');
      v_attempts := r.attempts + 1;
      insert into public.automation_steps (run_id, organization_id, step_index, action_type, status, attempts, error)
        values (r.id, r.organization_id, r.step_index, v_steps->r.step_index->>'type', 'failed', v_attempts, left(v_msg, 500))
        on conflict (run_id, step_index) do update set status = 'failed', error = excluded.error, attempts = excluded.attempts, updated_at = now();
      if v_permanent or v_attempts >= r.max_attempts then
        update public.automation_runs set status = 'dead', attempts = v_attempts, last_error = left(v_msg, 500), finished_at = now() where id = r.id; return 'dead'; end if;
      update public.automation_runs set status = 'retrying', attempts = v_attempts, last_error = left(v_msg, 500), next_attempt_at = now() + make_interval(mins => power(2, v_attempts - 1)::int) where id = r.id;
      return 'retrying';
    end;
  end loop;
  update public.automation_runs set status = 'succeeded', finished_at = now(), last_error = null where id = r.id;
  return 'succeeded';
end $$;

-- ---------- privileges ----------
revoke all on function public.perm_ok_new(uuid, text, text), public.members_role_guard(), public.perm_default(text, text, text), public.perm_ok_for(uuid, uuid, text, text), public.perm_ok(uuid, text, text), public.perm_team_member(uuid, uuid), public.perm_scope_ok(uuid, text, uuid, uuid),
  public.perm_location_ok(uuid, uuid), public.perm_guard(), public.perm_actor_admin(uuid), public.role_validate(text, jsonb, jsonb), public.integration_admin(uuid), public.perm_automation_ok(uuid, uuid, jsonb) from public, anon;
-- policies and triggers call these as the signed-in user, so they must stay executable by `authenticated`
-- (perm_ok_for / perm_team_member stay internal so they cannot be used to probe other people's memberships)
grant execute on function public.perm_default(text, text, text), public.perm_ok(uuid, text, text), public.perm_ok_new(uuid, text, text), public.perm_scope_ok(uuid, text, uuid, uuid), public.perm_location_ok(uuid, uuid) to authenticated;
revoke all on function public.perm_ok_for(uuid, uuid, text, text), public.perm_team_member(uuid, uuid) from authenticated;
revoke all on function public.integration_admin(uuid), public.perm_automation_ok(uuid, uuid, jsonb), public.perm_actor_admin(uuid), public.role_validate(text, jsonb, jsonb), public.perm_guard(), public.members_role_guard() from authenticated;
revoke all on function public.role_save(uuid, uuid, text, text, jsonb, jsonb, boolean), public.role_delete(uuid, uuid), public.member_assign_role(uuid, uuid, uuid, text), public.branch_save(uuid, uuid, text, boolean),
  public.member_branches_set(uuid, uuid, uuid[]), public.location_branch_set(uuid, uuid, uuid), public.team_directory(uuid), public.my_permissions(uuid) from public, anon;
grant execute on function public.role_save(uuid, uuid, text, text, jsonb, jsonb, boolean), public.role_delete(uuid, uuid), public.member_assign_role(uuid, uuid, uuid, text), public.branch_save(uuid, uuid, text, boolean),
  public.member_branches_set(uuid, uuid, uuid[]), public.location_branch_set(uuid, uuid, uuid), public.team_directory(uuid), public.my_permissions(uuid) to authenticated;
