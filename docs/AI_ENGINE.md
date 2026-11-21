# Advanced AI & Voice engine (migration 0018)

Text, voice and the visual editors all use the same validated models and database functions. The AI never writes anything itself: it prepares proposals and plans; a human approves each phase.

## Voice
`lib/ai/speech.ts` defines `SpeechProvider`; `OpenAiTranscriber` is the one implementation (`OPENAI_API_KEY` or `OPTIZEN_SPEECH_API_KEY`, optional `OPTIZEN_SPEECH_MODEL`, `OPTIZEN_SPEECH_BASE_URL`). Route `/api/ai/transcribe` is same-origin, signed-in, size/type/content-sniff checked, metered (kind `transcription`, 60/hour/user) and returns text only. **Audio is held in memory for one request and forwarded to the provider; it is never stored or logged, and neither is the transcript.** The browser records with MediaRecorder (max 120 s), can cancel, shows permission/unsupported/transcription errors, and puts the transcript in the message box to review and edit; nothing is sent automatically. Typing always works. The audio does leave Optizen to the transcription provider: say so in your privacy notice.

## Streaming
`/api/ai/stream` (server-sent events). Events: `start`, `text`, `reset` (narration before a tool call is discarded), `tool_start/tool_end` (a fixed human label only), `proposal`, `plan`, `done`, `error`. Tool arguments, tool results, personal data, credentials and model reasoning never enter the stream (tested). Closing the connection cancels the turn: usage is settled as `cancelled`, nothing half-finished is stored, the request id is released. A stream that ends without `done` is an "interrupted" error with Retry. Every send carries a `requestId`; the database (`ai_requests`) makes retries idempotent: a finished request replays its stored answer (no second model call, usage or proposal), a running one is refused, a crashed one is taken over after 2 minutes.

## Atomic budgets
`ai_reserve` claims capacity before the model runs, under a per-organization advisory lock, counting settled tokens plus open reservations (daily org, monthly org, daily per user, hourly messages, voice). `ai_settle` records actual tokens; abandoned reservations expire after 10 minutes. Owner page `/settings/ai`: provider configuration status (keys never shown; "configured" is not a live check), usage today/month, limits, per-user and per-day history, recent requests, and cost **estimates** from prices the owner enters.

## Multi-step plans
`propose_plan` takes up to 12 dependent steps (`module`, `fields`, `layout`, `pipeline`, `ops_module`, `workflow`, `dashboard`, `role`). `lib/ai/plan.ts` validates them as one unit against the configuration they would produce: modules/fields are resolved by key or label (ambiguity is an error), dependencies are inferred and must be earlier steps, workflows/dashboards may use modules and business modules created earlier in the same plan, personal data fields are refused in dashboards, people cannot be named. Stored in `ai_plans`/`ai_plan_steps`.
* Each step is accepted or rejected (accepting needs its dependencies; rejecting rejects dependents).
* **Draft phase** (explicit approval): one workspace-configuration draft for all configuration steps (one transaction), one automation draft per workflow. Nothing is live. Edit the drafts in the form/pipeline builders and on the canvas; the publish phase publishes what the drafts now contain.
* **Publish phase** (second explicit approval, with a choice whether to enable workflows): configuration, workflows, roles, dashboards, in that order, as the approving user.
* Durable state per step; a lease allows one runner; a failed step marks dependents skipped; **Resume** retries only unfinished steps (finished work is never repeated; tested). Stale plans (workspace published since) are refused.

## Operations
`propose_lead_update`, `propose_assignment`, `propose_task` create *operation proposals*; **Confirm** runs them with the confirming user's own permissions through the normal functions. There are no tools for payments, invoices, outbound messages or stock changes, and the database rejects any other operation kind.

## Onboarding
Optional conversation in the setup wizard (`onboardingChatAction`): up to a few questions, then a proposal built through the same plan validator (modules, fields, pipeline, business modules, up to 4 workflows, 2 dashboards). Starter workflows are saved as drafts, never enabled. Blank and keyword starting points remain. Limited to 30 calls/user/day before any organization exists.

## Fixes to earlier limitations
* Original Builder page saves with conflict detection (`save_workspace_visual`).
* Unfinished canvases: `automation_wip`, private to the author, shape-checked, never run or published.
* Custom phone/email fields: `records.data`/`search_text` are closed to clients; `records_view` masks phone/email fields for roles without `contacts: view`; analytics and the assistant read the view.
* Invoice customer contact details: permission `billing_contacts: view`; `invoices.snapshot` is closed; `invoice_snapshot()` and the PDF mask phone/email.
* Contact merging: an employee who cannot already see a matching contact gets one neutral refusal (no name, no modification). Managers/admins keep reuse.
* Custom-module boards (`/work/<module>/board`) group by any dropdown field; moves go through the normal record update.
* Pipeline migration plans are kept on the version row (`applied_stage_moves`).

## Limits
* Existence of a phone/email is still inferable by lead creators only through the neutral refusal (not the data). `records_view` evaluates a function per row, so analytics over very large record sets is slower. Invoices created before a role change keep their frozen snapshot (masking is applied at read time).
* One speech provider and one chat provider are implemented. Streaming is implemented for the Anthropic provider; others fall back to non-streaming.
* Browser behaviour (microphone, SSE, drag and drop) was verified through the pure models and server code, not in a real browser here. Concurrency is tested for logic (PGlite is single-connection); live parallel tests are in `tests/integration`.
