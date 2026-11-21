-- 0019 Complete user experience: invitations, profiles and notification preferences, in-app notification generation, global search, role-aware home data.
-- 0001-0018 are untouched. Every write is a function; the actor and organization always come from the signed-in membership.
-- Nothing here sends email, push or WhatsApp: invitations produce a LINK the inviter shares, and notifications are in-app only.

-- ---------- invitations ----------
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null check (role in ('admin','manager','employee')),
  custom_role_id uuid, branch_ids uuid[] not null default '{}',
  token_hash text not null unique, -- sha-256 of the token; the token itself is shown once and never stored
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  expires_at timestamptz not null, invited_by uuid not null, created_at timestamptz not null default now(), accepted_by uuid, accepted_at timestamptz, revoked_at timestamptz,
  foreign key (custom_role_id, organization_id) references public.custom_roles (id, organization_id)
);
create index invitations_org_idx on public.invitations (organization_id, created_at desc);
create unique index invitations_one_pending on public.invitations (organization_id, email) where status = 'pending';
alter table public.invitations enable row level security; revoke all on public.invitations from anon, authenticated; grant select (id, organization_id, email, role, custom_role_id, branch_ids, status, expires_at, invited_by, created_at, accepted_at, revoked_at) on public.invitations to authenticated;
create policy invitations_read on public.invitations for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));

create or replace function public.invite_hash(p_token text) returns text language sql immutable set search_path = '' as $$ select encode(sha256(convert_to(coalesce(p_token, ''), 'utf8')), 'hex') $$;

create or replace function public.invite_create(p_org uuid, p_email text, p_role text, p_custom_role uuid default null, p_branches uuid[] default '{}', p_days integer default 7) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_actor text := public.crm_member_role(p_org); v_email text := lower(btrim(coalesce(p_email, ''))); v_token text; v_id uuid; v_base text := p_role;
begin
  if v_actor not in ('owner','admin') then raise exception 'Only owners and admins can invite people.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  if p_custom_role is not null then select base_role into v_base from public.custom_roles where id = p_custom_role and organization_id = p_org; if v_base is null then raise exception 'Role not found.' using errcode = 'P0002'; end if; end if;
  if v_base not in ('admin','manager','employee') then raise exception 'Choose a role: admin, manager or employee.' using errcode = '22023'; end if;
  if v_base = 'admin' and v_actor <> 'owner' then raise exception 'Only the owner can invite admins.' using errcode = '42501'; end if;
  if p_days not between 1 and 30 then raise exception 'An invitation lasts 1 to 30 days.' using errcode = '22023'; end if;
  if coalesce(array_length(p_branches, 1), 0) > 20 or exists (select 1 from unnest(coalesce(p_branches, '{}')) b where not exists (select 1 from public.branches x where x.id = b and x.organization_id = p_org)) then raise exception 'Unknown branch.' using errcode = '22023'; end if;
  if exists (select 1 from public.organization_members m join auth.users u on u.id = m.user_id where m.organization_id = p_org and lower(u.email::text) = v_email) then raise exception 'That person is already on the team.' using errcode = '23505'; end if;
  perform pg_advisory_xact_lock(hashtext('invite:' || p_org::text));
  if (select count(*) from public.invitations where organization_id = p_org and status = 'pending' and expires_at > now()) >= 50 then raise exception 'Too many open invitations. Revoke some first.' using errcode = '22023'; end if;
  update public.invitations set status = 'revoked', revoked_at = now() where organization_id = p_org and email = v_email and status = 'pending';
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.invitations (organization_id, email, role, custom_role_id, branch_ids, token_hash, expires_at, invited_by) values (p_org, v_email, v_base, p_custom_role, coalesce(p_branches, '{}'), public.invite_hash(v_token), now() + make_interval(days => p_days), v_uid) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'invitation.created', jsonb_build_object('invitation_id', v_id, 'role', v_base));
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', now() + make_interval(days => p_days));
end $$;

