-- 0018 Advanced AI & Voice engine. 0001-0017 are untouched.
-- (1) atomic usage reservations (a budget can never be oversold by concurrent requests), (2) idempotent requests (a retry never repeats work or duplicates proposals),
-- (3) durable multi-step plans, (4) operation proposals, (5) owner AI settings, (6) onboarding limits, (7) unfinished workflow drafts, (8) lead-merge hardening,
-- (9) preserved pipeline history. Every write is a function; actor and organization come from the signed-in membership.

-- ---------- (1) settings, usage and atomic reservations ----------
alter table public.ai_settings
  add column if not exists monthly_token_limit integer check (monthly_token_limit between 1000 and 100000000),
  add column if not exists per_user_daily_tokens integer check (per_user_daily_tokens between 1000 and 5000000),
  add column if not exists input_price_per_mtok numeric(12,4) check (input_price_per_mtok >= 0),
  add column if not exists output_price_per_mtok numeric(12,4) check (output_price_per_mtok >= 0),
  add column if not exists price_currency text not null default 'USD' check (price_currency ~ '^[A-Z]{3}$');
alter table public.ai_usage
  add column if not exists kind text not null default 'chat' check (kind in ('chat','transcription','plan','onboarding')),
  add column if not exists request_id uuid, add column if not exists reserved_tokens integer not null default 0 check (reserved_tokens >= 0), add column if not exists audio_seconds integer check (audio_seconds >= 0);
alter table public.ai_usage drop constraint if exists ai_usage_status_check;
alter table public.ai_usage add constraint ai_usage_status_check check (status in ('ok','error','blocked','cancelled','reserved'));
create index if not exists ai_usage_reserved_idx on public.ai_usage (organization_id, created_at) where status = 'reserved';

-- Reserve capacity BEFORE the model is called. The check and the insert happen under one per-organization lock, so N parallel requests cannot all pass a nearly-full budget.
-- Tokens are counted as: settled rows = actual input+output, open reservations = their reserved estimate. Reservations older than 10 minutes are treated as abandoned.
create or replace function public.ai_reserve(p_org uuid, p_request uuid, p_est integer, p_kind text default 'chat') returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text := public.ai_ctx(p_org); s public.ai_settings; v_org bigint; v_user bigint; v_month bigint; v_msgs int; v_tr int; v_est integer := least(greatest(coalesce(p_est, 0), 0), 200000); v_why text; v_id uuid;
begin
  if p_kind not in ('chat','transcription','plan','onboarding') then raise exception 'Invalid usage kind.' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('aibudget:' || p_org::text));
  update public.ai_usage set status = 'error', error = 'reservation expired', reserved_tokens = 0 where organization_id = p_org and status = 'reserved' and created_at < now() - interval '10 minutes';
  select * into s from public.ai_settings where organization_id = p_org;
  if not found then s.enabled := true; s.daily_token_limit := 300000; s.hourly_messages_per_user := 40; end if;
  select coalesce(sum(case when status = 'reserved' then reserved_tokens else input_tokens + output_tokens end), 0) into v_org from public.ai_usage where organization_id = p_org and created_at >= date_trunc('day', now()) and status <> 'blocked';
  select coalesce(sum(case when status = 'reserved' then reserved_tokens else input_tokens + output_tokens end), 0) into v_user from public.ai_usage where organization_id = p_org and user_id = v_uid and created_at >= date_trunc('day', now()) and status <> 'blocked';
  select coalesce(sum(case when status = 'reserved' then reserved_tokens else input_tokens + output_tokens end), 0) into v_month from public.ai_usage where organization_id = p_org and created_at >= date_trunc('month', now()) and status <> 'blocked';
  select count(*) into v_msgs from public.ai_usage where organization_id = p_org and user_id = v_uid and created_at > now() - interval '1 hour' and status not in ('blocked') and kind in ('chat','plan');
  select count(*) into v_tr from public.ai_usage where organization_id = p_org and user_id = v_uid and created_at > now() - interval '1 hour' and status <> 'blocked' and kind = 'transcription';
  v_why := case when not s.enabled then 'AI is turned off for this organization.'
    when v_org + v_est > s.daily_token_limit then 'The organization reached its daily AI usage limit. It resets at midnight UTC.'
    when s.monthly_token_limit is not null and v_month + v_est > s.monthly_token_limit then 'The organization reached its monthly AI usage limit.'
    when s.per_user_daily_tokens is not null and v_user + v_est > s.per_user_daily_tokens then 'You reached your daily AI usage limit.'
    when p_kind in ('chat','plan') and v_msgs >= s.hourly_messages_per_user then 'You reached your hourly AI message limit. Try again later.'
    when p_kind = 'transcription' and v_tr >= 60 then 'You reached your hourly voice limit. Type your message instead, or try again later.' end;
  if v_why is not null then
    insert into public.ai_usage (organization_id, user_id, provider, model, status, error, kind, request_id) values (p_org, v_uid, '', '', 'blocked', left(v_why, 500), p_kind, p_request);
    return jsonb_build_object('allowed', false, 'reason', v_why);
  end if;
  insert into public.ai_usage (organization_id, user_id, provider, model, status, kind, request_id, reserved_tokens) values (p_org, v_uid, '', '', 'reserved', p_kind, p_request, v_est) returning id into v_id;
  return jsonb_build_object('allowed', true, 'usage_id', v_id, 'role', v_role);
end $$;

-- Settle a reservation with the real numbers (or release it on failure/cancel). Only the reserving user, only once.
create or replace function public.ai_settle(p_org uuid, p_usage uuid, p_provider text, p_model text, p_in integer, p_out integer, p_tools integer, p_status text, p_error text, p_ms integer, p_audio integer default null, p_conv uuid default null) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.ai_ctx(p_org);
  if p_status not in ('ok','error','cancelled') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  update public.ai_usage set provider = left(coalesce(p_provider, ''), 40), model = left(coalesce(p_model, ''), 80), input_tokens = least(greatest(coalesce(p_in, 0), 0), 200000), output_tokens = least(greatest(coalesce(p_out, 0), 0), 200000),
    tool_calls = least(greatest(coalesce(p_tools, 0), 0), 50), status = p_status, error = left(p_error, 500), latency_ms = p_ms, reserved_tokens = 0, audio_seconds = least(greatest(coalesce(p_audio, 0), 0), 3600),
    conversation_id = coalesce((select c.id from public.ai_conversations c where c.id = p_conv and c.organization_id = p_org and c.user_id = (select auth.uid())), conversation_id)
    where id = p_usage and organization_id = p_org and user_id = (select auth.uid()) and status = 'reserved';
