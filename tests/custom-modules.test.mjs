// Custom Module Builder SQL tests: real PostgreSQL engine (PGlite) running the real migrations 0001-0006.
// NOT Supabase: auth schema/auth.uid()/default grants are a small shim. Live login/logout persistence is in tests/integration/records.itest.mjs.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { validateRecord } from '../src/lib/records/validate.ts';
import { slug, fieldSlug, validateConfig } from '../src/lib/workspace/schema.ts';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [OWN, OWN2, EMP, EMP2, MGR, ADM] = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const F = (label, kind = 'text', extra = {}) => ({ key: fieldSlug(label), label, kind, ...extra });
const mod = (label, fields, status = 'active') => ({ module: { key: slug(label), label, status }, object: { key: slug(label), label, fields } });
const def = (...mods) => ({ schemaVersion: 1, businessName: 'X', modules: [...CORE, ...mods.map(m => m.module)], objects: mods.map(m => m.object), pipeline: { stages: ['New', 'Won'] } });
const vehicles = () => mod('Vehicles', [F('Registration Number', 'text', { required: true }), F('Status', 'choice', { options: ['Available', 'Sold', 'In repair'] })]);

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const rows = (u, sql, p) => as(u, sql, p).then(r => r.rows);
const rpc = (u, fn, ...args) => as(u, `select public.${fn}(${args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' && args[i] !== null ? '::jsonb' : ''}`).join(',')}) r`, args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a))).then(r => r.rows[0].r);
const fails = (p, code, msg) => assert.rejects(p, e => (!code || e.code === code) && (!msg || msg.test(e.message)));
const publish = async (u, org, d) => { await rpc(u, 'save_workspace_draft', org, d); return rpc(u, 'publish_workspace_config', org); };
const live = async org => (await db.query(`select definition from public.workspace_configuration_versions where organization_id=$1 and status='published'`, [org])).rows[0].definition;
const create = (u, org, obj, data) => rpc(u, 'record_create', org, obj, data);
const recs = (u, org, obj) => rows(u, 'select * from public.records where organization_id=$1 and object_key=$2 order by created_at, id', [org, obj]);
let A, B, seq = 20;
// A brand-new organization (own owner) with the standard team, so tests can reshape its configuration freely.
async function fresh() {
  const owner = id(String(seq++)); await db.exec(`insert into auth.users values ('${owner}','o${seq}@x.test')`);
  const org = await rpc(owner, 'create_workspace', `Fresh ${seq}`, null, null, def()).then(String);
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await rpc(owner, 'crm_add_member', org, e, r);
  return { org, owner };
}

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${OWN}','own@x.test'),('${OWN2}','own2@x.test'),('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${MGR}','mgr@x.test'),('${ADM}','adm@x.test');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const mk = (u, n) => rpc(u, 'create_workspace', n, null, null, def()).then(String);
  A = await mk(OWN, 'Org A'); B = await mk(OWN2, 'Org B');
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await rpc(OWN, 'crm_add_member', A, e, r);
});

test('ACCEPTANCE: owner creates Vehicles with Registration Number + Status and publishes; an employee creates a record that persists', async () => {
  assert.equal(await publish(OWN, A, def(vehicles())), 2);
  const id1 = await create(EMP, A, 'vehicles', { registration_number: 'MH12AB1234', status: 'Available' });
  // "new session": a fresh role switch re-reads from storage (a real logout/login is covered by the live integration test)
  const [r] = await rows(EMP, 'select * from public.records where id=$1', [id1]);
  assert.deepEqual(r.data, { registration_number: 'MH12AB1234', status: 'Available' });
  assert.equal(r.created_by, EMP); assert.equal(r.config_revision, 2); assert.equal(r.object_key, 'vehicles');
  assert.equal((await rows(OWN, 'select 1 from public.records where id=$1', [id1])).length, 1, 'owner sees the employee record');
  await rpc(EMP, 'record_update', A, id1, { status: 'Sold' });
  assert.equal((await recs(EMP, A, 'vehicles'))[0].data.status, 'Sold');
});

test('arbitrary module names: any label becomes a working module; the same name in two organizations stays separate', async () => {
  const names = ['Pet Grooming Appointments', 'Müller & Söhne', '🚗 Fleet', 'Q3 — Goals (2026)', '  Spaces   Everywhere  '];
  await publish(OWN, A, def(vehicles(), ...names.map(n => mod(n.trim().replace(/\s+/g, ' '), [F('Title', 'text', { required: true }), F('Amount', 'currency', { currency: 'EUR' })]))));
  for (const n of names) {
    const key = slug(n.trim().replace(/\s+/g, ' ')); assert.match(key, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    await create(EMP, A, key, { title: `record in ${n}`, amount: 12.5 });
    assert.equal((await recs(EMP, A, key)).length, 1);
  }
  // org B defines a module with the same name and different fields
  await publish(OWN2, B, def(mod('Vehicles', [F('Chassis'), F('Weight', 'number')])));
  const bId = await create(OWN2, B, 'vehicles', { chassis: 'CH-1', weight: 1200 });
  assert.equal((await recs(OWN2, B, 'vehicles')).length, 1);
  assert.equal((await recs(EMP, A, 'vehicles')).length, 1, 'A\'s vehicles unaffected');
  assert.equal((await rows(OWN2, 'select 1 from public.records where organization_id=$1', [A])).length, 0, 'B cannot read A');
  assert.equal((await rows(EMP, 'select 1 from public.records where id=$1', [bId])).length, 0, 'A cannot read B');
  // cross-org writes: A's user cannot touch B (member check) and B's user cannot use A's module definition
  await fails(create(EMP, B, 'vehicles', { chassis: 'x' }), '42501');
  await fails(rpc(EMP, 'record_update', B, bId, { chassis: 'hacked' }), '42501');
  await fails(rpc(OWN2, 'record_update', B, (await recs(EMP, A, 'vehicles'))[0].id, { registration_number: 'x' }), 'P0002', /not found/);
  await fails(create(OWN2, B, 'pet-grooming-appointments', { title: 'x' }), 'P0002');
  await fails(create(OWN2, A, 'vehicles', { chassis: 'x' }), '42501');
  assert.equal((await recs(OWN2, B, 'vehicles'))[0].data.chassis, 'CH-1');
});

test('field types: text, number, date, dropdown, checkbox, phone, email, currency validate and normalize in the database', async () => {
  const { org: A, owner: OWN } = await fresh();
  const kinds = mod('Kitchen Sink', [F('Name'), F('Count', 'number'), F('Due', 'date'), F('Tier', 'choice', { options: ['Gold', 'Silver'] }), F('Active', 'yes_no'), F('Phone', 'phone'), F('Email', 'email'), F('Price', 'currency', { currency: 'USD' })]);
  await publish(OWN, A, def(vehicles(), kinds));
  const ok = async data => { const rid = await create(EMP, A, 'kitchen-sink', data); return (await recs(EMP, A, 'kitchen-sink')).find(r => r.id === rid).data; };
  assert.deepEqual(await ok({ name: '  Hello  ', count: 3.5, due: '2026-02-28', tier: 'Gold', active: false, phone: '+91 98765-43210', email: ' A@B.CO ', price: 19.99 }),
    { name: 'Hello', count: 3.5, due: '2026-02-28', tier: 'Gold', active: false, phone: '+919876543210', email: 'a@b.co', price: 19.99 });
  const bad = (data, re) => fails(create(EMP, A, 'kitchen-sink', data), '22023', re);
  await bad({ name: 5 }, /must be text/); await bad({ name: 'x'.repeat(2001) }, /2000/);
  await bad({ count: '5' }, /must be a number/); await bad({ count: 1e15 }, /too large/);
  await bad({ price: 1.234 }, /2 decimal/); await bad({ price: 'free' }, /must be a number/);
  await bad({ due: '2026-02-30' }, /valid date/); await bad({ due: '28/02/2026' }, /valid date/); await bad({ due: '1800-01-01' }, /valid date/);
  await bad({ tier: 'Bronze' }, /listed options/); await bad({ tier: 3 }, /listed options/);
  await bad({ active: 'yes' }, /yes or no/); await bad({ active: 1 }, /yes or no/);
  await bad({ phone: 'call me' }, /phone/); await bad({ phone: '123' }, /phone/);
  await bad({ email: 'nope' }, /email/); await bad({ email: 'a@b' }, /email/);
  await bad({ nonexistent: 'x' }, /Unknown field/);
  await fails(as(EMP, `select public.record_create($1,'kitchen-sink','"not an object"'::jsonb)`, [A]), '22023', /Invalid record data/);
  // empty values clear; omitted optional fields are fine
  const id1 = await create(EMP, A, 'kitchen-sink', { name: 'x', tier: 'Gold' });
  await rpc(EMP, 'record_update', A, id1, { tier: '', count: null });
  assert.deepEqual((await recs(EMP, A, 'kitchen-sink')).find(r => r.id === id1).data, { name: 'x' });
});

test('required fields and dropdown option control', async () => {
  const { org: A, owner: OWN } = await fresh();
  await publish(OWN, A, def(vehicles()));
  await fails(create(EMP, A, 'vehicles', { status: 'Sold' }), '22023', /"Registration Number" is required/);
  await fails(create(EMP, A, 'vehicles', { registration_number: '   ' }), '22023', /required/);
  await fails(create(EMP, A, 'vehicles', { registration_number: 'X', status: 'Stolen' }), '22023', /listed options/);
  const id1 = await create(EMP, A, 'vehicles', { registration_number: 'R1', status: 'In repair' });
  await fails(rpc(EMP, 'record_update', A, id1, { registration_number: null }), '22023', /required/);
  // the owner removes the "In repair" option: the existing value stays valid for that record, but nobody can pick it for others
  const d = await live(A); d.objects.find(o => o.key === 'vehicles').fields[1].options = ['Available', 'Sold'];
  await publish(OWN, A, d);
  await rpc(EMP, 'record_update', A, id1, { registration_number: 'R1-edited', status: 'In repair' });
  assert.equal((await recs(EMP, A, 'vehicles')).find(r => r.id === id1).data.status, 'In repair');
  await fails(create(EMP, A, 'vehicles', { registration_number: 'R2', status: 'In repair' }), '22023', /listed options/);
});

test('permissions: members create, creators and managers edit, others cannot; no direct table writes; planned/hidden/core modules refuse records', async () => {
  const { org: A, owner: OWN } = await fresh();
  await publish(OWN, A, def(vehicles(), mod('Planned Thing', [F('Name')], 'planned'), mod('Old Thing', [F('Name')], 'archived')));
  const mine = await create(EMP, A, 'vehicles', { registration_number: 'E1' });
  await fails(rpc(EMP2, 'record_update', A, mine, { registration_number: 'steal' }), '42501', /you created/);
  await rpc(EMP, 'record_update', A, mine, { registration_number: 'E1b' });
  for (const u of [MGR, ADM, OWN]) await rpc(u, 'record_update', A, mine, { registration_number: `by-${u.slice(-2)}` });
  const mgrs = await create(MGR, A, 'vehicles', { registration_number: 'M1' });
  await fails(rpc(EMP, 'record_update', A, mgrs, { registration_number: 'no' }), '42501');
  await fails(create(OWN2, A, 'vehicles', { registration_number: 'x' }), '42501');
  await fails(as(null, `select public.record_create($1,'vehicles','{}')`, [A]), '42501');
  await fails(as(null, 'select * from public.records'), '42501');
  await fails(as(EMP, `insert into public.records (organization_id, object_key, created_by, updated_by) values ($1,'vehicles',$2,$2)`, [A, EMP]), '42501');
  await fails(as(OWN, `update public.records set data='{}' where id=$1`, [mine]), '42501');
  await fails(as(OWN, 'delete from public.records where id=$1', [mine]), '42501');
  await fails(create(EMP, A, 'planned-thing', { name: 'x' }), 'P0002'); await fails(create(EMP, A, 'old-thing', { name: 'x' }), 'P0002');
  await fails(create(EMP, A, 'leads', { name: 'x' }), 'P0002'); await fails(create(EMP, A, 'nope', {}), 'P0002');
  await fails(as(EMP, `select public.record_validate('{}','{}','{}')`), '42501'); // internal helpers are not callable
  await fails(rpc(EMP, 'save_workspace_draft', A, def()), '42501'); // only owners/admins configure
});

test('data protection: renames and hiding never lose data; removal and type changes are refused while records use a field', async () => {
  const { org: A, owner: OWN } = await fresh();
  await publish(OWN, A, def(vehicles()));
  const r1 = await create(EMP, A, 'vehicles', { registration_number: 'KEEP-1', status: 'Sold' });
  const edit = fn => async () => { const d = await live(A); fn(d.objects.find(o => o.key === 'vehicles'), d); return d; };
  // rename label (key unchanged) -> data intact and still editable under the new label
  await publish(OWN, A, await edit(o => { o.label = 'Fleet'; o.fields[0].label = 'Plate'; })());
  assert.equal((await recs(EMP, A, 'vehicles')).find(r => r.id === r1).data.registration_number, 'KEEP-1');
  await fails(create(EMP, A, 'vehicles', {}), '22023', /"Plate" is required/);
  // removing a field that holds data is refused; removing an unused field is fine
  await publish(OWN, A, await edit(o => o.fields.push(F('Notes')))());
  await rpc(OWN, 'save_workspace_draft', A, await edit(o => { o.fields = o.fields.filter(f => f.key !== 'status'); })());
  await fails(rpc(OWN, 'publish_workspace_config', A), '22023', /Hide the field instead/);
  await rpc(OWN, 'save_workspace_draft', A, await edit(o => { o.fields = o.fields.filter(f => f.key !== 'notes'); })());
  await rpc(OWN, 'publish_workspace_config', A);
  // changing the type of a field with data is refused
  await rpc(OWN, 'save_workspace_draft', A, await edit(o => { o.fields[1].kind = 'text'; delete o.fields[1].options; })());
  await fails(rpc(OWN, 'publish_workspace_config', A), '22023', /cannot change because records already use it/);
  // removing the module / record type while records exist is refused
  await rpc(OWN, 'save_workspace_draft', A, (await edit(() => {})()).objects.length ? { ...(await live(A)), modules: CORE, objects: [] } : null);
  await fails(rpc(OWN, 'publish_workspace_config', A), '22023', /Hide the module instead/);
  await rpc(OWN, 'discard_workspace_draft', A);
  // hiding a field keeps the data; hidden fields are read-only; showing it restores editing
  await publish(OWN, A, await edit(o => { o.fields[1].archived = true; })());
  assert.equal((await recs(EMP, A, 'vehicles')).find(r => r.id === r1).data.status, 'Sold');
  await fails(rpc(EMP, 'record_update', A, r1, { status: 'Available' }), '22023', /hidden/);
  await rpc(EMP, 'record_update', A, r1, { registration_number: 'KEEP-2' });
  assert.deepEqual((await recs(EMP, A, 'vehicles')).find(r => r.id === r1).data, { registration_number: 'KEEP-2', status: 'Sold' }, 'hidden value preserved through an edit');
  await publish(OWN, A, await edit(o => { delete o.fields[1].archived; })());
  await rpc(EMP, 'record_update', A, r1, { status: 'Available' });
  // hiding the whole module keeps the records but they can no longer be written
  const d = await live(A); d.modules.find(m => m.key === 'vehicles').status = 'archived'; await publish(OWN, A, d);
  assert.equal((await recs(OWN, A, 'vehicles')).length > 0, true);
  await fails(rpc(EMP, 'record_update', A, r1, { registration_number: 'x' }), 'P0002');
  d.modules.find(m => m.key === 'vehicles').status = 'active'; await publish(OWN, A, d);
  await rpc(EMP, 'record_update', A, r1, { registration_number: 'back' });
});

test('rollback: restoring an old version loads it as a draft, keeps data-bearing fields, and never rewrites history', async () => {
  const org = await rpc(OWN2, 'create_workspace', 'Rollback Co', null, null, def()).then(String);
  await publish(OWN2, org, def(mod('Assets', [F('Tag', 'text', { required: true })])));                                            // v2
  const withColor = def(mod('Assets', [F('Tag', 'text', { required: true }), F('Color')]), mod('Extras', [F('Name')]));
  await publish(OWN2, org, withColor);                                                                                           // v3
  const rec = await create(OWN2, org, 'assets', { tag: 'T-1', color: 'red' });
  await create(OWN2, org, 'extras', { name: 'e1' });
  const hist = async () => (await db.query('select revision, status from public.workspace_configuration_versions where organization_id=$1 order by revision', [org])).rows;
  assert.deepEqual(await hist(), [{ revision: 1, status: 'archived' }, { revision: 2, status: 'archived' }, { revision: 3, status: 'published' }]);
  assert.equal(await rpc(OWN2, 'restore_workspace_revision', org, 2), 4);
  const draft = (await rows(OWN2, `select definition from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org]))[0].definition;
  const assets = draft.objects.find(o => o.key === 'assets');
  assert.deepEqual(assets.fields.map(f => [f.key, !!f.archived]), [['tag', false], ['color', true]], 'color has data, so it comes back hidden instead of vanishing');
  assert.equal(draft.modules.find(m => m.key === 'extras').status, 'archived', 'module with records is kept (hidden)');
  assert.equal(await rpc(OWN2, 'publish_workspace_config', org), 4);
  assert.deepEqual((await recs(OWN2, org, 'assets'))[0].data, { tag: 'T-1', color: 'red' }, 'data intact after rollback');
  assert.equal((await recs(OWN2, org, 'extras')).length, 1);
  await fails(rpc(OWN2, 'record_update', org, rec, { color: 'blue' }), '22023', /hidden/);
  assert.deepEqual((await hist()).map(h => h.status), ['archived', 'archived', 'archived', 'published'], 'old versions untouched; rollback created version 4');
  // a rollback that has nothing to protect is a plain restore
  assert.equal(await rpc(OWN2, 'restore_workspace_revision', org, 1), 5);
  await fails(rpc(OWN2, 'restore_workspace_revision', org, 99), '22023', /does not exist/);
  await fails(rpc(OWN2, 'restore_workspace_revision', org, 5), '22023'); // a draft is not a restorable version
  await fails(rpc(EMP, 'restore_workspace_revision', A, 1), '42501');
});

