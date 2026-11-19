# Supabase setup and test workflow

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | app (`.env.local`) | Project API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | app | Public anon key. Safe in the browser **only because** RLS + 0003 privileges restrict it |
| `NEXT_PUBLIC_SITE_URL` | app | Public origin, e.g. `http://localhost:3000`. Used for the email-link redirect |
| `SUPABASE_TEST_URL` / `_ANON_KEY` / `_SERVICE_ROLE_KEY` | tests only (`.env.test.local`) | Disposable test project. The service-role key creates/deletes test users and is **never** read by the app |
| `SUPABASE_TEST_ALLOW_REMOTE=1` | tests only | Required to run against a non-local project |
| `APP_URL` | tests only | Running app for `app-routes.itest.mjs` |

The app does not use the service-role key. Keep it out of `.env.local`.

## A. Local stack (recommended for development and tests)

Needs Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
supabase init                      # once; creates supabase/config.toml, leaves migrations alone
supabase start
supabase db reset                  # applies supabase/migrations/0001..0003 in order
supabase status -o env             # API_URL, ANON_KEY, SERVICE_ROLE_KEY
```

In `supabase/config.toml` set `[auth] site_url = "http://localhost:3000"` and add `http://localhost:3000/auth/callback` to `additional_redirect_urls`. Local sign-in emails appear in the Mailpit/Inbucket UI (port 54324).

```bash
cp .env.example .env.local         # URL=API_URL, ANON key; SITE_URL=http://localhost:3000
cp .env.test.example .env.test.local   # fill in the three SUPABASE_TEST_* values from `supabase status`
```

## B. Hosted project

1. Create a project at supabase.com. Use a **separate** project for tests.
2. `supabase link --project-ref <ref>` then `supabase db push` (applies 0001, 0002, 0003; never edit an applied migration, add 0004+).
3. Authentication → Providers: Email enabled. Authentication → URL Configuration: Site URL = your origin; Redirect URLs include `<origin>/auth/callback`.
4. Authentication → Settings: decide on "Confirm email" (magic-link sign-in works either way) and whether public signups stay open. `signInWithOtp` creates a user on first use; 0003 caps each user at 5 owned organizations.
5. Production email: Supabase's built-in SMTP is heavily rate-limited; configure a custom SMTP provider.
6. Copy Project URL and anon key from Project Settings → API into `.env.local`.

## Running the tests

| Command | Needs | What it runs |
|---|---|---|
| `npm test` | nothing | Unit tests + SQL policy tests (PGlite) |
| `npm run test:integration` | Supabase test project, plus the app running for `app-routes` | Live tests. **Exits 2 if credentials are missing; it never skips silently.** |

For the app-route tests: `npm run build`, start the app (`node .next/standalone/server.js` with `.next/static` and `public` alongside, or `npm run dev`) with `.env.local` pointing at the **same** project, then run the command. Set `SKIP_APP_TESTS=1` to run only the database tests.

## Manual checks not automated

- **Email-link callback success path** (PKCE code exchange): request a link on `/login`, open it from Mailpit, confirm you land on `/work` (or `/onboarding` for a new user). Automating this needs the PKCE verifier cookie from the same browser session.
- **Sign-out button** (server action): click it, confirm you land on `/login` and `/work` redirects there. The session revocation itself is tested live.
