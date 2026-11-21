-- 0009: AI Assistant + hardening. 0001-0008 are untouched (functions from 0008 are replaced with CREATE OR REPLACE).
--
-- Part 1: deterministic ordering. lead_activities.created_at can tie (several writes in one clock tick), which made "history order" tests and screens
--   nondeterministic. A monotonic identity column (seq) is now the tie-breaker everywhere activities are listed.
-- Part 2: Website Forms hardening. (a) The credential in the URL (?key=) is refused unless the owner enabled it per connection (config.allow_query_key).
--   (b) Invalid contact details are never promoted to a contact: they stay in the lead summary, clearly labelled unverified and flagged in lead_attribution;
--   the display name is no longer derived from a phone number or the local part of an email address.
alter table public.lead_activities add column if not exists seq bigint generated always as identity;
create index if not exists lead_activities_lead_seq_idx on public.lead_activities (lead_id, created_at desc, seq desc);

create or replace function public.integration_submit(p_conn public.integration_connections, p_fields jsonb, p_meta jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := public.integration_map_fields(p_conn.id, p_fields); v_org uuid := p_conn.organization_id;
  v_source text := case p_conn.provider when 'website_forms' then 'website' when 'meta_lead_ads' then 'meta_ads' else 'other' end;
  v_name text; v_phone text; v_email text; v_summary text := m->>'summary'; v_warn jsonb := '[]'::jsonb; v_contact uuid; v_other uuid; v_lead uuid; v_stage text := public.crm_stages(v_org)->>0;
begin
  begin v_phone := public.crm_norm_phone(m->>'phone');
  exception when others then v_warn := v_warn || to_jsonb('The phone number was not valid and was kept in the summary.'::text); v_summary := coalesce(v_summary || E'\n', '') || 'Phone (not a valid number, unverified): ' || left(m->>'phone', 40); end;
  begin v_email := public.crm_norm_email(m->>'email');
  exception when others then v_warn := v_warn || to_jsonb('The email address was not valid and was kept in the summary.'::text); v_summary := coalesce(v_summary || E'\n', '') || 'Email (not a valid address, unverified): ' || left(m->>'email', 80); end;
  if v_phone is null and v_email is null then return jsonb_build_object('status', 'rejected', 'reason', 'A valid phone number or email address is required to create a lead.'); end if;
  begin v_name := public.crm_norm_name(coalesce(m->>'full_name', 'Unnamed ' || case p_conn.provider when 'meta_lead_ads' then 'Meta' else 'website' end || ' lead'));
  exception when others then v_name := public.crm_norm_name(left(coalesce(m->>'full_name', 'Unnamed lead'), 120)); end;
  v_summary := nullif(left(btrim(coalesce(v_summary, '')), 2000), '');
  if v_stage is null then return jsonb_build_object('status', 'rejected', 'reason', 'The workspace has no lead pipeline.'); end if;

  if v_phone is not null then select id into v_contact from public.contacts where organization_id = v_org and phone = v_phone; end if;
  if v_email is not null then
    select id into v_other from public.contacts where organization_id = v_org and email = v_email;
    if v_contact is null then v_contact := v_other; elsif v_other is not null and v_other <> v_contact then v_other := null; v_email := null; end if; -- two different contacts: keep the phone match
  end if;
  if v_contact is null then insert into public.contacts (organization_id, full_name, phone, email, created_by) values (v_org, v_name, v_phone, v_email, p_conn.id) returning id into v_contact;
  else update public.contacts set phone = coalesce(phone, v_phone), email = coalesce(email, v_email), updated_at = now() where id = v_contact; end if;
  insert into public.leads (organization_id, contact_id, stage, source, summary, assigned_to, created_by) values (v_org, v_contact, v_stage, v_source, v_summary, null, p_conn.id) returning id into v_lead;
  insert into public.lead_activities (organization_id, lead_id, actor_id, kind, meta) values (v_org, v_lead, p_conn.id, 'created', jsonb_build_object('stage', v_stage, 'source', v_source, 'integration', p_conn.provider, 'connection_id', p_conn.id));
  insert into public.lead_attribution (lead_id, organization_id, connection_id, provider, utm, referrer, page_url, user_agent, extra)
    values (v_lead, v_org, p_conn.id, p_conn.provider, m->'utm', left(p_meta->>'referrer', 500), left(coalesce(p_meta->>'page_url', p_fields->>'page_url'), 500), left(p_meta->>'user_agent', 300), m->'extra' || coalesce(p_meta->'provider', '{}'::jsonb) || case when jsonb_array_length(v_warn) > 0 then jsonb_build_object('contact_unverified', true) else '{}'::jsonb end);
  perform public.crm_emit(v_org, 'lead.created', 'lead', v_lead, jsonb_build_object('contact_id', v_contact, 'stage', v_stage, 'source', v_source, 'assigned_to', null, 'integration', p_conn.provider, 'connection_id', p_conn.id));
  return jsonb_build_object('status', 'created', 'lead_id', v_lead, 'warnings', v_warn);
end $$;

create or replace function public.integration_ingest_form(p_public_id text, p_secret text, p_payload jsonb, p_idem text, p_meta jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c public.integration_connections; v_hash text; v_key text := nullif(btrim(coalesce(p_idem, '')), ''); v_ev uuid; v_res jsonb; v_dup record; v_fail int;
begin
  if coalesce(p_public_id, '') !~ '^[a-z0-9]{16}$' or coalesce(p_secret, '') = '' or char_length(p_secret) > 200 then return jsonb_build_object('status', 'unauthorized'); end if;
  select coalesce(sum(n), 0) into v_fail from public.integration_rate_limits where key = 'fail:' || p_public_id and window_start = date_trunc('minute', now());
  if v_fail > 20 then return jsonb_build_object('status', 'rate_limited', 'reason', 'Too many failed attempts. Try again in a minute.'); end if;
  select * into c from public.integration_connections where public_id = p_public_id and provider = 'website_forms';
  if not found or c.secret_hash is null or c.secret_hash <> public.integration_sha256(p_secret) then
    perform public.integration_hit('fail:' || p_public_id, 1000000); -- counted; the check above throttles guessing
    if found then perform public.integration_log_error(c.organization_id, c.id, 'website_forms', 'invalid_credentials', 'A submission was refused: wrong or revoked credential.', '{}'::jsonb); end if;
    return jsonb_build_object('status', 'unauthorized');
  end if;
  -- a credential in the URL leaks into proxy/server logs and browser history: refused unless the owner explicitly enabled it for this connection
  if p_meta->>'credential_source' = 'query' and not coalesce((c.config->>'allow_query_key')::boolean, false) then
    return jsonb_build_object('status', 'unauthorized', 'reason', 'This connection does not accept the credential in the URL. Send it in the Authorization header, or enable URL credentials for this connection (less secure).');
  end if;
  if not public.integration_hit('conn:' || c.id, coalesce((c.config->>'rate_limit_per_min')::int, 60)) then return jsonb_build_object('status', 'rate_limited', 'reason', 'Rate limit exceeded for this connection.'); end if;
  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text) > 20000
     or exists (select 1 from jsonb_each(p_payload) e where jsonb_typeof(e.value) in ('object','array')) then
    return jsonb_build_object('status', 'invalid', 'reason', 'The submission must be a flat object (up to 20 KB) of text, number or boolean values.'); end if;

  v_hash := public.integration_sha256(p_payload::text);
  perform pg_advisory_xact_lock(hashtext('integ:' || c.id::text || ':' || coalesce(v_key, v_hash))); -- serialize concurrent retries of the same submission
  -- 1) explicit idempotency key (forever)  2) identical payload within 24h (a retried request without a key)
  select id, lead_id, status into v_dup from public.integration_webhook_events where connection_id = c.id and kind = 'form_submission' and
    ((v_key is not null and dedupe_key = 'k:' || v_key) or (v_key is null and payload_hash = v_hash and received_at > now() - interval '24 hours' and status = 'processed')) order by received_at limit 1;
  if found then
    if v_dup.status = 'rejected' then return jsonb_build_object('status', 'rejected', 'duplicate', true, 'reason', 'This submission was already received and rejected.'); end if;
    return jsonb_build_object('status', 'duplicate', 'lead_id', v_dup.lead_id);
  end if;

  insert into public.integration_webhook_events (organization_id, connection_id, provider, kind, dedupe_key, payload_hash, payload, signature_verified, status, attempts)
    values (c.organization_id, c.id, 'website_forms', 'form_submission', case when v_key is not null then 'k:' || v_key end, v_hash, p_payload, true, 'received', 1) returning id into v_ev;
  v_res := public.integration_submit(c, p_payload, coalesce(p_meta, '{}'::jsonb));
  if v_res->>'status' = 'created' then
    update public.integration_webhook_events set status = 'processed', processed_at = now(), lead_id = (v_res->>'lead_id')::uuid where id = v_ev;
    update public.integration_connections set status = 'connected', last_event_at = now(), last_error = null, updated_at = now() where id = c.id;
  else
    update public.integration_webhook_events set status = 'rejected', processed_at = now(), last_error = left(v_res->>'reason', 500) where id = v_ev;
    perform public.integration_log_error(c.organization_id, c.id, 'website_forms', 'rejected', v_res->>'reason', jsonb_build_object('event_id', v_ev));
    update public.integration_connections set last_event_at = now(), last_error = left(v_res->>'reason', 500), last_error_at = now() where id = c.id;
  end if;
  return v_res || jsonb_build_object('event_id', v_ev);