test('audit logging and indexes', async () => {
  const org = await rpc(OWN2, 'create_workspace', 'Audit Co', null, null, def()).then(String);
  await publish(OWN2, org, def(vehicles()));
  const rec = await create(OWN2, org, 'vehicles', { registration_number: 'A1', status: 'Sold' });
  await rpc(OWN2, 'record_update', org, rec, { status: 'Available', registration_number: 'A1' });
  await rpc(OWN2, 'record_update', org, rec, { status: 'Available' }); // no-op: no audit noise
  await rpc(OWN2, 'save_workspace_draft', org, def(vehicles())); await rpc(OWN2, 'discard_workspace_draft', org);
  await rpc(OWN2, 'restore_workspace_revision', org, 1);
  const audit = (await rows(OWN2, 'select event_name, actor_id, payload from public.audit_events where organization_id=$1 order by created_at, id', [org]));
  const names = audit.map(a => a.event_name);
  for (const n of ['organization.created', 'workspace.draft_saved', 'workspace.published', 'record.created', 'record.updated', 'workspace.draft_discarded', 'workspace.restore_requested']) assert.ok(names.includes(n), n);
  assert.equal(names.filter(n => n === 'record.updated').length, 1);
  assert.deepEqual(audit.find(a => a.event_name === 'record.updated').payload, { object: 'vehicles', record_id: rec, fields: ['status'] });
  assert.ok(!JSON.stringify(audit).includes('A1'), 'audit stores which fields changed, not their values');
  assert.equal((await db.query(`select 1 from public.domain_events where organization_id=$1 and event_name in ('record.created','record.updated')`, [org])).rows.length, 2);
  await db.exec('set role service_role'); try { await fails(db.query(`update public.audit_events set event_name='x'`), '42501'); } finally { await db.exec('reset role'); }
  const idx = (await db.query(`select indexname from pg_indexes where schemaname='public' and tablename in ('records','audit_events')`)).rows.map(r => r.indexname);
  for (const n of ['records_org_object_created_idx', 'records_data_gin_idx', 'audit_events_org_created_idx']) assert.ok(idx.includes(n), n);
});