end $$;

-- read-only view of the caller's numbers (includes open reservations)
create or replace function public.ai_budget(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); s public.ai_settings; v_org bigint; v_user bigint; v_month bigint; v_msgs int; v_role text := public.ai_ctx(p_org);
begin
  select * into s from public.ai_settings where organization_id = p_org;
  if not found then s.enabled := true; s.daily_token_limit := 300000; s.hourly_messages_per_user := 40; end if;
  select coalesce(sum(case when status = 'reserved' then reserved_tokens else input_tokens + output_tokens end), 0) into v_org from public.ai_usage where organization_id = p_org and created_at >= date_trunc('day', now()) and status <> 'blocked';
  select coalesce(sum(case when status = 'reserved' then reserved_tokens else input_tokens + output_tokens end), 0) into v_user from public.ai_usage where organization_id = p_org and user_id = v_uid and created_at >= date_trunc('day', now()) and status <> 'blocked';
  select coalesce(sum(case when status = 'reserved' then reserved_tokens else input_tokens + output_tokens end), 0) into v_month from public.ai_usage where organization_id = p_org and created_at >= date_trunc('month', now()) and status <> 'blocked';
  select count(*) into v_msgs from public.ai_usage where organization_id = p_org and user_id = v_uid and created_at > now() - interval '1 hour' and status <> 'blocked' and kind in ('chat','plan');
  return jsonb_build_object('allowed', s.enabled and v_org < s.daily_token_limit and v_msgs < s.hourly_messages_per_user and (s.monthly_token_limit is null or v_month < s.monthly_token_limit) and (s.per_user_daily_tokens is null or v_user < s.per_user_daily_tokens),
    'tokens_today', v_org, 'daily_limit', s.daily_token_limit, 'tokens_month', v_month, 'monthly_limit', s.monthly_token_limit, 'your_tokens_today', v_user, 'per_user_daily_limit', s.per_user_daily_tokens,
    'messages_last_hour', v_msgs, 'hourly_limit', s.hourly_messages_per_user, 'enabled', s.enabled, 'role', v_role);
end $$;

create or replace function public.ai_set_limits_v2(p_org uuid, p_enabled boolean, p_daily integer, p_hourly integer, p_monthly integer, p_per_user integer, p_in_price numeric, p_out_price numeric, p_currency text default 'USD') returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.ai_ctx(p_org) <> 'owner' then raise exception 'Only the owner can change AI limits.' using errcode = '42501'; end if;
  if p_daily not between 1000 and 5000000 or p_hourly not between 1 and 500 or (p_monthly is not null and p_monthly not between 1000 and 100000000) or (p_per_user is not null and p_per_user not between 1000 and 5000000)
     or (p_in_price is not null and p_in_price < 0) or (p_out_price is not null and p_out_price < 0) or coalesce(p_currency, 'USD') !~ '^[A-Z]{3}$' then raise exception 'Limits are out of range.' using errcode = '22023'; end if;
  if p_per_user is not null and p_per_user > p_daily then raise exception 'The per-user daily limit cannot exceed the organization daily limit.' using errcode = '22023'; end if;
  insert into public.ai_settings (organization_id, enabled, daily_token_limit, hourly_messages_per_user, monthly_token_limit, per_user_daily_tokens, input_price_per_mtok, output_price_per_mtok, price_currency)
    values (p_org, coalesce(p_enabled, true), p_daily, p_hourly, p_monthly, p_per_user, p_in_price, p_out_price, coalesce(p_currency, 'USD'))
    on conflict (organization_id) do update set enabled = excluded.enabled, daily_token_limit = excluded.daily_token_limit, hourly_messages_per_user = excluded.hourly_messages_per_user, monthly_token_limit = excluded.monthly_token_limit,
      per_user_daily_tokens = excluded.per_user_daily_tokens, input_price_per_mtok = excluded.input_price_per_mtok, output_price_per_mtok = excluded.output_price_per_mtok, price_currency = excluded.price_currency, updated_at = now();
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'ai.limits_changed', jsonb_build_object('enabled', p_enabled, 'daily', p_daily, 'hourly', p_hourly, 'monthly', p_monthly, 'per_user', p_per_user));
end $$;

-- owner-only usage history: per day, per user, per kind and status. Costs are ESTIMATES computed from prices the owner entered (never from the provider's invoice).
create or replace function public.ai_usage_summary(p_org uuid, p_days integer default 30) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_days integer := least(greatest(coalesce(p_days, 30), 1), 365); s public.ai_settings;
begin
  if public.ai_ctx(p_org) <> 'owner' then raise exception 'Only the owner can view AI usage.' using errcode = '42501'; end if;
  select * into s from public.ai_settings where organization_id = p_org;
  return jsonb_build_object(
    'prices', case when s.input_price_per_mtok is null and s.output_price_per_mtok is null then null else jsonb_build_object('input_per_mtok', s.input_price_per_mtok, 'output_per_mtok', s.output_price_per_mtok, 'currency', s.price_currency) end,
    'by_day', coalesce((select jsonb_agg(d order by d->>'day' desc) from (select jsonb_build_object('day', to_char(date_trunc('day', created_at), 'YYYY-MM-DD'), 'requests', count(*) filter (where status in ('ok','error','cancelled')), 'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0),
        'blocked', count(*) filter (where status = 'blocked'), 'errors', count(*) filter (where status = 'error'), 'audio_seconds', coalesce(sum(audio_seconds), 0)) d from public.ai_usage where organization_id = p_org and created_at >= now() - make_interval(days => v_days) group by date_trunc('day', created_at)) x), '[]'::jsonb),
    'by_user', coalesce((select jsonb_agg(u order by (u->>'tokens')::bigint desc) from (select jsonb_build_object('user_id', user_id, 'email', (select email from auth.users where id = a.user_id), 'requests', count(*) filter (where status in ('ok','error','cancelled')), 'tokens', coalesce(sum(input_tokens + output_tokens), 0), 'input_tokens', coalesce(sum(input_tokens), 0), 'output_tokens', coalesce(sum(output_tokens), 0)) u
        from public.ai_usage a where organization_id = p_org and created_at >= now() - make_interval(days => v_days) group by user_id) y), '[]'::jsonb),
    'by_kind', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from public.ai_usage where organization_id = p_org and created_at >= now() - make_interval(days => v_days) and status <> 'blocked' group by kind) z), '{}'::jsonb),
    'recent', coalesce((select jsonb_agg(r order by r->>'at' desc) from (select jsonb_build_object('at', created_at, 'user_id', user_id, 'kind', kind, 'status', status, 'model', model, 'input_tokens', input_tokens, 'output_tokens', output_tokens, 'tool_calls', tool_calls, 'error', error) r from public.ai_usage where organization_id = p_org order by created_at desc limit 50) w), '[]'::jsonb));
