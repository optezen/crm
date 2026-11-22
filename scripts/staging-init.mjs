// Creates the git-ignored staging env files with FRESH generated secrets (never printed) and blanks for the values only you can get from Supabase and Vercel.
// Safe to re-run: existing files are never overwritten.   node scripts/staging-init.mjs
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const b64 = () => randomBytes(32).toString('base64'), hex = n => randomBytes(n).toString('hex');
const KEY = b64(), GATEWAY = hex(24), MONITOR = hex(16);
const files = {
  '.env.staging.web': `# Staging WEB APP (Vercel). Paste the blanks from the Supabase dashboard (Project settings -> API). Never commit this file (it is git-ignored).
OPTIZEN_ENV=staging
STAGING_SUPABASE_REF=
SUPABASE_PRODUCTION_REF=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SITE_URL=
INTEGRATION_ENCRYPTION_KEY=${KEY}
INTEGRATION_GATEWAY_SECRET=${GATEWAY}
OPS_HEALTH_TOKEN=${MONITOR}
`,
  '.env.staging.workers': `# Staging WORKERS (Fly.io) - not needed for the first browser test. Same encryption key as the web app.
OPTIZEN_ENV=staging
STAGING_SUPABASE_REF=
SUPABASE_URL=
SUPABASE_ANON_KEY=
WORKER_JWT=
INTEGRATION_ENCRYPTION_KEY=${KEY}
`,
  '.env.staging.operator': `# OPERATOR machine only: used by scripts/db-apply.mjs, db-validate.mjs and db-register-gateway.mjs. Never put these on Vercel or Fly.
# Supabase -> Project settings -> Database -> Connection string (URI). Use the DIRECT connection (db.<ref>.supabase.co:5432) and replace [YOUR-PASSWORD].
STAGING_DATABASE_URL=
STAGING_SUPABASE_REF=
SUPABASE_PRODUCTION_REF=
`,
};
for (const [f, body] of Object.entries(files)) { if (existsSync(f)) { console.log(`kept     ${f} (already exists)`); continue; } writeFileSync(f, body, { mode: 0o600 }); console.log(`created  ${f}`); }
console.log('\nFresh secrets were generated into the files (not shown). Fill in the blanks, then: npm run preflight -- web --env-file .env.staging.web');
