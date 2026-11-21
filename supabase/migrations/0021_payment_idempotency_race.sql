-- 0021: concurrency fix found by tests/concurrency (real multi-connection PostgreSQL).
-- billing_post_payment looked up the idempotency key / provider reference BEFORE locking the invoice. Two simultaneous requests with the same key both missed, serialized on the
-- invoice lock, and the second then failed with an over-payment or duplicate-key error instead of returning the first payment. Money was never doubled (the lock and the unique
-- indexes held), but an idempotent retry must succeed with the original payment id. The function below is identical to 0012 except for the re-check after the lock.
-- Backwards compatible: same signature, same results for every request that did not race.
create or replace function public.billing_post_payment(p_org uuid, p_invoice uuid, p_amount numeric, p_method text, p_reference text, p_note text, p_received timestamptz, p_source text, p_conn uuid, p_provider_ref text, p_key text, p_actor uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare i public.invoices; v_id uuid; v_bal numeric; v_existing uuid;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > 1000000000000 then raise exception 'Enter an amount greater than zero with at most 2 decimals.' using errcode = '22023'; end if;
  if p_method not in ('cash','bank_transfer','card','upi','cheque','other') then raise exception 'Choose a payment method.' using errcode = '22023'; end if;
  if p_received < now() - interval '2 years' or p_received > now() + interval '1 day' then raise exception 'The payment date is out of range.' using errcode = '22023'; end if;
  if p_key is not null then select id into v_existing from public.invoice_payments where organization_id = p_org and idempotency_key = p_key; if found then return v_existing; end if; end if; -- a repeated submit returns the first payment
  if p_provider_ref is not null then select id into v_existing from public.invoice_payments where provider_connection_id = p_conn and provider_ref = p_provider_ref; if found then return v_existing; end if; end if;
  select * into i from public.invoices where id = p_invoice and organization_id = p_org for update; -- serializes concurrent payments on one invoice
  if not found then raise exception 'Invoice not found.' using errcode = 'P0002'; end if;
  -- re-check AFTER the lock: a retry that raced with the first request waited here, and must get the first payment back (not an over-payment or duplicate-key error)
  if p_key is not null then select id into v_existing from public.invoice_payments where organization_id = p_org and idempotency_key = p_key; if found then return v_existing; end if; end if;
  if p_provider_ref is not null then select id into v_existing from public.invoice_payments where provider_connection_id = p_conn and provider_ref = p_provider_ref; if found then return v_existing; end if; end if;
  if i.status <> 'issued' then raise exception 'Payments can only be recorded against issued invoices.' using errcode = '22023'; end if;
  v_bal := public.billing_balance(p_invoice);
  if p_amount > v_bal then raise exception 'The payment (%) is more than the outstanding amount (%).', p_amount, greatest(v_bal, 0) using errcode = '22023'; end if;
  insert into public.invoice_payments (organization_id, invoice_id, kind, amount, method, reference, note, source, provider_connection_id, provider_ref, idempotency_key, received_at, recorded_by)
    values (p_org, p_invoice, 'payment', p_amount, p_method, left(btrim(p_reference), 80), left(btrim(p_note), 300), p_source, p_conn, p_provider_ref, p_key, p_received, p_actor) returning id into v_id;
  insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id, actor_id) values (p_org, p_invoice, 'payment', -p_amount, v_id, p_actor);
  insert into public.audit_events (organization_id, actor_id, event_name, payload) values (p_org, p_actor, 'payment.received', jsonb_build_object('invoice_id', p_invoice, 'payment_id', v_id, 'amount', p_amount, 'source', p_source));
  perform public.crm_emit(p_org, 'payment.received', 'payment', v_id, jsonb_build_object('payment_id', v_id, 'invoice_id', p_invoice, 'number', i.number, 'amount', p_amount, 'currency', i.currency, 'method', p_method, 'source', p_source, 'balance_due', v_bal - p_amount, 'contact_id', i.contact_id));
  if v_bal - p_amount = 0 then perform public.crm_emit(p_org, 'invoice.paid', 'invoice', p_invoice, public.invoice_payload(i)); end if;
  return v_id;
end $$;
