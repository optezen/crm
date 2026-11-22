# Staging walkthrough for the owner: connect, deploy, and test in a browser

Scope of this first round: **basic CRM, Builder, operations and dashboards.** Not included yet: Meta, WhatsApp, Razorpay, paid AI, and background workers (see "What will not work yet"). The production-labelled Supabase project is never used.

## Step 0: generate the staging env files (done once, on your machine)
`node scripts/staging-init.mjs` created `.env.staging.web`, `.env.staging.workers`, `.env.staging.operator` (git-ignored, mode 0600) with **freshly generated** encryption key, gateway secret and monitor token. You only paste the Supabase and Vercel values into them; nothing secret needs to go into chat.

## Step 1: Supabase staging project
1. supabase.com → New project → name **`optizen-staging`** (a *new* project; not the production-labelled one). Same region you will use in production. Save the database password.
2. Project settings → **General**: copy the **Reference ID** (e.g. `abcdefghijklmnop`).
3. Project settings → **API**: copy the **Project URL** (`https://<ref>.supabase.co`) and the **anon / public key**. (Do **not** copy the service-role key or JWT secret yet; this round does not need them.)
4. Project settings → **Database → Connection string → URI** (the *direct* connection, `db.<ref>.supabase.co:5432`): copy it and replace `[YOUR-PASSWORD]`.
5. Fill the files:
   - `.env.staging.web`: `STAGING_SUPABASE_REF`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SITE_URL` (after Step 3), and `SUPABASE_PRODUCTION_REF` = the production-labelled project's ref (a second lock; leave blank if you prefer, it is already read from `.env.local` when present).
   - `.env.staging.operator`: `STAGING_DATABASE_URL`, `STAGING_SUPABASE_REF`, `SUPABASE_PRODUCTION_REF`.
6. Database → Extensions: confirm `pgcrypto` and `btree_gist` (the migrations create them if absent).

## Step 2: Resend SMTP (so sign-in e-mails actually arrive)
1. resend.com → API Keys → create a key (sending access). Domains: **add and verify a domain** you own (DNS records), or for a first test use Resend's `onboarding@resend.dev` sender, which only delivers to **the e-mail address of your Resend account**: fine for one owner, not for inviting a second tester.
2. Supabase → **Authentication → Emails → SMTP Settings** (Auth → Settings in older dashboards): enable custom SMTP:
   `Host smtp.resend.com` · `Port 465` · `Username resend` · `Password <the Resend API key>` · `Sender e-mail <something@your-verified-domain>` (or `onboarding@resend.dev`) · sender name `Optizen Staging`.
3. Authentication → **Rate Limits**: custom SMTP starts low (about 30 e-mails/hour); raise it if you will test with several people.
4. Authentication → Providers → Email: enabled. Leave "Confirm email" on.

## Step 3: Vercel staging project and the exact URL
Create a **separate** Vercel project named `optizen-staging` (so the URL is predictable: `https://optizen-staging.vercel.app`, if the name is free; otherwise Vercel shows the real one).
Two ways to deploy; tell me which you prefer:
- **A. GitHub import (simplest UI):** needs the branch pushed to `github.com/optezen/crm` (I will not push without your explicit approval). Vercel → Add New Project → import the repo → Production Branch = `feature/task-15-integrations-reliability` → add the env vars from `.env.staging.web` → Deploy.
- **B. CLI deploy from this machine (no push):** `npx vercel login`, `npx vercel link --project optizen-staging`, add the env vars (I can push them from `.env.staging.web` for you), `npx vercel deploy --prod`. Uploads the local source; nothing goes to GitHub.
Either way set `NEXT_PUBLIC_SITE_URL=https://<the staging url>` **before** the build (it is baked into the build).

## Step 4: Supabase Auth URLs (after you know the staging URL)
Authentication → **URL Configuration**:
- **Site URL**: `https://<staging-url>`
- **Redirect URLs**: `https://<staging-url>/auth/callback` (add only this exact URL; no wildcards, no localhost).

## Step 5: database (needs your explicit approval)
```bash
npm run preflight -- web --env-file .env.staging.web --compare-env-file .env.staging.workers   # expect no FAIL (workers file may FAIL on blanks: ignore for this round)
npm run db:plan -- --env-file .env.staging.operator --confirm-ref <ref>                         # PLAN ONLY, changes nothing
# you review the plan, then say "approved: ref <ref>"; only then:
npm run db:plan -- --env-file .env.staging.operator --confirm-ref <ref> --apply
npm run db:validate -- --env-file .env.staging.operator --confirm-ref <ref>                     # the security checks
node scripts/db-register-gateway.mjs --env-file .env.staging.operator --web-env-file .env.staging.web --confirm-ref <ref>
```