end $$;

-- ---------- (2) idempotent requests ----------
create table public.ai_requests (
  organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null, request_id uuid not null,
  status text not null check (status in ('running','done')), response jsonb check (response is null or octet_length(response::text) <= 60000),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), primary key (organization_id, user_id, request_id)
);
alter table public.ai_requests enable row level security; revoke all on public.ai_requests from anon, authenticated;
-- 'new': you own this request and must run it. 'running': another attempt is in flight (wait or retry later). 'done': here is the stored answer; do NOT run it again.
create or replace function public.ai_request_begin(p_org uuid, p_request uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); r public.ai_requests;
begin
  perform public.ai_ctx(p_org); perform pg_advisory_xact_lock(hashtext('airequest:' || p_org::text || p_request::text));
  select * into r from public.ai_requests where organization_id = p_org and user_id = v_uid and request_id = p_request;
  if not found then insert into public.ai_requests (organization_id, user_id, request_id, status) values (p_org, v_uid, p_request, 'running'); return jsonb_build_object('state', 'new'); end if;
  if r.status = 'done' then return jsonb_build_object('state', 'done', 'response', r.response); end if;
  if r.updated_at > now() - interval '2 minutes' then return jsonb_build_object('state', 'running'); end if;
  update public.ai_requests set updated_at = now() where organization_id = p_org and user_id = v_uid and request_id = p_request; return jsonb_build_object('state', 'new', 'takeover', true);
end $$;
create or replace function public.ai_request_finish(p_org uuid, p_request uuid, p_response jsonb) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.ai_ctx(p_org);
  update public.ai_requests set status = 'done', response = p_response, updated_at = now() where organization_id = p_org and user_id = (select auth.uid()) and request_id = p_request;
end $$;
-- a request that failed or was cancelled is released so the user can send it again
create or replace function public.ai_request_release(p_org uuid, p_request uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.ai_ctx(p_org);
  delete from public.ai_requests where organization_id = p_org and user_id = (select auth.uid()) and request_id = p_request and status = 'running';
end $$;
create or replace function public.ai_requests_prune() returns integer language sql security definer set search_path = '' as $$ with d as (delete from public.ai_requests where created_at < now() - interval '2 days' returning 1) select count(*)::int from d $$;
revoke all on function public.ai_requests_prune() from public, anon, authenticated;


-- ---------- (3) durable multi-step plans ----------
-- A plan is a list of dependent steps the assistant proposed in one conversation. Nothing is applied by proposing. Each step is accepted/rejected on its own; applying runs in two
-- explicit phases ("draft": save drafts; "publish": make them live), and every step's state is stored so a crash or a failed step can be resumed without repeating finished work.
create table public.ai_plans (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null, conversation_id uuid,
  title text not null check (char_length(title) between 1 and 160), summary text check (char_length(summary) <= 500), base_revision integer,
  status text not null default 'proposed' check (status in ('proposed','applying','drafted','applied','partially_applied','rejected','stale')),
  phase text check (phase in ('draft','publish')), lease_until timestamptz, run_options jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (id, organization_id)
);
create table public.ai_plan_steps (
  plan_id uuid not null, organization_id uuid not null, step_key text not null check (step_key ~ '^[a-z][a-z0-9_]{0,29}$'), ordinal integer not null,
  kind text not null check (kind in ('module','fields','layout','pipeline','ops_module','workflow','dashboard','role')), title text not null check (char_length(title) between 1 and 160),
  args jsonb not null check (octet_length(args::text) <= 40000), depends_on text[] not null default '{}',
  decision text not null default 'pending' check (decision in ('pending','accepted','rejected')),
  state text not null default 'pending' check (state in ('pending','drafted','applied','failed','skipped')), result jsonb, error text check (char_length(error) <= 500), attempts integer not null default 0, updated_at timestamptz not null default now(),
  primary key (plan_id, step_key), foreign key (plan_id, organization_id) references public.ai_plans (id, organization_id) on delete cascade
);
alter table public.ai_plans enable row level security; alter table public.ai_plan_steps enable row level security;
create policy ai_plans_read on public.ai_plans for select to authenticated using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy ai_plan_steps_read on public.ai_plan_steps for select to authenticated using (exists (select 1 from public.ai_plans p where p.id = plan_id and p.user_id = (select auth.uid())));
revoke all on public.ai_plans, public.ai_plan_steps from anon, authenticated; grant select on public.ai_plans, public.ai_plan_steps to authenticated;

create or replace function public.ai_plan_create(p_org uuid, p_conv uuid, p_title text, p_summary text, p_base_revision integer, p_steps jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid; s jsonb; v_keys text[] := '{}'; v_i int := 0; d text;
begin
  if public.ai_ctx(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can prepare configuration plans.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 or jsonb_typeof(p_steps) is distinct from 'array' or jsonb_array_length(p_steps) not between 1 and 12 then raise exception 'A plan has a title and 1 to 12 steps.' using errcode = '22023'; end if;
  if p_conv is not null and not exists (select 1 from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = v_uid) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if (select count(*) from public.ai_plans where organization_id = p_org and user_id = v_uid and status in ('proposed','drafted','partially_applied')) >= 10 then raise exception 'Too many open plans. Apply or dismiss some first.' using errcode = '22023'; end if;
  insert into public.ai_plans (organization_id, user_id, conversation_id, title, summary, base_revision) values (p_org, v_uid, p_conv, btrim(p_title), left(p_summary, 500), p_base_revision) returning id into v_id;
  for s in select * from jsonb_array_elements(p_steps) loop
    v_i := v_i + 1;
    if jsonb_typeof(s) <> 'object' or s->>'key' is null or s->>'key' !~ '^[a-z][a-z0-9_]{0,29}$' or s->>'key' = any(v_keys) then raise exception 'Step % has an invalid or duplicate key.', v_i using errcode = '22023'; end if;
    for d in select jsonb_array_elements_text(coalesce(s->'depends_on', '[]'::jsonb)) loop
      if not d = any(v_keys) then raise exception 'Step "%" depends on "%", which must be an EARLIER step.', s->>'key', d using errcode = '22023'; end if;
    end loop;
    insert into public.ai_plan_steps (plan_id, organization_id, step_key, ordinal, kind, title, args, depends_on) values (v_id, p_org, s->>'key', v_i, s->>'kind', left(btrim(coalesce(s->>'title', '')), 160), coalesce(s->'args', '{}'::jsonb),
      coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(s->'depends_on', '[]'::jsonb)) x), '{}'));
    v_keys := array_append(v_keys, s->>'key');
  end loop;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.plan_created', jsonb_build_object('plan_id', v_id, 'steps', v_i));
  return v_id;
