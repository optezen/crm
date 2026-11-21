-- 0020 Operational reliability: worker heartbeats and diagnostics, least-privilege worker role, scheduled maintenance, at-most-once message delivery,
-- messaging consent and an outbound message audit log, durable appointment reminders. 0001-0019 are untouched.
-- Principles: every queue is a table; workers hold no state; a crash can delay work but never lose or duplicate a business action. For effects that cannot be made
-- idempotent at the provider (sending a message) the rule is AT MOST ONCE: an ambiguous send is marked uncertain for a person to decide, never retried blindly.

-- ---------- least-privilege worker role ----------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'optizen_worker') then create role optizen_worker nologin noinherit; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticator') then execute 'grant optizen_worker to authenticator'; end if;
end $$;
grant usage on schema public to optizen_worker;

-- ---------- heartbeats ----------
create table public.worker_heartbeats (
  worker text not null check (worker in ('automation','integrations','maintenance')), instance text not null check (char_length(instance) between 1 and 80),
  started_at timestamptz not null default now(), last_seen timestamptz not null default now(), version text check (char_length(version) <= 40), stats jsonb not null default '{}'::jsonb check (octet_length(stats::text) <= 4000),
  last_error text check (char_length(last_error) <= 300), last_error_at timestamptz, primary key (worker, instance)
);
alter table public.worker_heartbeats enable row level security; revoke all on public.worker_heartbeats from anon, authenticated;
-- Workers report a class of error, never data: heartbeats are readable (through worker_status) by every organization's admins.
create or replace function public.worker_heartbeat(p_worker text, p_instance text, p_version text, p_stats jsonb, p_error text) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.worker_heartbeats (worker, instance, version, stats, last_error, last_error_at) values (p_worker, left(p_instance, 80), left(p_version, 40), coalesce(p_stats, '{}'::jsonb), left(p_error, 300), case when p_error is not null then now() end)
    on conflict (worker, instance) do update set last_seen = now(), version = excluded.version, stats = excluded.stats, last_error = coalesce(excluded.last_error, case when excluded.last_error is null and public.worker_heartbeats.last_error_at > now() - interval '10 minutes' then public.worker_heartbeats.last_error end), last_error_at = coalesce(excluded.last_error_at, public.worker_heartbeats.last_error_at);
  delete from public.worker_heartbeats where last_seen < now() - interval '7 days';
end $$;

-- ---------- consent, reminders, outbound audit ----------
create table public.messaging_consent (
  organization_id uuid not null references public.organizations(id) on delete cascade, contact_id uuid not null, channel text not null check (channel in ('whatsapp')),
  status text not null check (status in ('opted_in','opted_out')), source text not null check (source in ('staff','website_form','customer_reply','import')), note text check (char_length(note) <= 300),
  updated_by uuid, updated_at timestamptz not null default now(), primary key (organization_id, contact_id, channel), foreign key (contact_id, organization_id) references public.contacts (id, organization_id) on delete cascade
);
create table public.messaging_consent_log (id uuid primary key default gen_random_uuid(), organization_id uuid not null, contact_id uuid not null, channel text not null, status text not null, source text not null, note text, actor_id uuid, created_at timestamptz not null default now());
create index messaging_consent_log_idx on public.messaging_consent_log (organization_id, contact_id, created_at desc);
alter table public.messaging_consent enable row level security; alter table public.messaging_consent_log enable row level security;
revoke all on public.messaging_consent, public.messaging_consent_log from anon, authenticated; grant select on public.messaging_consent, public.messaging_consent_log to authenticated;
create policy messaging_consent_read on public.messaging_consent for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager') or exists (select 1 from public.leads l where l.contact_id = messaging_consent.contact_id));
create policy messaging_consent_log_read on public.messaging_consent_log for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager') or exists (select 1 from public.leads l where l.contact_id = messaging_consent_log.contact_id));
create or replace function public.consent_set(p_org uuid, p_contact uuid, p_status text, p_source text, p_note text) returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_cur text; v_note text := left(btrim(coalesce(p_note, '')), 300); v_role text := public.crm_member_role(p_org);
begin
  if p_status not in ('opted_in','opted_out') or p_source not in ('staff','website_form','customer_reply','import') then raise exception 'Invalid consent.' using errcode = '22023'; end if;
  if not exists (select 1 from public.contacts where id = p_contact and organization_id = p_org) then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  if v_role not in ('owner','admin','manager') and not public.contact_known_to_caller(p_contact) then raise exception 'Contact not found.' using errcode = 'P0002'; end if;
  if p_source <> 'staff' and v_uid is not null then raise exception 'Only the system can record that source.' using errcode = '42501'; end if;
  if p_status = 'opted_in' and char_length(v_note) < 3 then raise exception 'Say how the customer agreed to receive WhatsApp messages (at least 3 characters).' using errcode = '22023'; end if;
  select status into v_cur from public.messaging_consent where organization_id = p_org and contact_id = p_contact and channel = 'whatsapp';
  insert into public.messaging_consent (organization_id, contact_id, channel, status, source, note, updated_by) values (p_org, p_contact, 'whatsapp', p_status, p_source, nullif(v_note, ''), v_uid)
    on conflict (organization_id, contact_id, channel) do update set status = excluded.status, source = excluded.source, note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  insert into public.messaging_consent_log (organization_id, contact_id, channel, status, source, note, actor_id) values (p_org, p_contact, 'whatsapp', p_status, p_source, nullif(v_note, ''), v_uid);
  -- an opt-out also cancels anything not yet sent to this person
  if p_status = 'opted_out' then update public.integration_requests set status = 'cancelled', last_error = 'The customer opted out.', updated_at = now() where organization_id = p_org and status = 'requested' and channel = 'whatsapp' and (nullif(payload->>'contact_id', '')::uuid = p_contact or exists (select 1 from public.leads l where l.id = nullif(payload->>'lead_id', '')::uuid and l.contact_id = p_contact)); end if;
