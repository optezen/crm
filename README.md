# Optizen — Foundation Starter

A Next.js foundation for **Optizen**, one customizable, AI-assisted business operating system for any kind of business. Every workspace uses the same data and configuration architecture; there is no industry selection.

## Start

```bash
npm install
npm run dev
```

Open http://localhost:3000. `npm test` runs unit + SQL policy tests; `npm run test:integration` runs live Supabase tests. Setup: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## What is real and what is not

- Real: universal onboarding (name → description → blank, starting point or AI draft → preview), typed `WorkspaceConfig`, server-side workspace resolution from `organization_members`, role-gated Builder (draft, preview, publish), Work/Builder routes, reusable UI components, Supabase migrations (`0001` draft, `0002` onboarding RPC, `0003` security hardening, `0004` CRM engine, `0005` universal workspaces, `0006` custom modules), sign-out, session-refresh proxy.
- Onboarding is universal: business name, description, then a blank workspace, an optional starting point (`config/presets.json`, only provenance, never a restriction) or an AI draft, then a preview. Builder lets owners/admins edit modules, the lead pipeline and record-type definitions as a draft, review the diff, and publish a new immutable revision. **Custom modules:** owners create modules and fields (text, number, date, dropdown, checkbox, phone, email, currency; required/optional; controlled dropdown options) in Builder, preview the form, publish, and roll back; members then create, edit, search, filter and page through real records in Work Mode (`/work/<module>`). Renames and hiding never lose data, and a field/module that records use cannot be removed or retyped. Leads/Contacts are unchanged. AI drafting works only when `ANTHROPIC_API_KEY` is configured and is never published without approval.
- Needs setup: Supabase env vars (`.env.example`), apply migrations, enable email auth with redirect URL `<origin>/auth/callback`. Without them the app shows setup notices and saves nothing.
- Real (CRM data engine, `0004`): organization-scoped leads and contacts (deduplicated by phone/email), Work Mode lead list/search/filter/pagination/detail/edit, pipeline stages from the published configuration, role-based visibility and assignment (owner/admin/manager see all; employees see their own and unassigned leads), notes and activity history, follow-up tasks (owner, due date, status, outcome), team management at `/team`, and a transactional domain-event outbox (`domain_events`: `lead.created`, `lead.assigned`, `task.completed`, ...). All writes are database functions that re-check membership and role; see `src/lib/crm/service.ts`.
- Not implemented: relations between records, record deletion, per-module role permissions, event consumers/webhooks, a separate contacts screen, member removal, voice, inventory, billing, workflows (shown as "Planned"). AI drafting exists but is unverified against a real model (see docs/SUPABASE_SETUP.md).

## Operating principles

1. Same **versioned configuration schema** drives chat, speech and visual editor.
2. AI creates *drafts*; validator verifies; simulator previews; admin explicitly approves; runtime publishes immutable versions.
3. Hard business actions (inventory, billing, permissions, payments) are predefined and transactional; AI cannot execute arbitrary code or SQL.
4. Tenant isolation must be enforced in PostgreSQL, not merely by frontend filters.
5. Industry packs are templates; business-critical modules use proper typed APIs and domain invariants.

## How to work

- Developer 1: SQL migration, auth, RLS, CRM services, durable workflow runtime.
- Developer 2: UI/UX design system, employee workspaces, visual configuration editor.
- Developer 3: AI draft translation, validation, integrations, event adapters.
- Agree on a single schema and type contracts before parallel branches diverge.

See `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/CONFIG_CONTRACT.md`, and `docs/TASKS.md`.

## Hosting

Target is Fly.io. Next.js `output: 'standalone'` is configured. Deploy after production-ready authentication, secrets, backups, and staging tests exist, via `fly launch` and `fly deploy` following current Fly.io documentation. No deployment has been performed.

## Automations

Owners/admins build trigger -> conditions -> actions workflows at `/automations`. A background worker (`worker/automation-worker.mjs`) executes them; see [docs/AUTOMATION.md](docs/AUTOMATION.md) for design, limits and the infrastructure to configure.

## Connections

Owners/admins connect services at `/builder/connections`: Website Forms (complete), Meta Lead Ads and WhatsApp (adapters, need provider authorization), Google Ads / Telephony / Payments (contract only). See [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## AI assistant

"Ask Optizen" answers questions from your real workspace data and prepares module and automation drafts that you approve before anything changes. See [docs/AI_ASSISTANT.md](docs/AI_ASSISTANT.md).

## Business operations

Optional Appointments, Inventory and Billing modules, enabled per workspace in Builder. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Dashboards, reports and permissions

Build dashboards from real data at `/dashboards`, use the report library at `/reports`, and manage roles, branches and permissions at `/team/roles`. See [docs/ANALYTICS_AND_PERMISSIONS.md](docs/ANALYTICS_AND_PERMISSIONS.md).

## Builder Studio

Design workflows on a canvas, forms, pipelines (with a lead board) and dashboards visually; the AI, the canvas and the forms all use the same validated models. See [docs/BUILDER_STUDIO.md](docs/BUILDER_STUDIO.md).

## AI engine

Voice, streaming, multi-step plans, confirmed lead operations and conversational onboarding: see [docs/AI_ENGINE.md](docs/AI_ENGINE.md).
