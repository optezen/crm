-- 0027: explicit privileges for service_role.
-- Hosted Supabase no longer grants new tables, sequences and functions to service_role automatically (default privileges for objects created by `postgres` give it only
-- TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). Before this migration service_role could therefore not read or write any table or call any function that a migration had not granted
-- to it explicitly. The application never uses the service-role key (and must not), but operators, the staging/live test suites and the documented worker fallback do.
-- This restores the privileges service_role always had. It adds no access for anon, authenticated or optizen_worker, and service_role already bypasses row-level security.
-- Future objects created by postgres in this schema get the same grants automatically.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant all on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