end $$;

create table public.outbound_message_log (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, request_id uuid, connection_id uuid,
  event text not null check (event in ('queued','claimed','sent','retry','failed','uncertain','delivered','read','blocked_no_consent','blocked_opt_out','blocked_no_provider','requeued','cancelled')),
  detail text check (char_length(detail) <= 300), template text check (char_length(template) <= 120), created_at timestamptz not null default now()
); -- no message text and no phone numbers are ever written here
create index outbound_message_log_idx on public.outbound_message_log (organization_id, created_at desc);
alter table public.outbound_message_log enable row level security; revoke all on public.outbound_message_log from anon, authenticated; grant select on public.outbound_message_log to authenticated;
create policy outbound_message_log_read on public.outbound_message_log for select to authenticated using (public.org_role(organization_id) in ('owner','admin'));
create or replace function public.outbound_log(p_org uuid, p_req uuid, p_conn uuid, p_event text, p_detail text, p_template text) returns void language sql security definer set search_path = '' as $$
  insert into public.outbound_message_log (organization_id, request_id, connection_id, event, detail, template) values (p_org, p_req, p_conn, p_event, left(p_detail, 300), left(p_template, 120));
$$;

-- ---------- message requests: not tied to automations any more, deduplicated, consent-gated, at-most-once ----------
alter table public.integration_requests alter column run_id drop not null, alter column step_index drop not null;
alter table public.integration_requests add column if not exists dedupe_key text, add column if not exists kind text not null default 'automation' check (kind in ('automation','reminder'));
create unique index if not exists integration_requests_dedupe_uq on public.integration_requests (organization_id, dedupe_key) where dedupe_key is not null;

create or replace function public.integration_claim_requests(p_limit integer default 10) returns table (id uuid, organization_id uuid, connection_id uuid, payload jsonb, config jsonb, attempts integer) language plpgsql security definer set search_path = '' as $$
declare r record; v_contact uuid; v_status text;
begin
  -- 1. consent gate: anything for a contact without recorded opt-in (or with an opt-out) is stopped here, visibly, and never reaches the provider
  for r in select q.id, q.organization_id, q.payload, c.id cid from public.integration_requests q join public.integration_connections c on c.organization_id = q.organization_id and c.provider = 'whatsapp' and c.status = 'connected'
      where q.channel = 'whatsapp' and q.status = 'requested' and q.next_attempt_at <= now() order by q.created_at limit 200 for update of q skip locked loop
    v_contact := coalesce(nullif(r.payload->>'contact_id', '')::uuid, (select l.contact_id from public.leads l where l.id = nullif(r.payload->>'lead_id', '')::uuid and l.organization_id = r.organization_id));
    select m.status into v_status from public.messaging_consent m where m.organization_id = r.organization_id and m.contact_id = v_contact and m.channel = 'whatsapp';
    if v_contact is null or v_status is distinct from 'opted_in' then
      update public.integration_requests set status = 'failed', last_error = case when v_status = 'opted_out' then 'Not sent: the customer opted out of WhatsApp messages.' else 'Not sent: no WhatsApp consent is recorded for this contact. Record how they agreed on the lead page.' end, updated_at = now() where integration_requests.id = r.id;
      perform public.outbound_log(r.organization_id, r.id, r.cid, case when v_status = 'opted_out' then 'blocked_opt_out' else 'blocked_no_consent' end, null, null);
    end if;
  end loop;
  -- 2. claim the rest. Only never-attempted requests and ones that failed in a RETRYABLE way are claimed; a request left 'sending' by a crash is NOT re-sent (see maintenance_tick).
  return query with due as (
      select q.id rid, c.id cid from public.integration_requests q join public.integration_connections c on c.organization_id = q.organization_id and c.provider = 'whatsapp' and c.status = 'connected'
      where q.channel = 'whatsapp' and q.status = 'requested' and q.next_attempt_at <= now() order by q.created_at limit greatest(1, least(p_limit, 50)) for update of q skip locked)
    update public.integration_requests q set status = 'sending', attempts = q.attempts + 1, locked_until = now() + interval '5 minutes', provider = 'whatsapp', updated_at = now()
    from due join public.integration_connections c on c.id = due.cid where q.id = due.rid
    returning q.id, q.organization_id, c.id, q.payload, c.config, q.attempts;
end $$;

create or replace function public.integration_complete_request(p_request uuid, p_ok boolean, p_message_id text, p_error text, p_retryable boolean) returns text language plpgsql security definer set search_path = '' as $$
declare r public.integration_requests; v_status text; v_conn uuid;
begin
  select * into r from public.integration_requests where id = p_request for update;
  if not found then return 'missing'; end if;
  select id into v_conn from public.integration_connections where organization_id = r.organization_id and provider = 'whatsapp';
  if r.status in ('sent','delivered','read') then return r.status; end if;               -- completing twice changes nothing
  if r.status = 'cancelled' then return 'cancelled'; end if;
  if p_ok then
    update public.integration_requests set status = 'sent', provider_message_id = p_message_id, locked_until = null, last_error = null, updated_at = now() where id = p_request;
    perform public.outbound_log(r.organization_id, p_request, v_conn, 'sent', null, r.payload->>'template_name'); return 'sent';
  end if;
  v_status := case when p_retryable and r.attempts < 5 then 'requested' else 'failed' end;
  update public.integration_requests set status = v_status, locked_until = null, last_error = left(p_error, 500), updated_at = now(), next_attempt_at = now() + make_interval(mins => power(2, least(r.attempts, 8))::int) where id = p_request;
  perform public.outbound_log(r.organization_id, p_request, v_conn, case when v_status = 'failed' then 'failed' else 'retry' end, p_error, r.payload->>'template_name');
  perform public.integration_log_error(r.organization_id, v_conn, 'whatsapp', case when v_status = 'failed' then 'send_failed' else 'retry' end, p_error, jsonb_build_object('request_id', p_request, 'attempt', r.attempts));
  return v_status;