test('listing helpers: dropdown/checkbox filters and search work on stored data', async () => {
  const org = await rpc(OWN2, 'create_workspace', 'List Co', null, null, def()).then(String);
  await publish(OWN2, org, def(mod('Cars', [F('Model'), F('Status', 'choice', { options: ['Available', 'Sold'] }), F('Insured', 'yes_no'), F('Price', 'currency')])));
  for (const [m, s, i, p] of [['Swift', 'Available', true, 500000], ['Creta', 'Sold', false, 900000], ['Santro', 'Sold', true, 250000]]) await create(OWN2, org, 'cars', { model: m, status: s, insured: i, price: p });
  const q = (sql, p = []) => rows(OWN2, `select data->>'model' m from public.records where organization_id='${org}' and object_key='cars' and ${sql} order by 1`, p).then(r => r.map(x => x.m));
  assert.deepEqual(await q(`data->>'status' = 'Sold'`), ['Creta', 'Santro']);
  assert.deepEqual(await q(`data->>'insured' = 'true'`), ['Santro', 'Swift']);
  assert.deepEqual(await q(`data @> '{"status":"Sold","insured":true}'`), ['Santro']);
  assert.deepEqual(await q(`search_text ilike '%san%'`), ['Santro']);
  assert.deepEqual(await q(`search_text ilike '%900000%'`), ['Creta'], 'numbers are searchable');
});

