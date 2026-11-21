# Analytics, dashboards, reports and permissions

Migrations `0014` (permissions), `0015` (analytics + dashboards), `0016` (operations fixes). Nothing here is applied to any database yet.

## Permissions engine (0014)

* **Custom roles only narrow.** A custom role is a *base role* (admin/manager/employee; owner excluded) plus an overlay of denials. `organization_members.role` keeps holding the effective base role, so every older role check keeps working unchanged. The validator rejects a grant the base role does not already have, and `perm_ok_for` ANDs the overlay with `perm_default(base, module, action)`, so even a hand-edited row cannot widen access. Members without a custom role are unaffected (existing customers and data keep their behavior).
* **Actions** `view, create, edit, archive, export, assign, approve` per module (`leads`, `tasks`, `appointments`, `inventory`, `billing`, `dashboards`, `reports`, `integrations`, `automations`, `team`, and `custom:<module key>`).
* **Record visibility** scopes (leads, tasks, appointments, billing, each custom module): all / branch **team** (people sharing a branch with you) / **assigned** to you / **own** (created by you). Enforced by RESTRICTIVE RLS policies, which are ANDed with the existing policies and can only remove rows. A scope cannot show more than the base role already sees (an employee-based role with the "team" scope still sees only own + unassigned leads).
* **Writes:** BEFORE triggers refuse create / edit / assign / archive / approve (invoice issue, credit notes, refunds) when the overlay denies it, whichever function performs the write. Touching only `updated_at` (adding a note) is not an edit.
* **Branches and locations** are optional. Members belong to branches; stock locations can belong to a branch; a *location-restricted* role sees and uses only its branches' locations (and unassigned shared ones), for reads (RLS) and for every stock-ledger write.
* **Beyond the core tables:** integration management (`integration_admin`) needs `integrations.edit`; an automation can only be *published* if its publisher holds the permissions its actions need, and every *run* re-checks them (stale rights dead-letter the run); exports need the module's `export` permission (for members without a custom role the base-role default applies: employees cannot export); AI tools run as the user, so the same restrictions apply to what the assistant reads. System actors (worker, integration principals; `auth.uid()` is null) are governed by their own identity checks.
* **Tenant isolation:** every lookup is scoped by organization and by the signed-in user. A role, branch or permission of one organization has no effect in another; a person in two organizations is evaluated separately in each; role/branch ids from another organization are "not found"; `perm_ok_for` is not callable by clients (no membership probing).
* **Sensitive data:** personal contact fields (phone/email, including custom phone/email fields) are not available to analytics at all; billing data is manager+ and additionally governed by the billing permissions; PII masking for raw table reads is limited to the view permission (see limitations).

## Query grammar and reporting (0015)

Widgets, reports, exports and AI proposals are all the same JSON grammar (`src/lib/analytics/types.ts`), validated and executed by PostgreSQL (`analytics_build` / `analytics_run`). Identifiers come from a whitelist (`analytics_field_rows`), values are cast and quoted, queries run **as the user** (`SECURITY INVOKER`, so RLS, scopes and location rules apply) with a module `view` check for a clear error, an 8 s statement timeout, 100 rows per query, 2 groupings, 10 filters.

