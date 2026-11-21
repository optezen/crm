-- 0022: least-privilege tidy-up found by the security audit (tests/concurrency/security.test.mjs). Additive and reversible (re-grant to restore).
-- Supabase grants EXECUTE on every new function to anon and authenticated by default. These functions are internal and must not be callable through the public API:
--  * trigger functions (they never need an EXECUTE grant to fire; a direct call only errors, but an exposed name is needless surface);
--  * notif_enabled(): returned any member's notification preference to any signed-in caller who knew both ids. It is only used by definer functions and triggers, which keep working.
revoke all on function public.notif_lead_assigned(), public.notif_task_assigned(), public.protect_published_config(), public.protect_audit_events(), public.protect_crm_history() from public, anon, authenticated;
revoke all on function public.notif_enabled(uuid, uuid, text) from public, anon, authenticated;