end $$;

-- accept or reject one step. Accepting needs every dependency accepted; rejecting also rejects everything that depends on it. Only while the plan is still a proposal.
create or replace function public.ai_plan_decide(p_org uuid, p_plan uuid, p_step text, p_decision text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.ai_plans; st public.ai_plan_steps; v_changed text[] := '{}'; r record; v_more boolean := true;
begin
  perform public.ai_ctx(p_org);
  select * into p from public.ai_plans where id = p_plan and organization_id = p_org and user_id = v_uid for update; if not found then raise exception 'Plan not found.' using errcode = 'P0002'; end if;
  if p.status <> 'proposed' then raise exception 'This plan can no longer be changed here. Edit the drafts in the visual editors instead.' using errcode = '22023'; end if;
  if p_decision not in ('accepted','rejected','pending') then raise exception 'Invalid decision.' using errcode = '22023'; end if;
  select * into st from public.ai_plan_steps where plan_id = p_plan and step_key = p_step; if not found then raise exception 'Step not found.' using errcode = 'P0002'; end if;
  if p_decision = 'accepted' and exists (select 1 from public.ai_plan_steps where plan_id = p_plan and step_key = any(st.depends_on) and decision <> 'accepted') then
    raise exception 'Accept the steps this one depends on first (%).', array_to_string(st.depends_on, ', ') using errcode = '22023'; end if;
  update public.ai_plan_steps set decision = p_decision, updated_at = now() where plan_id = p_plan and step_key = p_step; v_changed := array[p_step];
  if p_decision <> 'accepted' then
    while v_more loop
      v_more := false;
      for r in select step_key from public.ai_plan_steps where plan_id = p_plan and decision <> p_decision and depends_on && v_changed and not (step_key = any(v_changed)) loop
        update public.ai_plan_steps set decision = p_decision, updated_at = now() where plan_id = p_plan and step_key = r.step_key; v_changed := array_append(v_changed, r.step_key); v_more := true; end loop;
    end loop;
  end if;
  update public.ai_plans set updated_at = now() where id = p_plan;
  return jsonb_build_object('changed', to_jsonb(v_changed));
end $$;

-- take the plan for a phase run. Only one runner at a time (a 3-minute lease; a crashed runner's lease simply expires, which is how recovery works).
create or replace function public.ai_plan_begin(p_org uuid, p_plan uuid, p_phase text, p_options jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.ai_plans;
begin
  if public.ai_ctx(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can apply plans.' using errcode = '42501'; end if;
  if p_phase not in ('draft','publish') then raise exception 'Invalid phase.' using errcode = '22023'; end if;
  select * into p from public.ai_plans where id = p_plan and organization_id = p_org and user_id = v_uid for update; if not found then raise exception 'Plan not found.' using errcode = 'P0002'; end if;
  if p.status = 'applying' and p.lease_until > now() then return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
  if p.status in ('applied','rejected','stale') then return jsonb_build_object('ok', false, 'reason', p.status); end if;
  if p_phase = 'draft' and p.status not in ('proposed','partially_applied','applying') then return jsonb_build_object('ok', false, 'reason', 'wrong_state'); end if;
  if p_phase = 'publish' and p.status not in ('drafted','partially_applied','applying') then return jsonb_build_object('ok', false, 'reason', 'wrong_state'); end if;
  if p_phase = 'draft' and not exists (select 1 from public.ai_plan_steps where plan_id = p_plan and decision = 'accepted') then return jsonb_build_object('ok', false, 'reason', 'nothing_accepted'); end if;
  update public.ai_plans set status = 'applying', phase = p_phase, lease_until = now() + interval '3 minutes', run_options = coalesce(p_options, '{}'::jsonb), updated_at = now() where id = p_plan;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.plan_' || p_phase || '_started', jsonb_build_object('plan_id', p_plan));
  return jsonb_build_object('ok', true, 'base_revision', p.base_revision);
end $$;
create or replace function public.ai_plan_step_set(p_org uuid, p_plan uuid, p_step text, p_state text, p_result jsonb, p_error text) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.ai_ctx(p_org);
  if p_state not in ('pending','drafted','applied','failed','skipped') then raise exception 'Invalid state.' using errcode = '22023'; end if;
  update public.ai_plan_steps s set state = p_state, result = coalesce(p_result, s.result), error = left(p_error, 500), attempts = s.attempts + case when p_state in ('drafted','applied','failed') then 1 else 0 end, updated_at = now()
    where s.plan_id = p_plan and s.organization_id = p_org and s.step_key = p_step and exists (select 1 from public.ai_plans p where p.id = p_plan and p.user_id = (select auth.uid()));
  update public.ai_plans set lease_until = now() + interval '3 minutes' where id = p_plan and user_id = (select auth.uid()) and status = 'applying';
end $$;
create or replace function public.ai_plan_end(p_org uuid, p_plan uuid, p_status text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  perform public.ai_ctx(p_org);
  if p_status not in ('proposed','drafted','applied','partially_applied','rejected','stale') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  update public.ai_plans set status = p_status, lease_until = null, updated_at = now() where id = p_plan and organization_id = p_org and user_id = v_uid and status in ('applying','proposed','drafted','partially_applied');
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.plan_' || p_status, jsonb_build_object('plan_id', p_plan));
end $$;

-- ---------- (4) operation proposals: confirmed lead updates, assignment and tasks (never money, messages or stock) ----------
alter table public.ai_proposals drop constraint if exists ai_proposals_kind_check;
alter table public.ai_proposals add constraint ai_proposals_kind_check check (kind in ('module_config','workflow','dashboard','operation'));
create or replace function public.ai_create_proposal(p_org uuid, p_conv uuid, p_kind text, p_title text, p_payload jsonb, p_base_revision integer) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid; v_role text := public.ai_ctx(p_org);
begin
  if p_kind not in ('module_config','workflow','dashboard','operation') or char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 then raise exception 'Invalid proposal.' using errcode = '22023'; end if;
  -- configuration proposals need owner/admin; an operation proposal is only a request the member confirms and that runs with THEIR own permissions
  if p_kind <> 'operation' and v_role not in ('owner','admin') then raise exception 'Only owners and admins can change the workspace configuration, automations or dashboards through the assistant.' using errcode = '42501'; end if;
  if p_kind = 'operation' and (p_payload->>'op') not in ('update_lead','assign_lead','create_task') then raise exception 'That operation is not supported through the assistant.' using errcode = '22023'; end if;
  if p_conv is not null and not exists (select 1 from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = v_uid) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if (select count(*) from public.ai_proposals where organization_id = p_org and user_id = v_uid and status = 'pending') >= 20 then raise exception 'Too many pending proposals. Apply or dismiss some first.' using errcode = '22023'; end if;
  insert into public.ai_proposals (organization_id, user_id, conversation_id, kind, title, payload, base_revision) values (p_org, v_uid, p_conv, p_kind, btrim(p_title), p_payload, p_base_revision) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.proposal_created', jsonb_build_object('proposal_id', v_id, 'kind', p_kind));
  return v_id;
end $$;
create or replace function public.ai_set_proposal_status(p_org uuid, p_proposal uuid, p_status text, p_result jsonb, p_workflow uuid default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.ai_proposals; v_role text := public.ai_ctx(p_org);
begin
  select * into p from public.ai_proposals where id = p_proposal and organization_id = p_org;
  if found and p.kind <> 'operation' and v_role not in ('owner','admin') then raise exception 'Only owners and admins can apply proposals.' using errcode = '42501'; end if;
  if not v_role in ('owner','admin') and not found then raise exception 'Only owners and admins can apply proposals.' using errcode = '42501'; end if;
  select * into p from public.ai_proposals where id = p_proposal and organization_id = p_org and user_id = v_uid for update;
  if not found then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  if p.created_at < now() - interval '7 days' and p.status = 'pending' then raise exception 'This proposal is older than 7 days. Ask for it again.' using errcode = '22023'; end if;
  if not ((p.kind in ('dashboard','operation') and p.status = 'pending' and p_status in ('published','rejected')) or (p.kind not in ('dashboard','operation') and p.status = 'pending' and p_status in ('draft_saved','rejected')) or (p.status = 'draft_saved' and p_status in ('published','rejected') and p.kind = 'module_config')
       or (p.status = 'draft_saved' and p_status in ('published','published_disabled','rejected') and p.kind = 'workflow')) then
    raise exception 'This proposal cannot move from % to %.', p.status, p_status using errcode = '22023'; end if;
  update public.ai_proposals set status = p_status, result = coalesce(p_result, result), workflow_id = coalesce(p_workflow, workflow_id), decided_at = now() where id = p_proposal;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.proposal_' || p_status, jsonb_build_object('proposal_id', p_proposal, 'kind', p.kind));
end $$;

-- ---------- (7) unfinished visual workflows: stored apart from drafts, never publishable ----------
create table public.automation_wip (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, workflow_id uuid,
  name text not null check (char_length(name) between 1 and 80), graph jsonb not null check (jsonb_typeof(graph) = 'object' and octet_length(graph::text) <= 65536),
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (workflow_id, organization_id) references public.automation_workflows (id, organization_id) on delete cascade
);
create index automation_wip_user_idx on public.automation_wip (organization_id, created_by, updated_at desc);
alter table public.automation_wip enable row level security; revoke all on public.automation_wip from anon, authenticated; grant select on public.automation_wip to authenticated;
create policy automation_wip_read on public.automation_wip for select to authenticated using (created_by = (select auth.uid()) and public.org_role(organization_id) in ('owner','admin'));
-- Shape check only. The graph is NEVER read by the engine; to run, a workflow still has to be a valid draft (automation_save_draft / automation_save_visual) and be published.
create or replace function public.automation_wip_save(p_org uuid, p_id uuid, p_workflow uuid, p_name text, p_graph jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid := p_id; n jsonb; e jsonb;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'Name the automation (up to 80 characters).' using errcode = '22023'; end if;
  if jsonb_typeof(p_graph) is distinct from 'object' or jsonb_typeof(p_graph->'nodes') is distinct from 'array' or jsonb_typeof(p_graph->'edges') is distinct from 'array' or jsonb_array_length(p_graph->'nodes') > 60 or jsonb_array_length(p_graph->'edges') > 120 or octet_length(p_graph::text) > 65536 then
    raise exception 'The unfinished workflow is invalid or too large.' using errcode = '22023'; end if;
  for n in select * from jsonb_array_elements(p_graph->'nodes') loop
    if jsonb_typeof(n) <> 'object' or n->>'id' !~ '^[a-z0-9_-]{1,24}$' or n->>'kind' not in ('trigger','condition','action','delay') then raise exception 'The unfinished workflow is invalid.' using errcode = '22023'; end if; end loop;
  for e in select * from jsonb_array_elements(p_graph->'edges') loop
    if jsonb_typeof(e) <> 'object' or e->>'from' !~ '^[a-z0-9_-]{1,24}$' or e->>'to' !~ '^[a-z0-9_-]{1,24}$' then raise exception 'The unfinished workflow is invalid.' using errcode = '22023'; end if; end loop;
  if p_workflow is not null and not exists (select 1 from public.automation_workflows where id = p_workflow and organization_id = p_org) then raise exception 'Automation not found.' using errcode = 'P0002'; end if;
  if v_id is null then
    if (select count(*) from public.automation_wip where organization_id = p_org and created_by = v_uid) >= 30 then raise exception 'At most 30 unfinished workflows.' using errcode = '22023'; end if;
    insert into public.automation_wip (organization_id, workflow_id, name, graph, created_by) values (p_org, p_workflow, btrim(p_name), p_graph, v_uid) returning id into v_id;
  else
    update public.automation_wip set name = btrim(p_name), graph = p_graph, workflow_id = p_workflow, updated_at = now() where id = v_id and organization_id = p_org and created_by = v_uid;
    if not found then raise exception 'Unfinished workflow not found.' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end $$;
create or replace function public.automation_wip_delete(p_org uuid, p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can manage automations.' using errcode = '42501'; end if;
  delete from public.automation_wip where id = p_id and organization_id = p_org and created_by = (select auth.uid());
end $$;

-- ---------- (6) AI onboarding (before any organization exists): a per-user daily gate ----------
create table public.ai_onboarding_usage (id uuid primary key default gen_random_uuid(), user_id uuid not null, input_tokens integer not null default 0, output_tokens integer not null default 0, status text not null default 'reserved' check (status in ('reserved','ok','error','cancelled')), created_at timestamptz not null default now());
create index ai_onboarding_usage_idx on public.ai_onboarding_usage (user_id, created_at desc);
alter table public.ai_onboarding_usage enable row level security; revoke all on public.ai_onboarding_usage from anon, authenticated;
create or replace function public.ai_onboarding_reserve(p_daily_calls integer default 30) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_n int; v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  perform pg_advisory_xact_lock(hashtext('aionb:' || v_uid::text));
  update public.ai_onboarding_usage set status = 'error' where user_id = v_uid and status = 'reserved' and created_at < now() - interval '10 minutes';
  select count(*) into v_n from public.ai_onboarding_usage where user_id = v_uid and created_at >= date_trunc('day', now());
  if v_n >= least(greatest(p_daily_calls, 1), 100) then return jsonb_build_object('allowed', false, 'reason', 'You reached today''s limit for AI setup help. You can still set up your workspace by hand.'); end if;
  insert into public.ai_onboarding_usage (user_id) values (v_uid) returning id into v_id; return jsonb_build_object('allowed', true, 'id', v_id);
end $$;
create or replace function public.ai_onboarding_settle(p_id uuid, p_in integer, p_out integer, p_status text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('ok','error','cancelled') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  update public.ai_onboarding_usage set input_tokens = least(greatest(coalesce(p_in, 0), 0), 200000), output_tokens = least(greatest(coalesce(p_out, 0), 0), 200000), status = p_status where id = p_id and user_id = (select auth.uid()) and status = 'reserved';
end $$;

-- ---------- (9) pipeline history is kept ----------
alter table public.workspace_configuration_versions add column if not exists applied_stage_moves jsonb;

create or replace function public.publish_workspace_config(p_org uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_draft public.workspace_configuration_versions; v_stage text; v_n bigint; mv jsonb; v_moved jsonb := '[]'::jsonb; v_cnt integer;
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can edit the workspace configuration.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('ws:' || p_org::text));
  select * into v_draft from public.workspace_configuration_versions where organization_id = p_org and status = 'draft' for update;
  if not found then raise exception 'There is no saved draft to publish.' using errcode = '22023'; end if;
  perform public.validate_workspace_definition(v_draft.definition);
  perform public.workspace_check_data_protection(p_org, v_draft.definition);
  for mv in select * from jsonb_array_elements(coalesce(v_draft.definition #> '{pipeline,stageMoves}', '[]'::jsonb)) loop
    with moved as (update public.leads set stage = mv->>'to', updated_at = now() where organization_id = p_org and stage = mv->>'from' returning id)
    insert into public.lead_activities (organization_id, lead_id, actor_id, kind, body, meta)
      select p_org, id, (select auth.uid()), 'stage_changed', null, jsonb_build_object('from', mv->>'from', 'to', mv->>'to', 'reason', 'pipeline_migration', 'revision', v_draft.revision) from moved;
    get diagnostics v_cnt = row_count;
    v_moved := v_moved || jsonb_build_array(jsonb_build_object('from', mv->>'from', 'to', mv->>'to', 'leads', v_cnt));
  end loop;
  select l.stage, count(*) into v_stage, v_n from public.leads l
    where l.organization_id = p_org and not coalesce(v_draft.definition#>'{pipeline,stages}' @> to_jsonb(l.stage), false)
    group by l.stage order by count(*) desc limit 1;
  if v_stage is not null then
    raise exception '% lead(s) are still in the stage "%", which the new pipeline removes. Move them to another stage first, or plan the move in the Pipeline builder.', v_n, v_stage using errcode = '22023'; end if;
  -- the plan is removed from the definition (so it cannot be re-applied) but kept, with its lead counts, on the version row as permanent history
  update public.workspace_configuration_versions set definition = definition #- '{pipeline,stageMoves}', applied_stage_moves = case when jsonb_array_length(v_moved) > 0 then v_moved end where id = v_draft.id;
  update public.workspace_configuration_versions set status = 'archived' where organization_id = p_org and status = 'published';
  update public.workspace_configuration_versions set status = 'published' where id = v_draft.id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'workspace.published', jsonb_build_object('revision', v_draft.revision, 'stage_moves', v_moved));
  perform public.crm_emit(p_org, 'workspace.published', 'workspace', p_org, jsonb_build_object('revision', v_draft.revision));
  return v_draft.revision;
end $$;

-- ---------- (8) lead merging: no oracle, no overwriting contacts the caller cannot see ----------
create or replace function public.contact_known_to_caller(p_contact uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (select 1 from public.leads l where l.contact_id = p_contact and public.can_see_lead(l.organization_id, l.assigned_to) and public.perm_ok(l.organization_id, 'leads', 'view') and public.perm_scope_ok(l.organization_id, 'leads', l.assigned_to, l.created_by));
$$;
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
    elsif v_other is not null and v_other <> v_contact then
      if v_role not in ('owner','admin','manager') then raise exception 'This phone number or email may already belong to an existing contact. Ask a manager to add the lead.' using errcode = '22023'; end if;
      raise exception 'That phone number and email belong to two different contacts.' using errcode = '23505'; end if;
  end if;
  -- A caller who cannot already see this contact must not be able to learn who it is, fill in its details, or attach themselves to it: they get one neutral refusal.
  -- Managers, admins and owners keep the original reuse behaviour.
  if v_contact is not null and v_role not in ('owner','admin','manager') and not public.contact_known_to_caller(v_contact) then
    raise exception 'This phone number or email may already belong to an existing contact. Ask a manager to add the lead.' using errcode = '22023'; end if;
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
  if public.crm_member_role(p_org) in ('owner','admin','manager') then raise exception 'A contact with that phone number or email already exists.' using errcode = '23505'; end if;
  raise exception 'This phone number or email may already belong to an existing contact. Ask a manager to add the lead.' using errcode = '22023';
end $$;

revoke all on function public.ai_reserve(uuid, uuid, integer, text), public.ai_settle(uuid, uuid, text, text, integer, integer, integer, text, text, integer, integer, uuid), public.ai_set_limits_v2(uuid, boolean, integer, integer, integer, integer, numeric, numeric, text), public.ai_usage_summary(uuid, integer),
  public.ai_request_begin(uuid, uuid), public.ai_request_finish(uuid, uuid, jsonb), public.ai_request_release(uuid, uuid), public.ai_plan_create(uuid, uuid, text, text, integer, jsonb), public.ai_plan_decide(uuid, uuid, text, text), public.ai_plan_begin(uuid, uuid, text, jsonb),
  public.ai_plan_step_set(uuid, uuid, text, text, jsonb, text), public.ai_plan_end(uuid, uuid, text), public.automation_wip_save(uuid, uuid, uuid, text, jsonb), public.automation_wip_delete(uuid, uuid), public.ai_onboarding_reserve(integer), public.ai_onboarding_settle(uuid, integer, integer, text),
  public.contact_known_to_caller(uuid) from public, anon;
grant execute on function public.ai_reserve(uuid, uuid, integer, text), public.ai_settle(uuid, uuid, text, text, integer, integer, integer, text, text, integer, integer, uuid), public.ai_set_limits_v2(uuid, boolean, integer, integer, integer, integer, numeric, numeric, text), public.ai_usage_summary(uuid, integer),
  public.ai_request_begin(uuid, uuid), public.ai_request_finish(uuid, uuid, jsonb), public.ai_request_release(uuid, uuid), public.ai_plan_create(uuid, uuid, text, text, integer, jsonb), public.ai_plan_decide(uuid, uuid, text, text), public.ai_plan_begin(uuid, uuid, text, jsonb),
  public.ai_plan_step_set(uuid, uuid, text, text, jsonb, text), public.ai_plan_end(uuid, uuid, text), public.automation_wip_save(uuid, uuid, uuid, text, jsonb), public.automation_wip_delete(uuid, uuid), public.ai_onboarding_reserve(integer), public.ai_onboarding_settle(uuid, integer, integer, text) to authenticated;
revoke all on function public.contact_known_to_caller(uuid) from authenticated;

-- read one of the caller's plans with its steps (invoker: the table policies decide)
create or replace function public.ai_plan_get(p_org uuid, p_plan uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare p public.ai_plans;
begin
  select * into p from public.ai_plans where id = p_plan and organization_id = p_org; if not found then raise exception 'Plan not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('plan', jsonb_build_object('id', p.id, 'title', p.title, 'summary', p.summary, 'status', p.status, 'phase', p.phase, 'base_revision', p.base_revision, 'run_options', p.run_options, 'created_at', p.created_at),
    'steps', coalesce((select jsonb_agg(jsonb_build_object('key', s.step_key, 'kind', s.kind, 'title', s.title, 'args', s.args, 'depends_on', to_jsonb(s.depends_on), 'decision', s.decision, 'state', s.state, 'result', s.result, 'error', s.error, 'attempts', s.attempts) order by s.ordinal) from public.ai_plan_steps s where s.plan_id = p.id), '[]'::jsonb));
end $$;
revoke all on function public.ai_plan_get(uuid, uuid) from public, anon; grant execute on function public.ai_plan_get(uuid, uuid) to authenticated;

-- Partial lead update used by confirmed assistant operations: only the supplied fields change; phone and email are never touched (so hidden contact details cannot be disturbed).
create or replace function public.crm_patch_lead(p_org uuid, p_lead uuid, p_full_name text default null, p_source text default null, p_summary text default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_lead public.leads := public.crm_lock_lead(p_org, p_lead, public.crm_member_role(p_org)); v_c public.contacts; v_changed text[] := '{}'; v_name text; v_source text; v_summary text;
begin
  select * into v_c from public.contacts where id = v_lead.contact_id;
  if p_full_name is not null then v_name := public.crm_norm_name(p_full_name); if v_c.full_name is distinct from v_name then v_changed := array_append(v_changed, 'name'); end if; end if;
  if p_source is not null then v_source := public.crm_norm_source(p_source); if v_lead.source is distinct from v_source then v_changed := array_append(v_changed, 'source'); end if; end if;
  if p_summary is not null then v_summary := public.crm_norm_text(p_summary, 2000, 'Summary'); if v_lead.summary is distinct from v_summary then v_changed := array_append(v_changed, 'summary'); end if; end if;
  if cardinality(v_changed) = 0 then return; end if;
  if v_name is not null then update public.contacts set full_name = v_name, updated_at = now() where id = v_c.id; end if;
  update public.leads set source = coalesce(v_source, source), summary = case when p_summary is not null then v_summary else summary end where id = p_lead;
  perform public.crm_log(p_org, p_lead, 'updated', null, jsonb_build_object('fields', to_jsonb(v_changed), 'via', 'assistant'));
  perform public.crm_emit(p_org, 'lead.updated', 'lead', p_lead, jsonb_build_object('fields', to_jsonb(v_changed)));
end $$;
revoke all on function public.crm_patch_lead(uuid, uuid, text, text, text) from public, anon; grant execute on function public.crm_patch_lead(uuid, uuid, text, text, text) to authenticated;

-- team member lookup by exact email for assistant proposals (members of the same organization only; no listing)
create or replace function public.ai_resolve_member(p_org uuid, p_email text) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r record;
begin
  perform public.ai_ctx(p_org);
  select m.user_id, u.email::text e into r from public.organization_members m join auth.users u on u.id = m.user_id where m.organization_id = p_org and lower(u.email::text) = lower(btrim(coalesce(p_email, ''))) and m.active;
  if not found then return null; end if;
  return jsonb_build_object('user_id', r.user_id, 'email', r.e);
end $$;
revoke all on function public.ai_resolve_member(uuid, text) from public, anon; grant execute on function public.ai_resolve_member(uuid, text) to authenticated;

-- ---------- H: custom phone/email fields and invoice contact details become real permissions ----------
create or replace function public.role_validate(p_base text, p_perms jsonb, p_scopes jsonb) returns void language plpgsql immutable set search_path = '' as $$
declare m text; a text; v jsonb;
begin
  if p_base not in ('admin','manager','employee') then raise exception 'A role is based on admin, manager or employee.' using errcode = '22023'; end if;
  if jsonb_typeof(p_perms) is distinct from 'object' or jsonb_typeof(p_scopes) is distinct from 'object' then raise exception 'Invalid role permissions.' using errcode = '22023'; end if;
  for m, v in select key, value from jsonb_each(p_perms) loop
    if m !~ '^(leads|contacts|billing_contacts|tasks|appointments|inventory|billing|dashboards|reports|integrations|automations|team|custom:[a-z0-9]+(-[a-z0-9]+)*)$' or jsonb_typeof(v) is distinct from 'object' then raise exception 'Unknown module "%" in role permissions.', m using errcode = '22023'; end if;
    for a, v in select key, value from jsonb_each(p_perms->m) loop
      if a not in ('view','create','edit','archive','export','assign','approve') or jsonb_typeof(v) is distinct from 'boolean' or (m in ('contacts','billing_contacts') and a <> 'view') then raise exception 'Invalid permission "%.%".', m, a using errcode = '22023'; end if;
      if v::text::boolean and not public.perm_default(p_base, m, a) then raise exception 'A role based on % cannot be granted "%" in "%": custom roles can only narrow their base role.', p_base, a, m using errcode = '22023'; end if;
    end loop;
  end loop;
  for m, v in select key, value from jsonb_each(p_scopes) loop
    if m !~ '^(leads|tasks|appointments|billing|custom:[a-z0-9]+(-[a-z0-9]+)*)$' or jsonb_typeof(v) is distinct from 'string' or (v #>> '{}') not in ('all','team','assigned','own') then raise exception 'Invalid visibility for "%".', m using errcode = '22023'; end if;
  end loop;
end $$;

-- Invoice contact details (the billed customer's phone and email inside the frozen snapshot) need their own permission: module "billing_contacts", action "view".
-- Every base role that can see invoices keeps it unless a custom role turns it off.
create or replace function public.invoice_snapshot_masked(p_org uuid, p_snapshot jsonb) returns jsonb language sql stable security definer set search_path = '' as $$
  select case when p_snapshot is null then null when public.perm_ok(p_org, 'billing_contacts', 'view') then p_snapshot
    else jsonb_set(p_snapshot, '{bill_to}', coalesce(p_snapshot->'bill_to', '{}'::jsonb) - 'phone' - 'email') end;
$$;
create or replace function public.invoice_snapshot(p_org uuid, p_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare i public.invoices;
begin
  if public.crm_member_role(p_org) not in ('owner','admin','manager') or not public.perm_ok(p_org, 'billing', 'view') then raise exception 'Only owners, admins and managers can view invoices.' using errcode = '42501'; end if;
  select * into i from public.invoices where id = p_id and organization_id = p_org;
  if not found or not public.perm_scope_ok(p_org, 'billing', null, i.created_by) then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  return public.invoice_snapshot_masked(p_org, i.snapshot);
end $$;
create or replace function public.invoice_pdf_access(p_org uuid, p_id uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_role text := public.crm_member_role(p_org); i public.invoices;
begin
  if v_role not in ('owner','admin','manager') or not public.perm_ok(p_org, 'billing', 'view') then raise exception 'Only owners, admins and managers can download invoices.' using errcode = '42501'; end if;
  select * into i from public.invoices where id = p_id and organization_id = p_org;
  if not found or i.status <> 'issued' or not public.perm_scope_ok(p_org, 'billing', null, i.created_by) then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'invoice.pdf_downloaded', jsonb_build_object('invoice_id', i.id, 'number', i.number));
  return jsonb_build_object('number', i.number, 'snapshot', public.invoice_snapshot_masked(p_org, i.snapshot));
end $$;

-- Custom-module phone and email values live inside records.data. Clients can no longer read the raw column (nor search_text, which is built from it); they read the
-- records_view model, whose data/search_text come from record_data_for(): the same row visibility as the table policies, with phone- and email-kind fields removed for anyone
-- whose role lacks "contacts: view". Analytics and the assistant read the view too (their source definitions are rewritten below), so every path is covered.
create or replace function public.record_data_for(p_id uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.records; v jsonb; f jsonb; v_def jsonb;
begin
  select * into r from public.records where id = p_id; if not found then return null; end if;
  if (select auth.uid()) is null or not public.is_org_member(r.organization_id) or not public.perm_ok(r.organization_id, 'custom:' || r.object_key, 'view')
     or not public.perm_scope_ok(r.organization_id, 'custom:' || r.object_key, null, r.created_by) then return null; end if;
  v := r.data;
  if not public.perm_ok(r.organization_id, 'contacts', 'view') then
    select c.definition into v_def from public.workspace_configuration_versions c where c.organization_id = r.organization_id and c.status = 'published' order by c.revision desc limit 1;
    for f in select e.value from jsonb_array_elements(coalesce((select o.value->'fields' from jsonb_array_elements(coalesce(v_def->'objects', '[]'::jsonb)) o where o.value->>'key' = r.object_key), '[]'::jsonb)) e loop
      if f->>'kind' in ('phone','email') then v := v - (f->>'key'); end if;
    end loop;
  end if;
  return v;
end $$;
create or replace function public.record_search_for(p_id uuid) returns text language sql stable security definer set search_path = '' as $$
  select case when public.record_data_for(p_id) is null then null else public.record_search_text(public.record_data_for(p_id)) end;
$$;
create view public.records_view with (security_invoker = true) as
  select r.id, r.organization_id, r.object_key, r.config_revision, r.created_by, r.updated_by, r.created_at, r.updated_at, public.record_data_for(r.id) as data, public.record_search_for(r.id) as search_text from public.records r;
revoke all on public.records_view from anon, authenticated; grant select on public.records_view to authenticated;
revoke all on function public.record_data_for(uuid), public.record_search_for(uuid), public.invoice_snapshot_masked(uuid, jsonb), public.invoice_snapshot(uuid, uuid) from public, anon;
grant execute on function public.record_data_for(uuid), public.record_search_for(uuid), public.invoice_snapshot_masked(uuid, jsonb), public.invoice_snapshot(uuid, uuid) to authenticated;

do $$
declare d text; r record; cols text;
begin
  -- 1. column-level privileges: the raw personal-data-bearing columns are no longer readable by clients
  select string_agg(quote_ident(column_name), ', ') into cols from information_schema.columns where table_schema = 'public' and table_name = 'records' and column_name not in ('data', 'search_text');
  execute 'revoke select on public.records from authenticated'; execute format('grant select (%s) on public.records to authenticated', cols);
  select string_agg(quote_ident(column_name), ', ') into cols from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name <> 'snapshot';
  execute 'revoke select on public.invoices from authenticated'; execute format('grant select (%s) on public.invoices to authenticated', cols);
  -- 2. the two invoker functions that read records.data now read the view (identical output; masking comes from the view)
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'analytics_source_info';
  if position('public.records t' in d) = 0 then raise exception 'analytics_source_info changed shape; update 0018'; end if;
  execute replace(d, 'public.records t', 'public.records_view t');
  select pg_get_functiondef(p.oid) into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'ai_tool_list_module_records';
  if position('from public.records where organization_id = p_org and object_key = p_module' in d) = 0 then raise exception 'ai_tool_list_module_records changed shape; update 0018'; end if;
  execute replace(d, 'from public.records where organization_id = p_org and object_key = p_module', 'from public.records_view where organization_id = p_org and object_key = p_module');
end $$;
