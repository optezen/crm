-- 0008: Integration Hub. 0001-0007 are untouched (0007 tables are extended with ALTER, never rewritten).
--
-- Trust model (who is allowed to create CRM data from the outside world):
--   * An integration is never a human. Leads created by a connector carry created_by = <connection id> (a service principal that belongs to exactly one
--     organization), lead_activities.actor_id = <connection id>, and domain_events.actor_id = NULL. No auth.users identity is impersonated.
--   * The organization is ALWAYS derived from the connection row that the caller proved access to. Request bodies never choose an organization:
--       - Website forms: the caller proves a per-connection secret (only its SHA-256 is stored). integration_ingest_form is callable by anon, so the
--         Vercel route needs NO service-role key.
--       - Provider webhooks (Meta, WhatsApp): the web route verifies the provider HMAC signature with the platform app secret, then hands the
--         normalized events to integration_receive_webhook together with the gateway secret (only its hash is stored). The organization is resolved
--         from the SELECTED asset (page id / phone number id), which is globally unique, so one tenant cannot claim another tenant's asset.
--       - Network work (fetching a Meta lead, sending a WhatsApp template) happens in the Fly.io worker with the service-role key; credentials are
--         encrypted by the application (AES-256-GCM, key in the server environment, never in the database) and stored as ciphertext.
--   * Every write is a SECURITY DEFINER function. Clients get SELECT only, and never see secret hashes or credential ciphertext through RLS/column grants.
-- Durable processing: webhook events are rows (status, attempts, next_attempt_at, locked_until); a crashed worker's claim simply expires.

-- ---------- tables ----------
create table public.integration_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('website_forms','meta_lead_ads','whatsapp','google_ads','telephony','payments')),
  name text not null check (char_length(name) between 1 and 80),
  status text not null default 'setup_required' check (status in ('not_connected','setup_required','connected','expired','error')),
  public_id text unique check (public_id ~ '^[a-z0-9]{16}$'),
  secret_hash text,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 4000),
  last_event_at timestamptz, last_sync_at timestamptz, last_error text, last_error_at timestamptz,
  created_by uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create index integration_connections_org_idx on public.integration_connections (organization_id, provider);
create unique index integration_one_oauth_connection on public.integration_connections (organization_id, provider) where provider in ('meta_lead_ads','whatsapp');

-- Ciphertext only (encrypted by the application). Never readable by clients: no policy, no grants.
create table public.integration_credentials (
  connection_id uuid primary key references public.integration_connections(id) on delete cascade,
  organization_id uuid not null, ciphertext text not null check (char_length(ciphertext) <= 20000), key_version integer not null default 1,
  expires_at timestamptz, updated_at timestamptz not null default now()
);

create table public.integration_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, connection_id uuid not null,
  kind text not null check (kind in ('page','form','phone_number','waba','ad_account')),
  external_id text not null check (char_length(external_id) between 1 and 100), name text check (char_length(name) <= 200),
  selected boolean not null default false, metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  unique (connection_id, kind, external_id),
  foreign key (connection_id, organization_id) references public.integration_connections (id, organization_id) on delete cascade
);
-- webhook routing key: one selected page / phone number belongs to exactly one organization in the whole system
create unique index integration_asset_route_uq on public.integration_assets (kind, external_id) where selected and kind in ('page','phone_number');

create table public.integration_field_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, connection_id uuid not null,
  external_field text not null check (char_length(external_field) between 1 and 80),
  target text not null check (target in ('full_name','first_name','last_name','phone','email','summary','ignore')),
  unique (connection_id, external_field),
  foreign key (connection_id, organization_id) references public.integration_connections (id, organization_id) on delete cascade
);

create table public.integration_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null, provider text not null, kind text not null check (kind in ('form_submission','meta_leadgen','whatsapp_status')),
  dedupe_key text, payload_hash text, payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 30000),
  signature_verified boolean not null default false,
  status text not null default 'received' check (status in ('received','processing','processed','ignored','rejected','failed','dead')),
  attempts integer not null default 0, max_attempts integer not null default 5, next_attempt_at timestamptz not null default now(), locked_until timestamptz,
  last_error text, lead_id uuid, received_at timestamptz not null default now(), processed_at timestamptz,
  foreign key (connection_id, organization_id) references public.integration_connections (id, organization_id) on delete cascade
);
create unique index integration_events_dedupe_uq on public.integration_webhook_events (connection_id, dedupe_key) where dedupe_key is not null;
create index integration_events_hash_idx on public.integration_webhook_events (connection_id, payload_hash, received_at desc);
create index integration_events_due_idx on public.integration_webhook_events (next_attempt_at) where status in ('received','processing','failed');
create index integration_events_org_idx on public.integration_webhook_events (organization_id, received_at desc);

create table public.integration_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, connection_id uuid not null, kind text not null check (char_length(kind) <= 40),
  status text not null default 'running' check (status in ('running','succeeded','failed')), items integer not null default 0, error text,
  started_at timestamptz not null default now(), finished_at timestamptz,
  foreign key (connection_id, organization_id) references public.integration_connections (id, organization_id) on delete cascade
);
create index integration_jobs_conn_idx on public.integration_sync_jobs (connection_id, started_at desc);