end $$;

create or replace function public.integration_set_config(p_org uuid, p_conn uuid, p_config jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; v jsonb := '{}'::jsonb;
begin
  perform public.integration_admin(p_org); c := public.integration_get(p_org, p_conn);
  if jsonb_typeof(p_config) is distinct from 'object' then raise exception 'Invalid configuration.' using errcode = '22023'; end if;
  if p_config ? 'rate_limit_per_min' then
    if (p_config->>'rate_limit_per_min') !~ '^[0-9]{1,3}$' or (p_config->>'rate_limit_per_min')::int not between 1 and 600 then raise exception 'The rate limit must be between 1 and 600 per minute.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('rate_limit_per_min', (p_config->>'rate_limit_per_min')::int); end if;
  if p_config ? 'allow_query_key' then
    if jsonb_typeof(p_config->'allow_query_key') is distinct from 'boolean' then raise exception 'allow_query_key must be true or false.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('allow_query_key', p_config->'allow_query_key'); end if;
  if c.provider = 'whatsapp' then
    if p_config ? 'provider' then
      if p_config->>'provider' not in ('meta_cloud','interakt') then raise exception 'Choose Meta Cloud API or Interakt.' using errcode = '22023'; end if;
      v := v || jsonb_build_object('provider', p_config->>'provider'); end if;
    if p_config ? 'template_name' or p_config ? 'template_language' then
      if coalesce(p_config->>'template_name', '') !~ '^[a-z0-9_]{1,100}$' or coalesce(p_config->>'template_language', '') !~ '^[a-z]{2}(_[A-Z]{2})?$' then raise exception 'Enter the approved template name (lowercase, digits, underscore) and language code such as en or en_US.' using errcode = '22023'; end if;
      v := v || jsonb_build_object('template_name', p_config->>'template_name', 'template_language', p_config->>'template_language'); end if;
    if p_config ? 'default_country_code' then
      if p_config->>'default_country_code' !~ '^[0-9]{1,3}$' then raise exception 'The default country code is 1 to 3 digits, for example 91.' using errcode = '22023'; end if;
      v := v || jsonb_build_object('default_country_code', p_config->>'default_country_code'); end if;
    if p_config ? 'phone_number_id' then
      if p_config->>'phone_number_id' !~ '^[0-9]{5,30}$' then raise exception 'The phone number id is a number from Meta.' using errcode = '22023'; end if;
      v := v || jsonb_build_object('phone_number_id', p_config->>'phone_number_id'); end if;
  end if;
  update public.integration_connections set config = (config || v), updated_at = now() where id = p_conn;
end $$;

-- =====================================================================================================================
-- Part 3: AI Assistant. Conversations, proposals, usage and the READ-ONLY tool functions the assistant may call.
-- Security model:
--   * The assistant has no SQL access. It can only call the ai_tool_* functions below, each with a fixed signature, hard limits and pagination.
--   * Every ai_tool_* function is SECURITY INVOKER: it runs as the signed-in user, so row level security (leads visibility, owner/admin-only
--     integration and automation tables, tenant isolation) is the single source of truth. Role checks are repeated inside where a clearer error helps.
--   * Contact details are masked and free text is redacted unless the user's request needs them (include_contact); everything returned is capped.
--   * The assistant never writes configuration. It can only create a PROPOSAL (ai_create_proposal); a human applies it through the normal
--     save/publish functions, which re-check owner/admin and validate again.
-- =====================================================================================================================
create table public.ai_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default true,
  daily_token_limit integer not null default 300000 check (daily_token_limit between 1000 and 5000000),
  hourly_messages_per_user integer not null default 40 check (hourly_messages_per_user between 1 and 500),
  updated_at timestamptz not null default now()
);
create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null,
  title text check (char_length(title) <= 120), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id, user_id)
);
create index ai_conversations_user_idx on public.ai_conversations (user_id, organization_id, updated_at desc);
create table public.ai_messages (
  id uuid primary key default gen_random_uuid(), seq bigint generated always as identity,
  conversation_id uuid not null, organization_id uuid not null, user_id uuid not null,
  role text not null check (role in ('user','assistant')), content jsonb not null check (octet_length(content::text) <= 30000), created_at timestamptz not null default now(),
  foreign key (conversation_id, organization_id, user_id) references public.ai_conversations (id, organization_id, user_id) on delete cascade
);
create index ai_messages_conv_idx on public.ai_messages (conversation_id, seq);
-- audit trail of tool calls: arguments and counts, never result bodies (those can contain personal data)
create table public.ai_tool_calls (
  id uuid primary key default gen_random_uuid(), conversation_id uuid, organization_id uuid not null, user_id uuid not null,
  tool text not null check (char_length(tool) <= 60), args jsonb not null default '{}'::jsonb check (octet_length(args::text) <= 4000),
  ok boolean not null, result_count integer, error text check (char_length(error) <= 500), duration_ms integer, created_at timestamptz not null default now()
);
create index ai_tool_calls_org_idx on public.ai_tool_calls (organization_id, created_at desc);
create table public.ai_usage (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null, conversation_id uuid,
  provider text not null, model text not null, input_tokens integer not null default 0, output_tokens integer not null default 0, tool_calls integer not null default 0,
  status text not null check (status in ('ok','error','blocked')), error text check (char_length(error) <= 500), latency_ms integer, created_at timestamptz not null default now()
);
create index ai_usage_org_idx on public.ai_usage (organization_id, created_at desc);
create index ai_usage_user_idx on public.ai_usage (organization_id, user_id, created_at desc);
create table public.ai_proposals (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null, conversation_id uuid,
  kind text not null check (kind in ('module_config','workflow')), title text not null check (char_length(title) between 1 and 160),
  payload jsonb not null check (octet_length(payload::text) <= 60000), base_revision integer,
  status text not null default 'pending' check (status in ('pending','draft_saved','published','published_disabled','rejected')),
  result jsonb, workflow_id uuid, created_at timestamptz not null default now(), decided_at timestamptz
);
create index ai_proposals_user_idx on public.ai_proposals (user_id, organization_id, created_at desc);