create or replace function public.invite_revoke(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can manage invitations.' using errcode = '42501'; end if;
  update public.invitations set status = 'revoked', revoked_at = now() where id = p_id and organization_id = p_org and status = 'pending';
  if not found then raise exception 'That invitation is not pending.' using errcode = 'P0002'; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'invitation.revoked', jsonb_build_object('invitation_id', p_id));
end $$;

-- What the holder of a link may learn: the organization name, the role, and whether it is usable by THIS signed-in account. Nothing about other people.
create or replace function public.invite_preview(p_token text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare i public.invitations; v_email text; v_org text;
begin
  if (select auth.uid()) is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into i from public.invitations where token_hash = public.invite_hash(p_token);
  if not found then return jsonb_build_object('state', 'invalid'); end if;
  select lower(email::text) into v_email from auth.users where id = (select auth.uid()); select name into v_org from public.organizations where id = i.organization_id;
  return jsonb_build_object('state', case when i.status = 'revoked' then 'revoked' when i.status = 'accepted' then 'accepted' when i.expires_at <= now() then 'expired' when v_email is distinct from i.email then 'wrong_account' else 'ready' end, 'organization', v_org, 'role', i.role);
end $$;

create or replace function public.invite_accept(p_token text) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); i public.invitations; v_email text; b uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into i from public.invitations where token_hash = public.invite_hash(p_token) for update;
  if not found or i.status <> 'pending' or i.expires_at <= now() then raise exception 'This invitation is no longer valid. Ask for a new one.' using errcode = '22023'; end if;
  select lower(email::text) into v_email from auth.users where id = v_uid;
  if v_email is distinct from i.email then raise exception 'This invitation was sent to a different email address. Sign in with the invited address.' using errcode = '42501'; end if;
  if exists (select 1 from public.organization_members where organization_id = i.organization_id and user_id = v_uid) then
    update public.invitations set status = 'accepted', accepted_by = v_uid, accepted_at = now() where id = i.id; return i.organization_id; end if;
  insert into public.organization_members (organization_id, user_id, role, custom_role_id) values (i.organization_id, v_uid, i.role, i.custom_role_id);
  for b in select unnest(i.branch_ids) loop insert into public.member_branches (organization_id, user_id, branch_id) select i.organization_id, v_uid, b where exists (select 1 from public.branches x where x.id = b and x.organization_id = i.organization_id) on conflict do nothing; end loop;
  update public.invitations set status = 'accepted', accepted_by = v_uid, accepted_at = now() where id = i.id;
  perform public.crm_emit(i.organization_id, 'member.added', 'member', v_uid, jsonb_build_object('role', i.role, 'via', 'invitation'));
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (i.organization_id, v_uid, 'invitation.accepted', jsonb_build_object('invitation_id', i.id));
  return i.organization_id;
end $$;

-- change someone's role and branch access in one transaction (the underlying functions check who may do what)
create or replace function public.member_update_access(p_org uuid, p_user uuid, p_role text, p_custom_role uuid, p_branches uuid[]) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_custom_role is not null then perform public.member_assign_role(p_org, p_user, p_custom_role, 'employee');
  else perform public.crm_set_member_role(p_org, p_user, p_role); perform public.member_assign_role(p_org, p_user, null, p_role); end if;
  perform public.member_branches_set(p_org, p_user, p_branches);
end $$;