test('TypeScript record validation (Work Mode forms) and the SQL gate agree on a corpus', async () => {
  const object = mod('Parity', [F('Txt'), F('Num', 'number'), F('Day', 'date'), F('Pick', 'choice', { options: ['A', 'B'] }), F('Flag', 'yes_no'), F('Tel', 'phone'), F('Mail', 'email'), F('Money', 'currency'), F('Req', 'text', { required: true }), F('Gone', 'text', { archived: true })]).object;
  const valid = { Req: 'r' }, k = f => fieldSlug(f);
  const corpus = [valid, { ...valid, txt: 'x' }, { ...valid, num: 1.5 }, { ...valid, num: '1' }, { ...valid, day: '2026-01-31' }, { ...valid, day: '2026-13-01' }, { ...valid, pick: 'A' }, { ...valid, pick: 'C' },
    { ...valid, flag: true }, { ...valid, flag: 'true' }, { ...valid, tel: '+1 (555) 123-4567' }, { ...valid, tel: 'abc' }, { ...valid, mail: 'a@b.co' }, { ...valid, mail: 'a@' }, { ...valid, money: 10.5 }, { ...valid, money: 10.555 },
    { txt: 'no req' }, { ...valid, mystery: 1 }, { ...valid, gone: 'x' }, { ...valid, txt: '' }, { ...valid, txt: null }, { ...valid, num: 1e15 }, { ...valid, txt: 'x'.repeat(2001) }, { ...valid, day: '2026-02-29' }, { ...valid, day: '2024-02-29' }];
  void k;
  const org = await rpc(OWN2, 'create_workspace', 'Parity Co', null, null, def()).then(String);
  await publish(OWN2, org, def(mod('Parity', object.fields)));
  for (const input of corpus) {
    const ts = validateRecord(object, Object.fromEntries(Object.entries(input).map(([key, v]) => [fieldSlug(key), v]))).ok;
    const sql = await create(OWN2, org, 'parity', Object.fromEntries(Object.entries(input).map(([key, v]) => [fieldSlug(key), v]))).then(() => true, () => false);
    assert.equal(ts, sql, `TS=${ts} SQL=${sql} for ${JSON.stringify(input)}`);
  }
});