alter table public.ai_settings enable row level security; alter table public.ai_conversations enable row level security; alter table public.ai_messages enable row level security;
alter table public.ai_tool_calls enable row level security; alter table public.ai_usage enable row level security; alter table public.ai_proposals enable row level security;
-- chats are private to their author (not even owners read other people's conversations); usage and tool audit are visible to owners/admins
create policy ai_settings_read on public.ai_settings for select to authenticated using (public.is_org_member(organization_id));
create policy ai_conversations_read on public.ai_conversations for select to authenticated using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy ai_messages_read on public.ai_messages for select to authenticated using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy ai_proposals_read on public.ai_proposals for select to authenticated using (user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy ai_tool_calls_read on public.ai_tool_calls for select to authenticated using (public.org_role(organization_id) in ('owner','admin') or (user_id = (select auth.uid()) and public.is_org_member(organization_id)));
create policy ai_usage_read on public.ai_usage for select to authenticated using (public.org_role(organization_id) in ('owner','admin') or (user_id = (select auth.uid()) and public.is_org_member(organization_id)));
revoke all on public.ai_settings, public.ai_conversations, public.ai_messages, public.ai_tool_calls, public.ai_usage, public.ai_proposals from anon, authenticated;
grant select on public.ai_settings, public.ai_conversations, public.ai_messages, public.ai_tool_calls, public.ai_usage, public.ai_proposals to authenticated;

-- ---------- helpers ----------
create or replace function public.ai_ctx(p_org uuid) returns text language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_role text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select role into v_role from public.organization_members where organization_id = p_org and user_id = v_uid;
  if v_role is null then raise exception 'You are not a member of this organization.' using errcode = '42501'; end if;
  return v_role;
end $$;
create or replace function public.ai_email(p_org uuid, p_user uuid) returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.ai_ctx(p_org);
  return (select u.email::text from auth.users u join public.organization_members m on m.user_id = u.id where m.organization_id = p_org and m.user_id = p_user);
end $$;
create or replace function public.ai_mask_phone(p text) returns text language sql immutable set search_path = '' as $$
  select case when p is null then null else repeat('•', greatest(char_length(p) - 2, 0)) || right(p, 2) end;
$$;
create or replace function public.ai_mask_email(p text) returns text language sql immutable set search_path = '' as $$
  select case when p is null then null else left(split_part(p, '@', 1), 1) || '***@' || split_part(p, '@', 2) end;
$$;
-- removes things that look like emails or phone numbers from free text and bounds its length
create or replace function public.ai_redact(p text, p_max integer default 300) returns text language sql immutable set search_path = '' as $$
  select left(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''), '[^\s@]+@[^\s@]+\.[^\s@]+', '[email]', 'g'), '\+?\d[\d\s().-]{5,}\d', '[number]', 'g'), '[\x00-\x08\x0b\x0c\x0e-\x1f]', '', 'g'), greatest(p_max, 1));
