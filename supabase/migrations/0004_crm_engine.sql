-- 0004: CRM data engine (contacts, leads, activities, follow-up tasks, domain-event outbox).
-- Same security model as 0003: clients get SELECT only (through RLS). Every write goes through a SECURITY DEFINER
-- function that (a) derives the actor from auth.uid(), (b) checks membership + role in the *given* organization,
-- (c) validates/normalizes input, and (d) writes the activity row and the domain event in the same transaction.
-- Error codes used by the functions: 28000 unauthenticated, 42501 forbidden, 22023 invalid input,
-- 23505 duplicate, P0002 not found. The app shows messages only for 22023/23505/P0002.

-- ---------- role helpers (used by RLS policies, so they must be executable by `authenticated`) ----------
create or replace function public.org_role(p_org_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_members m where m.organization_id = p_org_id and m.user_id = (select auth.uid());
$$;
-- Owners/admins/managers see every lead; employees see leads assigned to them and unassigned ones.
create or replace function public.can_see_lead(p_org_id uuid, p_assigned_to uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.org_role(p_org_id) in ('owner','admin','manager'), false)
      or (public.org_role(p_org_id) is not null and (p_assigned_to is null or p_assigned_to = (select auth.uid())));
$$;
revoke all on function public.org_role(uuid), public.can_see_lead(uuid, uuid) from public, anon;
grant execute on function public.org_role(uuid), public.can_see_lead(uuid, uuid) to authenticated;

-- ---------- tables ----------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 120),
  phone text check (phone ~ '^\+?[0-9]{7,15}$'),
  email text check (email = lower(email) and char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index contacts_org_phone_uq on public.contacts (organization_id, phone) where phone is not null;
create unique index contacts_org_email_uq on public.contacts (organization_id, email) where email is not null;

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  stage text not null check (char_length(stage) between 1 and 80),
  source text not null default 'other' check (source in ('walk_in','phone','website','whatsapp','referral','meta_ads','other')),
  summary text check (char_length(summary) <= 2000),
  assigned_to uuid,
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (contact_id, organization_id) references public.contacts (id, organization_id),
  -- the assignee must be a member of the SAME organization (MATCH SIMPLE: not enforced while assigned_to is null)
  foreign key (organization_id, assigned_to) references public.organization_members (organization_id, user_id)
);
create index leads_org_created_idx on public.leads (organization_id, created_at desc, id);
create index leads_org_stage_idx on public.leads (organization_id, stage);
create index leads_org_assignee_idx on public.leads (organization_id, assigned_to);
create index leads_contact_idx on public.leads (contact_id);

create table public.lead_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  actor_id uuid,
  kind text not null check (kind in ('created','updated','stage_changed','assigned','note','task_created','task_completed')),
  body text check (char_length(body) <= 4000),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (lead_id, organization_id) references public.leads (id, organization_id) on delete cascade
);
create index lead_activities_lead_idx on public.lead_activities (lead_id, created_at desc);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  title text not null check (char_length(title) between 1 and 200),
  owner_id uuid not null,
  due_date date not null,
  status text not null default 'open' check (status in ('open','done')),
  outcome text check (char_length(outcome) <= 1000),
  completed_at timestamptz, completed_by uuid,
  created_by uuid not null, created_at timestamptz not null default now(),
  check ((status = 'open' and outcome is null and completed_at is null)
      or (status = 'done' and completed_at is not null and char_length(btrim(outcome)) >= 1)),
  foreign key (lead_id, organization_id) references public.leads (id, organization_id) on delete cascade,
  foreign key (organization_id, owner_id) references public.organization_members (organization_id, user_id)
);
create index tasks_owner_idx on public.tasks (organization_id, owner_id, status, due_date);
create index tasks_lead_idx on public.tasks (lead_id);

-- Transactional outbox: future adapters (webhooks, workflows, AI) consume rows where processed_at is null.
create table public.domain_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_name text not null check (event_name ~ '^[a-z_]+\.[a-z_]+$'),
  aggregate_type text not null, aggregate_id uuid not null,
  actor_id uuid, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), processed_at timestamptz
);
create index domain_events_pending_idx on public.domain_events (created_at) where processed_at is null;
create index domain_events_org_idx on public.domain_events (organization_id, created_at desc);