Metric definitions (also shown with every result):
* **Invoiced** = sum of issued invoice totals by issue date (source `invoices`). It is *not* collected revenue; credit notes are not deducted. **Collected** = payments recorded by staff, minus refunds for net (`payments.signed_amount`); it does not confirm any external processing. **Outstanding** = invoice ledger balance of issued invoices (`balance_due`), positive only; negative balances are credits owed to customers.
* **Currencies are never combined:** summing money requires grouping by `currency` or filtering to one. **Quantities of different products are never added:** group or filter by product/SKU.
* **Lead funnel** = leads currently in each stage (not stage history). **Response time** = hours from lead creation to the first note, task, stage change or edit made by a person (automation-made activity excluded); untouched leads are not averaged in. **Assignment time** = hours to the first assignment (person or automation). **Overdue task** = open and past due. **Low stock** = on hand at or below the product's level. **Batches expiring** = quantity still on hand in lots expiring within N days (negative days = already expired).
* Time zones: bucketing and ranges use the `tz` in the query (reports use the organization's appointments time zone, else UTC); weeks start on Monday.
* **CSV export** (`/api/reports/export`): predefined reports or a readable dashboard widget only; needs `export`; 5000-row cap; a definition header line; formula-looking cells are neutralized; the export is audited (counts only). Widgets/reports without export permission still show up to 100 aggregated rows to people with `view`.

## Dashboards

`dashboards` + `dashboard_widgets` (migration 0015): personal or organization-shared, up to 24 widgets (KPI, line, bar, pie, table, funnel) with position and 1-12 x 1-12 size, versioned with optimistic concurrency. `dashboard_save` validates every widget query with the same function that runs it, under the *saver's* permissions, plus per-type shape rules. A shared dashboard shows each widget under the *viewer's* permissions (an unauthorized widget shows "no access"). Sharing needs manager+ and the `approve` action. Rearranging is move-earlier/later and resizing is width/height numbers (no drag-and-drop yet).

## AI dashboards

Tools `get_analytics_catalog`, `query_analytics` (read-only, all roles, answers computed by the database) and `propose_dashboard` (owners/admins): the model only sees catalog metrics, every widget is validated by the database, unsupported metrics are refused with a pointer to the catalog, and nothing exists until the user approves; approval runs `dashboard_save` as the approving person.

## Operations fixes (0016)

Time off is entered in the organization time zone (`staff_time_off_add_local`); products have custom fields in the create/edit form; issued invoices download as PDF generated only from the immutable snapshot (`invoice_pdf_access`: manager+, billing permission, audited; deterministic bytes; Latin-1 text only, other characters print as "?"); `inventory_reconcile_v2` and `billing_reconcile_v2` report (never repair) a wider set of problems.

## Limitations

Raw table reads (PostgREST) are filtered by view permission, scope and location but cannot mask individual columns; PII masking is applied in analytics, exports and the AI tools. Custom-role permissions for `archive` exist but few operations archive today. Branch "team" is "shares a branch", not a separate teams feature. Role changes take effect on the next request. There is no drag-and-drop layout, no scheduled/emailed reports and no per-widget export button yet (reports export; widgets export through the API). Cross-currency conversion is deliberately not offered.


## Contact privacy (migration 0017)

* `contacts.phone` / `contacts.email` can no longer be selected by clients at all (column-level privilege revoked from `authenticated`; `select *` on contacts is refused). The read model `crm_lead_list` still has `phone`/`email` columns, but they come from `contact_phone()` / `contact_email()`, which return a value only when the caller (1) may view contact details (new permission module **`contacts`**, action `view`; every base role keeps it unless a custom role turns it off) and (2) can see the contact (owner/admin, or can see at least one of its leads under the lead visibility rules, scopes included). Otherwise they return null and `contact_hidden` is true. A test asserts this matches row-level security for owner, admin, manager and employees, and that another organization never reads a value.
* Searching by phone/email cannot be used as an oracle: hidden values are null before filtering. Editing a lead as someone who cannot see its details keeps the stored phone/email (the form omits them and `crm_update_lead` ignores submitted values).
* The AI lead lookup returns no phone/email (and says so) for such users even when the model asks for contact details. Analytics, reports and exports never had personal fields; tests now assert it. Server-side automation, integrations and invoice issuing still read numbers as definer functions (that is how messages are sent).
* **Remaining limits:** phone/email *custom fields* of custom modules live in `records.data` (jsonb) and are filtered by the module's view permission, not masked; invoices keep the billed contact's name/phone/email in their immutable snapshot, visible to people allowed to view billing; creating a lead with an existing phone number still merges into the existing contact (an existing behaviour that lets any lead-creator learn that a number exists; stricter rules would change onboarding flows).

## Invoice PDF (migration 0017 era)

* Endpoint order: authenticate (401 for anonymous, even for malformed ids), validate id (404), then the database decides (`invoice_pdf_access`: manager+, billing permission, own organization, issued only, scope) and audits. Another organization's invoice and a missing invoice are both 404; a role without permission is 403; internal errors are a generic 500. Covered by `tests/visual-builder.test.mjs` (handler with injected dependencies) and the live route test.
* Rendering uses **PDFKit with embedded Noto Sans** (SIL OFL, `assets/fonts`): Latin, Latin Extended, Vietnamese, Greek, Cyrillic and Devanagari (properly shaped), the rupee sign and typographic punctuation. Output is deterministic. **Not covered** (printed as `?`): Arabic, Hebrew, Thai, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Odia, CJK and emoji. `unsupportedCharacters()` reports them. Adding a script means adding its Noto font to `assets/fonts` and `SCRIPTS`. Right-to-left layout is not implemented.
* `next.config.ts` loads `pdfkit` from node_modules (`serverExternalPackages`) and includes the font directory in the standalone trace.