$$;
create or replace function public.ai_text(p text, p_max integer, p_keep boolean) returns text language sql immutable set search_path = '' as $$
  select case when p is null then null when p_keep then left(p, p_max) else public.ai_redact(p, p_max) end;
$$;

-- ---------- conversations, messages, usage ----------
create or replace function public.ai_budget(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); s public.ai_settings; v_tokens bigint; v_msgs int; v_role text := public.ai_ctx(p_org);
begin
  select * into s from public.ai_settings where organization_id = p_org;
  if not found then s.enabled := true; s.daily_token_limit := 300000; s.hourly_messages_per_user := 40; end if;
  select coalesce(sum(input_tokens + output_tokens), 0) into v_tokens from public.ai_usage where organization_id = p_org and created_at >= date_trunc('day', now());
  select count(*) into v_msgs from public.ai_usage where organization_id = p_org and user_id = v_uid and created_at > now() - interval '1 hour' and status <> 'blocked';
  return jsonb_build_object('allowed', s.enabled and v_tokens < s.daily_token_limit and v_msgs < s.hourly_messages_per_user,
    'reason', case when not s.enabled then 'AI is turned off for this organization.' when v_tokens >= s.daily_token_limit then 'The organization reached its daily AI usage limit. It resets at midnight UTC.'
      when v_msgs >= s.hourly_messages_per_user then 'You reached your hourly AI message limit. Try again later.' end,
    'tokens_today', v_tokens, 'daily_limit', s.daily_token_limit, 'messages_last_hour', v_msgs, 'hourly_limit', s.hourly_messages_per_user, 'role', v_role);
end $$;

create or replace function public.ai_set_limits(p_org uuid, p_enabled boolean, p_daily_tokens integer, p_hourly_messages integer) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.ai_ctx(p_org) <> 'owner' then raise exception 'Only the owner can change AI limits.' using errcode = '42501'; end if;
  if p_daily_tokens not between 1000 and 5000000 or p_hourly_messages not between 1 and 500 then raise exception 'Limits are out of range.' using errcode = '22023'; end if;
  insert into public.ai_settings (organization_id, enabled, daily_token_limit, hourly_messages_per_user) values (p_org, coalesce(p_enabled, true), p_daily_tokens, p_hourly_messages)
    on conflict (organization_id) do update set enabled = excluded.enabled, daily_token_limit = excluded.daily_token_limit, hourly_messages_per_user = excluded.hourly_messages_per_user, updated_at = now();
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'ai.limits_changed', jsonb_build_object('enabled', p_enabled, 'daily_tokens', p_daily_tokens, 'hourly_messages', p_hourly_messages));
end $$;

create or replace function public.ai_create_conversation(p_org uuid, p_title text default null) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.ai_ctx(p_org);
  if (select count(*) from public.ai_conversations where organization_id = p_org and user_id = (select auth.uid())) >= 200 then raise exception 'Too many conversations. Delete old ones first.' using errcode = '22023'; end if;
  insert into public.ai_conversations (organization_id, user_id, title) values (p_org, (select auth.uid()), left(nullif(btrim(p_title), ''), 120)) returning id into v_id;
  return v_id;
end $$;

create or replace function public.ai_add_message(p_org uuid, p_conv uuid, p_role text, p_content jsonb) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  perform public.ai_ctx(p_org);
  if p_role not in ('user','assistant') then raise exception 'Invalid role.' using errcode = '22023'; end if;
  if not exists (select 1 from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = v_uid) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  insert into public.ai_messages (conversation_id, organization_id, user_id, role, content) values (p_conv, p_org, v_uid, p_role, p_content) returning id into v_id;
  update public.ai_conversations set updated_at = now(), title = coalesce(title, left(btrim(p_content->>'text'), 80)) where id = p_conv;
  return v_id;
end $$;