-- ---------- profiles and notification preferences ----------
create table public.user_profiles (user_id uuid primary key, display_name text check (char_length(display_name) between 1 and 80), updated_at timestamptz not null default now());
create table public.notification_prefs (user_id uuid not null, organization_id uuid not null references public.organizations(id) on delete cascade, task_assigned boolean not null default true, lead_assigned boolean not null default true, task_overdue boolean not null default true, automation boolean not null default true, updated_at timestamptz not null default now(), primary key (user_id, organization_id));
alter table public.user_profiles enable row level security; alter table public.notification_prefs enable row level security;
revoke all on public.user_profiles, public.notification_prefs from anon, authenticated; grant select on public.user_profiles, public.notification_prefs to authenticated;
create policy user_profiles_read on public.user_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy notification_prefs_read on public.notification_prefs for select to authenticated using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create or replace function public.profile_save(p_name text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if v = '' then delete from public.user_profiles where user_id = v_uid; return; end if;
  if char_length(v) > 80 then raise exception 'Use a name of up to 80 characters.' using errcode = '22023'; end if;
  insert into public.user_profiles (user_id, display_name) values (v_uid, v) on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();
end $$;
-- display names of the people in MY organization (members only), for showing names instead of emails
create or replace function public.member_names(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.crm_member_role(p_org);
  return coalesce((select jsonb_object_agg(p.user_id::text, p.display_name) from public.user_profiles p join public.organization_members m on m.user_id = p.user_id and m.organization_id = p_org), '{}'::jsonb);
end $$;
create or replace function public.notification_prefs_save(p_org uuid, p_task_assigned boolean, p_lead_assigned boolean, p_task_overdue boolean, p_automation boolean) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  perform public.crm_member_role(p_org);
  insert into public.notification_prefs (user_id, organization_id, task_assigned, lead_assigned, task_overdue, automation) values (v_uid, p_org, coalesce(p_task_assigned, true), coalesce(p_lead_assigned, true), coalesce(p_task_overdue, true), coalesce(p_automation, true))
    on conflict (user_id, organization_id) do update set task_assigned = excluded.task_assigned, lead_assigned = excluded.lead_assigned, task_overdue = excluded.task_overdue, automation = excluded.automation, updated_at = now();
end $$;

-- ---------- notifications: categories, assignment and overdue generation, read/unread ----------
alter table public.notifications add column if not exists category text not null default 'automation' check (category in ('automation','task_assigned','lead_assigned','task_overdue'));
alter table public.notifications add column if not exists dedupe_key text;
create unique index if not exists notifications_dedupe_uq on public.notifications (user_id, dedupe_key) where dedupe_key is not null;
create or replace function public.notif_enabled(p_org uuid, p_user uuid, p_category text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select case p_category when 'task_assigned' then task_assigned when 'lead_assigned' then lead_assigned when 'task_overdue' then task_overdue else automation end from public.notification_prefs where user_id = p_user and organization_id = p_org), true)
$$;
create or replace function public.notif_task_assigned() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid());
begin
  if new.owner_id is distinct from v_actor and public.notif_enabled(new.organization_id, new.owner_id, 'task_assigned') then
    insert into public.notifications (organization_id, user_id, title, body, link, category) values (new.organization_id, new.owner_id, left('New follow-up: ' || new.title, 120), 'Due ' || to_char(new.due_date, 'DD Mon YYYY'), '/work/leads/' || new.lead_id, 'task_assigned'); end if;
  return new;
end $$;
create trigger notif_task_assigned_trg after insert on public.tasks for each row execute function public.notif_task_assigned();
create or replace function public.notif_lead_assigned() returns trigger language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_name text;
begin
  if new.assigned_to is not null and new.assigned_to is distinct from v_actor and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to) and public.notif_enabled(new.organization_id, new.assigned_to, 'lead_assigned') then
    select full_name into v_name from public.contacts where id = new.contact_id;
    insert into public.notifications (organization_id, user_id, title, body, link, category) values (new.organization_id, new.assigned_to, 'A lead was assigned to you', left(v_name, 120), '/work/leads/' || new.id, 'lead_assigned'); end if;
  return new;
end $$;
create trigger notif_lead_assigned_trg after insert or update of assigned_to on public.leads for each row execute function public.notif_lead_assigned();
-- Overdue follow-ups for the CALLER, once per task per day. It runs when the person opens the app or the notification center (there is no background sender), and is idempotent.
create or replace function public.notifications_generate_overdue(p_org uuid) returns integer language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); n int;
begin
  perform public.crm_member_role(p_org);
  if not public.notif_enabled(p_org, v_uid, 'task_overdue') then return 0; end if;
  with ins as (insert into public.notifications (organization_id, user_id, title, body, link, category, dedupe_key)
    select t.organization_id, v_uid, left('Overdue: ' || t.title, 120), 'Was due ' || to_char(t.due_date, 'DD Mon YYYY'), '/work/leads/' || t.lead_id, 'task_overdue', 'overdue:' || t.id || ':' || current_date
    from public.tasks t where t.organization_id = p_org and t.owner_id = v_uid and t.status = 'open' and t.due_date < current_date on conflict do nothing returning 1) select count(*) into n from ins;
  return n;
