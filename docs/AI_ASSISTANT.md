# Optizen AI Assistant

Migration: `supabase/migrations/0009_ai_assistant.sql`. Code: `src/lib/ai/`, route `POST /api/ai/chat`, panel `src/components/AiPanel.tsx` ("Ask Optizen" in the top bar of Work and Builder pages, shortcut Ctrl/Cmd+/).

## What it can do

* **Answer questions from real data** through 10 read-only tools: `list_leads`, `get_lead`, `list_pending_tasks`, `get_team_summary`, `list_modules`, `list_module_records`, `get_connection_status`\*, `get_integration_errors`\*, `list_workflows`\*, `get_workflow_runs`\* (\* owners and admins only), plus operations tools `get_operations_status`, `list_appointments`, `get_inventory_status`, `list_stock_movements` and (owners, admins, managers) `list_invoices`, `get_billing_summary`. Answers must come from tool results; unavailable data and unfinished integrations are reported as such (Google Ads, telephony and payments are not implemented; WhatsApp/Meta are only "usable" when the connection status is `connected`).
* **Prepare drafts** with `propose_module_changes` (new module, fields, renames, hide a field) and `propose_automation` (the existing trigger/condition/action grammar). Both only create a *proposal* (owner/admin only). The chat shows a preview and diff. **Step 1** "Approve: save as draft" writes a draft through `save_workspace_draft` / `automation_save_draft` (not live). **Step 2** "Publish" is a separate click through `publish_workspace_config` / `automation_publish` (automations: enable or keep disabled). Publishing is refused if the saved draft differs from what was approved or the workspace moved on. Versioning and rollback are the Builder's own (restore a version as draft).
* Unsupported requests (relations, formulas, named people in automations, appointment/payment triggers, SMS/email sending) are rejected with an explanation of what is supported.

## Architecture

* **Provider abstraction:** `ModelProvider` (`provider.ts`) with one implementation, `AnthropicProvider` (`anthropic.ts`), chosen by `providerFor(env)` (`OPTIZEN_AI_PROVIDER`, default `anthropic`). The pre-existing onboarding AI draft (`workspace/ai.ts`) now uses the same provider, so there is one code path to the model. Adding a vendor = implement the interface and register it in `providerFor`.
* **No arbitrary SQL, code or cross-tenant access:** the model can only call registered tools with typed, bounded, unknown-key-rejecting schemas (`schema.ts`). No tool takes an organization or user argument; both come from the authenticated session. Reads run as `SECURITY INVOKER` SQL functions (`ai_tool_*`), so row level security and role checks apply in the database (employees see their own/unassigned leads, admin-only tables stay admin-only); a lying client role is still refused by the database.
* **Data minimization:** lists return no contact details; `get_lead` masks phone/email and redacts email/phone-like text unless `include_contact` is requested for a specific lead; record phone/email/text fields are masked/redacted; credentials, secrets and ciphertext never leave the database layer; results are capped (25 rows/page, 14k characters).
* **Prompt injection:** record text, notes, form submissions and provider messages are treated as untrusted data: wrapped with a notice, scanned, and instruction-like strings are **withheld** and counted (a heuristic, not the boundary). The real boundary: tools are read-only or proposal-only, a human approves every change in the UI (the apply actions are server actions the model cannot call), admin tools are not even offered to other roles, and the UI renders model output as plain text.
* **Limits and cost control:** 6 model calls and 8 tool calls per message, 8 s per tool, 55 s per turn, 1200 tokens per call and 8000 output tokens per message; per-organization daily token budget (default 300k) and per-user hourly messages (default 40); owners adjust or disable with `ai_set_limits` (no UI yet). One retry for transient provider errors only (the call is a pure read).
* **Audit:** `ai_conversations`/`ai_messages` (private to the author, even from admins), `ai_tool_calls` (tool, arguments, counts; never result bodies), `ai_usage` (provider, model, tokens, latency, status), `ai_proposals`, plus `audit_events` (`ai.tool_call`, `ai.proposal_created|draft_saved|published|rejected`).

## Configuration

`ANTHROPIC_API_KEY` (server only), optional `OPTIZEN_AI_MODEL` (default `claude-sonnet-5-5`) and `OPTIZEN_AI_PROVIDER`. Without a key the panel says AI is not configured and nothing is sent anywhere. The route needs a function timeout of at least 60 s (`maxDuration = 60`; Vercel Hobby limits are lower).

## Limitations

Not streaming (one response per message); no per-user/organization usage dashboard or limit UI; conversation titles are the first message; injection detection is heuristic; tool results sent to the model leave your infrastructure (see your provider's data terms; masking reduces but does not eliminate this); the assistant cannot answer questions about data older than a tool page without paging; module proposals cannot delete or retype fields (the Builder protects data the same way).