create or replace function public.ai_delete_conversation(p_org uuid, p_conv uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.ai_ctx(p_org);
  delete from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = (select auth.uid());
end $$;

create or replace function public.ai_log_tool_call(p_org uuid, p_conv uuid, p_tool text, p_args jsonb, p_ok boolean, p_count integer, p_error text, p_ms integer) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  perform public.ai_ctx(p_org);
  if p_conv is not null and not exists (select 1 from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = v_uid) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  insert into public.ai_tool_calls (conversation_id, organization_id, user_id, tool, args, ok, result_count, error, duration_ms)
    values (p_conv, p_org, v_uid, left(p_tool, 60), coalesce(p_args, '{}'::jsonb), p_ok, p_count, left(p_error, 500), p_ms);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.tool_call', jsonb_build_object('tool', left(p_tool, 60), 'ok', p_ok, 'conversation_id', p_conv));
end $$;

create or replace function public.ai_record_usage(p_org uuid, p_conv uuid, p_provider text, p_model text, p_in integer, p_out integer, p_tools integer, p_status text, p_error text, p_ms integer) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  perform public.ai_ctx(p_org);
  if p_status not in ('ok','error','blocked') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  insert into public.ai_usage (organization_id, user_id, conversation_id, provider, model, input_tokens, output_tokens, tool_calls, status, error, latency_ms)
    values (p_org, v_uid, p_conv, left(p_provider, 40), left(p_model, 80), least(greatest(coalesce(p_in, 0), 0), 200000), least(greatest(coalesce(p_out, 0), 0), 200000), least(greatest(coalesce(p_tools, 0), 0), 50), p_status, left(p_error, 500), p_ms);
end $$;

-- ---------- proposals (the only thing the assistant can "write"; applying one is a separate, human action) ----------
create or replace function public.ai_create_proposal(p_org uuid, p_conv uuid, p_kind text, p_title text, p_payload jsonb, p_base_revision integer) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  if public.ai_ctx(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can change the workspace configuration or automations.' using errcode = '42501'; end if;
  if p_kind not in ('module_config','workflow') or char_length(btrim(coalesce(p_title, ''))) not between 1 and 160 then raise exception 'Invalid proposal.' using errcode = '22023'; end if;
  if p_conv is not null and not exists (select 1 from public.ai_conversations where id = p_conv and organization_id = p_org and user_id = v_uid) then raise exception 'Conversation not found.' using errcode = 'P0002'; end if;
  if (select count(*) from public.ai_proposals where organization_id = p_org and user_id = v_uid and status = 'pending') >= 20 then raise exception 'Too many pending proposals. Apply or dismiss some first.' using errcode = '22023'; end if;
  insert into public.ai_proposals (organization_id, user_id, conversation_id, kind, title, payload, base_revision) values (p_org, v_uid, p_conv, p_kind, btrim(p_title), p_payload, p_base_revision) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.proposal_created', jsonb_build_object('proposal_id', v_id, 'kind', p_kind));
  return v_id;
end $$;

create or replace function public.ai_set_proposal_status(p_org uuid, p_proposal uuid, p_status text, p_result jsonb, p_workflow uuid default null) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); p public.ai_proposals;
begin
  if public.ai_ctx(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can apply proposals.' using errcode = '42501'; end if;
  select * into p from public.ai_proposals where id = p_proposal and organization_id = p_org and user_id = v_uid for update;
  if not found then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  if p.created_at < now() - interval '7 days' and p.status = 'pending' then raise exception 'This proposal is older than 7 days. Ask for it again.' using errcode = '22023'; end if;
  if not ((p.status = 'pending' and p_status in ('draft_saved','rejected')) or (p.status = 'draft_saved' and p_status in ('published','rejected') and p.kind = 'module_config')
       or (p.status = 'draft_saved' and p_status in ('published','published_disabled','rejected') and p.kind = 'workflow')) then
    raise exception 'This proposal cannot move from % to %.', p.status, p_status using errcode = '22023'; end if;
  update public.ai_proposals set status = p_status, result = coalesce(p_result, result), workflow_id = coalesce(p_workflow, workflow_id), decided_at = now() where id = p_proposal;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'ai.proposal_' || p_status, jsonb_build_object('proposal_id', p_proposal, 'kind', p.kind));
end $$;

-- ---------- READ-ONLY tools (SECURITY INVOKER: row level security decides what the signed-in user may see) ----------
create or replace function public.ai_tool_list_leads(p_org uuid, p_stage text, p_source text, p_assignee text, p_search text, p_limit integer, p_offset integer) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_uid uuid := (select auth.uid()); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25); v_off int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_items jsonb; v_total int; v_search text := replace(replace(replace(left(btrim(coalesce(p_search, '')), 80), '\', '\\'), '%', '\%'), '_', '\_');
begin
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id), '[]'::jsonb), coalesce(max(x.total), 0) into v_items, v_total from (
    select jsonb_build_object('id', l.id, 'name', c.full_name, 'stage', l.stage, 'source', l.source, 'assigned_to', public.ai_email(p_org, l.assigned_to), 'created_at', l.created_at,
        'open_tasks', (select count(*) from public.tasks t where t.lead_id = l.id and t.status = 'open')) j, l.created_at, l.id, count(*) over () total
    from public.leads l join public.contacts c on c.id = l.contact_id and c.organization_id = l.organization_id
    where l.organization_id = p_org and (p_stage is null or l.stage = p_stage) and (p_source is null or l.source = p_source)
      and (p_assignee is null or (p_assignee = 'me' and l.assigned_to = v_uid) or (p_assignee = 'unassigned' and l.assigned_to is null)
           or (p_assignee ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and l.assigned_to = (case when p_assignee ~ '^[0-9a-f]{8}-' then p_assignee::uuid end)))
      and (v_search = '' or c.full_name ilike '%' || v_search || '%')
    order by l.created_at desc, l.id limit v_limit offset v_off) x;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_off, 'has_more', v_off + jsonb_array_length(v_items) < v_total, 'viewer_role', v_role, 'items', v_items);
end $$;

