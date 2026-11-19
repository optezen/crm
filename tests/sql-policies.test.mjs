// SQL-level tests: real PostgreSQL engine (PGlite/WASM) running the real migration files.
// NOT Supabase: the `auth` schema, auth.uid() and Supabase's default grants are a small shim (below).
// Proves migrations apply and RLS/privileges/triggers behave; does not prove GoTrue, PostgREST or the Next.js app.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto } });
const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b', C = '00000000-0000-0000-0000-00000000000c';
const def = (n = 'X') => ({ schemaVersion: 1, businessName: n, industryTemplate: 'clinic', modules: [], objects: [], pipeline: { stages: ['a', 'b'] } });

// Run one statement as a role/user, like PostgREST does (role switch + JWT claim), then reset.
async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const rejects = (p, code) => assert.rejects(p, e => (code ? e.code === code : true));
const create = (user, name = 'Org', ind = 'clinic', d = def(name)) => as(user, 'select public.create_organization($1,$2,$3::jsonb) id', [name, ind, JSON.stringify(d)]).then(r => r.rows[0].id);

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    -- Supabase's default privileges, so revokes in 0003 are meaningful:
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${A}'), ('${B}'), ('${C}');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
});

test('migrations 0001-0003 apply in order', async () => {
  const r = await db.query(`select count(*)::int n from pg_tables where schemaname='public'`);
  assert.equal(r.rows[0].n, 4);
});

test('anon has no table privileges and cannot call create_organization', async () => {
  await rejects(as(null, 'select * from public.organizations'), '42501');
  await rejects(as(null, `select public.create_organization('Nope','clinic','{"schemaVersion":1}')`), '42501');
  await rejects(as(null, 'select public.is_org_member(gen_random_uuid())'), '42501');
});

test('create_organization: owner comes from auth.uid(), config stored, audit written', async () => {
  const org = await create(A, '  Alpha  ');
  const m = await as(A, 'select role from public.organization_members where organization_id=$1 and user_id=$2', [org, A]);
  assert.equal(m.rows[0].role, 'owner');
  const c = await as(A, `select status, definition from public.workspace_configuration_versions where organization_id=$1`, [org]);
  assert.equal(c.rows[0].status, 'published'); assert.equal(c.rows[0].definition.businessName, 'Alpha'); // trimmed, taken from validated name
  assert.equal((await as(A, 'select 1 from public.audit_events where organization_id=$1', [org])).rows.length, 1);
});

test('create_organization rejects bad input and unauthenticated callers', async () => {
  await rejects(as(A, `select public.create_organization('x','clinic','{"schemaVersion":1}')`), '22023');
  await rejects(as(A, `select public.create_organization('Valid','banking','{"schemaVersion":1}')`), '22023');
  await rejects(as(A, `select public.create_organization('Valid','clinic','{"schemaVersion":2}')`), '22023');
  await rejects(as(A, `select public.create_organization('Valid','clinic','[]')`), '22023');
  await rejects(as(A, `select public.create_organization('Valid','clinic',$1::jsonb)`, [JSON.stringify({ schemaVersion: 1, pad: 'x'.repeat(200001) })]), '22023');
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','',false)`);
  await rejects(db.query(`select public.create_organization('Valid','clinic','{"schemaVersion":1}')`), '28000');
  await db.exec('reset role');
});

test('definition cannot lie about its own name or industry', async () => {
  const org = await create(B, 'Real Name', 'salon', { ...def('Spoof'), industryTemplate: 'clinic' });
  const r = await as(B, 'select definition from public.workspace_configuration_versions where organization_id=$1', [org]);
  assert.equal(r.rows[0].definition.businessName, 'Real Name'); assert.equal(r.rows[0].definition.industryTemplate, 'salon');
});

test('organization limit per owner is enforced', async () => {
  for (let i = 0; i < 4; i++) await create(C, `C org ${i}`); // 4 + 1 below = 5
  await create(C, 'C org 5');
  await rejects(create(C, 'C org 6'), '54000');
});

