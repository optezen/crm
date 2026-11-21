-- 0007: Automation Engine. 0001-0006 are untouched.
--
-- Model: a workflow = trigger + conditions (AND/OR) + ordered actions, stored as versioned JSON (draft -> published, published
-- versions immutable). Workflows never contain SQL or code: every action type is a fixed, validated server-side operation below.
--
-- Pipeline (all in Postgres, so it is transactional, durable and testable; the worker is a thin loop that calls automation_tick):
--   domain_events (outbox, 0004)  --automation_dispatch-->  automation_runs (queue, one run per workflow per event)
--   automation_runs               --automation_execute--->  automation_steps (history) + the action's real effect
-- * Idempotency: unique (workflow_id, event_id) on runs, unique (run_id, step_index) on steps, and unique (run, step) on every effect
--   (task, notification, integration request). Events are claimed with FOR UPDATE SKIP LOCKED and marked via processed_at.
-- * Durability: delayed actions are rows (status 'waiting', next_attempt_at); nothing lives in memory. A crashed worker rolls its
--   transaction back, which releases the claim. Transient failures retry with backoff (max 5 attempts), permanent ones and exhausted
--   retries go to status 'dead' (dead-letter) and can be requeued by an owner/admin.
-- * Loop prevention: events emitted by an automation carry payload.automation {run_id, depth, chain}. A workflow already in the chain, or
--   a chain deeper than 3, is recorded as a 'skipped' run instead of executing.
-- * Permissions: a run acts as the person who published that workflow version; if they are no longer an active owner/admin the run is
--   refused. Only owners/admins manage workflows and read logs. Worker functions are granted to service_role only.

-- ---------- members can be deactivated (excluded from automatic assignment) ----------
alter table public.organization_members add column if not exists active boolean not null default true;

-- ---------- tables ----------
create table public.automation_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  enabled boolean not null default false, enabled_at timestamptz,
  published_version integer,
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create index automation_workflows_org_idx on public.automation_workflows (organization_id, created_at desc);

create table public.automation_workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null, organization_id uuid not null,
  version integer not null, status text not null check (status in ('draft','published','archived')),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  created_by uuid not null, created_at timestamptz not null default now(), published_by uuid, published_at timestamptz,
  unique (workflow_id, version), unique (id, workflow_id),
  foreign key (workflow_id, organization_id) references public.automation_workflows (id, organization_id) on delete cascade
);
create unique index automation_one_draft on public.automation_workflow_versions (workflow_id) where status = 'draft';

create or replace function public.automation_protect_versions() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or not exists (select 1 from public.organizations where id = old.organization_id) then return old; end if;
    raise exception 'Published automation versions cannot be deleted.' using errcode = '42501';
  end if;
  if old.status <> 'draft' and (new.definition is distinct from old.definition or new.version <> old.version or new.workflow_id <> old.workflow_id
      or new.organization_id <> old.organization_id or old.status = 'archived' or new.status = 'draft') then
    raise exception 'Published automation versions are immutable.' using errcode = '42501'; end if;
  if old.status = 'draft' and new.status = 'archived' then raise exception 'A draft cannot be archived.' using errcode = '42501'; end if;
  return new;
end $$;
create trigger automation_versions_protect before update or delete on public.automation_workflow_versions for each row execute function public.automation_protect_versions();

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workflow_id uuid not null, version_id uuid not null,
  event_id uuid not null references public.domain_events(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','waiting','retrying','succeeded','dead','cancelled','skipped')),
  step_index integer not null default 0, attempts integer not null default 0, max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  context jsonb not null default '{}'::jsonb, depth integer not null default 0, chain uuid[] not null default '{}',
  last_error text, created_at timestamptz not null default now(), finished_at timestamptz,
  unique (workflow_id, event_id), unique (id, organization_id),
  foreign key (workflow_id, organization_id) references public.automation_workflows (id, organization_id) on delete cascade,
  foreign key (version_id, workflow_id) references public.automation_workflow_versions (id, workflow_id)
);
create index automation_runs_due_idx on public.automation_runs (next_attempt_at) where status in ('queued','waiting','retrying');
create index automation_runs_org_idx on public.automation_runs (organization_id, created_at desc);
create index automation_runs_workflow_idx on public.automation_runs (workflow_id, created_at desc);

create table public.automation_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_runs(id) on delete cascade,
  organization_id uuid not null, step_index integer not null, action_type text not null,
  status text not null check (status in ('succeeded','failed')), attempts integer not null default 1,
  result jsonb, error text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (run_id, step_index)
);