create or replace function public.ai_tool_get_lead(p_org uuid, p_lead uuid, p_include_contact boolean) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); l public.leads; c public.contacts; v_keep boolean := coalesce(p_include_contact, false); v_acts jsonb; v_tasks jsonb; v_attr jsonb;
begin
  select * into l from public.leads where id = p_lead and organization_id = p_org;
  if not found then raise exception 'Lead not found, or you cannot see it.' using errcode = 'P0002'; end if;
  select * into c from public.contacts where id = l.contact_id and organization_id = p_org;
  select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'note', public.ai_text(a.body, 300, v_keep), 'at', a.created_at) order by a.created_at desc, a.seq desc), '[]'::jsonb) into v_acts
    from (select * from public.lead_activities where lead_id = p_lead and organization_id = p_org order by created_at desc, seq desc limit 10) a;
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', public.ai_text(t.title, 120, v_keep), 'owner', public.ai_email(p_org, t.owner_id), 'due_date', t.due_date, 'status', t.status, 'outcome', public.ai_text(t.outcome, 200, v_keep)) order by t.due_date, t.id), '[]'::jsonb) into v_tasks
    from (select * from public.tasks where lead_id = p_lead and organization_id = p_org order by status, due_date, id limit 10) t;
  select jsonb_build_object('provider', provider, 'utm', utm) into v_attr from public.lead_attribution where lead_id = p_lead;
  return jsonb_build_object('id', l.id, 'name', c.full_name, 'stage', l.stage, 'source', l.source, 'assigned_to', public.ai_email(p_org, l.assigned_to), 'created_at', l.created_at, 'updated_at', l.updated_at,
    'summary', public.ai_text(l.summary, 500, v_keep), 'contact_details_included', v_keep and v_role is not null,
    'phone', case when v_keep then c.phone else public.ai_mask_phone(c.phone) end, 'email', case when v_keep then c.email else public.ai_mask_email(c.email) end,
    'activities', v_acts, 'tasks', v_tasks, 'attribution', v_attr);
end $$;

create or replace function public.ai_tool_list_tasks(p_org uuid, p_owner text, p_overdue boolean, p_limit integer, p_offset integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_uid uuid := (select auth.uid()); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25); v_off int := least(greatest(coalesce(p_offset, 0), 0), 10000); v_items jsonb; v_total int;
begin
  select coalesce(jsonb_agg(x.j order by x.due_date, x.id), '[]'::jsonb), coalesce(max(x.total), 0) into v_items, v_total from (
    select jsonb_build_object('id', t.id, 'title', public.ai_text(t.title, 120, false), 'owner', public.ai_email(p_org, t.owner_id), 'due_date', t.due_date, 'overdue', t.due_date < current_date,
        'lead_id', t.lead_id, 'lead_name', c.full_name) j, t.due_date, t.id, count(*) over () total
    from public.tasks t join public.leads l on l.id = t.lead_id join public.contacts c on c.id = l.contact_id
    where t.organization_id = p_org and t.status = 'open'
      and (coalesce(p_owner, 'me') = 'all' or (coalesce(p_owner, 'me') = 'me' and t.owner_id = v_uid) or (p_owner ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and t.owner_id = (case when p_owner ~ '^[0-9a-f]{8}-' then p_owner::uuid end)))
      and (not coalesce(p_overdue, false) or t.due_date < current_date)
    order by t.due_date, t.id limit v_limit offset v_off) x;
  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_off, 'has_more', v_off + jsonb_array_length(v_items) < v_total, 'today', current_date, 'viewer_role', v_role, 'items', v_items);
end $$;