end $$;
create or replace function public.notifications_set_read(p_ids uuid[], p_read boolean) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  update public.notifications set read_at = case when p_read then coalesce(read_at, now()) else null end where user_id = v_uid and (p_ids is null or id = any(p_ids));
end $$;

-- ---------- role-aware home data ----------
-- Everything on the home screen comes from here, as the signed-in user (row-level security and permissions apply). No samples, no invented numbers.
create or replace function public.home_summary(p_org uuid, p_tz text default 'UTC') returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.org_role(p_org); v_tz text := case when exists (select 1 from pg_catalog.pg_timezone_names z where z.name = p_tz) then p_tz else 'UTC' end; v_today date := (now() at time zone v_tz)::date; v_appt boolean;
begin
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  v_appt := exists (select 1 from public.workspace_configuration_versions c where c.organization_id = p_org and c.status = 'published' and (c.definition #>> '{operations,appointments,enabled}') = 'true');
  return jsonb_build_object('role', v_role, 'today', v_today,
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'due', t.due_date, 'lead_id', t.lead_id, 'lead', c.full_name, 'overdue', t.due_date < v_today) order by t.due_date, t.created_at) from (select * from public.tasks where organization_id = p_org and owner_id = v_uid and status = 'open' order by due_date, created_at limit 8) t left join public.leads l on l.id = t.lead_id left join public.contacts c on c.id = l.contact_id), '[]'::jsonb),
    'open_tasks', (select count(*) from public.tasks where organization_id = p_org and owner_id = v_uid and status = 'open'),
    'overdue_tasks', (select count(*) from public.tasks where organization_id = p_org and owner_id = v_uid and status = 'open' and due_date < v_today),
    'leads', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', c.full_name, 'stage', l.stage, 'updated_at', l.updated_at) order by l.updated_at desc) from (select * from public.leads where organization_id = p_org and assigned_to = v_uid order by updated_at desc limit 6) l join public.contacts c on c.id = l.contact_id), '[]'::jsonb),
    'my_leads', (select count(*) from public.leads where organization_id = p_org and assigned_to = v_uid),
    'unassigned_leads', (select count(*) from public.leads where organization_id = p_org and assigned_to is null),
    'appointments_enabled', v_appt,
    'appointments', case when not v_appt then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'starts_at', a.starts_at, 'status', a.status, 'type', ty.name, 'contact', ct.full_name) order by a.starts_at) from (select * from public.appointments where organization_id = p_org and status in ('scheduled','confirmed') and (starts_at at time zone v_tz)::date = v_today and (v_role in ('owner','admin','manager') or staff_id = v_uid) order by starts_at limit 8) a join public.appointment_types ty on ty.id = a.type_id left join public.contacts ct on ct.id = a.contact_id), '[]'::jsonb) end,
    'unread', (select count(*) from public.notifications where organization_id = p_org and user_id = v_uid and read_at is null),
    'notifications', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'title', n.title, 'body', n.body, 'link', n.link, 'created_at', n.created_at, 'category', n.category) order by n.created_at desc) from (select * from public.notifications where organization_id = p_org and user_id = v_uid and read_at is null order by created_at desc limit 5) n), '[]'::jsonb),
    'members', (select count(*) from public.organization_members where organization_id = p_org),
    'leads_total', (select count(*) from public.leads where organization_id = p_org));
end $$;

