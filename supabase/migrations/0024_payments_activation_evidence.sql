-- 0024: a payment gateway connection can become Connected only after a correctly signed notification from it has been received.
-- last_event_at is set only by payment_gateway_receive, which the web app calls after verifying the gateway signature with the connection's own secret. Enforced by a trigger so that
-- EVERY path (the Connections screen, the generic integration_set_status function, direct calls by an administrator) obeys the same rule: no "Connected" without trusted evidence.
create or replace function public.payments_require_evidence() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.provider = 'payments' and new.status = 'connected' and (tg_op = 'INSERT' or old.status is distinct from 'connected') and new.last_event_at is null then
    raise exception 'A payment gateway can be activated only after a correctly signed notification from it has been received. Send a test payment from the gateway first.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger integration_payments_evidence before insert or update of status on public.integration_connections for each row execute function public.payments_require_evidence();
revoke all on function public.payments_require_evidence() from public, anon, authenticated;
