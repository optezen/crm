-- ARCHITECTURAL STARTER ONLY: do not run on production without auth/RLS review.
create extension if not exists pgcrypto;
create table if not exists public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null, industry_template text not null check (industry_template in ('clinic','salon','scrap')), created_at timestamptz not null default now()
);
create table if not exists public.organization_members (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check (role in ('owner','admin','manager','employee')),
 primary key (organization_id,user_id)
);
create table if not exists public.workspace_configuration_versions (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 revision integer not null, status text not null check (status in ('draft','validated','published','archived')),
 schema_version integer not null default 1, definition jsonb not null,
 created_by uuid references auth.users(id), created_at timestamptz not null default now(),
 unique (organization_id, revision)
);
create table if not exists public.audit_events (
 id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id) on delete cascade,
 actor_id uuid references auth.users(id), event_name text not null, payload jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);

-- A user can only read memberships they belong to; no membership self-creation.
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.workspace_configuration_versions enable row level security;
alter table public.audit_events enable row level security;

-- Membership lookups via a narrow SECURITY DEFINER function avoid policy recursion.
create or replace function public.is_org_member(p_org_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.organization_members m where m.organization_id = p_org_id and m.user_id = (select auth.uid()));
$$;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

create policy organizations_read on public.organizations for select to authenticated using (public.is_org_member(id));
create policy members_read on public.organization_members for select to authenticated using (user_id = (select auth.uid()));
create policy config_read on public.workspace_configuration_versions for select to authenticated using (public.is_org_member(organization_id));
create policy audits_read on public.audit_events for select to authenticated using (public.is_org_member(organization_id));
-- No client INSERT/UPDATE policies yet. Controlled writes require separately reviewed backend services.