-- Round-robin cursor: one row per workflow, locked FOR UPDATE while choosing so concurrent runs take turns.
create table public.automation_rotation (
  workflow_id uuid primary key references public.automation_workflows(id) on delete cascade,
  organization_id uuid not null, last_user_id uuid, updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null, title text not null check (char_length(title) between 1 and 120),
  body text check (char_length(body) <= 500), link text check (char_length(link) <= 200),
  run_id uuid references public.automation_runs(id) on delete set null, step_index integer,
  read_at timestamptz, created_at timestamptz not null default now()
);
create unique index notifications_effect_uq on public.notifications (run_id, step_index) where run_id is not null;
create index notifications_user_idx on public.notifications (user_id, organization_id, created_at desc);

-- External messaging is only REQUESTED here. No provider is connected: rows stay 'requested' until a future provider adapter claims them.
create table public.integration_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.automation_runs(id) on delete cascade, step_index integer not null,
  channel text not null check (channel in ('whatsapp','sms','email','webhook')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'requested' check (status in ('requested','sent','failed','cancelled')),
  provider text, created_at timestamptz not null default now(),
  unique (run_id, step_index)
);
create index integration_requests_org_idx on public.integration_requests (organization_id, status, created_at desc);

-- Tasks created by an automation are tagged so a retry can never create the same task twice.
alter table public.tasks add column if not exists automation_run_id uuid references public.automation_runs(id) on delete set null;
alter table public.tasks add column if not exists automation_step integer;
create unique index tasks_automation_effect_uq on public.tasks (automation_run_id, automation_step) where automation_run_id is not null;

-- Events that existed before this migration must not trigger workflows created afterwards.
update public.domain_events set processed_at = now() where processed_at is null;

-- ---------- row level security: read only; every write is a function ----------
alter table public.automation_workflows enable row level security;
alter table public.automation_workflow_versions enable row level security;
alter table public.automation_runs enable row level security;
alter table public.automation_steps enable row level security;
alter table public.automation_rotation enable row level security;
alter table public.notifications enable row level security;
alter table public.integration_requests enable row level security;
create policy automation_workflows_read on public.automation_workflows for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy automation_versions_read on public.automation_workflow_versions for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy automation_runs_read on public.automation_runs for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy automation_steps_read on public.automation_steps for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy integration_requests_read on public.integration_requests for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy notifications_read on public.notifications for select to authenticated using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
revoke all on public.automation_workflows, public.automation_workflow_versions, public.automation_runs, public.automation_steps,
  public.automation_rotation, public.notifications, public.integration_requests from anon, authenticated;
grant select on public.automation_workflows, public.automation_workflow_versions, public.automation_runs, public.automation_steps,
  public.notifications, public.integration_requests to authenticated;

-- ---------- small pure helpers ----------
create or replace function public.automation_num(p text) returns numeric language sql immutable set search_path = '' as $$
  select case when p ~ '^-?[0-9]{1,30}(\.[0-9]{1,15})?$' then p::numeric end;
$$;
create or replace function public.automation_date(p text) returns date language plpgsql stable set search_path = '' as $$
begin
  if p is null then return null; end if;
  if lower(btrim(p)) = 'today' then return current_date; end if;
  if p ~ '^\d{4}-\d{2}-\d{2}' then return left(p, 10)::date; end if;
  return null;
exception when others then return null;
end $$;
create or replace function public.automation_get(p_ctx jsonb, p_path text) returns text language sql immutable set search_path = '' as $$
  select p_ctx #>> string_to_array(p_path, '.');
$$;
-- {{lead.full_name}} style substitution; no spaces, unknown paths become empty text. Output only ever lands in validated text fields.
create or replace function public.automation_tpl(p_text text, p_ctx jsonb) returns text language plpgsql immutable set search_path = '' as $$
declare k text; v_out text := coalesce(p_text, '');
begin
  for k in select distinct (regexp_matches(v_out, '\{\{([a-z0-9_.-]{1,60})\}\}', 'g'))[1] loop
    v_out := replace(v_out, '{{' || k || '}}', left(coalesce(public.automation_get(p_ctx, k), ''), 500));
  end loop;
  return v_out;
end $$;

create or replace function public.automation_cond(c jsonb, p_ctx jsonb) returns boolean language plpgsql stable set search_path = '' as $$
declare a text := public.automation_get(p_ctx, c->>'field'); b text := c->'value' #>> '{}'; op text := c->>'op'; x numeric; y numeric; d1 date; d2 date;
begin
  case op
    when 'empty' then return a is null or btrim(a) = '';
    when 'not_empty' then return a is not null and btrim(a) <> '';
    when 'eq', 'neq' then
      x := public.automation_num(a); y := public.automation_num(b);
      return (case when x is not null and y is not null then x = y else a is not distinct from b end) = (op = 'eq');
    when 'contains' then return a is not null and b is not null and position(lower(b) in lower(a)) > 0;
    when 'gt' then x := public.automation_num(a); y := public.automation_num(b); return x is not null and y is not null and x > y;
    when 'lt' then x := public.automation_num(a); y := public.automation_num(b); return x is not null and y is not null and x < y;
    when 'before' then d1 := public.automation_date(a); d2 := public.automation_date(b); return d1 is not null and d2 is not null and d1 < d2;
    when 'after' then d1 := public.automation_date(a); d2 := public.automation_date(b); return d1 is not null and d2 is not null and d1 > d2;
    else return false;
  end case;