test('configuration validator parity for the new field attributes and module status', async () => {
  const good = def(vehicles());
  const withField = f => def(mod('M', [f]));
  const corpus = [good, withField(F('P', 'phone')), withField(F('E', 'email')), withField(F('C', 'currency', { currency: 'INR' })), withField(F('C', 'currency')), withField(F('C', 'currency', { currency: 'inr' })), withField(F('C', 'currency', { currency: 'RUPEES' })),
    withField(F('R', 'text', { required: true })), withField(F('R', 'text', { required: 'yes' })), withField(F('R', 'text', { archived: true })), withField(F('R', 'text', { archived: 'no' })), withField(F('D', 'choice', { options: [] })), withField(F('D', 'choice')),
    def(mod('M', [F('X')], 'archived')), def(mod('M', [F('X')], 'deleted')), { ...good, modules: [{ ...CORE[0], status: 'archived' }, CORE[1]] }];
  for (const d of corpus) {
    const ts = validateConfig(d).ok;
    const sql = await db.query('select public.validate_workspace_definition($1::jsonb)', [JSON.stringify(d)]).then(() => true, () => false);
    assert.equal(ts, sql, `TS=${ts} SQL=${sql} for ${JSON.stringify(d).slice(0, 200)}`);
  }
});

test('existing CRM Leads, tasks and team features keep working next to custom modules', async () => {
  const lead = await rpc(EMP, 'crm_create_lead', A, 'Asha Rao', '+919800000001', null, 'phone', null, null, null);
  await rpc(EMP, 'crm_add_note', A, lead, 'still works');
  assert.equal((await rows(EMP, 'select count(*)::int n from public.crm_lead_list where organization_id=$1', [A]))[0].n >= 1, true);
  assert.equal((await rows(OWN2, 'select 1 from public.leads where organization_id=$1', [A])).length, 0);
});
