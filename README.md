# Business OS — Foundation Starter

A **local, non-production** Next.js user experience starter for an AI-first, configurable business operating system. Includes three industry templates (skin clinic, salon, scrap yard), a role-neutral overview, and a basic configuration studio with module toggles and a **static** automation review demonstration.

## Start

```bash
npm install
npm run dev
```

Open http://localhost:3000. `npm test` runs unit + SQL policy tests; `npm run test:integration` runs live Supabase tests. Setup: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md).

## What is real and what is not

- Real: onboarding (name → industry → review), typed `WorkspaceConfig`, server-side workspace resolution from `organization_members`, role-gated Builder (read-only), Work/Builder routes, reusable UI components, Supabase migrations (`0001` draft, `0002` onboarding RPC, `0003` security hardening), sign-out, session-refresh proxy.
- Industry JSON in `config/industries.json` are **onboarding templates only**; there is no industry switcher.
- Needs setup: Supabase env vars (`.env.example`), apply migrations, enable email auth with redirect URL `<origin>/auth/callback`. Without them the app shows setup notices and saves nothing.
- Not implemented: record storage, config editing/publishing, AI, voice, inventory, billing, workflows (shown as "Planned").

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