end $$;
create or replace function public.automation_eval(p_match jsonb, p_ctx jsonb) returns boolean language plpgsql stable set search_path = '' as $$
declare v_conds jsonb := coalesce(p_match->'conditions', '[]'::jsonb);
begin
  if jsonb_array_length(v_conds) = 0 then return true; end if;
  if p_match->>'op' = 'or' then return exists (select 1 from jsonb_array_elements(v_conds) c where public.automation_cond(c.value, p_ctx)); end if;
  return not exists (select 1 from jsonb_array_elements(v_conds) c where not public.automation_cond(c.value, p_ctx));
end $$;

-- ---------- definition validator (mirrored by src/lib/automation/validate.ts; a parity test runs a corpus through both) ----------
create or replace function public.automation_scope(p_event text) returns text language sql immutable set search_path = '' as $$
  select case when p_event like 'lead.%' then 'lead' when p_event like 'task.%' then 'task' when p_event like 'record.%' then 'record' else 'none' end;
$$;
create or replace function public.automation_path_ok(p_path text, p_scope text) returns boolean language sql immutable set search_path = '' as $$
  select p_path ~ '^(lead|task|record)\.[a-z][a-z0-9_]{0,39}$'
     and ((p_path like 'lead.%' and p_scope in ('lead','task')) or (p_path like 'task.%' and p_scope = 'task') or (p_path like 'record.%' and p_scope = 'record'));
$$;
create or replace function public.automation_keys_ok(p jsonb, p_allowed text[]) returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p) = 'object' and not exists (select 1 from jsonb_object_keys(p) k where k <> all(p_allowed)), false);
$$;

