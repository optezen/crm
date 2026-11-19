# Unified Configuration Contract (v0)

The system needs **one canonical configuration representation** for three editor modes.

## Draft model

```json
{
  "schemaVersion": 1,
  "organizationId": "org-uuid",
  "version": 3,
  "status": "draft",
  "industryTemplate": "clinic",
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