end $$;

-- an administrator can deliberately send an uncertain or failed message again (they accept the duplicate risk)
create or replace function public.integration_requeue_request(p_org uuid, p_request uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.integration_admin(p_org);
  update public.integration_requests set status = 'requested', attempts = 0, next_attempt_at = now(), locked_until = null, last_error = null, updated_at = now() where id = p_request and organization_id = p_org and status = 'failed' and provider_message_id is null;
  if not found then raise exception 'Only a failed message that was not accepted by the provider can be sent again.' using errcode = '22023'; end if;
  perform public.outbound_log(p_org, p_request, null, 'requeued', 'by ' || (select auth.uid())::text, null);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'message.requeued', jsonb_build_object('request_id', p_request));
end $$;

-- ---------- appointment reminders ----------
create table public.reminder_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade, enabled boolean not null default false,
  offsets integer[] not null default '{1440,60}' check (cardinality(offsets) between 1 and 4), notify_staff boolean not null default true, notify_customer boolean not null default false,
  whatsapp_template text check (char_length(whatsapp_template) <= 120), whatsapp_language text check (whatsapp_language ~ '^[a-z]{2}(_[A-Z]{2})?$'), quiet_from time, quiet_to time, updated_at timestamptz not null default now()
);
create table public.appointment_reminders (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, appointment_id uuid not null references public.appointments(id) on delete cascade,
  starts_at timestamptz not null, offset_minutes integer not null, audience text not null check (audience in ('staff','customer')), due_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sent','queued','cancelled','skipped','failed')), reason text check (char_length(reason) <= 300), request_id uuid, processed_at timestamptz,
  unique (appointment_id, starts_at, offset_minutes, audience)
);
create index appointment_reminders_due_idx on public.appointment_reminders (due_at) where status = 'pending';
alter table public.reminder_settings enable row level security; alter table public.appointment_reminders enable row level security;
revoke all on public.reminder_settings, public.appointment_reminders from anon, authenticated; grant select on public.reminder_settings, public.appointment_reminders to authenticated;
create policy reminder_settings_read on public.reminder_settings for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
create policy appointment_reminders_read on public.appointment_reminders for select to authenticated using (public.org_role(organization_id) in ('owner','admin','manager'));
create or replace function public.reminder_settings_save(p_org uuid, p_enabled boolean, p_offsets integer[], p_staff boolean, p_customer boolean, p_template text, p_language text, p_quiet_from time, p_quiet_to time) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can change reminder settings.' using errcode = '42501'; end if;
  if coalesce(cardinality(p_offsets), 0) not between 1 and 4 or exists (select 1 from unnest(p_offsets) o where o not between 5 and 10080) or (select count(distinct o) from unnest(p_offsets) o) <> cardinality(p_offsets) then raise exception 'Choose 1 to 4 different reminder times between 5 minutes and 7 days before.' using errcode = '22023'; end if;
  if coalesce(p_customer, false) and (coalesce(btrim(p_template), '') = '' or p_language is null) then raise exception 'Customer reminders need the name and language of an approved WhatsApp template.' using errcode = '22023'; end if;
  if p_language is not null and p_language !~ '^[a-z]{2}(_[A-Z]{2})?$' then raise exception 'Use a language code such as en or en_GB.' using errcode = '22023'; end if;
  if (p_quiet_from is null) <> (p_quiet_to is null) then raise exception 'Set both quiet hours times, or neither.' using errcode = '22023'; end if;
  insert into public.reminder_settings (organization_id, enabled, offsets, notify_staff, notify_customer, whatsapp_template, whatsapp_language, quiet_from, quiet_to) values (p_org, coalesce(p_enabled, false), p_offsets, coalesce(p_staff, true), coalesce(p_customer, false), nullif(btrim(p_template), ''), p_language, p_quiet_from, p_quiet_to)
    on conflict (organization_id) do update set enabled = excluded.enabled, offsets = excluded.offsets, notify_staff = excluded.notify_staff, notify_customer = excluded.notify_customer, whatsapp_template = excluded.whatsapp_template, whatsapp_language = excluded.whatsapp_language, quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to, updated_at = now();
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'reminders.settings_saved', jsonb_build_object('enabled', p_enabled, 'offsets', p_offsets));
  perform public.reminders_sync_org(p_org);
end $$;

-- (Re)builds the schedule for ONE appointment. Rescheduling creates new rows for the new start time and cancels the old pending ones; a row that was already sent is never sent again.
create or replace function public.reminders_sync(p_appt uuid) returns void language plpgsql security definer set search_path = '' as $$
declare a public.appointments; s public.reminder_settings; o integer; aud text;
begin
  select * into a from public.appointments where id = p_appt; if not found then return; end if;
  select * into s from public.reminder_settings where organization_id = a.organization_id;
  update public.appointment_reminders set status = 'cancelled', reason = case when a.status not in ('scheduled','confirmed') then 'The appointment is ' || a.status || '.' else 'The appointment was rescheduled.' end, processed_at = now()
    where appointment_id = p_appt and status = 'pending' and (a.status not in ('scheduled','confirmed') or starts_at <> a.starts_at or s is null or not s.enabled or offset_minutes <> all (s.offsets));
  if s is null or not s.enabled or a.status not in ('scheduled','confirmed') or a.starts_at <= now() then return; end if;
  foreach o in array s.offsets loop
    if a.starts_at - make_interval(mins => o) <= now() then continue; end if; -- a reminder time already in the past is not created retroactively
    foreach aud in array array['staff','customer'] loop
      if (aud = 'staff' and (not s.notify_staff or a.staff_id is null)) or (aud = 'customer' and (not s.notify_customer or a.contact_id is null)) then continue; end if;
      insert into public.appointment_reminders (organization_id, appointment_id, starts_at, offset_minutes, audience, due_at) values (a.organization_id, a.id, a.starts_at, o, aud, a.starts_at - make_interval(mins => o))
        on conflict (appointment_id, starts_at, offset_minutes, audience) do update set status = 'pending', reason = null, processed_at = null, due_at = excluded.due_at where public.appointment_reminders.status = 'cancelled';
    end loop;
  end loop;