-- SECURITY DEFINER because organization_members is only readable per-row by clients; scoping is explicit: counts for every member, per-member details only for owner/admin/manager
create or replace function public.ai_tool_team_summary(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_uid uuid := (select auth.uid()); v_roles jsonb; v_members jsonb := null;
begin
  select coalesce(jsonb_object_agg(role, n), '{}'::jsonb) into v_roles from (select role, count(*) n from public.organization_members where organization_id = p_org group by role) r;
  if v_role in ('owner','admin','manager') then
    select coalesce(jsonb_agg(jsonb_build_object('email', public.ai_email(p_org, m.user_id), 'role', m.role, 'active', m.active,
        'open_tasks', (select count(*) from public.tasks t where t.organization_id = p_org and t.owner_id = m.user_id and t.status = 'open'),
        'assigned_leads', (select count(*) from public.leads l where l.organization_id = p_org and l.assigned_to = m.user_id)) order by m.role, m.user_id), '[]'::jsonb) into v_members
      from public.organization_members m where m.organization_id = p_org;
  end if;
  return jsonb_build_object('viewer_role', v_role, 'members_by_role', v_roles, 'members', v_members,
    'your_open_tasks', (select count(*) from public.tasks t where t.organization_id = p_org and t.owner_id = v_uid and t.status = 'open'),
    'note', case when v_members is null then 'Per-member details are available to owners, admins and managers.' end);
end $$;

create or replace function public.ai_tool_list_modules(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); d jsonb; v_out jsonb;
begin
  select definition into d from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
  if d is null then return jsonb_build_object('modules', '[]'::jsonb); end if;
  select coalesce(jsonb_agg(jsonb_build_object('key', m.value->>'key', 'label', m.value->>'label', 'status', m.value->>'status',
      'core', (m.value->>'key') in ('overview','leads'),
      'record_count', case when (m.value->>'key') in ('overview','leads') then null else (select count(*) from public.records r where r.organization_id = p_org and r.object_key = m.value->>'key') end,
      'fields', coalesce((select jsonb_agg(jsonb_build_object('key', f.value->>'key', 'label', f.value->>'label', 'kind', f.value->>'kind', 'required', coalesce((f.value->>'required')::boolean, false))) 
         from jsonb_array_elements(coalesce((select o.value->'fields' from jsonb_array_elements(d->'objects') o where o.value->>'key' = m.value->>'key'), '[]'::jsonb)) f where coalesce((f.value->>'archived')::boolean, false) = false), '[]'::jsonb))), '[]'::jsonb)
    into v_out from jsonb_array_elements(d->'modules') m;
  return jsonb_build_object('business', d->>'businessName', 'pipeline_stages', d->'pipeline'->'stages', 'modules', v_out);
end $$;

create or replace function public.ai_tool_list_module_records(p_org uuid, p_module text, p_search text, p_limit integer, p_offset integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); d jsonb; o jsonb; v_limit int := least(greatest(coalesce(p_limit, 10), 1), 25); v_off int := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_search text := replace(replace(replace(lower(left(btrim(coalesce(p_search, '')), 80)), '\', '\\'), '%', '\%'), '_', '\_'); v_items jsonb := '[]'::jsonb; v_total int := 0; r record; v_data jsonb; f jsonb; v_n int := 0;
begin
  select definition into d from public.workspace_configuration_versions where organization_id = p_org and status = 'published' order by revision desc limit 1;
  if coalesce(p_module, '') in ('', 'overview', 'leads') or d is null or not exists (select 1 from jsonb_array_elements(d->'modules') m where m.value->>'key' = p_module and m.value->>'status' = 'active') then
    raise exception 'Module not found. Use list_modules to see the available custom modules.' using errcode = 'P0002'; end if;
  select x.value into o from jsonb_array_elements(d->'objects') x where x.value->>'key' = p_module;
  for r in select id, data, created_at, count(*) over () total from public.records where organization_id = p_org and object_key = p_module and (v_search = '' or search_text like '%' || v_search || '%') order by created_at desc, id limit v_limit offset v_off loop
    v_total := r.total; v_data := '{}'::jsonb; v_n := 0;
    for f in select * from jsonb_array_elements(coalesce(o->'fields', '[]'::jsonb)) loop
      continue when coalesce((f->>'archived')::boolean, false) or not jsonb_exists(r.data, f->>'key');
      v_n := v_n + 1; exit when v_n > 12;
      v_data := v_data || jsonb_build_object(f->>'label', case f->>'kind'
        when 'phone' then to_jsonb(public.ai_mask_phone(r.data->>(f->>'key')))
        when 'email' then to_jsonb(public.ai_mask_email(r.data->>(f->>'key')))
        when 'text' then to_jsonb(public.ai_redact(r.data->>(f->>'key'), 200))
        else r.data->(f->>'key') end);
    end loop;
    v_items := v_items || jsonb_build_object('id', r.id, 'created_at', r.created_at, 'values', v_data);
  end loop;
  return jsonb_build_object('module', p_module, 'total', v_total, 'limit', v_limit, 'offset', v_off, 'has_more', v_off + jsonb_array_length(v_items) < v_total, 'items', v_items);
end $$;

create or replace function public.ai_tool_connection_status(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_conns jsonb; v_ev jsonb;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can view connections.' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('provider', c.provider, 'name', c.name, 'status', c.status, 'last_event_at', c.last_event_at, 'last_sync_at', c.last_sync_at,
      'last_error', public.ai_text(c.last_error, 300, true), 'selected_assets', (select count(*) from public.integration_assets a where a.connection_id = c.id and a.selected)) order by c.provider, c.created_at), '[]'::jsonb) into v_conns
    from public.integration_connections c where c.organization_id = p_org;
  select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) into v_ev from (select status, count(*) n from public.integration_webhook_events where organization_id = p_org and received_at > now() - interval '24 hours' group by status) s;
  return jsonb_build_object('connections', v_conns, 'events_last_24h_by_status', v_ev,
    'providers_without_connection', (select coalesce(jsonb_agg(p), '[]'::jsonb) from unnest(array['website_forms','meta_lead_ads','whatsapp','google_ads','telephony','payments']) p where not exists (select 1 from public.integration_connections c where c.organization_id = p_org and c.provider = p and c.status <> 'not_connected')),
    'not_yet_supported', jsonb_build_array('google_ads', 'telephony', 'payments'));
end $$;

create or replace function public.ai_tool_integration_errors(p_org uuid, p_limit integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 20);
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can view integration errors.' using errcode = '42501'; end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('at', e.created_at, 'source', e.source, 'code', e.code, 'message', public.ai_text(e.message, 300, true)) order by e.created_at desc, e.id)
    from (select * from public.integration_errors where organization_id = p_org order by created_at desc, id limit v_limit) e), '[]'::jsonb), 'limit', v_limit);
end $$;

create or replace function public.ai_tool_list_workflows(p_org uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org);
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can view automations.' using errcode = '42501'; end if;
  return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'name', public.ai_text(w.name, 80, true), 'enabled', w.enabled, 'published_version', w.published_version,
      'trigger', (select v.definition #>> '{trigger,event}' from public.automation_workflow_versions v where v.workflow_id = w.id and v.status in ('published','draft') order by v.version desc limit 1),
      'actions', (select jsonb_array_length(v.definition->'actions') from public.automation_workflow_versions v where v.workflow_id = w.id and v.status in ('published','draft') order by v.version desc limit 1),
      'has_unpublished_draft', exists (select 1 from public.automation_workflow_versions v where v.workflow_id = w.id and v.status = 'draft'),
      'last_run', (select jsonb_build_object('status', r.status, 'at', r.created_at) from public.automation_runs r where r.workflow_id = w.id order by r.created_at desc, r.id limit 1)) order by w.created_at desc)
    from (select * from public.automation_workflows where organization_id = p_org order by created_at desc limit 50) w), '[]'::jsonb));
end $$;

