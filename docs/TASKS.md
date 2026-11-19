# GitHub issue-ready Day 1 tickets

## DEV1-001 — Tenant-safe foundation
- Define organizations, memberships, branches and audit log migrations.
- Enforce org isolation at DB and service level, test with two organizations.
- Add auth login/logout and organization selection.
- Done: cross-tenant reads return denied; migration can apply and rollback in dev.

## DEV2-001 — Design system and UX flows
- Define typography, spacing, interaction standards, status semantics and mobile responsiveness.
- Draw/implement three key journeys: lead -> call task; service -> inventory deduction; owner -> AI query.
- Refine the working demo shell into polished role-specific workspaces.
- Done: task paths can be demonstrated with keyboard + narrow mobile view.

## DEV3-001 — AI/contracts integration
- Define allowed tool list, strict tool request/result schemas, and per-user auth context.
- Create test fixture tool results for `get_leads`, `get_appointments`, `get_inventory`.
- Define website form webhook signature, duplicate policy and org-connection mapping.
- Done: fake cross-org request rejected; AI tool results link to underlying records.

## SHARED-001 — Configuration schema gate
- Review `CONFIG_CONTRACT.md`; lock v0 names and workflow action catalog.
- Add schema validation, proposed-diff output and draft publishing approval contract.
- No developer adds arbitrary per-industry conditionals until this is reviewed.

## SHARED-002 — Merge and release quality
- Every PR: lint/typecheck, unit tests, test proof, owner review, no leaked secrets.
- Every evening: staging deploy, smoke test three business templates.
- Keep release branch and tested rollback process.