-- Append-only history. Cascades from deleting the organization are still allowed (same pattern as audit_events).
create or replace function public.protect_crm_history() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations where id = old.organization_id) then return old; end if;
  if tg_table_name = 'domain_events' and tg_op = 'UPDATE'
     and (to_jsonb(new) - 'processed_at') = (to_jsonb(old) - 'processed_at') then return new; end if; -- only the consumer mark may change
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger lead_activities_protect before update or delete on public.lead_activities for each row execute function public.protect_crm_history();
create trigger domain_events_protect before update or delete on public.domain_events for each row execute function public.protect_crm_history();

-- ---------- read access (RLS) ----------
alter table public.contacts enable row level security;
alter table public.leads enable row level security;
alter table public.lead_activities enable row level security;
alter table public.tasks enable row level security;
alter table public.domain_events enable row level security;

create policy leads_read on public.leads for select to authenticated using (public.can_see_lead(organization_id, assigned_to));
-- Contacts: managers and above see all; employees only contacts of leads they can see (leads RLS applies inside the subquery).
create policy contacts_read on public.contacts for select to authenticated using (
  public.org_role(organization_id) in ('owner','admin','manager')
  or exists (select 1 from public.leads l where l.contact_id = contacts.id));
create policy activities_read on public.lead_activities for select to authenticated using (
  exists (select 1 from public.leads l where l.id = lead_activities.lead_id));
create policy tasks_read on public.tasks for select to authenticated using (
  exists (select 1 from public.leads l where l.id = tasks.lead_id));
create policy events_read on public.domain_events for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));

-- Read models. security_invoker: the caller's RLS applies to the underlying tables.
create view public.crm_lead_list with (security_invoker = true) as
  select l.id, l.organization_id, l.stage, l.source, l.summary, l.assigned_to, l.created_at, l.updated_at,
         c.id as contact_id, c.full_name, c.phone, c.email,
         (select count(*) from public.tasks t where t.lead_id = l.id and t.status = 'open')::int as open_tasks
  from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id;
create view public.crm_stage_counts with (security_invoker = true) as
  select organization_id, stage, count(*)::int as n from public.leads group by organization_id, stage;

revoke all on public.contacts, public.leads, public.lead_activities, public.tasks, public.domain_events, public.crm_lead_list, public.crm_stage_counts from anon, authenticated;
grant select on public.contacts, public.leads, public.lead_activities, public.tasks, public.domain_events, public.crm_lead_list, public.crm_stage_counts to authenticated;

-- ---------- internal helpers (NOT callable by clients) ----------
create or replace function public.crm_member_role(p_org uuid) returns text language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select role into v_role from public.organization_members where organization_id = p_org and user_id = v_uid;
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  return v_role;
end $$;

