-- 0023: safe re-encryption of stored provider credentials (integration encryption-key rotation, docs/KEY_ROTATION.md).
-- The worker decrypts a credential with the old key, encrypts it with the new one and calls this function. It is a COMPARE-AND-SWAP: the row changes only if it still holds the exact
-- ciphertext that was read, so a credential refreshed in the meantime (for example a renewed Meta token) is never overwritten with stale data. Callable only by the worker role and the
-- service role. No secret is logged or returned; the audit entry records only the connection id and the key version.
create or replace function public.integration_rekey_credential(p_conn uuid, p_old text, p_new text, p_version integer) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_n integer; v_org uuid;
begin
  if p_new is null or p_new !~ '^v[0-9]{1,4}:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' or p_version is null or p_version < 1 or p_version > 9999 or p_new not like 'v' || p_version || ':%' or char_length(p_new) > 20000 then
    raise exception 'Invalid credential.' using errcode = '22023'; end if;
  update public.integration_credentials set ciphertext = p_new, key_version = p_version, updated_at = now() where connection_id = p_conn and ciphertext = p_old returning organization_id into v_org;
  get diagnostics v_n = row_count;
  if v_n = 1 then insert into public.audit_events (organization_id, actor_id, event_name, payload) values (v_org, null, 'integration.credentials_rekeyed', jsonb_build_object('connection_id', p_conn, 'key_version', p_version)); end if;
  return v_n = 1;
end $$;
-- how many stored credentials use each key version (no secrets): the rotation is finished when only the current version remains
create or replace function public.integration_key_versions() returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(key_version::text, n), '{}'::jsonb) from (select key_version, count(*) n from public.integration_credentials group by key_version) x;
$$;
revoke all on function public.integration_rekey_credential(uuid, text, text, integer), public.integration_key_versions() from public, anon, authenticated;
grant execute on function public.integration_rekey_credential(uuid, text, text, integer), public.integration_key_versions() to service_role, optizen_worker;