-- ---------- global search ----------
-- SECURITY INVOKER: it reads only through the same tables and views the screens use, so row-level security, scopes, location rules and field masking all apply.
--  * leads/contacts: crm_lead_list (phone and email come from the checked functions, so a hidden number is NULL and can neither match nor leak);
--    phone/email are only searched when the query looks like a number/address, and a hit is shown by NAME only (never the matched value).
--  * records: records_view (masked data and search text). invoices: only what the caller can read; the frozen snapshot is not searched.
--  * every result is {type, id, title, subtitle, link}: titles and subtitles are names, numbers, stages and dates, never contact details.
create index if not exists contacts_name_idx on public.contacts (organization_id, lower(full_name) text_pattern_ops);
create index if not exists tasks_title_idx on public.tasks (organization_id, lower(title) text_pattern_ops);
create index if not exists invoices_number_idx on public.invoices (organization_id, lower(number) text_pattern_ops);
create or replace function public.global_search(p_org uuid, p_q text, p_types text[] default null, p_limit integer default 20, p_offset integer default 0) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_q text := btrim(coalesce(p_q, '')); v_like text; v_pre text; v_lim integer := least(greatest(coalesce(p_limit, 20), 1), 50); v_off integer := least(greatest(coalesce(p_offset, 0), 0), 1000); v_need integer := v_lim + v_off + 1; v_all boolean := p_types is null or cardinality(p_types) = 0;
  v_digits text; v_contact boolean; v_items jsonb; v_role text := public.org_role(p_org); v_def jsonb;
