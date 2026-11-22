// scripts/staging-set.mjs with scripted input against temporary copies of the env files: right values are written, wrong ones stop everything before anything is written, no secret is printed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REF = 'abcdefghij1234', OTHER = 'zzzzzzzzzz9999', PUB = 'sb_publishable_' + 'K'.repeat(32), PW = 'p@ss/w:rd#1';
const mk = () => { const d = mkdtempSync(join(tmpdir(), 'ss-')); for (const [f, body] of [['.env.staging.web', 'OPTIZEN_ENV=staging\nSTAGING_SUPABASE_REF=\nSUPABASE_PRODUCTION_REF=\nNEXT_PUBLIC_SUPABASE_URL=\nNEXT_PUBLIC_SUPABASE_ANON_KEY=\nNEXT_PUBLIC_SITE_URL=\nINTEGRATION_ENCRYPTION_KEY=KEEPME\n'], ['.env.staging.operator', 'STAGING_DATABASE_URL=\nSTAGING_SUPABASE_REF=\nSUPABASE_PRODUCTION_REF=\n'], ['.env.staging.workers', 'STAGING_SUPABASE_REF=\nSUPABASE_URL=\nSUPABASE_ANON_KEY=\nINTEGRATION_ENCRYPTION_KEY=KEEPME\n']]) writeFileSync(join(d, f), body); return d; };
const run = (lines, d = mk()) => { const r = spawnSync(process.execPath, ['scripts/staging-set.mjs', '--dir', d], { cwd: new URL('../', import.meta.url).pathname, input: lines.join('\n') + '\n', encoding: 'utf8', env: { PATH: process.env.PATH } }); return { ...r, d, read: f => readFileSync(join(d, f), 'utf8') }; };
const good = [`https://${REF}.supabase.co`, '', OTHER, PUB, `postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:5432/postgres`, PW, ''];

test('correct values are written to all three files, the password is URL-encoded, generated secrets are kept, nothing secret is printed', () => {
  const r = run(good); assert.equal(r.status, 0, r.stdout + r.stderr); const web = r.read('.env.staging.web'), op = r.read('.env.staging.operator'), wk = r.read('.env.staging.workers');
  assert.match(web, new RegExp(`STAGING_SUPABASE_REF=${REF}`)); assert.match(web, new RegExp(`SUPABASE_PRODUCTION_REF=${OTHER}`)); assert.match(web, /NEXT_PUBLIC_SITE_URL=https:\/\/optizen-staging\.vercel\.app/); assert.match(web, /INTEGRATION_ENCRYPTION_KEY=KEEPME/); assert.match(wk, /INTEGRATION_ENCRYPTION_KEY=KEEPME/);
  assert.ok(op.includes(`postgres:${encodeURIComponent(PW)}@db.${REF}.supabase.co`), 'special characters in the password are encoded'); assert.ok(wk.includes(`SUPABASE_URL=https://${REF}.supabase.co`));
  for (const secret of [PUB, PW, encodeURIComponent(PW)]) assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'secrets are never printed'); assert.match(r.stdout, new RegExp(`staging project ref   ${REF}`));
});

test('mistakes stop the tool and write nothing', () => {
  const cases = [['ref differs from the URL', [`https://${REF}.supabase.co`, OTHER], /does not match the Project URL/], ['not a hosted URL', ['http://localhost:54321'], /not a hosted Supabase project URL/],
    ['staging equals production', [`https://${REF}.supabase.co`, '', REF], /SAME ref as the production/], ['secret key pasted as the browser key', [`https://${REF}.supabase.co`, '', OTHER, 'sb_secret_' + 'K'.repeat(32)], /publishable\/anon key/],
    ['connection string of another project', [...good.slice(0, 4), `postgresql://postgres:[YOUR-PASSWORD]@db.${OTHER}.supabase.co:5432/postgres`, PW], /not .*abcdefghij1234/], ['transaction pooler', [...good.slice(0, 4), `postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-x.pooler.supabase.com:6543/postgres`, PW], /transaction pooler/],
    ['password already typed into the string', [...good.slice(0, 4), `postgresql://postgres:hunter2@db.${REF}.supabase.co:5432/postgres`, PW], /literal \[YOUR-PASSWORD\]/], ['http site url', [...good.slice(0, 6), 'http://x.test'], /https:\/\/host/]];
  for (const [name, lines, re] of cases) { const d = mk(); const before = readFileSync(join(d, '.env.staging.web'), 'utf8'); const r = run(lines, d); assert.equal(r.status, 1, `${name}: ${r.stdout}`); assert.match(r.stderr, re, name); assert.equal(r.read('.env.staging.web'), before, `${name}: nothing written`); assert.match(r.stderr, /Nothing was written/); }
});