end $$;
create or replace function public.reminders_sync_org(p_org uuid) returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  update public.appointment_reminders set status = 'cancelled', reason = 'Reminders were turned off or changed.', processed_at = now() where organization_id = p_org and status = 'pending' and not exists (select 1 from public.reminder_settings s where s.organization_id = p_org and s.enabled);
  for r in select id from public.appointments where organization_id = p_org and status in ('scheduled','confirmed') and starts_at > now() loop perform public.reminders_sync(r.id); end loop;
end $$;
create or replace function public.reminders_appt_trg() returns trigger language plpgsql security definer set search_path = '' as $$ begin perform public.reminders_sync(new.id); return null; end $$;
create trigger reminders_appt after insert or update of starts_at, status, staff_id, contact_id on public.appointments for each row execute function public.reminders_appt_trg();

-- Delivers due reminders. Staff: an in-app notification (always available). Customer: only through a CONNECTED WhatsApp provider, an approved template, a phone number and recorded consent;
-- otherwise the reminder is skipped WITH the reason (never silently, never as "sent"). Customer messages carry the appointment type and local time only: no notes, no staff, no other details.
create or replace function public.reminders_process(p_limit integer default 50) returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.appointment_reminders; a public.appointments; s public.reminder_settings; v_tz text; v_local timestamp; v_type text; v_phone text; v_status text; v_conn uuid; v_req uuid; v_sent int := 0; v_skipped int := 0; v_q int := 0; v_due timestamptz; v_lf time; v_when text;
begin
  for r in select * from public.appointment_reminders where status = 'pending' and due_at <= now() order by due_at limit greatest(1, least(p_limit, 200)) for update skip locked loop
    select * into a from public.appointments where id = r.appointment_id; select * into s from public.reminder_settings where organization_id = r.organization_id;
    if a.id is null or a.status not in ('scheduled','confirmed') or a.starts_at <> r.starts_at or s is null or not s.enabled then update public.appointment_reminders set status = 'cancelled', reason = 'No longer applicable.', processed_at = now() where id = r.id; continue; end if;
    if a.starts_at <= now() then update public.appointment_reminders set status = 'skipped', reason = 'The appointment has already started.', processed_at = now() where id = r.id; v_skipped := v_skipped + 1; continue; end if;
    select coalesce((c.definition #>> '{operations,appointments,timezone}'), 'UTC') into v_tz from public.workspace_configuration_versions c where c.organization_id = r.organization_id and c.status = 'published' order by c.revision desc limit 1;
    if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_tz) then v_tz := 'UTC'; end if;
    v_local := (now() at time zone v_tz)::timestamp;
    -- quiet hours are evaluated in the ORGANIZATION's time zone (they may wrap midnight); a reminder is deferred to the end of the window, or skipped if that would be after the appointment
    if s.quiet_from is not null and (case when s.quiet_from <= s.quiet_to then v_local::time >= s.quiet_from and v_local::time < s.quiet_to else v_local::time >= s.quiet_from or v_local::time < s.quiet_to end) then
      v_due := (((v_local::date + case when s.quiet_from > s.quiet_to and v_local::time >= s.quiet_from then 1 else 0 end) + s.quiet_to)::timestamp at time zone v_tz);
      if v_due >= a.starts_at then update public.appointment_reminders set status = 'skipped', reason = 'It would fall in quiet hours and after the appointment starts.', processed_at = now() where id = r.id; v_skipped := v_skipped + 1;
      else update public.appointment_reminders set due_at = v_due where id = r.id; end if; continue; end if;
    select name into v_type from public.appointment_types where id = a.type_id; v_when := to_char((a.starts_at at time zone v_tz), 'DD Mon YYYY "at" HH24:MI') || ' (' || v_tz || ')';
    if r.audience = 'staff' then
      if public.notif_enabled(r.organization_id, a.staff_id, 'reminder') then insert into public.notifications (organization_id, user_id, title, body, link, category, dedupe_key) values (r.organization_id, a.staff_id, left('Appointment reminder: ' || coalesce(v_type, 'Appointment'), 120), v_when, '/work/appointments/' || a.id, 'reminder', 'reminder:' || r.id) on conflict do nothing; end if;
      update public.appointment_reminders set status = 'sent', processed_at = now() where id = r.id; v_sent := v_sent + 1;
    else
      select id into v_conn from public.integration_connections where organization_id = r.organization_id and provider = 'whatsapp' and status = 'connected';
      select phone into v_phone from public.contacts where id = a.contact_id; select status into v_status from public.messaging_consent where organization_id = r.organization_id and contact_id = a.contact_id and channel = 'whatsapp';
      if v_conn is null or s.whatsapp_template is null or v_phone is null or v_status is distinct from 'opted_in' then
        update public.appointment_reminders set status = 'skipped', processed_at = now(), reason = case when v_conn is null then 'No WhatsApp provider is connected.' when s.whatsapp_template is null then 'No approved WhatsApp template is set for reminders.' when v_phone is null then 'The contact has no phone number.' when v_status = 'opted_out' then 'The customer opted out.' else 'No WhatsApp consent is recorded.' end where id = r.id;
        perform public.outbound_log(r.organization_id, null, v_conn, case when v_status = 'opted_out' then 'blocked_opt_out' when v_conn is null then 'blocked_no_provider' else 'blocked_no_consent' end, 'appointment reminder', s.whatsapp_template); v_skipped := v_skipped + 1;
      else
        insert into public.integration_requests (organization_id, channel, kind, dedupe_key, payload, provider) values (r.organization_id, 'whatsapp', 'reminder', 'reminder:' || r.id,
          jsonb_build_object('contact_id', a.contact_id, 'phone', v_phone, 'template_name', s.whatsapp_template, 'template_language', s.whatsapp_language, 'params', jsonb_build_array(coalesce(v_type, 'Appointment'), to_char((a.starts_at at time zone v_tz), 'DD Mon YYYY'), to_char((a.starts_at at time zone v_tz), 'HH24:MI'))), 'whatsapp')
          on conflict (organization_id, dedupe_key) where dedupe_key is not null do nothing returning id into v_req;
        update public.appointment_reminders set status = 'queued', request_id = v_req, processed_at = now() where id = r.id; perform public.outbound_log(r.organization_id, v_req, v_conn, 'queued', 'appointment reminder', s.whatsapp_template); v_q := v_q + 1;
      end if;
    end if;
  end loop;
  return jsonb_build_object('staff_sent', v_sent, 'customer_queued', v_q, 'skipped', v_skipped);
end $$;

-- notifications: a category for reminders, muteable per person
alter table public.notification_prefs add column if not exists reminder boolean not null default true;
alter table public.notifications drop constraint if exists notifications_category_check;
alter table public.notifications add constraint notifications_category_check check (category in ('automation','task_assigned','lead_assigned','task_overdue','reminder'));
create or replace function public.notif_enabled(p_org uuid, p_user uuid, p_category text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select case p_category when 'task_assigned' then task_assigned when 'lead_assigned' then lead_assigned when 'task_overdue' then task_overdue when 'reminder' then reminder else automation end from public.notification_prefs where user_id = p_user and organization_id = p_org), true)
$$;