begin
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  if char_length(v_q) < 2 then return jsonb_build_object('items', '[]'::jsonb, 'has_more', false); end if;
  if char_length(v_q) > 80 then raise exception 'Search for at most 80 characters.' using errcode = '22023'; end if;
  if not v_all and exists (select 1 from unnest(p_types) t where t not in ('lead','task','appointment','invoice','record')) then raise exception 'Unknown search type.' using errcode = '22023'; end if;
  v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%'; v_pre := replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g'); v_contact := char_length(v_digits) >= 4 or position('@' in v_q) > 0;
  select c.definition into v_def from public.workspace_configuration_versions c where c.organization_id = p_org and c.status = 'published' order by c.revision desc limit 1;
  select coalesce(jsonb_agg(x order by (x->>'rank')::int, x->>'title'), '[]'::jsonb) into v_items from (
    select x from (select x from (
      select jsonb_build_object('type', 'lead', 'id', l.id, 'title', l.full_name, 'subtitle', l.stage || ' · ' || replace(l.source, '_', ' '), 'link', '/work/leads/' || l.id, 'rank', case when lower(l.full_name) like v_pre escape '\' then 0 else 1 end) x
      from public.crm_lead_list l where (v_all or 'lead' = any(p_types)) and l.organization_id = p_org
        and (lower(l.full_name) like v_like escape '\' or lower(coalesce(l.summary, '')) like v_like escape '\' or (v_contact and (lower(coalesce(l.email, '')) like v_like escape '\' or (char_length(v_digits) >= 4 and regexp_replace(coalesce(l.phone, ''), '[^0-9]', '', 'g') like '%' || v_digits || '%'))))
        ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) a
    union all select x from (select x from (
      select jsonb_build_object('type', 'task', 'id', t.id, 'title', t.title, 'subtitle', coalesce(c.full_name, 'Lead') || ' · due ' || to_char(t.due_date, 'DD Mon') || case when t.status = 'done' then ' · done' else '' end, 'link', '/work/leads/' || t.lead_id, 'rank', case when lower(t.title) like v_pre escape '\' then 0 else 1 end) x
      from public.tasks t join public.leads l on l.id = t.lead_id join public.contacts c on c.id = l.contact_id where (v_all or 'task' = any(p_types)) and t.organization_id = p_org and lower(t.title) like v_like escape '\'   ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) b
    union all select x from (select x from (
      select jsonb_build_object('type', 'appointment', 'id', a.id, 'title', ty.name || coalesce(' · ' || ct.full_name, ''), 'subtitle', to_char(a.starts_at at time zone 'UTC', 'DD Mon YYYY HH24:MI') || ' UTC · ' || replace(a.status, '_', ' '), 'link', '/work/appointments/' || a.id, 'rank', case when lower(ty.name) like v_pre escape '\' or lower(coalesce(ct.full_name, '')) like v_pre escape '\' then 0 else 1 end) x
      from public.appointments a join public.appointment_types ty on ty.id = a.type_id left join public.contacts ct on ct.id = a.contact_id where (v_all or 'appointment' = any(p_types)) and a.organization_id = p_org
        and (lower(ty.name) like v_like escape '\' or lower(coalesce(ct.full_name, '')) like v_like escape '\' or lower(coalesce(a.notes, '')) like v_like escape '\')   ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) c
    union all select x from (select x from (
      select jsonb_build_object('type', 'invoice', 'id', i.id, 'title', coalesce(i.number, 'Draft invoice'), 'subtitle', i.status || ' · ' || i.currency || ' ' || i.total || coalesce(' · ' || ct.full_name, ''), 'link', '/work/billing/' || i.id, 'rank', case when lower(coalesce(i.number, '')) like v_pre escape '\' then 0 else 1 end) x
      from public.invoices i left join public.contacts ct on ct.id = i.contact_id where (v_all or 'invoice' = any(p_types)) and i.organization_id = p_org and v_role in ('owner','admin','manager') and (lower(coalesce(i.number, '')) like v_like escape '\' or lower(coalesce(ct.full_name, '')) like v_like escape '\')   ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) d
    union all select x from (select x from (
      select jsonb_build_object('type', 'record', 'id', r.id, 'title', coalesce((select r.data->>(f.value->>'key') from jsonb_array_elements(coalesce((select o.value->'fields' from jsonb_array_elements(coalesce(v_def->'objects', '[]'::jsonb)) o where o.value->>'key' = r.object_key), '[]'::jsonb)) f where f.value->>'kind' in ('text','choice') and coalesce(r.data->>(f.value->>'key'), '') <> '' limit 1), 'Record'),
        'subtitle', coalesce((select m.value->>'label' from jsonb_array_elements(coalesce(v_def->'modules', '[]'::jsonb)) m where m.value->>'key' = r.object_key), r.object_key), 'link', '/work/' || r.object_key || '/' || r.id, 'rank', 1) x
      from public.records_view r where (v_all or 'record' = any(p_types)) and r.organization_id = p_org and lower(coalesce(r.search_text, '')) like v_like escape '\'
      ) s0 order by (s0.x->>'rank')::int, s0.x->>'title' limit v_need) e
  ) u;
  return jsonb_build_object('items', coalesce((select jsonb_agg(i) from (select i from jsonb_array_elements(v_items) with ordinality t(i, n) order by n offset v_off limit v_lim) z), '[]'::jsonb), 'has_more', jsonb_array_length(v_items) > v_off + v_lim);
end $$;

revoke all on function public.invite_hash(text), public.invite_create(uuid, text, text, uuid, uuid[], integer), public.invite_revoke(uuid, uuid), public.invite_preview(text), public.invite_accept(text), public.member_update_access(uuid, uuid, text, uuid, uuid[]), public.profile_save(text), public.member_names(uuid),
  public.notification_prefs_save(uuid, boolean, boolean, boolean, boolean), public.notif_enabled(uuid, uuid, text), public.notifications_generate_overdue(uuid), public.notifications_set_read(uuid[], boolean), public.home_summary(uuid, text), public.global_search(uuid, text, text[], integer, integer) from public, anon;
grant execute on function public.invite_create(uuid, text, text, uuid, uuid[], integer), public.invite_revoke(uuid, uuid), public.invite_preview(text), public.invite_accept(text), public.member_update_access(uuid, uuid, text, uuid, uuid[]), public.profile_save(text), public.member_names(uuid),
  public.notification_prefs_save(uuid, boolean, boolean, boolean, boolean), public.notifications_generate_overdue(uuid), public.notifications_set_read(uuid[], boolean), public.home_summary(uuid, text), public.global_search(uuid, text, text[], integer, integer) to authenticated;