## What will not work yet (by design in this round)
- **Automations, appointment reminders, overdue-follow-up alerts** need background workers (Fly.io). You can build and publish workflows, but they will not run. Builder → **Operations** will say "No worker has reported yet": that is the honest, expected message.
- **Meta Lead Ads, WhatsApp, Razorpay (Payments connection), AI assistant/voice:** not configured; the screens say so and offer no fake connect. Website Forms works (no provider needed).
- **Notifications** are in-app only.

---

# Owner testing checklist (browser, on the staging URL)

Tick as you go; write down anything surprising (screenshot + what you clicked). Use a normal window and, for step 12, your phone.

## A. Sign-in and workspace
1. Open the staging URL → you are sent to **Sign in**. Enter your e-mail → "check your e-mail" message.
2. The e-mail arrives (check spam) → click the link → you land in the app, not on an error page. Opening the same link a second time should **not** sign you in again.
3. First-time flow: create a workspace (name it e.g. "Staging Test Co"; try both "blank" and describing a business). You land on the home page showing your workspace name.
4. Sign out, then sign in again: your workspace is still there.

## B. CRM (Work mode)
5. **Leads → New lead**: name, phone `+91…`, e-mail, source. It appears in the list and opens a detail page.
6. On the lead: change the **stage**, **assign** it to yourself, add a **note**, add a **follow-up** (due today), then **complete** it with an outcome. Each change shows up in the activity timeline.
7. Create 5–10 leads; try the **search** (top bar) by name and by phone fragment, the list **filters**, and the **board** view (move a card with the Move menu and by dragging).
8. **Home** shows today's follow-ups and your leads; **Follow-ups** lists tasks; **Notifications** opens (it will be quiet: workers are off).
9. Lead page → **WhatsApp consent** card: record an opt-in (it asks for a confirmation and *how* they agreed). It says WhatsApp is not connected and nothing is sent. Then record an opt-out.

## C. Builder
10. **Builder → Modules**: add a custom module (e.g. "Vehicles" with Registration and Price). Publish. It appears in Work mode; add and edit a record; try the list search and filters. Try to remove the module while it has records: it should be **refused** with a clear reason.
11. **Builder → Forms / Pipeline**: rename a stage, set "requires assignee" on one; moving a lead there without an assignee is refused. **Workflows**: open the visual canvas, build "when a lead is created → assign → create task", publish (it will not execute yet: no workers).
    **Connections → Website Forms**: create a connection, copy the webhook URL (Copy button) and secret, then send the `curl` example from the card: a lead should appear. Meta/WhatsApp/Payments cards must say they are not configured.

## D. Operations
12. **Builder → Business operations**: turn on Appointments (set your time zone), Inventory, Billing; publish.
    - **Appointments**: create a type, set working hours (Setup), book an appointment, try to double-book the same slot (refused), reschedule, cancel.
    - **Inventory**: add a location and a product, receive stock, consume stock, try to consume more than you have (refused), check the ledger.
    - **Billing**: create an invoice (lines + tax), issue it, record a **partial** payment, then the rest; try to overpay (refused); **download the PDF** and open it.
    - **Appointments → Setup → Reminders**: the settings form saves (reminders will not be sent yet).

## E. Dashboards and reports
13. **Dashboards**: create one with a few widgets (leads by stage, tasks, revenue if billing is on); numbers match what you entered. **Reports**: open each report and compare a count with the list screens.

## F. Team and permissions
14. **Team & roles → Invite**: invite a second e-mail as *employee* (you get a **link**, no e-mail is sent). Open the link in a private window signed in as that person (their e-mail must receive the sign-in e-mail: with Resend's sandbox sender this works only for your own address, so use an address alias you control). Check the employee cannot open Builder, Billing or Connections, and sees only what their role allows.

## G. Operations screen and phone
15. **Builder → Operations**: shows "No worker has reported yet", queue counts, connection status. Nothing here should look broken.
16. On your **phone**: sign in, create a lead, check the bottom tabs and that nothing scrolls sideways.

## Report back
For each number: **works / confusing / broken**, plus anything that felt slow (a screen taking more than ~2 seconds). I will turn the list into fixes and re-run the security and regression suites.