-- ---------- scheduled maintenance (run by the maintenance worker; safe to run from several workers: one runs, the others skip) ----------
create or replace function public.maintenance_tick() returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_overdue int; v_uncertain int; v_rem jsonb; v_purged int; v_tomorrow int;
begin
  if not pg_try_advisory_xact_lock(hashtext('optizen:maintenance')) then return jsonb_build_object('skipped', 'another maintenance run is active'); end if;
  -- 1. overdue follow-ups for everyone, once per task per day, only for active members who have not muted them (in-app only)
  with ins as (insert into public.notifications (organization_id, user_id, title, body, link, category, dedupe_key)
    select t.organization_id, t.owner_id, left('Overdue: ' || t.title, 120), 'Was due ' || to_char(t.due_date, 'DD Mon YYYY'), '/work/leads/' || t.lead_id, 'task_overdue', 'overdue:' || t.id || ':' || current_date
    from public.tasks t join public.organization_members m on m.organization_id = t.organization_id and m.user_id = t.owner_id and m.active
    where t.status = 'open' and t.due_date < current_date and public.notif_enabled(t.organization_id, t.owner_id, 'task_overdue') on conflict do nothing returning 1) select count(*) into v_overdue from ins;
  -- 2. a message left "sending" by a crashed worker may or may not have reached the customer: never resend automatically
  with u as (update public.integration_requests set status = 'failed', locked_until = null, updated_at = now(), last_error = 'Delivery uncertain: the worker stopped while sending. It was not retried automatically, to avoid sending the customer a duplicate. If they did not receive it, send it again.'
    where status = 'sending' and locked_until < now() and provider_message_id is null returning id, organization_id, payload) select count(*) into v_uncertain from u;
  insert into public.outbound_message_log (organization_id, request_id, event, detail) select organization_id, id, 'uncertain', 'worker stopped while sending' from public.integration_requests where status = 'failed' and last_error like 'Delivery uncertain:%' and updated_at > now() - interval '1 minute' and not exists (select 1 from public.outbound_message_log l where l.request_id = integration_requests.id and l.event = 'uncertain');
  -- 3. due appointment reminders
  v_rem := public.reminders_process(200);
  -- 4. housekeeping
  v_purged := public.integration_purge(30); delete from public.ai_requests where created_at < now() - interval '2 days'; delete from public.outbound_message_log where created_at < now() - interval '180 days';
  return jsonb_build_object('overdue_notifications', v_overdue, 'uncertain_messages', v_uncertain, 'reminders', v_rem, 'purged', v_purged);
end $$;

-- ---------- administrator diagnostics ----------
create or replace function public.worker_status(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can view background processing.' using errcode = '42501'; end if;
  return jsonb_build_object('now', now(),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('worker', w.worker, 'instance', w.instance, 'last_seen', w.last_seen, 'started_at', w.started_at, 'version', w.version, 'healthy', w.last_seen > now() - interval '2 minutes', 'last_error', w.last_error, 'last_error_at', w.last_error_at, 'stats', w.stats) order by w.worker, w.instance) from public.worker_heartbeats w), '[]'::jsonb),
    'queues', jsonb_build_object(
      'automation_runs', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.automation_runs where organization_id = p_org and status in ('queued','waiting','retrying','dead') group by status) x), '{}'::jsonb),
      'oldest_queued_run_seconds', (select extract(epoch from now() - min(next_attempt_at))::int from public.automation_runs where organization_id = p_org and status in ('queued','retrying') and next_attempt_at <= now()),
      'webhook_events', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.integration_webhook_events where organization_id = p_org and status in ('received','processing','failed','dead') group by status) x), '{}'::jsonb),
      'messages', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from public.integration_requests where organization_id = p_org and channel = 'whatsapp' and status in ('requested','sending','failed') group by status) x), '{}'::jsonb),
      'uncertain_messages', (select count(*) from public.integration_requests where organization_id = p_org and status = 'failed' and last_error like 'Delivery uncertain:%'),
      'reminders_pending', (select count(*) from public.appointment_reminders where organization_id = p_org and status = 'pending')));
end $$;
create or replace function public.outbound_messages_recent(p_org uuid, p_limit integer default 50) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.crm_member_role(p_org) not in ('owner','admin') then raise exception 'Only owners and admins can view the message log.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x) from (select jsonb_build_object('id', l.id, 'request_id', l.request_id, 'event', l.event, 'detail', l.detail, 'template', l.template, 'at', l.created_at, 'can_requeue', exists (select 1 from public.integration_requests q where q.id = l.request_id and q.status = 'failed' and q.provider_message_id is null)) x from public.outbound_message_log l where l.organization_id = p_org order by l.created_at desc limit least(greatest(p_limit, 1), 200)) y), '[]'::jsonb);
end $$;

