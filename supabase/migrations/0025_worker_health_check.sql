-- 0025: a health check an uptime monitor can poll to learn whether every background worker is reporting, without logging in.
-- Like the other anonymous entry points it is gated by the gateway secret (held only by the web app), and it returns nothing but worker names and ages: no organization, user or message data.
create or replace function public.worker_health_check(p_gateway_secret text) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.integration_gateway where secret_hash = public.integration_sha256(p_gateway_secret)) then
    perform public.integration_hit('gateway-fail', 1000000); return jsonb_build_object('status', 'unauthorized'); end if;
  return jsonb_build_object('status', 'ok', 'expected', jsonb_build_array('automation', 'integrations', 'maintenance'),
    'workers', coalesce((select jsonb_agg(jsonb_build_object('worker', w.worker, 'age_seconds', extract(epoch from now() - w.last_seen)::int, 'healthy', w.last_seen > now() - interval '2 minutes') order by w.worker)
      from (select distinct on (worker) worker, last_seen from public.worker_heartbeats order by worker, last_seen desc) w), '[]'::jsonb));
end $$;
revoke all on function public.worker_health_check(text) from public, anon, authenticated; grant execute on function public.worker_health_check(text) to anon, authenticated;