create or replace function public.crm_stages(p_org uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((select definition->'pipeline'->'stages' from public.workspace_configuration_versions
                   where organization_id = p_org and status = 'published' order by revision desc limit 1), '[]'::jsonb);
$$;

-- Locks the lead row; "not found" for both missing and not-visible leads so ids cannot be probed.
create or replace function public.crm_lock_lead(p_org uuid, p_lead uuid, p_role text) returns public.leads language plpgsql security definer set search_path = '' as $$
declare v public.leads;
begin
  select * into v from public.leads where id = p_lead and organization_id = p_org for update;
  if not found or not (p_role in ('owner','admin','manager') or v.assigned_to is null or v.assigned_to = (select auth.uid())) then
    raise exception 'Lead not found.' using errcode = 'P0002';
  end if;
  return v;
end $$;

create or replace function public.crm_emit(p_org uuid, p_name text, p_type text, p_id uuid, p_payload jsonb) returns void language sql security definer set search_path = '' as $$
  insert into public.domain_events (organization_id, event_name, aggregate_type, aggregate_id, actor_id, payload)
  values (p_org, p_name, p_type, p_id, (select auth.uid()), coalesce(p_payload, '{}'::jsonb));
$$;

create or replace function public.crm_log(p_org uuid, p_lead uuid, p_kind text, p_body text, p_meta jsonb) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lead_activities (organization_id, lead_id, actor_id, kind, body, meta)
  values (p_org, p_lead, (select auth.uid()), p_kind, p_body, coalesce(p_meta, '{}'::jsonb));
  update public.leads set updated_at = now() where id = p_lead;
end $$;

-- Input normalizers shared by the write functions (the app normalizes first; this is defense in depth).
create or replace function public.crm_norm_name(p text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g');
begin
  if char_length(v) not between 1 and 120 then raise exception 'Enter a name of up to 120 characters.' using errcode = '22023'; end if;
  return v;
end $$;
create or replace function public.crm_norm_phone(p text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(regexp_replace(coalesce(p, ''), '[\s().-]', '', 'g'), '');
begin
  if v is not null and v !~ '^\+?[0-9]{7,15}$' then raise exception 'Enter a valid phone number (7 to 15 digits, optional leading +).' using errcode = '22023'; end if;
  return v;
end $$;
create or replace function public.crm_norm_email(p text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(lower(btrim(coalesce(p, ''))), '');
begin
  if v is not null and (char_length(v) > 254 or v !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then raise exception 'Enter a valid email address.' using errcode = '22023'; end if;
  return v;
end $$;
create or replace function public.crm_norm_source(p text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := coalesce(nullif(btrim(p), ''), 'other');
begin
  if v not in ('walk_in','phone','website','whatsapp','referral','meta_ads','other') then raise exception 'Choose a valid lead source.' using errcode = '22023'; end if;
  return v;
end $$;
create or replace function public.crm_norm_text(p text, p_max int, p_what text) returns text language plpgsql immutable set search_path = '' as $$
declare v text := nullif(btrim(coalesce(p, '')), '');
begin
  if v is not null and char_length(v) > p_max then raise exception '% must be at most % characters.', p_what, p_max using errcode = '22023'; end if;
  return v;
end $$;

revoke all on function public.crm_member_role(uuid), public.crm_stages(uuid), public.crm_lock_lead(uuid, uuid, text),
  public.crm_emit(uuid, text, text, uuid, jsonb), public.crm_log(uuid, uuid, text, text, jsonb),
  public.crm_norm_name(text), public.crm_norm_phone(text), public.crm_norm_email(text), public.crm_norm_source(text), public.crm_norm_text(text, int, text)
  from public, anon, authenticated;

-- ---------- public write API (RPC) ----------
create or replace function public.crm_create_lead(p_org uuid, p_full_name text, p_phone text, p_email text, p_source text, p_summary text, p_stage text, p_assigned_to uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org);
  v_name text := public.crm_norm_name(p_full_name); v_phone text := public.crm_norm_phone(p_phone); v_email text := public.crm_norm_email(p_email);
  v_source text := public.crm_norm_source(p_source); v_summary text := public.crm_norm_text(p_summary, 2000, 'Summary');
  v_stages jsonb := public.crm_stages(p_org); v_stage text := coalesce(nullif(btrim(p_stage), ''), public.crm_stages(p_org)->>0);
  v_contact uuid; v_other uuid; v_lead uuid;
begin
  if v_stage is null or not coalesce(v_stages @> to_jsonb(v_stage), false) then raise exception 'Choose a stage from the pipeline.' using errcode = '22023'; end if;
  if p_assigned_to is not null then
    if v_role = 'employee' and p_assigned_to <> v_uid then raise exception 'You can only assign leads to yourself.' using errcode = '42501'; end if;
    if not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_assigned_to) then
      raise exception 'The assignee must be a member of this organization.' using errcode = '22023'; end if;
  end if;
  -- one contact per phone / email inside an organization: reuse instead of duplicating
  if v_phone is not null then select id into v_contact from public.contacts where organization_id = p_org and phone = v_phone; end if;
  if v_email is not null then
    select id into v_other from public.contacts where organization_id = p_org and email = v_email;
    if v_contact is null then v_contact := v_other;
    elsif v_other is not null and v_other <> v_contact then raise exception 'That phone number and email belong to two different contacts.' using errcode = '23505'; end if;
  end if;
  if v_contact is null then
    insert into public.contacts (organization_id, full_name, phone, email, created_by) values (p_org, v_name, v_phone, v_email, v_uid) returning id into v_contact;
  else
    update public.contacts set phone = coalesce(phone, v_phone), email = coalesce(email, v_email), updated_at = now() where id = v_contact;
  end if;
  insert into public.leads (organization_id, contact_id, stage, source, summary, assigned_to, created_by)
    values (p_org, v_contact, v_stage, v_source, v_summary, p_assigned_to, v_uid) returning id into v_lead;
  perform public.crm_log(p_org, v_lead, 'created', null, jsonb_build_object('stage', v_stage, 'source', v_source));
  perform public.crm_emit(p_org, 'lead.created', 'lead', v_lead, jsonb_build_object('contact_id', v_contact, 'stage', v_stage, 'source', v_source, 'assigned_to', p_assigned_to));
  if p_assigned_to is not null then
    perform public.crm_log(p_org, v_lead, 'assigned', null, jsonb_build_object('from', null, 'to', p_assigned_to));
    perform public.crm_emit(p_org, 'lead.assigned', 'lead', v_lead, jsonb_build_object('from', null, 'to', p_assigned_to));
  end if;
  return v_lead;
exception when unique_violation then
  raise exception 'A contact with that phone number or email already exists.' using errcode = '23505';
end $$;

create or replace function public.crm_update_lead(p_org uuid, p_lead uuid, p_full_name text, p_phone text, p_email text, p_source text, p_summary text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_role text := public.crm_member_role(p_org); v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org));
  v_c public.contacts; v_name text := public.crm_norm_name(p_full_name); v_phone text := public.crm_norm_phone(p_phone); v_email text := public.crm_norm_email(p_email);
  v_source text := public.crm_norm_source(p_source); v_summary text := public.crm_norm_text(p_summary, 2000, 'Summary'); v_changed text[] := '{}';
begin
  select * into v_c from public.contacts where id = v_lead.contact_id;
  if v_c.full_name is distinct from v_name then v_changed := array_append(v_changed, 'name'); end if;
  if v_c.phone is distinct from v_phone then v_changed := array_append(v_changed, 'phone'); end if;
  if v_c.email is distinct from v_email then v_changed := array_append(v_changed, 'email'); end if;
  if v_lead.source is distinct from v_source then v_changed := array_append(v_changed, 'source'); end if;
  if v_lead.summary is distinct from v_summary then v_changed := array_append(v_changed, 'summary'); end if;
  if cardinality(v_changed) = 0 then return; end if;
  update public.contacts set full_name = v_name, phone = v_phone, email = v_email, updated_at = now() where id = v_c.id;
  update public.leads set source = v_source, summary = v_summary where id = p_lead;
  perform public.crm_log(p_org, p_lead, 'updated', null, jsonb_build_object('fields', to_jsonb(v_changed)));
  perform public.crm_emit(p_org, 'lead.updated', 'lead', p_lead, jsonb_build_object('fields', to_jsonb(v_changed)));
exception when unique_violation then
  raise exception 'Another contact already uses that phone number or email.' using errcode = '23505';
end $$;

create or replace function public.crm_set_stage(p_org uuid, p_lead uuid, p_stage text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org)); v_stage text := btrim(coalesce(p_stage, ''));
begin
  if not coalesce(public.crm_stages(p_org) @> to_jsonb(v_stage), false) then raise exception 'Choose a stage from the pipeline.' using errcode = '22023'; end if;
  if v_lead.stage = v_stage then return; end if;
  update public.leads set stage = v_stage where id = p_lead;
  perform public.crm_log(p_org, p_lead, 'stage_changed', null, jsonb_build_object('from', v_lead.stage, 'to', v_stage));
  perform public.crm_emit(p_org, 'lead.stage_changed', 'lead', p_lead, jsonb_build_object('from', v_lead.stage, 'to', v_stage));
end $$;

-- Managers and above assign anyone (or unassign). Employees may only claim an unassigned lead for themselves.
create or replace function public.crm_assign_lead(p_org uuid, p_lead uuid, p_assignee uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org));
begin
  if v_role = 'employee' and not (p_assignee = v_uid and v_lead.assigned_to is null) then
    raise exception 'Employees can only assign an unassigned lead to themselves.' using errcode = '42501'; end if;
  if p_assignee is not null and not exists (select 1 from public.organization_members where organization_id = p_org and user_id = p_assignee) then
    raise exception 'The assignee must be a member of this organization.' using errcode = '22023'; end if;
  if v_lead.assigned_to is not distinct from p_assignee then return; end if;
  update public.leads set assigned_to = p_assignee where id = p_lead;
  perform public.crm_log(p_org, p_lead, 'assigned', null, jsonb_build_object('from', v_lead.assigned_to, 'to', p_assignee));
  perform public.crm_emit(p_org, 'lead.assigned', 'lead', p_lead, jsonb_build_object('from', v_lead.assigned_to, 'to', p_assignee));
end $$;

create or replace function public.crm_add_note(p_org uuid, p_lead uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org)); v_body text := public.crm_norm_text(p_body, 4000, 'Note');
begin
  if v_body is null then raise exception 'Write a note first.' using errcode = '22023'; end if;
  perform public.crm_log(p_org, p_lead, 'note', v_body, '{}'::jsonb);
  perform public.crm_emit(p_org, 'lead.note_added', 'lead', p_lead, '{}'::jsonb);
end $$;

create or replace function public.crm_create_task(p_org uuid, p_lead uuid, p_title text, p_owner uuid, p_due date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org));
  v_title text := public.crm_norm_text(p_title, 200, 'Task title'); v_owner uuid := coalesce(p_owner, (select auth.uid())); v_task uuid;