-- ---------- grants ----------
revoke all on function public.worker_heartbeat(text, text, text, jsonb, text), public.maintenance_tick(), public.reminders_process(integer), public.reminders_sync(uuid), public.reminders_sync_org(uuid), public.reminders_appt_trg(), public.outbound_log(uuid, uuid, uuid, text, text, text),
  public.consent_set(uuid, uuid, text, text, text), public.integration_requeue_request(uuid, uuid), public.reminder_settings_save(uuid, boolean, integer[], boolean, boolean, text, text, time, time), public.worker_status(uuid), public.outbound_messages_recent(uuid, integer) from public, anon, authenticated;
revoke all on function public.integration_claim_requests(integer), public.integration_complete_request(uuid, boolean, text, text, boolean) from public, anon, authenticated;
grant execute on function public.consent_set(uuid, uuid, text, text, text), public.integration_requeue_request(uuid, uuid), public.reminder_settings_save(uuid, boolean, integer[], boolean, boolean, text, text, time, time), public.worker_status(uuid), public.outbound_messages_recent(uuid, integer) to authenticated;
grant execute on function public.worker_heartbeat(text, text, text, jsonb, text), public.maintenance_tick(), public.reminders_process(integer), public.integration_claim_requests(integer), public.integration_complete_request(uuid, boolean, text, text, boolean) to service_role;
-- the worker role may call exactly the worker API and read the encrypted credential blob; it has no other table access
grant execute on function public.worker_heartbeat(text, text, text, jsonb, text), public.maintenance_tick(), public.reminders_process(integer), public.automation_tick(integer, integer), public.integration_apply_status_events(integer), public.integration_claim_events(integer), public.integration_ingest_lead(uuid, jsonb, jsonb),
  public.integration_fail_event(uuid, text, boolean), public.integration_set_connection_state(uuid, text, text), public.integration_job(uuid, text, text, integer, text), public.integration_claim_requests(integer), public.integration_complete_request(uuid, boolean, text, text, boolean), public.integration_purge(integer) to optizen_worker;
grant select (connection_id, ciphertext) on public.integration_credentials to optizen_worker;

-- ---------- delivery status processing: reconcile uncertain sends, honour provider opt-out signals ----------
create or replace function public.integration_apply_status_events(p_limit integer default 100) returns integer language plpgsql security definer set search_path = '' as $$
declare ev public.integration_webhook_events; v_n int := 0; v_status text; v_req uuid;
begin
  for ev in select * from public.integration_webhook_events where kind = 'whatsapp_status' and status in ('received','failed') and next_attempt_at <= now() order by received_at limit greatest(1, least(p_limit, 500)) for update skip locked loop
    v_status := case ev.payload->>'status' when 'sent' then 'sent' when 'delivered' then 'delivered' when 'read' then 'read' when 'failed' then 'failed' end;
    select id into v_req from public.integration_requests where organization_id = ev.organization_id and provider = 'whatsapp' and provider_message_id = ev.payload->>'message_id';
    -- Reconcile an ambiguous send: the provider echoes our request id (biz_opaque_callback_data). If the message was accepted although we never recorded its id (crash, uncertain), attach it now.
    if v_req is null and (ev.payload->>'callback') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      update public.integration_requests set provider_message_id = ev.payload->>'message_id', status = 'sent', last_error = null, locked_until = null, updated_at = now()
        where id = (ev.payload->>'callback')::uuid and organization_id = ev.organization_id and channel = 'whatsapp' and provider_message_id is null and status in ('failed','sending','requested') returning id into v_req;
      if v_req is not null then perform public.outbound_log(ev.organization_id, v_req, ev.connection_id, 'sent', 'reconciled from a delivery status after an uncertain send', null); end if;
    end if;
    if v_status is null or v_req is null then
      update public.integration_webhook_events set status = 'ignored', processed_at = now(), last_error = case when v_req is null then 'No matching message request.' else 'Unsupported status.' end where id = ev.id;
    else
      -- never move backwards (read -> delivered) and never overwrite a terminal failure with a late "sent"
      update public.integration_requests set status = v_status, updated_at = now(), last_error = case when v_status = 'failed' then left(ev.payload->>'error', 500) else last_error end
        where id = v_req and array_position(array['requested','sending','sent','delivered','read'], status) < array_position(array['requested','sending','sent','delivered','read'], v_status) or (id = v_req and v_status = 'failed' and status in ('sending','sent'));
      update public.integration_webhook_events set status = 'processed', processed_at = now() where id = ev.id;
      -- 131050: the customer stopped marketing messages from this business. Record the opt-out so nothing further is sent to them.
      if v_status = 'failed' and (ev.payload->>'error') like '131050%' then
        insert into public.messaging_consent (organization_id, contact_id, channel, status, source, note) select r.organization_id, coalesce(nullif(r.payload->>'contact_id', '')::uuid, (select l.contact_id from public.leads l where l.id = nullif(r.payload->>'lead_id', '')::uuid)), 'whatsapp', 'opted_out', 'customer_reply', 'WhatsApp reported the customer stopped messages from this business (131050).'
          from public.integration_requests r where r.id = v_req and coalesce(nullif(r.payload->>'contact_id', '')::uuid, (select l.contact_id from public.leads l where l.id = nullif(r.payload->>'lead_id', '')::uuid)) is not null
          on conflict (organization_id, contact_id, channel) do update set status = 'opted_out', source = 'customer_reply', note = excluded.note, updated_at = now();
      end if;
      if v_status = 'failed' then perform public.integration_log_error(ev.organization_id, ev.connection_id, 'whatsapp', 'delivery_failed', coalesce(ev.payload->>'error', 'Delivery failed'), jsonb_build_object('request_id', v_req)); end if;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- an administrator can put a dead or failed incoming-lead event back in the queue (for example after reconnecting Meta)
