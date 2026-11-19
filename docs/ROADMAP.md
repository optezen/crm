# Business OS — Revised Product Roadmap

**Planning date:** 17 November 2026. **Pilot target:** 1 December 2026. **Team:** 3 developers with AI coding tools. **Deployment target:** Fly.io (web/API/worker), Supabase (PostgreSQL/Auth/Storage). A pilot is not a public commercial launch.

## Product definition

AI-native business OS whose core is a metadata-defined, multi-tenant system of records + workflows + permissions + views. Three equivalent configuration surfaces: chat, voice (transcribe to chat instructions), visual editor. Each writes to one versioned, typed configuration model. Day-to-day work mode differs from administrator builder mode.

## Invariants

- Every organization's data isolated; permission checks at database and service boundary.
- All AI requests are drafts until validated and approved; no model-written executable scripts or arbitrary SQL.
- Critical transactions (stock, payments, package usage) executed only in transaction-safe, domain-specific services.
- The workflow runtime must be deterministic, versioned, idempotent and auditable; delayed steps executed by durable queue.
- Voice is another input adapter; it must not bypass draft, review or authorization steps.
- Operational metrics use query results, not model-generated guesses.
- Every UI workflow supports keyboard/mobile accessibility, progressive disclosure and reversible configuration.

## December 1 pilot: deliberate small scope

**P0 / blocking:** two tenant-isolated workspaces (clinic and salon) with base leads/contacts, one editable pipeline, task assignment, appointments, service session completion, branch inventory stock ledger and simple invoice/payment records; minimal read-only AI chat with 3 permission-checked tools; a single fixed follow-up workflow template; website lead intake; staging on Fly.io; backups and audit logs.

**P1 / limited demonstration:** three industry templates load through a shared configuration object (scrap yard can remain UI/config-only); minimal admin form to change supported module visibility, field labels and pipeline stages. Changes saved as draft and published through explicit admin approval.

**Conditional external integrations:** Meta lead test webhook, official WhatsApp or BSP template message, only if credentials and access are available. Not launch blockers.

**NOT in December pilot:** arbitrary object builder, drag/drop workflow graph, prompt-generated production automations, voice-based production publishing, full clinic medical record, advanced scrap operational logic, AI autonomous actions, telephony verification, full WhatsApp inbox, ad attribution, tax-compliance certification. These are future steps.

## Parallel 13-day schedule (Nov 18–30)

| Date | Dev 1 — Platform & business logic | Dev 2 — Product UX | Dev 3 — AI & integrations | Exit criterion |
|---|---|---|---|---|
| Nov 18 | Repo contracts; tenant schema; migration 001 | User journeys + design tokens | Tool registry & API types | Shared contracts agreed |
| Nov 19 | Auth, org membership, RLS tests | App shell, role workspaces | Chat UI/API mock, website adapter contract | User isolation in staging |
| Nov 20 | Leads/contacts/tasks CRUD | Lead list and profile | Secure website intake | Create and see lead |
| Nov 21 | Pipeline + assignment | Follow-up task UX | Read-only AI lead query | AI and UI agree on lead |
| Nov 22 | Services/bookings | Calendar and booking flows | Appointment query tool | Book appointment |
| Nov 23 | Package/session model | Session view and actions | Workflow trigger adapter | Complete test session |
| Nov 24 | Stock ledger, recipes, locking | Inventory work screens | Inventory query tool | Correct stock balance |
| Nov 25 | Atomic session+stock transaction, invoice | Billing and session UX | Website ingestion retry/telemetry | Exactly-once deduction |
| Nov 26 | Workflow state machine / scheduler | Simple automation template editor | AI workflow draft validation (no publishing) | Template simulates and runs |
| Nov 27 | RBAC & reports | Home dashboard, approval UX | Integration connection status | Admin can review config |
| Nov 28 | End-to-end integration | Usability tests | Prompt injection and webhook tests | Critical paths pass |
| Nov 29 | Concurrency, tenant access, restore test | Mobile and keyboard QA | AI permission tests | Security gates pass |
| Nov 30 | Release candidate, monitoring | Pilot onboarding | AI spend limits, integration diagnostics | Go/no-go checkpoint |

**December 1:** controlled pilot with synthetic data or authorized data after security/privacy review. Delay if tenant isolation, inventory correctness, backups or audit trail fail.

## After pilot

1. **December:** strengthen workflow engine, event telemetry, telephony adapters, WhatsApp two-way messaging (subject to access), explicit AI draft-to-workflow for supported actions.
2. **January:** React Flow visual builder; typed workflow grammar; workflow replay/simulation; change previews and rollback; optional speech-to-text input.
3. **February:** custom object and form builder, report layout editor, configurable role workspaces; operational scrap-yard module.
4. **March onward:** industry marketplace, richer AI analytics, data migration tools, compliance review and scaled SaaS onboarding.

## Demo acceptance tests

- Change workspace from clinic to salon to scrap: menu, KPI labels, pipeline and forms differ using template JSON, not distinct app code.
- A valid workflow definition survives edits from either chat or visual editor without losing structure.
- First contact tasks obey business hours, retry limits, opt-outs and escalation.
- A completed service session cannot deduct consumables twice or produce negative stock.
- Two tenants cannot read each other's data, including AI tool results.
- No AI-generated workflow runs before authorized review/publish.