begin
  if v_title is null then raise exception 'Enter a task title.' using errcode = '22023'; end if;
  if p_due is null or p_due < current_date - 1 or p_due > current_date + 1095 then raise exception 'Choose a due date within the next three years.' using errcode = '22023'; end if;
  if v_role = 'employee' and v_owner <> v_uid then raise exception 'Employees can only create tasks for themselves.' using errcode = '42501'; end if;
  select user_id into v_owner from public.organization_members where organization_id = p_org and user_id = v_owner;
  if v_owner is null then raise exception 'The task owner must be a member of this organization.' using errcode = '22023'; end if;
  -- the owner must be able to open the lead they were asked to follow up
  if v_lead.assigned_to is not null and v_lead.assigned_to <> v_owner
     and not exists (select 1 from public.organization_members where organization_id = p_org and user_id = v_owner and role in ('owner','admin','manager')) then
    raise exception 'That employee cannot access this lead. Assign the lead to them first.' using errcode = '22023'; end if;
  insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, created_by) values (p_org, p_lead, v_title, v_owner, p_due, v_uid) returning id into v_task;
  perform public.crm_log(p_org, p_lead, 'task_created', v_title, jsonb_build_object('task_id', v_task, 'owner_id', v_owner, 'due_date', p_due));
  perform public.crm_emit(p_org, 'task.created', 'task', v_task, jsonb_build_object('lead_id', p_lead, 'owner_id', v_owner, 'due_date', p_due));
  return v_task;
