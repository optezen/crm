# User experience (Task 14, migration 0019)

## Work Mode
* **Home (`/work`)** is built from the signed-in user's own data via `home_summary()` (row-level security applies): my follow-ups (one-tap Done), my leads, today's appointments (own for employees, everyone's for managers), unread notifications, quick actions that link to real create screens, and for owners/admins a "Get started" list computed from real state (it disappears as steps are done). Modules that are off, or not allowed for the role, are absent. There is no sample data anywhere in a real workspace.
* **Navigation:** Work (Home, modules, Follow-ups, enabled business modules), Insights, Set up (Builder, Team; owners/admins only), You (Notifications, Account). Planned modules are shown to builders only. On phones: a menu bar (a `<details>` menu, no gesture or script needed), bottom tabs (Home, Follow-ups, Search, Alerts), 44px touch targets, a skip link, and visible focus.
* **Follow-ups (`/tasks`)**: open / overdue / done, mine or everyone (managers), paging, Done in one tap.
* **Lead board and custom-module boards** have a Move menu on every card, so dragging is never required.
* **Search (`/search`, `global_search()`)**: leads, follow-ups, appointments, invoices (managers+), custom-module records; filters by type; paging. It is `SECURITY INVOKER`, reads through the same views as the screens, and never returns or matches hidden contact details: results are names/numbers/stages/dates; phone and email are searched only through the checked functions (a hidden value is NULL, so it cannot match); masked custom phone/email fields are not searchable. Indexes are prefix indexes (`text_pattern_ops`); "contains" search scans within one organization, which is fine to tens of thousands of rows (add `pg_trgm` beyond that).
* **Notifications (`/notifications`)**: one inbox with read/unread, filters and per-person preferences. Created in-app for: a task assigned to you by someone else, a lead assigned to you, an overdue follow-up (once per task per day, generated when you open Optizen or the inbox, since there is no background sender), and automation messages. **Optizen does not send email, push or WhatsApp notifications**, and the screens say so.
* **Account (`/account`)**: display name, notification preferences, sign out. Password changes do not apply (sign-in is by emailed link).

## Team
* **Invitations**: owner/admin creates a link for an email address with a role (or a custom role) and optional branches, valid 1-30 days. **Optizen does not send the email**: the link is shown once to be shared; only its SHA-256 hash is stored. It works only for the signed-in account whose email matches, once, until it expires or is revoked. Accepting needs a normal sign-in (the sign-in link brings the person back to the invitation); `next` redirects are restricted to an allow-list.
* **Role and branch changes** (`member_update_access`) are one transaction and keep every existing rule (owners cannot be changed, admins are managed by the owner only).

## Builder
`/builder/home` shows, per area, what is **live** and what is only a **saved draft**, with the same path everywhere: edit -> save as draft -> review -> publish (version history and rollback on the Modules page). All configuration screens share one tab bar (Overview, Modules, Forms, Pipeline, Workflows, Dashboards, Team & roles, Connections, AI for the owner). Advanced options stay in each area's page.

## Quality
Shared loading skeleton, error and not-found screens for the whole app; the home view and shell are presentational components shared with the browser tests.

## Tests
* Database/logic (`npm test`, 205+ tests): invitations, role changes, notifications, preferences, home data, search privacy and isolation, navigation link audit, redirect safety.
* **Real browser** (`npm run test:browser`, Chromium via Playwright, needs `npm run build` first): login, the onboarding wizard by keyboard, the real shell/home/board components rendered with clearly labelled **fixture data** (enabled only with `OPTIZEN_UX_FIXTURES=1`): desktop and phone layout, menu by keyboard, skip link, touch-target size, no horizontal scroll, accessibility scan (axe, serious/critical), board Move menu, refused moves, drag and drop.
* Not browser-tested (they need a database): sign-in, invitation acceptance, search results, saving. They are covered at the database level.

## Limits
Invitations are links, not emails. Notifications are in-app and generated on page load, not by a background job. Activity timelines exist for leads (notes, stage, assignment, tasks); other record types have no history yet. Search is prefix-indexed. Employees can still see Insights pages their role allows (dashboards/reports views are on by default for every role).