test('tenant isolation: A cannot read or modify B', async () => {
  const orgA = (await as(A, `select id from public.organizations where name='Alpha'`)).rows[0].id;
  const orgB = (await as(B, `select id from public.organizations where name='Real Name'`)).rows[0].id;
  // reads
  assert.equal((await as(A, 'select 1 from public.organizations where id=$1', [orgB])).rows.length, 0);
  assert.equal((await as(A, 'select 1 from public.organization_members where organization_id=$1', [orgB])).rows.length, 0);
  assert.equal((await as(A, 'select 1 from public.workspace_configuration_versions where organization_id=$1', [orgB])).rows.length, 0);
  assert.equal((await as(A, 'select 1 from public.audit_events where organization_id=$1', [orgB])).rows.length, 0);
  assert.equal((await as(A, 'select public.is_org_member($1) m', [orgB])).rows[0].m, false);
  // writes: no INSERT/UPDATE/DELETE privilege at all for clients (even on their own org)
  await rejects(as(A, 'insert into public.organization_members values ($1,$2,$3)', [orgB, A, 'owner']), '42501');
  await rejects(as(A, 'insert into public.organization_members values ($1,$2,$3)', [orgA, B, 'owner']), '42501');
  await rejects(as(A, `update public.organizations set name='pwned' where id=$1`, [orgB]), '42501');
  await rejects(as(A, `update public.organization_members set role='owner' where organization_id=$1`, [orgA]), '42501');
  await rejects(as(A, 'delete from public.organization_members where organization_id=$1', [orgB]), '42501');
  await rejects(as(A, `update public.workspace_configuration_versions set definition='{"schemaVersion":1}' where organization_id=$1`, [orgA]), '42501');
  await rejects(as(A, `insert into public.audit_events (organization_id, event_name) values ($1,'forged')`, [orgA]), '42501');
  // and B's data is unchanged
  assert.equal((await as(B, 'select name from public.organizations where id=$1', [orgB])).rows[0].name, 'Real Name');
});

test('RLS alone (privileges restored) still isolates tenants and blocks writes', async () => {
  // Defense in depth: re-grant table privileges temporarily; RLS with no write policies must still deny.
  await db.exec('grant insert, update, delete on public.organizations, public.organization_members to authenticated');
  try {
    const orgB = (await as(B, `select id from public.organizations where name='Real Name'`)).rows[0].id;
    assert.equal((await as(A, `update public.organizations set name='pwned' where id=$1 returning id`, [orgB])).rows.length, 0);
    await rejects(as(A, 'insert into public.organization_members values ($1,$2,$3)', [orgB, A, 'owner']), '42501');
    assert.equal((await as(A, 'delete from public.organization_members where organization_id=$1 returning 1', [orgB])).rows.length, 0);
  } finally { await db.exec('revoke insert, update, delete on public.organizations, public.organization_members from authenticated'); }
});

test('published configs and audit events are immutable, even for service_role', async () => {
  const org = (await as(A, `select id from public.organizations where name='Alpha'`)).rows[0].id;
  await db.exec('set role service_role');
  try {
    await rejects(db.query(`update public.workspace_configuration_versions set definition='{"schemaVersion":1}' where organization_id=$1`, [org]), '42501');
    await rejects(db.query('delete from public.workspace_configuration_versions where organization_id=$1', [org]), '42501');
    await rejects(db.query(`update public.audit_events set event_name='x' where organization_id=$1`, [org]), '42501');
    await rejects(db.query('delete from public.audit_events where organization_id=$1', [org]), '42501');
    await db.query(`update public.workspace_configuration_versions set status='archived' where organization_id=$1`, [org]); // archiving is allowed
    await db.query('delete from public.organizations where id=$1', [org]); // cascade cleanup still works
  } finally { await db.exec('reset role'); }
  assert.equal((await db.query('select 1 from public.audit_events where organization_id=$1', [org])).rows.length, 0);
});
