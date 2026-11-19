# Target Architecture — boundaries and ownership

```text
Users (Work Mode / Builder Mode)
       |           |            |
  Chat input   Voice->text   Visual editor
       \           |           /
          Versioned Config API
                 |
       Draft -> Validate -> Simulate -> Approve -> Publish
                 |
    Typed business objects and views + event/workflow definitions
                 |
       ┌─────────┴──────────┐
  Domain command APIs    Deterministic workflow runtime
 (CRM, inventory, etc)  (durable jobs, retries, logs)
       └─────────┬──────────┘
       PostgreSQL w/ RLS + audit ledger
                 |
      Integration adapters / webhooks
```

## Domains

- `identity`: orgs, memberships, branches, RBAC, audit.
- `records`: contacts, leads, field definitions, custom values, views, pipeline templates.
- `workflow`: trigger/action registry, versions, runs, scheduling, retries.
- `operations`: appointments, sessions, consumption recipe, stock ledger, invoice/payment.
- `integrations`: provider authorization, encrypted credentials, webhook ingestion, delivery log.
- `assistant`: tools, structured draft schema, approval requests, evidence and source links.

## Integration rules

- Webhook handler: authenticate and validate signature -> persist event with external id and org mapping -> enqueue job -> acknowledge -> process idempotently -> report failures.
- NEVER ingest unknown webhook into an arbitrary organization. Only an established provider connection maps events to an org.
- Do not put provider keys in browser bundles; never log access tokens or patient messages.
- For Meta, get authorized app permissions and customer authorization; for WhatsApp, use official platform or supported BSP.

## Database and security

- Each business row has an `organization_id`, critical branch rows also include `branch_id`.
- Use PostgreSQL row-level security plus server-side authorization, composite constraints, narrow privileges and security tests.
- Service-role privileges are server-only and audited. For normal user queries, act under validated identity.
- Inventory movements are append-only ledger entries; adjustments are compensating entries, not silent edits. Concurrency locks protect balances.
- Keep files in private object storage with time-limited URLs, retention policies and consent metadata.

## Fly.io topology

Fly.io app hosts Next.js UI and API; separate worker or reliable managed job processing handles delayed workflows and webhook processing. Supabase hosts PostgreSQL/Auth/Storage. Keep long-running work off interactive HTTP requests. Configure managed secrets, backups, health checks, and request rate limits.
