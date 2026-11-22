// Fills in the Supabase values of the three staging env files by asking for them. Secrets are typed hidden and never printed. Run it in YOUR terminal:
//   node scripts/staging-set.mjs
// It asks for: Project URL, publishable/anon key, the database connection string (with [YOUR-PASSWORD] left as is) and the database password. It derives the project ref from the URL,
// checks that every value belongs to the SAME project, URL-encodes the password, and writes STAGING_SUPABASE_REF, URLs and keys into .env.staging.web / .operator / .workers.
// Existing generated secrets (encryption key, gateway secret, monitor token) are never touched. Re-run any time to change a value.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { projectRef } from '../src/lib/env-guard.ts';
import { describeTarget } from './lib/target.mjs';

const dir = process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : '.';
let muted = false; const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc); cb(); } });
const rl = createInterface({ input: process.stdin, output: out, terminal: process.stdin.isTTY });
// A queue of typed/piped lines: robust whether the answers arrive one by one (a terminal) or all at once (a pipe).
const queue = [], waiting = []; let closed = false;
rl.on('line', l => (waiting.length ? waiting.shift()(l) : queue.push(l))); rl.on('close', () => { closed = true; while (waiting.length) waiting.shift()(''); });
const ask = (q, { secret = false, def } = {}) => new Promise(res => { process.stdout.write(`${q}${def ? ` [${def}]` : ''}: `); muted = secret; const done = a => { muted = false; if (secret) process.stdout.write('\n'); res(String(a).trim() || def || ''); }; if (queue.length) done(queue.shift()); else if (closed) done(''); else waiting.push(done); });
const fail = m => { console.error(`\nSTOP: ${m}\nNothing was written.`); process.exit(1); };

console.log('Supabase dashboard: Project settings -> General (Reference ID), API (Project URL, publishable/anon key), Database -> Connection string.\n');
const url = (await ask('Project URL (https://<ref>.supabase.co)')).replace(/\/$/, ''); const ref = projectRef(url); if (!ref) fail('That is not a hosted Supabase project URL (https://<ref>.supabase.co).');
const typedRef = await ask('Reference ID (Enter to use the one from the URL)', { def: ref }); if (typedRef !== ref) fail(`The Reference ID (${typedRef}) does not match the Project URL (${ref}). Check that both come from the same project.`);
const prodDefault = (() => { for (const f of ['.env.production', '.env.local']) if (existsSync(f)) { const m = /^NEXT_PUBLIC_SUPABASE_URL=https:\/\/([a-z0-9]{10,30})\.supabase\./m.exec(readFileSync(f, 'utf8')); if (m) return m[1]; } return ''; })();
const prod = await ask('Production-labelled project ref, as a second lock (Enter to skip)', { def: prodDefault }); if (prod && prod === ref) fail('That is the SAME ref as the production-labelled project. Staging must be a different project.');
const anon = await ask('Publishable / anon key (hidden)', { secret: true }); const okAnon = /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(anon) || (() => { try { const p = JSON.parse(Buffer.from(anon.split('.')[1], 'base64url').toString()); return p.role === 'anon' && (!p.ref || p.ref === ref); } catch { return false; } })();
if (!okAnon) fail('That does not look like the publishable/anon key of this project (it must start with sb_publishable_, or be a JWT with role "anon" for this project). Never use the secret/service-role key here.');
console.log('Database connection string: copy the URI from Database -> Connection string (keep the literal [YOUR-PASSWORD]); the password is asked next.');
let conn = await ask('Connection string URI (hidden)', { secret: true }); const pw = await ask('Database password (hidden)', { secret: true }); if (!pw) fail('A database password is required.');
if (conn.includes('[YOUR-PASSWORD]')) conn = conn.replace('[YOUR-PASSWORD]', encodeURIComponent(pw)); else fail('Leave the literal [YOUR-PASSWORD] in the connection string; the tool inserts the password safely.');
let t; try { t = describeTarget(conn); } catch { fail('The connection string is not a valid URI.'); } if (t.local || t.ref !== ref) fail(`The connection string points at project "${t.ref ?? t.host}", not ${ref}. Use the connection string of the same project.`);
if (/:6543\b/.test(conn)) fail('That is the transaction pooler (port 6543). Migrations need the direct connection (db.<ref>.supabase.co:5432) or the Session pooler (port 5432).');
const site = (await ask('Staging site URL', { def: 'https://optizen-staging.vercel.app' })).replace(/\/$/, ''); if (!/^https:\/\/[^/\s]+$/.test(site)) fail('The site URL must be https://host with no path.');
rl.close();

const set = (file, values) => { const f = `${dir}/${file}`; if (!existsSync(f)) fail(`${f} not found. Run: node scripts/staging-init.mjs`); let s = readFileSync(f, 'utf8'); for (const [k, v] of Object.entries(values)) { const re = new RegExp(`^${k}=.*$`, 'm'); s = re.test(s) ? s.replace(re, () => `${k}=${v}`) : `${s.replace(/\n?$/, '\n')}${k}=${v}\n`; } writeFileSync(f, s, { mode: 0o600 }); };
set('.env.staging.web', { STAGING_SUPABASE_REF: ref, SUPABASE_PRODUCTION_REF: prod, NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, NEXT_PUBLIC_SITE_URL: site });
set('.env.staging.operator', { STAGING_DATABASE_URL: conn, STAGING_SUPABASE_REF: ref, SUPABASE_PRODUCTION_REF: prod });
set('.env.staging.workers', { STAGING_SUPABASE_REF: ref, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon });
console.log(`\nWritten (values not shown):\n  staging project ref   ${ref}\n  project URL           ${url}\n  database host         ${t.host} (${/pooler/.test(t.host) ? 'session pooler' : 'direct'})\n  site URL              ${site}\n  production ref lock   ${prod ? 'set' : 'not set (still read from .env.local at runtime if present)'}\nNext: tell Claude "values are ready".`);
process.exit(0);
