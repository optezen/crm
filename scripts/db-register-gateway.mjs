// One-time step after the migrations: registers the HASH of INTEGRATION_GATEWAY_SECRET in the staging database (so the website-form, webhook and health endpoints can authenticate).
// Reads the secret from the web env file, so nothing has to be pasted into a SQL editor.
//   node scripts/db-register-gateway.mjs --env-file .env.staging.operator --web-env-file .env.staging.web --confirm-ref <ref>
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { targetProblem, describeTarget, loadEnvFile } from './lib/target.mjs';
const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; };
loadEnvFile(arg('--env-file')); const url = process.env.STAGING_DATABASE_URL; if (!url) { console.error('Set STAGING_DATABASE_URL.'); process.exit(2); }
const problem = targetProblem(url, { confirmRef: arg('--confirm-ref') }); if (problem) { console.error(`REFUSED: ${problem}`); process.exit(2); }
const web = arg('--web-env-file'); const secret = web && /^INTEGRATION_GATEWAY_SECRET=(.+)$/m.exec(readFileSync(web, 'utf8'))?.[1]?.trim(); if (!secret || secret.length < 32) { console.error('INTEGRATION_GATEWAY_SECRET (at least 32 characters) not found in --web-env-file.'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: describeTarget(url).local ? false : { rejectUnauthorized: false } }); await c.connect();
try { await c.query('select public.integration_set_gateway_secret($1)', [secret]); console.log('Gateway secret registered (hash only is stored).'); } finally { await c.end(); }