end $$;

create or replace function public.crm_complete_task(p_org uuid, p_task uuid, p_outcome text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_t public.tasks; v_outcome text := public.crm_norm_text(p_outcome, 1000, 'Outcome');
begin
  select * into v_t from public.tasks where id = p_task and organization_id = p_org for update;
  if not found or not (v_role in ('owner','admin','manager') or v_t.owner_id = v_uid) then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if v_t.status = 'done' then raise exception 'This task is already completed.' using errcode = '22023'; end if;
  if v_outcome is null then raise exception 'Record the outcome before completing the task.' using errcode = '22023'; end if;
  update public.tasks set status = 'done', outcome = v_outcome, completed_at = now(), completed_by = v_uid where id = p_task;
  perform public.crm_log(p_org, v_t.lead_id, 'task_completed', v_outcome, jsonb_build_object('task_id', p_task, 'title', v_t.title));
  perform public.crm_emit(p_org, 'task.completed', 'task', p_task, jsonb_build_object('lead_id', v_t.lead_id, 'owner_id', v_t.owner_id));
end $$;

-- ---------- team membership ----------
create or replace function public.crm_list_members(p_org uuid)
returns table (user_id uuid, role text, email text) language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.crm_member_role(p_org);
  return query select m.user_id, m.role, u.email::text from public.organization_members m join auth.users u on u.id = m.user_id
    where m.organization_id = p_org order by array_position(array['owner','admin','manager','employee'], m.role), u.email;
end $$;

-- Owners add admins/managers/employees; admins add managers/employees. The person must already have signed in once.
create or replace function public.crm_add_member(p_org uuid, p_email text, p_role text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org); v_email text := public.crm_norm_email(p_email); v_user uuid;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage the team.' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('admin','manager','employee') then raise exception 'Choose a role: admin, manager or employee.' using errcode = '22023'; end if;
  if p_role = 'admin' and v_role <> 'owner' then raise exception 'Only owners can add admins.' using errcode = '42501'; end if;
  if v_email is null then raise exception 'Enter an email address.' using errcode = '22023'; end if;
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then raise exception 'No account uses that email yet. Ask them to sign in to Optizen once, then add them.' using errcode = '22023'; end if;
  if exists (select 1 from public.organization_members where organization_id = p_org and user_id = v_user) then raise exception 'That person is already on the team.' using errcode = '23505'; end if;
  insert into public.organization_members (organization_id, user_id, role) values (p_org, v_user, p_role);
  perform public.crm_emit(p_org, 'member.added', 'member', v_user, jsonb_build_object('role', p_role));
  return v_user;
end $$;

create or replace function public.crm_set_member_role(p_org uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_cur text;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage the team.' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('admin','manager','employee') then raise exception 'Choose a role: admin, manager or employee.' using errcode = '22023'; end if;
  select role into v_cur from public.organization_members where organization_id = p_org and user_id = p_user;
  if v_cur is null then raise exception 'Team member not found.' using errcode = 'P0002'; end if;
  if v_cur = 'owner' or p_user = v_uid then raise exception 'You cannot change your own role or an owner''s role.' using errcode = '42501'; end if;
  if v_role = 'admin' and (v_cur = 'admin' or p_role = 'admin') then raise exception 'Only owners can manage admins.' using errcode = '42501'; end if;
  if v_cur = p_role then return; end if;
  update public.organization_members set role = p_role where organization_id = p_org and user_id = p_user;
  perform public.crm_emit(p_org, 'member.role_changed', 'member', p_user, jsonb_build_object('from', v_cur, 'to', p_role));
end $$;

revoke all on function public.crm_create_lead(uuid, text, text, text, text, text, text, uuid), public.crm_update_lead(uuid, uuid, text, text, text, text, text),
  public.crm_set_stage(uuid, uuid, text), public.crm_assign_lead(uuid, uuid, uuid), public.crm_add_note(uuid, uuid, text),
  public.crm_create_task(uuid, uuid, text, uuid, date), public.crm_complete_task(uuid, uuid, text), public.crm_list_members(uuid),
  public.crm_add_member(uuid, text, text), public.crm_set_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.crm_create_lead(uuid, text, text, text, text, text, text, uuid), public.crm_update_lead(uuid, uuid, text, text, text, text, text),
  public.crm_set_stage(uuid, uuid, text), public.crm_assign_lead(uuid, uuid, uuid), public.crm_add_note(uuid, uuid, text),
  public.crm_create_task(uuid, uuid, text, uuid, date), public.crm_complete_task(uuid, uuid, text), public.crm_list_members(uuid),
  public.crm_add_member(uuid, text, text), public.crm_set_member_role(uuid, uuid, text) to authenticated;