create table public.integration_errors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid references public.integration_connections(id) on delete cascade,
  source text not null check (char_length(source) <= 40), code text check (char_length(code) <= 60), message text not null check (char_length(message) <= 1000),
  context jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index integration_errors_org_idx on public.integration_errors (organization_id, created_at desc);

create table public.integration_rate_limits (key text not null, window_start timestamptz not null, n integer not null default 0, primary key (key, window_start));
create table public.integration_gateway (singleton boolean primary key default true check (singleton), secret_hash text not null);

-- where a lead came from, for reporting and for automations (UTM, page, referrer); one row per integration-created lead
create table public.lead_attribution (
  lead_id uuid primary key, organization_id uuid not null, connection_id uuid, provider text not null,
  utm jsonb not null default '{}'::jsonb, referrer text check (char_length(referrer) <= 500), page_url text check (char_length(page_url) <= 500),
  user_agent text check (char_length(user_agent) <= 300), extra jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(),
  foreign key (lead_id, organization_id) references public.leads (id, organization_id) on delete cascade
);

-- automation integration requests (0007) become a real delivery queue
alter table public.integration_requests drop constraint if exists integration_requests_status_check;
alter table public.integration_requests add constraint integration_requests_status_check check (status in ('requested','sending','sent','delivered','read','failed','cancelled'));
alter table public.integration_requests add column if not exists provider_message_id text, add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz not null default now(), add column if not exists locked_until timestamptz,
  add column if not exists last_error text, add column if not exists updated_at timestamptz not null default now();
create unique index integration_requests_provider_msg_uq on public.integration_requests (provider, provider_message_id) where provider_message_id is not null;
create index integration_requests_due_idx on public.integration_requests (next_attempt_at) where status in ('requested','sending') and channel = 'whatsapp';

-- ---------- row level security: owners/admins read; nothing is writable by clients ----------
alter table public.integration_connections enable row level security;
alter table public.integration_credentials enable row level security;
alter table public.integration_assets enable row level security;
alter table public.integration_field_mappings enable row level security;
alter table public.integration_webhook_events enable row level security;
alter table public.integration_sync_jobs enable row level security;
alter table public.integration_errors enable row level security;
alter table public.integration_rate_limits enable row level security;
alter table public.integration_gateway enable row level security;
alter table public.lead_attribution enable row level security;
create policy integration_connections_read on public.integration_connections for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy integration_assets_read on public.integration_assets for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy integration_mappings_read on public.integration_field_mappings for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy integration_events_read on public.integration_webhook_events for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy integration_jobs_read on public.integration_sync_jobs for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy integration_errors_read on public.integration_errors for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create policy lead_attribution_read on public.lead_attribution for select to authenticated using (exists (select 1 from public.leads l where l.id = lead_id and public.can_see_lead(l.organization_id, l.assigned_to)));
revoke all on public.integration_connections, public.integration_credentials, public.integration_assets, public.integration_field_mappings, public.integration_webhook_events,
  public.integration_sync_jobs, public.integration_errors, public.integration_rate_limits, public.integration_gateway, public.lead_attribution from anon, authenticated;
-- column-level grant: secret_hash is never selectable by a client
grant select (id, organization_id, provider, name, status, public_id, config, last_event_at, last_sync_at, last_error, last_error_at, created_by, created_at, updated_at) on public.integration_connections to authenticated;
grant select on public.integration_assets, public.integration_field_mappings, public.integration_sync_jobs, public.integration_errors, public.lead_attribution to authenticated;
grant select (id, organization_id, connection_id, provider, kind, status, attempts, last_error, lead_id, received_at, processed_at, signature_verified) on public.integration_webhook_events to authenticated;

-- ---------- helpers ----------
create or replace function public.integration_sha256(p text) returns text language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;
create or replace function public.integration_rand() returns text language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;
-- fixed-window counter; true while the caller is still within the limit
create or replace function public.integration_hit(p_key text, p_limit integer) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  insert into public.integration_rate_limits (key, window_start, n) values (p_key, date_trunc('minute', now()), 1)
    on conflict (key, window_start) do update set n = public.integration_rate_limits.n + 1 returning n into v_n;
  return v_n <= p_limit;
end $$;
create or replace function public.integration_log_error(p_org uuid, p_conn uuid, p_source text, p_code text, p_message text, p_context jsonb default '{}'::jsonb) returns void language sql security definer set search_path = '' as $$
  insert into public.integration_errors (organization_id, connection_id, source, code, message, context) values (p_org, p_conn, left(p_source, 40), left(p_code, 60), left(coalesce(p_message, 'error'), 1000), coalesce(p_context, '{}'::jsonb));
