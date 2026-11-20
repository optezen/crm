# Unified Configuration Contract

## Implemented today: `WorkspaceConfig` (schemaVersion 1)

Optizen is one platform. Every workspace, whatever the business, stores the same versioned definition in `workspace_configuration_versions.definition`. **There is no industry field**; `industryTemplate` exists only on definitions created before migration 0005 and is ignored.

```json
{
  "schemaVersion": 1,
  "businessName": "Acme Bakery",
  "description": "Optional free-text business profile",
  "preset": "optional-starting-point-key",
  "modules": [{ "key": "overview", "label": "Overview", "status": "active" }, { "key": "leads", "label": "Leads", "status": "active" }, { "key": "orders", "label": "Orders", "status": "planned" }],
  "objects": [{ "key": "orders", "label": "Orders", "fields": [{ "key": "total", "label": "Total", "kind": "number" }, { "key": "state", "label": "State", "kind": "choice", "options": ["Open", "Closed"] }] }],
  "pipeline": { "stages": ["New", "Contacted", "Qualified", "Won", "Lost"] }
}
```

- Field kinds: `text`, `number`, `date`, `choice` (dropdown, with `options`), `yes_no` (checkbox), `phone`, `email`, `currency` (optional 3-letter `currency`, default INR). Field attributes: `required`, `archived` (hidden; data kept).
- Module status: `active` (usable), `planned` (placeholder), `archived` (hidden everywhere, records kept).
- `overview` and `leads` are core modules (the CRM engine runs on them): always present and active. `pipeline.stages` (2-20 unique names) drives lead stages.
- **Custom modules**: a module with key K plus a record type (`objects[]`) with the same key K. When the module is `active`, Work Mode gets `/work/K` (list, search, dropdown/checkbox filters, pagination), `/work/K/new` and `/work/K/<id>`, driven by the live published definition. Records are stored in `public.records` (organization_id, object_key, `data` jsonb keyed by **field key**).
- **Data protection**: field keys never change; renaming edits only `label`. Hiding sets `archived: true` (values kept, read-only, restorable). Publish is refused if it would remove a record type or field that records use, or change the type of a field records use. Dropdown options can be removed: values already stored stay valid.
- **Permissions**: members read; any member creates records in active modules; creators edit their own records; owners/admins/managers edit any. Configuration: owners/admins only.
- **Rollback**: `restore_workspace_revision` loads an earlier version as the draft (data-bearing fields/types are kept, hidden if the old version lacked them); review, then publish as a new version. History is never rewritten.
- `preset` is provenance only. Presets (`config/presets.json`) are optional starting points and never restrict what a workspace can become.
- Validation lives in two places that must agree: `validateConfig` (`src/lib/workspace/schema.ts`, used by the Builder UI and server) and `public.validate_workspace_definition` (migration 0005, the real gate). A test runs a corpus through both.
- Lifecycle: `save_workspace_draft` (one draft per organization, owners/admins) -> review diff -> `publish_workspace_config` (publishes the *saved* draft as the next immutable revision; refuses if any lead would be left in a removed stage) or `discard_workspace_draft`.
- AI drafting (`src/lib/workspace/ai.ts`) only produces a candidate that goes through the same validation and the same save -> publish approval. It runs only when `ANTHROPIC_API_KEY` is set.

## Future design (not implemented): v0 draft model

The system needs **one canonical configuration representation** for three editor modes.

## Draft model

```json
{
  "schemaVersion": 1,
  "organizationId": "org-uuid",
  "version": 3,
  "status": "draft",
  "navigation": [{"module": "leads", "visibleToRoles": ["owner", "sales"]}],
  "objects": [{"key": "leads", "fields": [{"key": "name", "kind": "text", "required": true}]}],
  "pipelines": [{"key": "sales", "stages": ["new", "contacted", "won"]}],
  "workflows": [{"key": "new-lead-followup", "trigger": {"event": "lead.created"}, "steps": [
    {"id": "assign", "type": "assign.round_robin", "teamId": "sales"},
    {"id": "task", "type": "task.create", "after": "assign", "dueMinutes": 30}
  ]}]
}
```

## Contract properties

1. Only whitelisted `trigger`, `condition` and `action` types are allowed; schemas validate arguments.
2. Chat model emits **candidate JSON** + explanation, not executable code or SQL.
3. Visual editor maps nodes and edges onto the same workflow steps.
4. Voice converts audio to text; the identical draft parser is used.
5. Config is stored with status `draft`, `validated`, `published`, `archived` and immutable published versions.
6. Before publish, compare changes, simulate sample events, check role permissions, detect cycles, require approval.
7. Runtime references a published config version, not a mutable draft.
8. Destructive actions, billing operations, patient-data access and external messages require stronger approvals.
9. Keep team identifiers, branch identifiers and provider connections in validated references instead of free text.
10. Dashboard and AI tools query identical read models; AI does not invent metrics.

## First supported automation grammar

- Triggers: `lead.created`, `task.overdue`, `call.outcome_recorded`, `session.completed`.
- Actions: `assign.round_robin`, `task.create`, `task.escalate`, `notification.internal`.
- Guards: `lead.opted_out`, business hours, max attempts, assigned team, available worker.
- Wait behavior: durable scheduled event; no sleeping in request handler.

Use a proper schema validator (for example Zod) when implementation starts. The JSON above is a design example, not executable production configuration.