create or replace function public.integration_requeue_event(p_org uuid, p_event uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.integration_admin(p_org);
  update public.integration_webhook_events set status = 'received', attempts = 0, next_attempt_at = now(), locked_until = null, last_error = null where id = p_event and organization_id = p_org and kind = 'meta_leadgen' and status in ('dead','failed') and payload <> '{}'::jsonb;
  if not found then raise exception 'Only a failed incoming lead that still has its data can be retried.' using errcode = '22023'; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'integration.event_requeued', jsonb_build_object('event_id', p_event));
end $$;
revoke all on function public.integration_requeue_event(uuid, uuid) from public, anon; grant execute on function public.integration_requeue_event(uuid, uuid) to authenticated;

-- ---------- payment gateway foundation ----------
-- Money is recorded ONLY from verified provider evidence: the web route verifies the gateway's signature (per-connection secret) and passes normalized events here; nothing the browser
-- or a customer sends can create a payment. Events are stored once (duplicate callbacks are ignored), applied through the single payment posting function (so partial payments, the
-- balance check and the ledger all apply), and anything that cannot be applied cleanly is HELD for a person with the reason, never guessed or force-applied.
create table public.payment_gateway_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade, connection_id uuid not null references public.integration_connections(id) on delete cascade,
  event_id text not null check (char_length(event_id) between 1 and 200), kind text not null check (kind in ('payment_captured','payment_failed','refund_processed')),
  provider_payment_id text not null check (char_length(provider_payment_id) between 1 and 120), invoice_id uuid, amount numeric(18,2) check (amount is null or amount > 0), currency text check (currency ~ '^[A-Z]{3}$'), method text check (method in ('cash','bank_transfer','card','upi','cheque','other')),
  state text not null default 'received' check (state in ('received','applied','held','ignored')), reason text check (char_length(reason) <= 300), payment_id uuid, attempts integer not null default 0,
  received_at timestamptz not null default now(), processed_at timestamptz, unique (connection_id, event_id)
);
create index payment_gateway_events_due_idx on public.payment_gateway_events (received_at) where state = 'received';
alter table public.payment_gateway_events enable row level security; revoke all on public.payment_gateway_events from anon, authenticated; grant select on public.payment_gateway_events to authenticated;
create policy payment_gateway_events_read on public.payment_gateway_events for select to authenticated using (public.org_role(organization_id) in ('owner','admin') and public.perm_ok(organization_id, 'billing', 'view'));

create or replace function public.payments_connection_create(p_org uuid, p_name text, p_gateway text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_public text := left(public.integration_rand(), 16);
begin
  perform public.integration_admin(p_org);
  if public.ops_require(p_org, 'billing') not in ('owner','admin') then raise exception 'Only owners and admins can connect a payment gateway.' using errcode = '42501'; end if;
  if p_gateway not in ('razorpay') then raise exception 'That payment gateway is not supported yet.' using errcode = '22023'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'Name the connection.' using errcode = '22023'; end if;
  if exists (select 1 from public.integration_connections where organization_id = p_org and provider = 'payments' and status <> 'not_connected') then raise exception 'A payment gateway is already set up.' using errcode = '23505'; end if;
  insert into public.integration_connections (organization_id, provider, name, status, public_id, config, created_by) values (p_org, 'payments', btrim(p_name), 'setup_required', v_public, jsonb_build_object('gateway', p_gateway), (select auth.uid())) returning id into v_id;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'integration.created', jsonb_build_object('connection_id', v_id, 'provider', 'payments'));
  return jsonb_build_object('id', v_id, 'public_id', v_public);
end $$;

