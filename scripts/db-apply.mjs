// Applies the migrations to a STAGING database, in order, each in its own transaction, recording a checksum so an already-applied file can never be silently edited.
//   STAGING_DATABASE_URL=postgresql://… node scripts/db-apply.mjs --confirm-ref <ref>            # PLAN ONLY (default): prints what would run, changes nothing
//   STAGING_DATABASE_URL=postgresql://… node scripts/db-apply.mjs --confirm-ref <ref> --apply    # applies. Requires approval from the owner: see docs/STAGING.md
// Works with `supabase db push` too: use whichever you prefer, but not both on the same database.
import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { targetProblem, describeTarget } from './lib/target.mjs';

const arg = n => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : undefined; }; const apply = process.argv.includes('--apply');
const url = process.env.STAGING_DATABASE_URL; if (!url) { console.error('Set STAGING_DATABASE_URL.'); process.exit(2); }
const problem = targetProblem(url, { confirmRef: arg('--confirm-ref') }); if (problem) { console.error(`REFUSED: ${problem}`); process.exit(2); }
const dir = new URL('../supabase/migrations/', import.meta.url); const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
files.forEach((f, i) => { if (Number(f.slice(0, 4)) !== i + 1) { console.error(`REFUSED: migration chain is not contiguous at ${f}`); process.exit(2); } });
const sha = f => createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex');
const c = new pg.Client({ connectionString: url, ssl: describeTarget(url).local ? false : { rejectUnauthorized: false } }); await c.connect();
try {
  await c.query(`create table if not exists public.optizen_schema_migrations (version text primary key, sha256 text not null, applied_at timestamptz not null default now())`); await c.query(`alter table public.optizen_schema_migrations enable row level security`); await c.query(`revoke all on public.optizen_schema_migrations from anon, authenticated`);
  const done = new Map((await c.query('select version, sha256 from public.optizen_schema_migrations')).rows.map(r => [r.version, r.sha256]));
  for (const f of files) { const v = f.slice(0, 4); if (done.has(v) && done.get(v) !== sha(f)) { console.error(`REFUSED: ${f} was applied with different content (checksum mismatch). Never edit an applied migration; add a new one.`); process.exit(3); } }
  const todo = files.filter(f => !done.has(f.slice(0, 4))); console.log(`${files.length} migrations in the repository, ${done.size} already applied, ${todo.length} to apply${apply ? '' : ' (PLAN ONLY: pass --apply to run)'}.`); todo.forEach(f => console.log(`  ${apply ? 'apply' : 'would apply'} ${f}`));
  if (!apply) process.exit(0);
  for (const f of todo) { const t = Date.now(); try { await c.query('begin'); await c.query(readFileSync(new URL(f, dir), 'utf8')); await c.query('insert into public.optizen_schema_migrations (version, sha256) values ($1,$2)', [f.slice(0, 4), sha(f)]); await c.query('commit'); console.log(`  applied ${f} (${Date.now() - t} ms)`); }
    catch (e) { await c.query('rollback').catch(() => {}); console.error(`FAILED ${f}: ${e.message}${e.position ? ` (at character ${e.position})` : ''}\nThis migration was rolled back; earlier ones stay applied. Fix forward with a new migration, or restore the pre-release backup.`); process.exit(1); } }
  console.log('Done. Next: node scripts/db-validate.mjs --confirm-ref <ref>');
} finally { await c.end(); }