create or replace function public.ai_tool_workflow_runs(p_org uuid, p_workflow uuid, p_status text, p_limit integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); v_limit int := least(greatest(coalesce(p_limit, 10), 1), 20);
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can view automation runs.' using errcode = '42501'; end if;
  return jsonb_build_object('limit', v_limit, 'items', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'workflow', public.ai_text(w.name, 80, true), 'status', r.status, 'attempts', r.attempts, 'at', r.created_at,
      'error', public.ai_text(r.last_error, 300, true), 'steps', (select coalesce(jsonb_agg(jsonb_build_object('action', s.action_type, 'status', s.status) order by s.step_index), '[]'::jsonb) from public.automation_steps s where s.run_id = r.id)) order by r.created_at desc, r.id)
    from (select * from public.automation_runs where organization_id = p_org and (p_workflow is null or workflow_id = p_workflow) and (p_status is null or status = p_status) order by created_at desc, id limit v_limit) r
    join public.automation_workflows w on w.id = r.workflow_id), '[]'::jsonb));
end $$;

-- ---------- reads used by the orchestrator and the approval flow (invoker: RLS keeps every conversation and proposal private to its author) ----------
create or replace function public.ai_recent_messages(p_org uuid, p_conv uuid, p_limit integer) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('role', m.role, 'text', left(m.content->>'text', 4000)) order by m.seq)
    from (select * from public.ai_messages where conversation_id = p_conv and organization_id = p_org order by seq desc limit least(greatest(coalesce(p_limit, 12), 1), 30)) m), '[]'::jsonb);
end $$;
create or replace function public.ai_get_proposal(p_org uuid, p_proposal uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); p public.ai_proposals;
begin
  select * into p from public.ai_proposals where id = p_proposal and organization_id = p_org;
  if not found then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p.id, 'kind', p.kind, 'title', p.title, 'payload', p.payload, 'base_revision', p.base_revision, 'status', p.status, 'workflow_id', p.workflow_id, 'created_at', p.created_at);
end $$;
-- the saved draft of the workflow a workflow proposal created, so publishing can verify it still equals what the user approved
create or replace function public.ai_get_workflow_draft(p_org uuid, p_proposal uuid) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_role text := public.ai_ctx(p_org); p public.ai_proposals;
begin
  if v_role not in ('owner','admin') then raise exception 'Only owners and admins can view automations.' using errcode = '42501'; end if;
  select * into p from public.ai_proposals where id = p_proposal and organization_id = p_org;
  if not found or p.workflow_id is null then raise exception 'Proposal not found.' using errcode = 'P0002'; end if;
  return (select v.definition from public.automation_workflow_versions v where v.workflow_id = p.workflow_id and v.status = 'draft');
end $$;

-- ---------- privileges ----------
revoke all on function public.ai_ctx(uuid), public.ai_email(uuid, uuid), public.ai_mask_phone(text), public.ai_mask_email(text), public.ai_redact(text, integer), public.ai_text(text, integer, boolean),
  public.ai_budget(uuid), public.ai_set_limits(uuid, boolean, integer, integer), public.ai_create_conversation(uuid, text), public.ai_add_message(uuid, uuid, text, jsonb), public.ai_delete_conversation(uuid, uuid),
  public.ai_log_tool_call(uuid, uuid, text, jsonb, boolean, integer, text, integer), public.ai_record_usage(uuid, uuid, text, text, integer, integer, integer, text, text, integer),
  public.ai_create_proposal(uuid, uuid, text, text, jsonb, integer), public.ai_set_proposal_status(uuid, uuid, text, jsonb, uuid),
  public.ai_tool_list_leads(uuid, text, text, text, text, integer, integer), public.ai_tool_get_lead(uuid, uuid, boolean), public.ai_tool_list_tasks(uuid, text, boolean, integer, integer),
  public.ai_tool_team_summary(uuid), public.ai_tool_list_modules(uuid), public.ai_tool_list_module_records(uuid, text, text, integer, integer), public.ai_tool_connection_status(uuid),
  public.ai_tool_integration_errors(uuid, integer), public.ai_tool_list_workflows(uuid), public.ai_tool_workflow_runs(uuid, uuid, text, integer),
  public.ai_recent_messages(uuid, uuid, integer), public.ai_get_proposal(uuid, uuid), public.ai_get_workflow_draft(uuid, uuid) from public, anon;
grant execute on function public.ai_ctx(uuid), public.ai_email(uuid, uuid), public.ai_mask_phone(text), public.ai_mask_email(text), public.ai_redact(text, integer), public.ai_text(text, integer, boolean),
  public.ai_budget(uuid), public.ai_set_limits(uuid, boolean, integer, integer), public.ai_create_conversation(uuid, text), public.ai_add_message(uuid, uuid, text, jsonb), public.ai_delete_conversation(uuid, uuid),
  public.ai_log_tool_call(uuid, uuid, text, jsonb, boolean, integer, text, integer), public.ai_record_usage(uuid, uuid, text, text, integer, integer, integer, text, text, integer),
  public.ai_create_proposal(uuid, uuid, text, text, jsonb, integer), public.ai_set_proposal_status(uuid, uuid, text, jsonb, uuid),
  public.ai_tool_list_leads(uuid, text, text, text, text, integer, integer), public.ai_tool_get_lead(uuid, uuid, boolean), public.ai_tool_list_tasks(uuid, text, boolean, integer, integer),
  public.ai_tool_team_summary(uuid), public.ai_tool_list_modules(uuid), public.ai_tool_list_module_records(uuid, text, text, integer, integer), public.ai_tool_connection_status(uuid),
  public.ai_tool_integration_errors(uuid, integer), public.ai_tool_list_workflows(uuid), public.ai_tool_workflow_runs(uuid, uuid, text, integer),
  public.ai_recent_messages(uuid, uuid, integer), public.ai_get_proposal(uuid, uuid), public.ai_get_workflow_draft(uuid, uuid) to authenticated;