-- the web route (anon key + gateway secret) asks for the encrypted webhook secret of ONE connection, then verifies the signature itself
create or replace function public.payment_gateway_connection(p_public_id text, p_gateway_secret text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; k public.integration_credentials;
begin
  if not exists (select 1 from public.integration_gateway where secret_hash = public.integration_sha256(p_gateway_secret)) then perform public.integration_hit('gateway-fail', 1000000); return jsonb_build_object('status', 'unauthorized'); end if;
  select * into c from public.integration_connections where public_id = p_public_id and provider = 'payments' and status in ('connected','setup_required');
  if not found then return jsonb_build_object('status', 'unknown'); end if;
  select * into k from public.integration_credentials where connection_id = c.id; if not found then return jsonb_build_object('status', 'no_secret'); end if;
  return jsonb_build_object('status', 'ok', 'connection_id', c.id, 'gateway', c.config->>'gateway', 'ciphertext', k.ciphertext);
end $$;
create or replace function public.payment_gateway_receive(p_conn uuid, p_gateway_secret text, p_events jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.integration_connections; e jsonb; v_new int := 0; v_dup int := 0; v_bad int := 0; v_id uuid;
begin
  if not exists (select 1 from public.integration_gateway where secret_hash = public.integration_sha256(p_gateway_secret)) then perform public.integration_hit('gateway-fail', 1000000); return jsonb_build_object('status', 'unauthorized'); end if;
  select * into c from public.integration_connections where id = p_conn and provider = 'payments' and status in ('connected','setup_required'); if not found then return jsonb_build_object('status', 'unknown'); end if;
  if jsonb_typeof(p_events) is distinct from 'array' or jsonb_array_length(p_events) > 50 then raise exception 'Invalid payment events.' using errcode = '22023'; end if;
  for e in select * from jsonb_array_elements(p_events) loop
    begin
      insert into public.payment_gateway_events (organization_id, connection_id, event_id, kind, provider_payment_id, invoice_id, amount, currency, method) values (c.organization_id, c.id, e->>'event_id', e->>'kind', e->>'provider_payment_id',
        case when (e->>'invoice_id') ~ '^[0-9a-f-]{36}$' then (e->>'invoice_id')::uuid end, nullif(e->>'amount', '')::numeric, nullif(e->>'currency', ''), nullif(e->>'method', ''))
        on conflict (connection_id, event_id) do nothing returning id into v_id;
      if v_id is null then v_dup := v_dup + 1; else v_new := v_new + 1; end if; v_id := null;
    exception when others then v_bad := v_bad + 1; end;
  end loop;
  update public.integration_connections set last_event_at = now() where id = c.id;
  return jsonb_build_object('status', 'ok', 'queued', v_new, 'duplicates', v_dup, 'invalid', v_bad);
end $$;

-- Worker: applies captured payments through billing_apply_provider_payment. A payment whose invoice is unknown, not issued, in another currency, or that exceeds the balance is HELD.
create or replace function public.payment_gateway_apply(p_limit integer default 50) returns jsonb language plpgsql security definer set search_path = '' as $$
declare ev public.payment_gateway_events; v_pay uuid; v_applied int := 0; v_held int := 0; v_ignored int := 0; c public.integration_connections;
begin
  for ev in select * from public.payment_gateway_events where state = 'received' order by received_at limit greatest(1, least(p_limit, 200)) for update skip locked loop
    select * into c from public.integration_connections where id = ev.connection_id;
    if ev.kind <> 'payment_captured' then
      update public.payment_gateway_events set state = case when ev.kind = 'payment_failed' then 'ignored' else 'held' end, processed_at = now(), reason = case when ev.kind = 'payment_failed' then 'The gateway reported a failed payment. Nothing was recorded.' else 'A refund was reported by the gateway. Review it and record the refund yourself if it is correct.' end where id = ev.id;
      if ev.kind = 'payment_failed' then v_ignored := v_ignored + 1; else v_held := v_held + 1; end if; continue; end if;
    begin
      if c.status <> 'connected' then raise exception 'The payment gateway connection is not active.' using errcode = '22023'; end if;
      if ev.invoice_id is null then raise exception 'The payment did not say which invoice it is for.' using errcode = 'P0002'; end if;
      v_pay := public.billing_apply_provider_payment(ev.connection_id, ev.invoice_id, ev.amount, ev.currency, ev.provider_payment_id, coalesce(ev.method, 'other'));
      update public.payment_gateway_events set state = 'applied', payment_id = v_pay, processed_at = now(), reason = null where id = ev.id; v_applied := v_applied + 1;
    exception when others then
      update public.payment_gateway_events set state = 'held', attempts = attempts + 1, processed_at = now(), reason = left(sqlerrm, 300) where id = ev.id; v_held := v_held + 1;
      perform public.integration_log_error(ev.organization_id, ev.connection_id, 'payments', 'payment_held', left(sqlerrm, 300), jsonb_build_object('event_id', ev.id));
    end;
  end loop;
  return jsonb_build_object('applied', v_applied, 'held', v_held, 'ignored', v_ignored);
end $$;

-- A held event can be retried after the cause is fixed (for example the invoice was issued), by an administrator.
create or replace function public.payment_gateway_retry(p_org uuid, p_event uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.integration_admin(p_org);
  update public.payment_gateway_events set state = 'received', processed_at = null, reason = null where id = p_event and organization_id = p_org and state = 'held' and kind = 'payment_captured';
  if not found then raise exception 'Only a held payment can be retried.' using errcode = '22023'; end if;
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, (select auth.uid()), 'payment.gateway_retry', jsonb_build_object('event_id', p_event));
end $$;

-- Reconciliation: what the gateway told us versus what is on the invoices. Manual payments (source 'manual') are never mixed into gateway totals.
create or replace function public.payment_reconcile(p_org uuid) returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if public.ops_require(p_org, 'billing') not in ('owner','admin') then raise exception 'Only owners and admins can reconcile payments.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'held', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'amount', e.amount, 'currency', e.currency, 'invoice_id', e.invoice_id, 'reason', e.reason, 'received_at', e.received_at) order by e.received_at) from public.payment_gateway_events e where e.organization_id = p_org and e.state = 'held'), '[]'::jsonb),
    'applied_without_payment', (select count(*) from public.payment_gateway_events e where e.organization_id = p_org and e.state = 'applied' and not exists (select 1 from public.invoice_payments p where p.id = e.payment_id)),
    'amount_mismatches', coalesce((select jsonb_agg(jsonb_build_object('event_id', e.id, 'event_amount', e.amount, 'payment_amount', p.amount)) from public.payment_gateway_events e join public.invoice_payments p on p.id = e.payment_id where e.organization_id = p_org and e.state = 'applied' and e.amount <> p.amount), '[]'::jsonb),
    'gateway_payments_without_event', (select count(*) from public.invoice_payments p where p.organization_id = p_org and p.source = 'provider' and not exists (select 1 from public.payment_gateway_events e where e.payment_id = p.id)),
    'gateway_total_by_currency', coalesce((select jsonb_object_agg(currency, total) from (select i.currency, sum(p.amount) total from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where p.organization_id = p_org and p.source = 'provider' and p.kind = 'payment' group by i.currency) x), '{}'::jsonb),
    'manual_total_by_currency', coalesce((select jsonb_object_agg(currency, total) from (select i.currency, sum(p.amount) total from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where p.organization_id = p_org and p.source = 'manual' and p.kind = 'payment' group by i.currency) x), '{}'::jsonb));
end $$;

revoke all on function public.payments_connection_create(uuid, text, text), public.payment_gateway_connection(text, text), public.payment_gateway_receive(uuid, text, jsonb), public.payment_gateway_apply(integer), public.payment_gateway_retry(uuid, uuid), public.payment_reconcile(uuid) from public, anon, authenticated;
grant execute on function public.payments_connection_create(uuid, text, text), public.payment_gateway_retry(uuid, uuid), public.payment_reconcile(uuid) to authenticated;
grant execute on function public.payment_gateway_connection(text, text), public.payment_gateway_receive(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.payment_gateway_apply(integer) to service_role, optizen_worker;