$$;
create or replace function public.integration_admin(p_org uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can manage connections.' using errcode = '42501'; end if;
end $$;
create or replace function public.integration_get(p_org uuid, p_conn uuid) returns public.integration_connections language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections;
begin
  select * into c from public.integration_connections where id = p_conn and organization_id = p_org for update;
  if not found then raise exception 'Connection not found.' using errcode = 'P0002'; end if;
  return c;
end $$;

-- ---------- field mapping + normalization ----------
-- Explicit mappings win; otherwise common field names are recognized (Elementor, Contact Form 7, Gravity Forms, Meta lead forms...).
-- Unmapped fields are kept (appended to the lead summary and stored in lead_attribution.extra), never silently dropped.
create or replace function public.integration_map_fields(p_conn uuid, p_fields jsonb) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k text; v text; n text; tgt text; v_utm jsonb := '{}'::jsonb; v_extra jsonb := '{}'::jsonb;
  v_name text; v_first text; v_last text; v_phone text; v_email text; v_summary text := ''; v_lines text := '';
begin
  for k, v in select key, btrim(value) from jsonb_each_text(coalesce(p_fields, '{}'::jsonb)) order by key loop
    continue when v = '' or k like '\_optizen%';
    n := regexp_replace(lower(k), '[^a-z0-9]', '', 'g');
    select target into tgt from public.integration_field_mappings where connection_id = p_conn and external_field = k;
    if tgt is null then
      tgt := case
        when lower(k) ~ '^(utm_(source|medium|campaign|term|content)|gclid|fbclid|msclkid)$' then 'utm'
        when n in ('name','fullname','yourname','customername','contactname','clientname','leadname') then 'full_name'
        when n in ('firstname','fname','givenname') then 'first_name'
        when n in ('lastname','lname','surname','familyname') then 'last_name'
        when n in ('phone','phonenumber','mobile','mobilenumber','tel','telephone','contactnumber','yourphone','yourphonenumber','whatsapp','whatsappnumber','cell') then 'phone'
        when n in ('email','emailaddress','yourmail','yourmailaddress','youremail','youremailaddress','mail','workemail') then 'email'
        when n in ('message','comments','comment','enquiry','inquiry','notes','description','yourmessage','details','requirement') then 'summary'
        when n in ('pageurl','referrer','useragent','formid','formname','postid','sitename','submissionid') then 'meta'
      end;
    end if;
    case tgt
      when 'ignore', 'meta' then null;
      when 'utm' then v_utm := v_utm || jsonb_build_object(lower(k), left(v, 200));
      when 'full_name' then v_name := coalesce(v_name, v);
      when 'first_name' then v_first := coalesce(v_first, v);
      when 'last_name' then v_last := coalesce(v_last, v);
      when 'phone' then v_phone := coalesce(v_phone, v);
      when 'email' then v_email := coalesce(v_email, v);
      when 'summary' then v_summary := case when v_summary = '' then v else v_summary || E'\n' || v end;
      else v_extra := v_extra || jsonb_build_object(left(k, 80), left(v, 500)); v_lines := v_lines || E'\n' || left(k, 80) || ': ' || left(v, 300);
    end case;
  end loop;
  return jsonb_build_object('full_name', coalesce(v_name, nullif(btrim(coalesce(v_first, '') || ' ' || coalesce(v_last, '')), '')), 'phone', v_phone, 'email', v_email,
    'summary', nullif(btrim(left(v_summary || v_lines, 2000)), ''), 'utm', v_utm, 'extra', v_extra);
end $$;

-- ---------- core: one normalized submission -> a real CRM lead (shared by website forms and provider adapters) ----------
create or replace function public.integration_submit(p_conn public.integration_connections, p_fields jsonb, p_meta jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  m jsonb := public.integration_map_fields(p_conn.id, p_fields); v_org uuid := p_conn.organization_id;
  v_source text := case p_conn.provider when 'website_forms' then 'website' when 'meta_lead_ads' then 'meta_ads' else 'other' end;
  v_name text; v_phone text; v_email text; v_summary text := m->>'summary'; v_warn jsonb := '[]'::jsonb; v_contact uuid; v_other uuid; v_lead uuid; v_stage text := public.crm_stages(v_org)->>0;
begin
  begin v_phone := public.crm_norm_phone(m->>'phone');
  exception when others then v_warn := v_warn || to_jsonb('The phone number was not valid and was kept in the summary.'::text); v_summary := coalesce(v_summary || E'\n', '') || 'Phone (as submitted): ' || left(m->>'phone', 40); end;
  begin v_email := public.crm_norm_email(m->>'email');
  exception when others then v_warn := v_warn || to_jsonb('The email address was not valid and was kept in the summary.'::text); v_summary := coalesce(v_summary || E'\n', '') || 'Email (as submitted): ' || left(m->>'email', 80); end;
  if v_phone is null and v_email is null then return jsonb_build_object('status', 'rejected', 'reason', 'A valid phone number or email address is required to create a lead.'); end if;
  begin v_name := public.crm_norm_name(coalesce(m->>'full_name', split_part(v_email, '@', 1), v_phone));
  exception when others then v_name := public.crm_norm_name(left(coalesce(m->>'full_name', 'Website lead'), 120)); end;
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
    values (v_lead, v_org, p_conn.id, p_conn.provider, m->'utm', left(p_meta->>'referrer', 500), left(coalesce(p_meta->>'page_url', p_fields->>'page_url'), 500), left(p_meta->>'user_agent', 300), m->'extra' || coalesce(p_meta->'provider', '{}'::jsonb));
  perform public.crm_emit(v_org, 'lead.created', 'lead', v_lead, jsonb_build_object('contact_id', v_contact, 'stage', v_stage, 'source', v_source, 'assigned_to', null, 'integration', p_conn.provider, 'connection_id', p_conn.id));
  return jsonb_build_object('status', 'created', 'lead_id', v_lead, 'warnings', v_warn);
end $$;

-- ---------- Website Forms: public ingestion (anon-callable; the credential is the identity) ----------
-- Returns {status: created|duplicate|rejected|unauthorized|rate_limited|invalid, ...}. It RETURNS instead of raising for refusals so that the failure counters
-- and the error log commit (a raised exception would roll them back).
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

-- ---------- provider webhooks: signed by the web route, routed by asset ----------
create or replace function public.integration_set_gateway_secret(p_secret text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if char_length(coalesce(p_secret, '')) < 32 then raise exception 'The gateway secret must be at least 32 characters.' using errcode = '22023'; end if;
  insert into public.integration_gateway (singleton, secret_hash) values (true, public.integration_sha256(p_secret)) on conflict (singleton) do update set secret_hash = excluded.secret_hash;
end $$;

-- p_events: [{kind: meta_leadgen|whatsapp_status, asset_kind: page|phone_number, asset_id, dedupe_key, payload}]. The caller has ALREADY verified the provider signature.
create or replace function public.integration_receive_webhook(p_provider text, p_gateway_secret text, p_events jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare e jsonb; a record; v_in int := 0; v_new int := 0; v_unrouted int := 0; v_dup int := 0; v_id uuid;
begin
  if (select coalesce(sum(n), 0) from public.integration_rate_limits where key = 'gateway-fail' and window_start = date_trunc('minute', now())) > 30 then return jsonb_build_object('status', 'rate_limited'); end if;
  if not exists (select 1 from public.integration_gateway where secret_hash = public.integration_sha256(p_gateway_secret)) then
    perform public.integration_hit('gateway-fail', 1000000); return jsonb_build_object('status', 'unauthorized'); end if;
  if not public.integration_hit('gateway', 600) then return jsonb_build_object('status', 'rate_limited'); end if;
  if p_provider not in ('meta_lead_ads','whatsapp') or jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 200 then raise exception 'Invalid webhook batch.' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(p_events) loop
    v_in := v_in + 1;
    if e->>'kind' not in ('meta_leadgen','whatsapp_status') or e->>'asset_kind' not in ('page','phone_number') or coalesce(e->>'dedupe_key', '') = '' then v_unrouted := v_unrouted + 1; continue; end if;
    select a2.organization_id org, a2.connection_id conn into a from public.integration_assets a2 join public.integration_connections c on c.id = a2.connection_id
      where a2.kind = e->>'asset_kind' and a2.external_id = e->>'asset_id' and a2.selected and c.provider = p_provider and c.status in ('connected','setup_required');
    if not found then v_unrouted := v_unrouted + 1; continue; end if; -- unknown / deselected asset: dropped, never attributed to a guessed organization
    insert into public.integration_webhook_events (organization_id, connection_id, provider, kind, dedupe_key, payload, signature_verified)
      values (a.org, a.conn, p_provider, e->>'kind', left(e->>'dedupe_key', 200), coalesce(e->'payload', '{}'::jsonb), true) on conflict (connection_id, dedupe_key) where dedupe_key is not null do nothing returning id into v_id;
    if v_id is null then v_dup := v_dup + 1; else v_new := v_new + 1; update public.integration_connections set last_event_at = now() where id = a.conn; end if;
    v_id := null;
  end loop;
  return jsonb_build_object('status', 'ok', 'received', v_in, 'queued', v_new, 'duplicates', v_dup, 'unrouted', v_unrouted);
end $$;

-- ---------- worker API (service role only) ----------
-- DB-only processing: delivery receipts update the automation integration_requests they belong to.
create or replace function public.integration_apply_status_events(p_limit integer default 100) returns integer language plpgsql security definer set search_path = '' as $$
declare ev public.integration_webhook_events; v_n int := 0; v_status text; v_req uuid;
begin
  for ev in select * from public.integration_webhook_events where kind = 'whatsapp_status' and status in ('received','failed') and next_attempt_at <= now() order by received_at limit greatest(1, least(p_limit, 500)) for update skip locked loop
    v_status := case ev.payload->>'status' when 'sent' then 'sent' when 'delivered' then 'delivered' when 'read' then 'read' when 'failed' then 'failed' end;
    select id into v_req from public.integration_requests where organization_id = ev.organization_id and provider = 'whatsapp' and provider_message_id = ev.payload->>'message_id';
    if v_status is null or v_req is null then
      update public.integration_webhook_events set status = 'ignored', processed_at = now(), last_error = case when v_req is null then 'No matching message request.' else 'Unsupported status.' end where id = ev.id;
    else
      -- never move backwards (read -> delivered) and never overwrite a terminal failure with a late "sent"
      update public.integration_requests set status = v_status, updated_at = now(), last_error = case when v_status = 'failed' then left(ev.payload->>'error', 500) else last_error end
        where id = v_req and array_position(array['requested','sending','sent','delivered','read'], status) < array_position(array['requested','sending','sent','delivered','read'], v_status) or (id = v_req and v_status = 'failed' and status in ('sending','sent'));
      update public.integration_webhook_events set status = 'processed', processed_at = now() where id = ev.id;
      if v_status = 'failed' then perform public.integration_log_error(ev.organization_id, ev.connection_id, 'whatsapp', 'delivery_failed', coalesce(ev.payload->>'error', 'Delivery failed'), jsonb_build_object('request_id', v_req)); end if;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Claims events that need network work (Meta lead retrieval). The claim expires, so a crashed worker's events are retried.
create or replace function public.integration_claim_events(p_limit integer default 10) returns table (id uuid, organization_id uuid, connection_id uuid, kind text, payload jsonb, attempts integer) language plpgsql security definer set search_path = '' as $$
begin
  return query update public.integration_webhook_events w set status = 'processing', attempts = w.attempts + 1, locked_until = now() + interval '5 minutes'
    where w.id in (select x.id from public.integration_webhook_events x where x.kind = 'meta_leadgen' and ((x.status in ('received','failed') and x.next_attempt_at <= now()) or (x.status = 'processing' and x.locked_until < now()))
      order by x.received_at limit greatest(1, least(p_limit, 50)) for update skip locked)
    returning w.id, w.organization_id, w.connection_id, w.kind, w.payload, w.attempts;
end $$;

create or replace function public.integration_ingest_lead(p_event uuid, p_fields jsonb, p_meta jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare ev public.integration_webhook_events; c public.integration_connections; v_res jsonb;
begin
  select * into ev from public.integration_webhook_events where id = p_event for update;
  if not found then raise exception 'Event not found.' using errcode = 'P0002'; end if;
  if ev.status = 'processed' then return jsonb_build_object('status', 'duplicate', 'lead_id', ev.lead_id); end if;
  select * into c from public.integration_connections where id = ev.connection_id and organization_id = ev.organization_id;
  if not found or c.status = 'not_connected' then raise exception 'The connection is no longer active.' using errcode = '22023'; end if;
  v_res := public.integration_submit(c, p_fields, coalesce(p_meta, '{}'::jsonb));
  if v_res->>'status' = 'created' then
    update public.integration_webhook_events set status = 'processed', processed_at = now(), lead_id = (v_res->>'lead_id')::uuid, last_error = null where id = ev.id;
    update public.integration_connections set status = 'connected', last_event_at = now(), last_sync_at = now(), last_error = null where id = c.id;
  else
    update public.integration_webhook_events set status = 'rejected', processed_at = now(), last_error = left(v_res->>'reason', 500) where id = ev.id;
    perform public.integration_log_error(ev.organization_id, c.id, c.provider, 'rejected', v_res->>'reason', jsonb_build_object('event_id', ev.id));
  end if;
  return v_res;
end $$;

-- retryable = transient provider/network problem (backoff, max_attempts, then dead letter); otherwise the event is failed for good ('dead') immediately.
create or replace function public.integration_fail_event(p_event uuid, p_message text, p_retryable boolean) returns text language plpgsql security definer set search_path = '' as $$
declare ev public.integration_webhook_events; v_status text;
begin
  select * into ev from public.integration_webhook_events where id = p_event for update;
  if not found then return 'missing'; end if;
  v_status := case when p_retryable and ev.attempts < ev.max_attempts then 'failed' else 'dead' end;
  update public.integration_webhook_events set status = v_status, last_error = left(p_message, 500), locked_until = null, processed_at = case when v_status = 'dead' then now() end,
    next_attempt_at = now() + make_interval(mins => power(2, least(ev.attempts, 8))::int) where id = p_event;
  perform public.integration_log_error(ev.organization_id, ev.connection_id, ev.provider, case when v_status = 'dead' then 'dead_letter' else 'retry' end, p_message, jsonb_build_object('event_id', p_event, 'attempt', ev.attempts));
  update public.integration_connections set last_error = left(p_message, 500), last_error_at = now() where id = ev.connection_id;
  return v_status;
end $$;

create or replace function public.integration_set_connection_state(p_conn uuid, p_status text, p_error text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('setup_required','connected','expired','error') then raise exception 'Invalid status.' using errcode = '22023'; end if;
  update public.integration_connections set status = p_status, last_error = left(p_error, 500), last_error_at = case when p_error is not null then now() else last_error_at end, updated_at = now() where id = p_conn;
  if p_error is not null then
    perform public.integration_log_error((select organization_id from public.integration_connections where id = p_conn), p_conn, 'connection', p_status, p_error, '{}'::jsonb); end if;
end $$;

create or replace function public.integration_job(p_conn uuid, p_kind text, p_status text, p_items integer, p_error text) returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  select organization_id into v_org from public.integration_connections where id = p_conn; if v_org is null then return; end if;
  insert into public.integration_sync_jobs (organization_id, connection_id, kind, status, items, error, finished_at) values (v_org, p_conn, left(p_kind, 40), p_status, coalesce(p_items, 0), left(p_error, 500), now());
  if p_status = 'succeeded' then update public.integration_connections set last_sync_at = now() where id = p_conn; end if;
end $$;

-- WhatsApp: claim automation requests whose organization has a CONNECTED whatsapp connection. Others stay 'requested' (no provider = nothing is sent).
create or replace function public.integration_claim_requests(p_limit integer default 10) returns table (id uuid, organization_id uuid, connection_id uuid, payload jsonb, config jsonb, attempts integer) language plpgsql security definer set search_path = '' as $$
begin
  return query with due as (
      select r.id rid, c.id cid from public.integration_requests r join public.integration_connections c on c.organization_id = r.organization_id and c.provider = 'whatsapp' and c.status = 'connected'
      where r.channel = 'whatsapp' and ((r.status = 'requested' and r.next_attempt_at <= now()) or (r.status = 'sending' and r.locked_until < now() and r.provider_message_id is null))
      order by r.created_at limit greatest(1, least(p_limit, 50)) for update of r skip locked)
    update public.integration_requests r set status = 'sending', attempts = r.attempts + 1, locked_until = now() + interval '5 minutes', provider = 'whatsapp', updated_at = now()
    from due join public.integration_connections c on c.id = due.cid where r.id = due.rid
    returning r.id, r.organization_id, c.id, r.payload, c.config, r.attempts;
end $$;

create or replace function public.integration_complete_request(p_request uuid, p_ok boolean, p_message_id text, p_error text, p_retryable boolean) returns text language plpgsql security definer set search_path = '' as $$
declare r public.integration_requests; v_status text;
begin
  select * into r from public.integration_requests where id = p_request for update;
  if not found then return 'missing'; end if;
  if p_ok then
    update public.integration_requests set status = 'sent', provider_message_id = p_message_id, locked_until = null, last_error = null, updated_at = now() where id = p_request; return 'sent';
  end if;
  v_status := case when p_retryable and r.attempts < 5 then 'requested' else 'failed' end;
  update public.integration_requests set status = v_status, locked_until = null, last_error = left(p_error, 500), updated_at = now(), next_attempt_at = now() + make_interval(mins => power(2, least(r.attempts, 8))::int) where id = p_request;
  perform public.integration_log_error(r.organization_id, (select id from public.integration_connections where organization_id = r.organization_id and provider = 'whatsapp'), 'whatsapp', case when v_status = 'failed' then 'send_failed' else 'retry' end, p_error, jsonb_build_object('request_id', p_request, 'attempt', r.attempts));
  return v_status;
end $$;

-- housekeeping for the worker (payloads contain personal data): keep processed events 30 days by default
create or replace function public.integration_purge(p_days integer default 30) returns integer language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from public.integration_rate_limits where window_start < now() - interval '1 day';
  update public.integration_webhook_events set payload = '{}'::jsonb where received_at < now() - make_interval(days => greatest(p_days, 1)) and status in ('processed','ignored','rejected','dead') and payload <> '{}'::jsonb;
  get diagnostics v_n = row_count; return v_n;
end $$;

-- ---------- management API (owners/admins; the organization is checked on every call) ----------
create or replace function public.integration_create_connection(p_org uuid, p_provider text, p_name text, p_config jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_name text := btrim(coalesce(p_name, '')); v_public text; v_secret text; v_id uuid;
begin
  perform public.integration_admin(p_org);
  if p_provider not in ('website_forms','meta_lead_ads','whatsapp') then raise exception 'This provider cannot be connected yet.' using errcode = '22023'; end if;
  if char_length(v_name) not between 1 and 80 then raise exception 'Name the connection (up to 80 characters).' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('integ-create:' || p_org::text));
  if p_provider = 'website_forms' and (select count(*) from public.integration_connections where organization_id = p_org and provider = 'website_forms') >= 10 then raise exception 'At most 10 website form connections per organization.' using errcode = '22023'; end if;
  if p_provider in ('meta_lead_ads','whatsapp') and exists (select 1 from public.integration_connections where organization_id = p_org and provider = p_provider) then raise exception 'This provider is already set up for the organization.' using errcode = '23505'; end if;
  if p_provider = 'website_forms' then v_public := left(public.integration_rand(), 16); v_secret := 'oz_' || public.integration_rand(); end if;
  insert into public.integration_connections (organization_id, provider, name, status, public_id, secret_hash, config, created_by)
    values (p_org, p_provider, v_name, 'setup_required', v_public, case when v_secret is not null then public.integration_sha256(v_secret) end, '{}'::jsonb, v_uid) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, v_uid, 'integration.created', jsonb_build_object('connection_id', v_id, 'provider', p_provider));
  return jsonb_build_object('id', v_id, 'public_id', v_public, 'secret', v_secret);
end $$;

create or replace function public.integration_rotate_secret(p_org uuid, p_conn uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; v_secret text := 'oz_' || public.integration_rand();
begin
  perform public.integration_admin(p_org); c := public.integration_get(p_org, p_conn);
  if c.provider <> 'website_forms' then raise exception 'Only website form connections have a webhook secret.' using errcode = '22023'; end if;
  update public.integration_connections set secret_hash = public.integration_sha256(v_secret), updated_at = now(), status = case when status = 'not_connected' then 'setup_required' else status end where id = p_conn;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'integration.secret_rotated', jsonb_build_object('connection_id', p_conn));
  return jsonb_build_object('id', p_conn, 'public_id', c.public_id, 'secret', v_secret);
end $$;

create or replace function public.integration_disconnect(p_org uuid, p_conn uuid) returns void language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections;
begin
  perform public.integration_admin(p_org); c := public.integration_get(p_org, p_conn);
  update public.integration_connections set status = 'not_connected', secret_hash = null, last_error = null, updated_at = now() where id = p_conn;
  delete from public.integration_credentials where connection_id = p_conn;
  update public.integration_assets set selected = false where connection_id = p_conn;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'integration.disconnected', jsonb_build_object('connection_id', p_conn, 'provider', c.provider));
end $$;

create or replace function public.integration_save_mappings(p_org uuid, p_conn uuid, p_mappings jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; m jsonb;
begin
  perform public.integration_admin(p_org); c := public.integration_get(p_org, p_conn);
  if c.provider not in ('website_forms','meta_lead_ads') then raise exception 'This connection has no incoming fields.' using errcode = '22023'; end if;
  if jsonb_typeof(p_mappings) is distinct from 'array' or jsonb_array_length(p_mappings) > 60 then raise exception 'Invalid field mappings.' using errcode = '22023'; end if;
  for m in select * from jsonb_array_elements(p_mappings) loop
    if jsonb_typeof(m->'external_field') is distinct from 'string' or char_length(btrim(m->>'external_field')) not between 1 and 80 or coalesce(m->>'target', '') not in ('full_name','first_name','last_name','phone','email','summary','ignore') then
      raise exception 'Every mapping needs a field name and a valid CRM field.' using errcode = '22023'; end if;
  end loop;
  delete from public.integration_field_mappings where connection_id = p_conn;
  insert into public.integration_field_mappings (organization_id, connection_id, external_field, target)
    select p_org, p_conn, btrim(x->>'external_field'), x->>'target' from jsonb_array_elements(p_mappings) x on conflict (connection_id, external_field) do update set target = excluded.target;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'integration.mapping_saved', jsonb_build_object('connection_id', p_conn));
end $$;

create or replace function public.integration_set_config(p_org uuid, p_conn uuid, p_config jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; v jsonb := '{}'::jsonb;
begin
  perform public.integration_admin(p_org); c := public.integration_get(p_org, p_conn);
  if jsonb_typeof(p_config) is distinct from 'object' then raise exception 'Invalid configuration.' using errcode = '22023'; end if;
  if p_config ? 'rate_limit_per_min' then
    if (p_config->>'rate_limit_per_min') !~ '^[0-9]{1,3}$' or (p_config->>'rate_limit_per_min')::int not between 1 and 600 then raise exception 'The rate limit must be between 1 and 600 per minute.' using errcode = '22023'; end if;
    v := v || jsonb_build_object('rate_limit_per_min', (p_config->>'rate_limit_per_min')::int); end if;
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

create or replace function public.integration_store_credentials(p_org uuid, p_conn uuid, p_ciphertext text, p_expires_at timestamptz, p_key_version integer default 1) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.integration_admin(p_org); perform public.integration_get(p_org, p_conn);
  if coalesce(p_ciphertext, '') !~ '^v[0-9]+:' then raise exception 'Credentials must be encrypted by the application before they are stored.' using errcode = '22023'; end if;
  insert into public.integration_credentials (connection_id, organization_id, ciphertext, key_version, expires_at) values (p_conn, p_org, p_ciphertext, coalesce(p_key_version, 1), p_expires_at)
    on conflict (connection_id) do update set ciphertext = excluded.ciphertext, key_version = excluded.key_version, expires_at = excluded.expires_at, updated_at = now();
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'integration.credentials_updated', jsonb_build_object('connection_id', p_conn));
end $$;
-- ciphertext is returned to owners/admins only so the (server-side) app can decrypt it with its key; it is useless without that key
create or replace function public.integration_read_credentials(p_org uuid, p_conn uuid) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.integration_credentials;
begin
  perform public.integration_admin(p_org);
  select * into r from public.integration_credentials where connection_id = p_conn and organization_id = p_org;
  if not found then return null; end if;
  return jsonb_build_object('ciphertext', r.ciphertext, 'key_version', r.key_version, 'expires_at', r.expires_at);
end $$;
create or replace function public.integration_set_status(p_org uuid, p_conn uuid, p_status text, p_error text) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.integration_admin(p_org); perform public.integration_get(p_org, p_conn);
  perform public.integration_set_connection_state(p_conn, p_status, p_error);
end $$;

create or replace function public.integration_upsert_assets(p_org uuid, p_conn uuid, p_assets jsonb) returns void language plpgsql security definer set search_path = '' as $$
declare a jsonb;
begin
  perform public.integration_admin(p_org); perform public.integration_get(p_org, p_conn);
  if jsonb_typeof(p_assets) is distinct from 'array' or jsonb_array_length(p_assets) > 200 then raise exception 'Invalid asset list.' using errcode = '22023'; end if;
  for a in select * from jsonb_array_elements(p_assets) loop
    if a->>'kind' not in ('page','form','phone_number','waba','ad_account') or coalesce(a->>'external_id', '') = '' then raise exception 'Invalid asset.' using errcode = '22023'; end if;
    insert into public.integration_assets (organization_id, connection_id, kind, external_id, name, metadata) values (p_org, p_conn, a->>'kind', left(a->>'external_id', 100), left(a->>'name', 200), coalesce(a->'metadata', '{}'::jsonb))
      on conflict (connection_id, kind, external_id) do update set name = excluded.name, metadata = excluded.metadata;
  end loop;
end $$;
create or replace function public.integration_select_asset(p_org uuid, p_conn uuid, p_asset uuid, p_selected boolean) returns void language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections;
begin
  perform public.integration_admin(p_org); c := public.integration_get(p_org, p_conn);
  update public.integration_assets set selected = coalesce(p_selected, false) where id = p_asset and connection_id = p_conn;
  if not found then raise exception 'Asset not found.' using errcode = 'P0002'; end if;
exception when unique_violation then
  raise exception 'That page or phone number is already connected to another workspace.' using errcode = '23505';
end $$;

-- field NAMES (never values) seen in recent submissions, so the mapping screen can offer the real fields of the customer's form
create or replace function public.integration_observed_fields(p_org uuid, p_conn uuid) returns text[] language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.integration_admin(p_org);
  if not exists (select 1 from public.integration_connections where id = p_conn and organization_id = p_org) then raise exception 'Connection not found.' using errcode = 'P0002'; end if;
  return coalesce(array(select distinct k from (select jsonb_object_keys(e.payload) k from (select payload from public.integration_webhook_events where connection_id = p_conn and organization_id = p_org and kind = 'form_submission' order by received_at desc limit 20) e) x where k !~* '^(utm_|gclid|fbclid|msclkid)' order by k limit 60), '{}');
end $$;

-- ---------- privileges ----------
revoke all on function public.integration_sha256(text), public.integration_rand(), public.integration_hit(text, integer), public.integration_log_error(uuid, uuid, text, text, text, jsonb),
  public.integration_admin(uuid), public.integration_get(uuid, uuid), public.integration_map_fields(uuid, jsonb), public.integration_submit(public.integration_connections, jsonb, jsonb),
  public.integration_set_connection_state(uuid, text, text) from public, anon, authenticated;
revoke all on function public.integration_set_gateway_secret(text), public.integration_apply_status_events(integer), public.integration_claim_events(integer), public.integration_ingest_lead(uuid, jsonb, jsonb),
  public.integration_fail_event(uuid, text, boolean), public.integration_job(uuid, text, text, integer, text), public.integration_claim_requests(integer),
  public.integration_complete_request(uuid, boolean, text, text, boolean), public.integration_purge(integer) from public, anon, authenticated;
grant execute on function public.integration_set_gateway_secret(text), public.integration_apply_status_events(integer), public.integration_claim_events(integer), public.integration_ingest_lead(uuid, jsonb, jsonb),
  public.integration_fail_event(uuid, text, boolean), public.integration_job(uuid, text, text, integer, text), public.integration_claim_requests(integer),
  public.integration_complete_request(uuid, boolean, text, text, boolean), public.integration_purge(integer) to service_role;
-- public entry points: the credential in the arguments is the identity
revoke all on function public.integration_ingest_form(text, text, jsonb, text, jsonb), public.integration_receive_webhook(text, text, jsonb) from public;
grant execute on function public.integration_ingest_form(text, text, jsonb, text, jsonb), public.integration_receive_webhook(text, text, jsonb) to anon, authenticated, service_role;
revoke all on function public.integration_create_connection(uuid, text, text, jsonb), public.integration_rotate_secret(uuid, uuid), public.integration_disconnect(uuid, uuid), public.integration_save_mappings(uuid, uuid, jsonb),
  public.integration_set_config(uuid, uuid, jsonb), public.integration_store_credentials(uuid, uuid, text, timestamptz, integer), public.integration_read_credentials(uuid, uuid),
  public.integration_set_status(uuid, uuid, text, text), public.integration_upsert_assets(uuid, uuid, jsonb), public.integration_select_asset(uuid, uuid, uuid, boolean), public.integration_observed_fields(uuid, uuid) from public, anon;
grant execute on function public.integration_create_connection(uuid, text, text, jsonb), public.integration_rotate_secret(uuid, uuid), public.integration_disconnect(uuid, uuid), public.integration_save_mappings(uuid, uuid, jsonb),
  public.integration_set_config(uuid, uuid, jsonb), public.integration_store_credentials(uuid, uuid, text, timestamptz, integer), public.integration_read_credentials(uuid, uuid),
  public.integration_set_status(uuid, uuid, text, text), public.integration_upsert_assets(uuid, uuid, jsonb), public.integration_select_asset(uuid, uuid, uuid, boolean), public.integration_observed_fields(uuid, uuid) to authenticated;