create or replace function public.automation_validate(p jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare
  v_event text; v_scope text; c jsonb; a jsonb; t text; v_idx int := 0; v_n int; r text; v_scalar boolean;
  v_events text[] := array['record.created','record.updated','lead.created','lead.assigned','task.created','task.completed','appointment.created','payment.received'];
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

-- ---------- round robin ----------
-- Serialized per workflow by locking its cursor row. Cursor is the last assigned user id; the next pick is the first eligible user with a
-- greater id, wrapping around. Removed members simply stop being candidates; deactivated members (active = false) are skipped.
create or replace function public.automation_next_assignee(p_org uuid, p_workflow uuid, p_roles text[]) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_last uuid; v_next uuid;
begin
  insert into public.automation_rotation (workflow_id, organization_id) values (p_workflow, p_org) on conflict do nothing;
  select last_user_id into v_last from public.automation_rotation where workflow_id = p_workflow and organization_id = p_org for update;
  select user_id into v_next from public.organization_members where organization_id = p_org and active and role = any(p_roles) and (v_last is null or user_id > v_last) order by user_id limit 1;
  if v_next is null then
    select user_id into v_next from public.organization_members where organization_id = p_org and active and role = any(p_roles) order by user_id limit 1; end if;
  if v_next is null then raise exception 'No active team member is eligible for assignment.' using errcode = '22023'; end if;
  update public.automation_rotation set last_user_id = v_next, updated_at = now() where workflow_id = p_workflow;
  return v_next;
end $$;

-- ---------- dispatcher: domain_events -> runs ----------
create or replace function public.automation_context(ev public.domain_events) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := jsonb_build_object('event', (ev.payload - 'automation') || jsonb_build_object('name', ev.event_name, 'actor_id', ev.actor_id, 'aggregate_id', ev.aggregate_id));
        v_t public.tasks; v_lead uuid; v_data jsonb; v_ld jsonb;
begin
  if ev.aggregate_type = 'lead' then v_lead := ev.aggregate_id;
  elsif ev.aggregate_type = 'task' then
    select * into v_t from public.tasks where id = ev.aggregate_id and organization_id = ev.organization_id;
    if found then v_lead := v_t.lead_id;
      v := v || jsonb_build_object('task', jsonb_build_object('id', v_t.id, 'lead_id', v_t.lead_id, 'title', v_t.title, 'owner_id', v_t.owner_id, 'due_date', v_t.due_date, 'status', v_t.status, 'outcome', v_t.outcome)); end if;
  elsif ev.aggregate_type = 'record' then
    select data into v_data from public.records where id = ev.aggregate_id and organization_id = ev.organization_id;
    if v_data is not null then v := v || jsonb_build_object('record', v_data); end if;
  end if;
  if v_lead is not null then
    select jsonb_build_object('id', l.id, 'stage', l.stage, 'source', l.source, 'summary', l.summary, 'assigned_to', l.assigned_to,
      'full_name', c.full_name, 'phone', c.phone, 'email', c.email, 'created_at', l.created_at) into v_ld
      from public.leads l join public.contacts c on c.id = l.contact_id where l.id = v_lead and l.organization_id = ev.organization_id;
    if v_ld is not null then v := v || jsonb_build_object('lead', v_ld); end if;
  end if;
  return v;
end $$;

create or replace function public.automation_dispatch(p_limit integer default 50) returns integer language plpgsql security definer set search_path = '' as $$
declare ev public.domain_events; w record; v_ctx jsonb; v_chain uuid[]; v_depth int; v_n int := 0; v_status text; v_err text;
begin
  for ev in select * from public.domain_events where processed_at is null order by created_at, id limit greatest(1, least(coalesce(p_limit, 50), 500)) for update skip locked loop
    v_ctx := null;
    v_chain := coalesce(array(select jsonb_array_elements_text(ev.payload->'automation'->'chain')::uuid), '{}'); v_depth := coalesce((ev.payload->'automation'->>'depth')::int, -1) + 1;
    for w in select wf.id wid, wf.organization_id org, v.id vid, v.definition def from public.automation_workflows wf
             join public.automation_workflow_versions v on v.workflow_id = wf.id and v.version = wf.published_version and v.status = 'published'
             where wf.organization_id = ev.organization_id and wf.enabled and v.definition #>> '{trigger,event}' = ev.event_name
               and greatest(v.published_at, wf.enabled_at) <= ev.created_at
               and (v.definition #>> '{trigger,object}' is null or v.definition #>> '{trigger,object}' = ev.payload->>'object') loop
      v_ctx := coalesce(v_ctx, public.automation_context(ev));
      continue when not public.automation_eval(w.def->'match', v_ctx);
      v_status := 'queued'; v_err := null;
      if w.wid = any(v_chain) then v_status := 'skipped'; v_err := 'Loop prevented: this automation already ran earlier in the same chain of events.';
      elsif v_depth > 3 then v_status := 'skipped'; v_err := 'Loop prevented: automations triggered by automations are limited to 3 levels.'; end if;
      insert into public.automation_runs (organization_id, workflow_id, version_id, event_id, status, context, depth, chain, last_error, finished_at)
        values (w.org, w.wid, w.vid, ev.id, v_status, v_ctx, v_depth, v_chain || w.wid, v_err, case when v_status = 'skipped' then now() end)
        on conflict (workflow_id, event_id) do nothing;
      v_n := v_n + 1;
    end loop;
    update public.domain_events set processed_at = now() where id = ev.id;
  end loop;
  return v_n;
end $$;

-- ---------- action executor ----------
create or replace function public.automation_emit(p_run public.automation_runs, p_actor uuid, p_name text, p_type text, p_id uuid, p_payload jsonb) returns void language sql security definer set search_path = '' as $$
  insert into public.domain_events (organization_id, event_name, aggregate_type, aggregate_id, actor_id, payload)
  values (p_run.organization_id, p_name, p_type, p_id, p_actor,
    p_payload || jsonb_build_object('automation', jsonb_build_object('run_id', p_run.id, 'workflow_id', p_run.workflow_id, 'depth', p_run.depth, 'chain', to_jsonb(p_run.chain))));
$$;

create or replace function public.automation_recipient(p_run public.automation_runs, p_who text, p_lead public.leads, p_task_owner uuid) returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  v := case p_who when 'lead_assignee' then p_lead.assigned_to when 'task_owner' then p_task_owner when 'event_actor' then (p_run.context #>> '{event,actor_id}')::uuid else p_who::uuid end;
  if v is null then raise exception 'There is nobody to send this to (the lead has no assignee, or the event has no actor).' using errcode = '22023'; end if;
  if not exists (select 1 from public.organization_members where organization_id = p_run.organization_id and user_id = v and active) then
    raise exception 'That person is not an active member of this organization.' using errcode = '22023'; end if;
  return v;
end $$;

-- Executes ONE action. Returns a result object; {"resume_at": ts} means "park the run until then".
create or replace function public.automation_do(p_run public.automation_runs, p_step jsonb, p_idx integer, p_actor uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_t text := p_step->>'type'; v_ctx jsonb := p_run.context; v_org uuid := p_run.organization_id;
  v_lead_id uuid := (v_ctx #>> '{lead,id}')::uuid; v_lead public.leads; v_task public.tasks; v_rec public.records;
  v_target uuid; v_owner uuid; v_title text; v_due date; v_id uuid; v_obj jsonb; v_data jsonb; v_text text; v_until timestamptz; v_phone text; v_email text; v_changed boolean;
begin
  if v_t in ('assign_lead','assign_round_robin','create_task') or (v_t in ('notify','request_integration') and v_lead_id is not null) then
    select * into v_lead from public.leads where id = v_lead_id and organization_id = v_org;
    if not found and v_t in ('assign_lead','assign_round_robin','create_task') then raise exception 'Lead not found.' using errcode = 'P0002'; end if;
  end if;

  if v_t in ('assign_lead','assign_round_robin') then
    select * into v_lead from public.leads where id = v_lead_id and organization_id = v_org for update;
    if v_t = 'assign_round_robin' then
      if coalesce((p_step->>'only_if_unassigned')::boolean, true) and v_lead.assigned_to is not null then return jsonb_build_object('skipped', 'already_assigned', 'assigned_to', v_lead.assigned_to); end if;
      v_target := public.automation_next_assignee(v_org, p_run.workflow_id, case when p_step ? 'roles' then array(select jsonb_array_elements_text(p_step->'roles')) else array['employee'] end);
    else
      v_target := (p_step->>'user_id')::uuid;
      if not exists (select 1 from public.organization_members where organization_id = v_org and user_id = v_target and active) then
        raise exception 'The chosen person is not an active member of this organization.' using errcode = '22023'; end if;
    end if;
    if v_lead.assigned_to is not distinct from v_target then return jsonb_build_object('unchanged', true, 'assigned_to', v_target); end if;
    update public.leads set assigned_to = v_target, updated_at = now() where id = v_lead_id;
    insert into public.lead_activities (organization_id, lead_id, actor_id, kind, meta) values (v_org, v_lead_id, p_actor, 'assigned',
      jsonb_build_object('from', v_lead.assigned_to, 'to', v_target, 'automation', true, 'run_id', p_run.id));
    perform public.automation_emit(p_run, p_actor, 'lead.assigned', 'lead', v_lead_id, jsonb_build_object('from', v_lead.assigned_to, 'to', v_target));
    return jsonb_build_object('assigned_to', v_target);

  elsif v_t = 'create_task' then
    v_owner := case when p_step->>'owner' = 'lead_assignee' then v_lead.assigned_to else (p_step->>'owner')::uuid end;
    if v_owner is null then raise exception 'The lead has no assignee yet. Put an assignment step before this task.' using errcode = '22023'; end if;
    if not exists (select 1 from public.organization_members where organization_id = v_org and user_id = v_owner and active) then
      raise exception 'The task owner is not an active member of this organization.' using errcode = '22023'; end if;
    if v_lead.assigned_to is not null and v_lead.assigned_to <> v_owner
       and not exists (select 1 from public.organization_members where organization_id = v_org and user_id = v_owner and role in ('owner','admin','manager')) then
      raise exception 'That employee cannot access this lead.' using errcode = '22023'; end if;
    v_title := public.crm_norm_text(public.automation_tpl(p_step->>'title', v_ctx), 200, 'Task title');
    if v_title is null then raise exception 'The task title is empty.' using errcode = '22023'; end if;
    v_due := current_date + (p_step->>'due_in_days')::int;
    select id into v_id from public.tasks where organization_id = v_org and lead_id = v_lead_id and owner_id = v_owner and status = 'open' and lower(title) = lower(v_title) limit 1;
    if v_id is not null then return jsonb_build_object('skipped', 'duplicate_open_task', 'task_id', v_id); end if;
    insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, created_by, automation_run_id, automation_step)
      values (v_org, v_lead_id, v_title, v_owner, v_due, p_actor, p_run.id, p_idx) returning id into v_id;
    insert into public.lead_activities (organization_id, lead_id, actor_id, kind, body, meta) values (v_org, v_lead_id, p_actor, 'task_created', v_title,
      jsonb_build_object('task_id', v_id, 'owner_id', v_owner, 'due_date', v_due, 'automation', true, 'run_id', p_run.id));
    update public.leads set updated_at = now() where id = v_lead_id;
    perform public.automation_emit(p_run, p_actor, 'task.created', 'task', v_id, jsonb_build_object('lead_id', v_lead_id, 'owner_id', v_owner, 'due_date', v_due));
    return jsonb_build_object('task_id', v_id, 'owner_id', v_owner, 'due_date', v_due);

  elsif v_t = 'update_task_status' then
    select * into v_task from public.tasks where id = (v_ctx #>> '{task,id}')::uuid and organization_id = v_org for update;
    if not found then raise exception 'Task not found.' using errcode = 'P0002'; end if;
    if p_step->>'status' = 'done' then
      if v_task.status = 'done' then return jsonb_build_object('unchanged', true); end if;
      v_text := public.crm_norm_text(public.automation_tpl(p_step->>'outcome', v_ctx), 1000, 'Outcome');
      if v_text is null then raise exception 'The outcome is empty.' using errcode = '22023'; end if;
      update public.tasks set status = 'done', outcome = v_text, completed_at = now(), completed_by = p_actor where id = v_task.id;
      insert into public.lead_activities (organization_id, lead_id, actor_id, kind, body, meta) values (v_org, v_task.lead_id, p_actor, 'task_completed', v_text,
        jsonb_build_object('task_id', v_task.id, 'title', v_task.title, 'automation', true, 'run_id', p_run.id));
      perform public.automation_emit(p_run, p_actor, 'task.completed', 'task', v_task.id, jsonb_build_object('lead_id', v_task.lead_id, 'owner_id', v_task.owner_id));
    else
      if v_task.status = 'open' then return jsonb_build_object('unchanged', true); end if;
      update public.tasks set status = 'open', outcome = null, completed_at = null, completed_by = null where id = v_task.id;
      perform public.automation_emit(p_run, p_actor, 'task.reopened', 'task', v_task.id, jsonb_build_object('lead_id', v_task.lead_id));
    end if;
    return jsonb_build_object('task_id', v_task.id, 'status', p_step->>'status');

  elsif v_t = 'update_record' then
    select * into v_rec from public.records where id = (v_ctx #>> '{event,aggregate_id}')::uuid and organization_id = v_org for update;
    if not found then raise exception 'Record not found.' using errcode = 'P0002'; end if;
    select o_def into v_obj from public.record_object(v_org, v_rec.object_key);
    v_data := public.record_validate(v_obj, jsonb_build_object(p_step->>'field',
      case when jsonb_typeof(p_step->'value') = 'string' then to_jsonb(public.automation_tpl(p_step->>'value', v_ctx)) else p_step->'value' end), v_rec.data);
    if v_data = v_rec.data then return jsonb_build_object('unchanged', true); end if;
    update public.records set data = v_data, search_text = public.record_search_text(v_data), updated_by = p_actor, updated_at = now() where id = v_rec.id;
    insert into public.audit_events (organization_id, actor_id, event_name, payload) values (v_org, p_actor, 'record.updated',
      jsonb_build_object('object', v_rec.object_key, 'record_id', v_rec.id, 'fields', jsonb_build_array(p_step->>'field'), 'automation_run_id', p_run.id));
    perform public.automation_emit(p_run, p_actor, 'record.updated', 'record', v_rec.id, jsonb_build_object('object', v_rec.object_key, 'fields', jsonb_build_array(p_step->>'field')));
    return jsonb_build_object('record_id', v_rec.id, 'field', p_step->>'field');

  elsif v_t = 'notify' then
    if v_ctx #>> '{task,id}' is not null then select * into v_task from public.tasks where id = (v_ctx #>> '{task,id}')::uuid and organization_id = v_org; end if;
    v_target := public.automation_recipient(p_run, p_step->>'recipient', v_lead, v_task.owner_id);
    insert into public.notifications (organization_id, user_id, title, body, link, run_id, step_index)
      values (v_org, v_target, left(public.automation_tpl(p_step->>'title', v_ctx), 120), nullif(left(public.automation_tpl(p_step->>'body', v_ctx), 500), ''),
        case when v_lead_id is not null then '/work/leads/' || v_lead_id end, p_run.id, p_idx) on conflict do nothing;
    return jsonb_build_object('notified', v_target);

  elsif v_t = 'wait' then
    if p_step ? 'minutes' then v_until := now() + make_interval(mins => (p_step->>'minutes')::int);
    else
      v_until := (public.automation_date(public.automation_get(v_ctx, p_step->>'until_field')))::timestamptz;
      if v_until is null then raise exception 'The date field to wait for is empty or not a date.' using errcode = '22023'; end if;
    end if;
    if v_until <= now() then return jsonb_build_object('waited', false, 'until', v_until); end if;
    return jsonb_build_object('resume_at', v_until);

  elsif v_t = 'request_integration' then
    if p_step ? 'to' then
      select c.phone, c.email into v_phone, v_email from public.leads l join public.contacts c on c.id = l.contact_id where l.id = v_lead_id and l.organization_id = v_org;
      if (p_step->>'channel' in ('whatsapp','sms') and v_phone is null) or (p_step->>'channel' = 'email' and v_email is null) then
        raise exception 'The lead has no % for this channel.', case when p_step->>'channel' = 'email' then 'email address' else 'phone number' end using errcode = '22023'; end if;
    end if;
    insert into public.integration_requests (organization_id, run_id, step_index, channel, payload) values (v_org, p_run.id, p_idx, p_step->>'channel',
      jsonb_build_object('message', public.automation_tpl(p_step->>'message', v_ctx), 'lead_id', v_lead_id, 'phone', v_phone, 'email', v_email)) on conflict do nothing;
    return jsonb_build_object('requested', p_step->>'channel', 'provider', null);
  end if;
  raise exception 'Unknown action.' using errcode = '22023';
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
  if not exists (select 1 from public.organization_members where organization_id = r.organization_id and user_id = v.published_by and active and role in ('owner','admin')) then
    update public.automation_runs set status = 'dead', last_error = 'The person who published this automation is no longer an active owner or admin. Republish it to continue.', finished_at = now() where id = r.id; return 'dead'; end if;
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

-- One worker iteration: turn new events into runs, then execute due runs. Safe to call from many workers at once (SKIP LOCKED).
create or replace function public.automation_tick(p_dispatch integer default 50, p_runs integer default 20) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_disp int; v_id uuid; v_s text; v_out jsonb := '{}'::jsonb;
begin
  v_disp := public.automation_dispatch(p_dispatch);
  for v_id in select id from public.automation_runs where status in ('queued','waiting','retrying') and next_attempt_at <= now()
              order by next_attempt_at, created_at limit greatest(1, least(coalesce(p_runs, 20), 200)) for update skip locked loop
    v_s := public.automation_execute(v_id);
    v_out := v_out || jsonb_build_object(v_s, coalesce((v_out->>v_s)::int, 0) + 1);
  end loop;
  return jsonb_build_object('dispatched', v_disp, 'runs', v_out);
end $$;

-- ---------- workflow management (owners/admins) ----------
create or replace function public.automation_save_draft(p_org uuid, p_workflow uuid, p_name text, p_definition jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); v_name text := btrim(coalesce(p_name, '')); v_id uuid := p_workflow; v_upd int;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  if char_length(v_name) not between 1 and 80 then raise exception 'Name the automation (up to 80 characters).' using errcode = '22023'; end if;
  perform public.automation_validate(p_definition);
  perform pg_advisory_xact_lock(hashtext('automation:' || p_org::text));
  if v_id is null then
    if (select count(*) from public.automation_workflows where organization_id = p_org) >= 50 then raise exception 'An organization can have at most 50 automations.' using errcode = '22023'; end if;
    insert into public.automation_workflows (organization_id, name, created_by) values (p_org, v_name, v_uid) returning id into v_id;
  else
    update public.automation_workflows set name = v_name, updated_at = now() where id = v_id and organization_id = p_org;
    get diagnostics v_upd = row_count;
    if v_upd = 0 then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
  end if;
  update public.automation_workflow_versions set definition = p_definition, created_by = v_uid, created_at = now() where workflow_id = v_id and status = 'draft';
  get diagnostics v_upd = row_count;
  if v_upd = 0 then
    insert into public.automation_workflow_versions (workflow_id, organization_id, version, status, definition, created_by)
      values (v_id, p_org, (select coalesce(max(version), 0) + 1 from public.automation_workflow_versions where workflow_id = v_id), 'draft', p_definition, v_uid); end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'automation.draft_saved', jsonb_build_object('workflow_id', v_id));
  return v_id;
end $$;

create or replace function public.automation_discard_draft(p_org uuid, p_workflow uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org);
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  perform 1 from public.automation_workflows where id = p_workflow and organization_id = p_org for update;
  if not found then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
  delete from public.automation_workflow_versions where workflow_id = p_workflow and status = 'draft';
  if not exists (select 1 from public.automation_workflow_versions where workflow_id = p_workflow) then delete from public.automation_workflows where id = p_workflow; end if;
end $$;

-- Publishes the saved draft as the next immutable version. Checks what the pure validator cannot: availability of the trigger and
-- that referenced modules/fields exist in the LIVE workspace configuration.
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
  if v_ev in ('appointment.created','payment.received') then
    raise exception 'The trigger "%" is not available yet: Optizen has no %s module. You can save the draft but not publish it.', v_ev, split_part(v_ev, '.', 1) using errcode = '22023'; end if;
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

create or replace function public.automation_set_enabled(p_org uuid, p_workflow uuid, p_enabled boolean) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.crm_member_role(p_org); w public.automation_workflows;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  select * into w from public.automation_workflows where id = p_workflow and organization_id = p_org for update;
  if not found then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
  if p_enabled and w.published_version is null then raise exception 'Publish the automation before enabling it.' using errcode = '22023'; end if;
  if w.enabled = p_enabled then return; end if;
  update public.automation_workflows set enabled = p_enabled, enabled_at = case when p_enabled then now() else enabled_at end, updated_at = now() where id = p_workflow;
  -- disabling stops work that has not happened yet (queued, delayed and retrying runs); finished history is untouched
  if not p_enabled then
    update public.automation_runs set status = 'cancelled', last_error = 'The automation was disabled.', finished_at = now() where workflow_id = p_workflow and status in ('queued','waiting','retrying'); end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, case when p_enabled then 'automation.enabled' else 'automation.disabled' end, jsonb_build_object('workflow_id', p_workflow));
end $$;

create or replace function public.automation_requeue_run(p_org uuid, p_run uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org); r public.automation_runs;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  select * into r from public.automation_runs where id = p_run and organization_id = p_org for update;
  if not found then raise exception 'Run not found.' using errcode = 'P0002'; end if;
  if r.status <> 'dead' then raise exception 'Only failed (dead-letter) runs can be retried.' using errcode = '22023'; end if;
  if not exists (select 1 from public.automation_workflows where id = r.workflow_id and enabled) then raise exception 'Enable the automation first.' using errcode = '22023'; end if;
  update public.automation_runs set status = 'retrying', attempts = 0, next_attempt_at = now(), finished_at = null where id = p_run;
end $$;

create or replace function public.notifications_mark_read(p_ids uuid[]) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  update public.notifications set read_at = now() where user_id = v_uid and read_at is null and (p_ids is null or id = any(p_ids));
end $$;

-- Owners/admins can deactivate a member: they stay on the team but are skipped by automatic assignment and cannot receive automation work.
create or replace function public.set_member_active(p_org uuid, p_user uuid, p_active boolean) returns void language plpgsql security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org); v_cur record;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can manage the team.' using errcode = '42501'; end if;
  select role, active into v_cur from public.organization_members where organization_id = p_org and user_id = p_user;
  if not found then raise exception 'Team member not found.' using errcode = 'P0002'; end if;
  if v_cur.role = 'owner' or p_user = (select auth.uid()) then raise exception 'You cannot deactivate yourself or an owner.' using errcode = '42501'; end if;
  if v_role = 'admin' and v_cur.role = 'admin' then raise exception 'Only owners can manage admins.' using errcode = '42501'; end if;
  update public.organization_members set active = coalesce(p_active, true) where organization_id = p_org and user_id = p_user;
  perform public.crm_emit(p_org, 'member.active_changed', 'member', p_user, jsonb_build_object('active', coalesce(p_active, true)));
end $$;

-- Team list including the active flag (crm_list_members from 0004 predates it and is left untouched).
create or replace function public.team_list_members(p_org uuid)
returns table (user_id uuid, role text, email text, active boolean) language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.crm_member_role(p_org);
  return query select m.user_id, m.role, u.email::text, m.active from public.organization_members m join auth.users u on u.id = m.user_id
    where m.organization_id = p_org order by array_position(array['owner','admin','manager','employee'], m.role), u.email;
end $$;

-- ---------- privileges ----------
revoke all on function public.automation_num(text), public.automation_date(text), public.automation_get(jsonb, text), public.automation_tpl(text, jsonb),
  public.automation_cond(jsonb, jsonb), public.automation_eval(jsonb, jsonb), public.automation_scope(text), public.automation_path_ok(text, text),
  public.automation_keys_ok(jsonb, text[]), public.automation_validate(jsonb), public.automation_next_assignee(uuid, uuid, text[]),
  public.automation_context(public.domain_events), public.automation_emit(public.automation_runs, uuid, text, text, uuid, jsonb),
  public.automation_recipient(public.automation_runs, text, public.leads, uuid), public.automation_do(public.automation_runs, jsonb, integer, uuid),
  public.automation_protect_versions() from public, anon, authenticated;
-- worker entry points: the backend worker uses the service-role key; no signed-in user can run them
revoke all on function public.automation_dispatch(integer), public.automation_execute(uuid), public.automation_tick(integer, integer) from public, anon, authenticated;
grant execute on function public.automation_dispatch(integer), public.automation_execute(uuid), public.automation_tick(integer, integer) to service_role;
revoke all on function public.automation_save_draft(uuid, uuid, text, jsonb), public.automation_discard_draft(uuid, uuid), public.automation_publish(uuid, uuid, boolean),
  public.automation_set_enabled(uuid, uuid, boolean), public.automation_requeue_run(uuid, uuid), public.notifications_mark_read(uuid[]),
  public.set_member_active(uuid, uuid, boolean), public.team_list_members(uuid) from public, anon;
grant execute on function public.automation_save_draft(uuid, uuid, text, jsonb), public.automation_discard_draft(uuid, uuid), public.automation_publish(uuid, uuid, boolean),
  public.automation_set_enabled(uuid, uuid, boolean), public.automation_requeue_run(uuid, uuid), public.notifications_mark_read(uuid[]),
  public.set_member_active(uuid, uuid, boolean), public.team_list_members(uuid) to authenticated;
