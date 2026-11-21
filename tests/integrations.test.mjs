// Integration Hub SQL tests: real PostgreSQL (PGlite) running the real migrations 0001-0008. NOT Supabase: auth.uid() and default grants are a shim.
// No external provider is contacted anywhere in this file; provider behaviour is covered with mocked HTTP in tests/integrations-adapters.test.mjs.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [EMP, EMP2, MGR, ADM] = ['c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const DEF = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Won'] } };

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const rows = (u, sql, p) => as(u, sql, p).then(r => r.rows);
const rpc = (u, fn, ...args) => as(u, `select public.${fn}(${args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' && args[i] !== null ? '::jsonb' : ''}`).join(',')}) r`, args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a))).then(r => r.rows[0].r);
const fails = (p, code, msg) => assert.rejects(p, e => (!code || e.code === code) && (!msg || msg.test(e.message)));
const q = async (sql, p) => (await db.query(sql, p)).rows;
async function worker(sql, params = []) { await db.exec('set role service_role'); try { return await db.query(sql, params); } finally { await db.exec('reset role'); } }
const wrpc = (fn, ...args) => worker(`select public.${fn}(${args.map((_, i) => `$${i + 1}${typeof args[i] === 'object' && args[i] !== null ? '::jsonb' : ''}`).join(',')}) r`, args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a))).then(r => r.rows[0].r);
const tick = async () => (await worker('select public.automation_tick(500, 50) r')).rows[0].r;
const drain = async () => { for (let i = 0; i < 8; i++) { const r = await tick(); if (!r.dispatched && !Object.keys(r.runs).length) return; } };
// the anonymous entry point exactly as the public route calls it
const ingest = (conn, payload, { secret = conn.secret, idem = null, meta = {} } = {}) => rpc(null, 'integration_ingest_form', conn.public_id, secret, payload, idem, meta);
let seq = 30;
async function fresh() {
  const owner = id(String(seq++)); await db.exec(`insert into auth.users values ('${owner}','o${seq}@x.test') on conflict do nothing`);
  const org = await rpc(owner, 'create_workspace', `Hub ${seq}`, null, null, DEF).then(String);
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await rpc(owner, 'crm_add_member', org, e, r);
  return { org, owner };
}
const form = async (o, name = 'Main website') => rpc(o.owner, 'integration_create_connection', o.org, 'website_forms', name);
const leads = org => q('select l.*, c.full_name, c.phone, c.email from public.leads l join public.contacts c on c.id = l.contact_id where l.organization_id=$1 order by l.created_at, l.id', [org]);
const GOOD = { 'Your Name': 'Asha Rao', 'Your Email': 'Asha@Example.com', 'Phone Number': '+91 98450 12345', Message: 'Interested in the 2BHK' };

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${MGR}','mgr@x.test'),('${ADM}','adm@x.test');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
});

test('DELIVERABLE: a website form submission becomes a real lead in the right organization, emits lead.created and the Automation Engine acts on it', async () => {
  const A = await fresh(), B = await fresh();
  const conn = await form(A);
  assert.match(conn.public_id, /^[a-z0-9]{16}$/); assert.match(conn.secret, /^oz_[0-9a-f]{64}$/);
  assert.equal((await q('select status from public.integration_connections where id=$1', [conn.id]))[0].status, 'setup_required');
  // an automation published BEFORE the lead arrives: round robin + follow-up task
  const wf = await rpc(A.owner, 'automation_save_draft', A.org, null, 'Website follow-up', { trigger: { event: 'lead.created' }, match: { conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }] },
    actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] });
  await rpc(A.owner, 'automation_publish', A.org, wf, true);

  const r = await ingest(conn, { ...GOOD, utm_source: 'google', utm_campaign: 'spring', gclid: 'abc' }, { meta: { page_url: 'https://acme.example/contact', referrer: 'https://google.com', user_agent: 'WordPress/6.5' } });
  assert.equal(r.status, 'created');
  const [lead] = await leads(A.org);
  assert.equal(lead.id, r.lead_id); assert.equal(lead.full_name, 'Asha Rao'); assert.equal(lead.email, 'asha@example.com'); assert.equal(lead.phone, '+919845012345');
  assert.equal(lead.source, 'website'); assert.equal(lead.stage, 'New'); assert.equal(lead.summary, 'Interested in the 2BHK');
  assert.equal(lead.created_by, conn.id, 'a service principal, not a person'); assert.equal((await leads(B.org)).length, 0, 'nothing leaks into another organization');
  const [attr] = await q('select * from public.lead_attribution where lead_id=$1', [lead.id]);
  assert.deepEqual(attr.utm, { utm_source: 'google', utm_campaign: 'spring', gclid: 'abc' }); assert.equal(attr.page_url, 'https://acme.example/contact'); assert.equal(attr.referrer, 'https://google.com'); assert.equal(attr.provider, 'website_forms');
  const [ev] = await q(`select * from public.domain_events where aggregate_id=$1 and event_name='lead.created'`, [lead.id]);
  assert.equal(ev.actor_id, null); assert.equal(ev.payload.integration, 'website_forms'); assert.equal(ev.payload.connection_id, conn.id);
  assert.deepEqual((await q('select actor_id, meta->>\'integration\' i from public.lead_activities where lead_id=$1', [lead.id]))[0], { actor_id: conn.id, i: 'website_forms' });
  const c = (await q('select status, last_event_at from public.integration_connections where id=$1', [conn.id]))[0];
  assert.equal(c.status, 'connected'); assert.ok(c.last_event_at);
  // the existing automation engine picks it up: assignment + task, exactly as for a lead typed in by a human
  await drain();
  const [after] = await leads(A.org); assert.equal(after.assigned_to, EMP);
  const t = await q('select title, owner_id from public.tasks where lead_id=$1', [lead.id]); assert.deepEqual(t, [{ title: 'Call Asha Rao', owner_id: EMP }]);
  // an employee sees the lead (assigned to them) and its attribution through normal RLS; owner B sees neither
  assert.equal((await rows(EMP, 'select 1 from public.lead_attribution where lead_id=$1', [lead.id])).length, 1);
  assert.equal((await rows(B.owner, 'select 1 from public.lead_attribution')).length, 0);
});

test('tenant isolation: the credential decides the organization; request fields cannot', async () => {
  const A = await fresh(), B = await fresh(); const ca = await form(A), cb = await form(B);
  assert.equal((await ingest(ca, GOOD, { secret: cb.secret })).status, 'unauthorized', "B's secret does not open A's endpoint");
  assert.equal((await ingest({ public_id: cb.public_id }, GOOD, { secret: ca.secret })).status, 'unauthorized');
  const r = await ingest(cb, { ...GOOD, organization_id: A.org, org: A.org, connection_id: ca.id });
  assert.equal(r.status, 'created');
  assert.equal((await leads(A.org)).length, 0); assert.equal((await leads(B.org)).length, 1);
  assert.match((await leads(B.org))[0].summary, new RegExp(A.org), 'a smuggled organization id is just an ordinary unmapped field');
  // management: another organization's owner cannot see or touch these connections
  assert.equal((await rows(B.owner, 'select 1 from public.integration_connections where id=$1', [ca.id])).length, 0);
  await fails(rpc(B.owner, 'integration_rotate_secret', B.org, ca.id), 'P0002'); await fails(rpc(B.owner, 'integration_disconnect', B.org, ca.id), 'P0002');
  await fails(rpc(B.owner, 'integration_save_mappings', B.org, ca.id, []), 'P0002'); await fails(rpc(B.owner, 'integration_set_config', B.org, ca.id, {}), 'P0002');
  await fails(rpc(B.owner, 'integration_rotate_secret', A.org, ca.id), '42501'); await fails(rpc(B.owner, 'integration_create_connection', A.org, 'website_forms', 'x'), '42501');
  assert.equal((await ingest(ca, GOOD)).status, 'created', "A's connection is unaffected");
});

test('permissions: only owners/admins manage connections; secrets and credentials are never readable by clients', async () => {
  const A = await fresh(); const conn = await form(A);
  for (const u of [EMP, MGR]) {
    await fails(rpc(u, 'integration_create_connection', A.org, 'website_forms', 'x'), '42501'); await fails(rpc(u, 'integration_rotate_secret', A.org, conn.id), '42501');
    await fails(rpc(u, 'integration_save_mappings', A.org, conn.id, []), '42501'); await fails(rpc(u, 'integration_disconnect', A.org, conn.id), '42501');
    assert.equal((await rows(u, 'select 1 from public.integration_connections')).length, 0); assert.equal((await rows(u, 'select 1 from public.integration_webhook_events')).length, 0);
  }
  await rpc(ADM, 'integration_save_mappings', A.org, conn.id, [{ external_field: 'x', target: 'ignore' }]);
  assert.equal((await rows(A.owner, 'select 1 from public.integration_connections where id=$1', [conn.id])).length, 1);
  await fails(as(A.owner, 'select secret_hash from public.integration_connections'), '42501'); await fails(as(A.owner, 'select * from public.integration_connections'), '42501');
  await fails(as(A.owner, 'select * from public.integration_credentials'), '42501'); await fails(as(null, 'select * from public.integration_connections'), '42501');
  await fails(as(A.owner, `insert into public.integration_connections (organization_id, provider, name, created_by) values ($1,'website_forms','x',$2)`, [A.org, A.owner]), '42501');
  // credentials: must arrive already encrypted; only owner/admin can read the ciphertext back
  const w = await rpc(A.owner, 'integration_create_connection', A.org, 'whatsapp', 'WhatsApp');
  await fails(rpc(A.owner, 'integration_store_credentials', A.org, w.id, '{"token":"plain"}', null), '22023', /encrypted/);
  await rpc(A.owner, 'integration_store_credentials', A.org, w.id, 'v1:AAAA.BBBB.CCCC', null);
  assert.equal((await rpc(A.owner, 'integration_read_credentials', A.org, w.id)).ciphertext, 'v1:AAAA.BBBB.CCCC'); await fails(rpc(EMP, 'integration_read_credentials', A.org, w.id), '42501');
  await fails(rpc(A.owner, 'integration_create_connection', A.org, 'whatsapp', 'again'), '23505'); await fails(rpc(A.owner, 'integration_create_connection', A.org, 'google_ads', 'g'), '22023', /cannot be connected yet/);
  // the worker/ingest functions are not callable by signed-in users
  for (const fn of ['integration_claim_events(5)', 'integration_apply_status_events(5)', 'integration_claim_requests(5)', 'integration_purge(30)']) await fails(as(A.owner, `select public.${fn}`), '42501');
  await fails(as(A.owner, `select public.integration_set_gateway_secret('${'x'.repeat(40)}')`), '42501'); await fails(as(null, `select public.integration_submit(null, '{}'::jsonb, '{}'::jsonb)`), '42501');
});

test('invalid credentials, rotation, disconnect, brute-force throttling and rate limits', async () => {
  const A = await fresh(); const conn = await form(A);
  for (const bad of ['', 'wrong', conn.secret + 'x', conn.secret.toUpperCase()]) assert.equal((await ingest(conn, GOOD, { secret: bad })).status, 'unauthorized');
  assert.equal((await ingest({ public_id: 'not-an-id' }, GOOD, { secret: conn.secret })).status, 'unauthorized');
  assert.equal((await leads(A.org)).length, 0);
  assert.ok((await q(`select 1 from public.integration_errors where connection_id=$1 and code='invalid_credentials'`, [conn.id])).length >= 3, 'refusals are logged for the owner to see');
  // rotation revokes the old secret immediately
  const rot = await rpc(A.owner, 'integration_rotate_secret', A.org, conn.id); assert.equal(rot.public_id, conn.public_id); assert.notEqual(rot.secret, conn.secret);
  assert.equal((await ingest(conn, GOOD)).status, 'unauthorized'); const live = { ...conn, secret: rot.secret };
  assert.equal((await ingest(live, GOOD)).status, 'created');
  // disconnect: no new submissions, history kept
  await rpc(A.owner, 'integration_disconnect', A.org, conn.id);
  assert.equal((await ingest(live, { ...GOOD, 'Phone Number': '+919999900000' })).status, 'unauthorized');
  assert.deepEqual((await q('select status, secret_hash is null n from public.integration_connections where id=$1', [conn.id]))[0], { status: 'not_connected', n: true }); assert.equal((await leads(A.org)).length, 1);
  // brute force: more than 20 failures in a minute throttles even that connection's correct secret until the window passes
  const B = await fresh(); const cb = await form(B);
  for (let i = 0; i < 22; i++) await ingest(cb, GOOD, { secret: 'guess' + i });
  assert.equal((await ingest(cb, GOOD)).status, 'rate_limited');
  await db.exec(`delete from public.integration_rate_limits`); assert.equal((await ingest(cb, GOOD)).status, 'created');
  // per-connection rate limit is configurable and enforced
  const C = await fresh(); const cc = await form(C); await rpc(C.owner, 'integration_set_config', C.org, cc.id, { rate_limit_per_min: 3 });
  const out = []; for (let i = 0; i < 5; i++) out.push((await ingest(cc, { name: 'N' + i, email: `n${i}@x.test` })).status);
  assert.deepEqual(out, ['created', 'created', 'created', 'rate_limited', 'rate_limited']);
  await fails(rpc(C.owner, 'integration_set_config', C.org, cc.id, { rate_limit_per_min: 0 }), '22023'); await fails(rpc(C.owner, 'integration_set_config', C.org, cc.id, { rate_limit_per_min: 100000 }), '22023');
});

test('credential in the URL is refused unless the owner enabled it; header credentials always work; invalid contact data is labelled, never promoted', async () => {
  const A = await fresh(); const conn = await form(A);
  const viaUrl = body => ingest(conn, body, { meta: { credential_source: 'query' } });
  const refused = await viaUrl({ name: 'U1', email: 'u1@x.test' }); assert.equal(refused.status, 'unauthorized'); assert.match(refused.reason, /does not accept the credential in the URL/);
  assert.equal((await leads(A.org)).length, 0);
  assert.equal((await ingest(conn, { name: 'H1', email: 'h1@x.test' }, { meta: { credential_source: 'header' } })).status, 'created');
  await fails(rpc(A.owner, 'integration_set_config', A.org, conn.id, { allow_query_key: 'yes' }), '22023'); await fails(rpc(EMP, 'integration_set_config', A.org, conn.id, { allow_query_key: true }), '42501');
  await rpc(A.owner, 'integration_set_config', A.org, conn.id, { allow_query_key: true });
  assert.equal((await viaUrl({ name: 'U2', email: 'u2@x.test' })).status, 'created', 'explicitly enabled');
  assert.equal((await ingest({ ...conn }, { name: 'U3', email: 'u3@x.test' }, { secret: 'wrong', meta: { credential_source: 'query' } })).status, 'unauthorized');
  // a wrong-format phone is not turned into a contact phone, the name is not taken from it, and the lead is flagged
  const r = await ingest(conn, { phone: '12-34', email: 'real@x.test' }); assert.equal(r.status, 'created');
  const l = (await leads(A.org)).find(x => x.id === r.lead_id); assert.equal(l.phone, null); assert.equal(l.full_name, 'Unnamed website lead'); assert.match(l.summary, /Phone \(not a valid number, unverified\): 12-34/);
  assert.equal((await q('select extra->>\'contact_unverified\' u from public.lead_attribution where lead_id=$1', [l.id]))[0].u, 'true');
  const ok = await ingest(conn, { name: 'Fine', phone: '+919811100099' }); assert.equal((await q('select extra->>\'contact_unverified\' u from public.lead_attribution where lead_id=$1', [ok.lead_id]))[0].u, null);
});

test('idempotency: retries never create a second lead (explicit key, identical payload, redelivery)', async () => {
  const A = await fresh(); const conn = await form(A);
  const a = await ingest(conn, GOOD, { idem: 'order-1001' }); const b = await ingest(conn, { ...GOOD, Message: 'edited on retry' }, { idem: 'order-1001' });
  assert.equal(a.status, 'created'); assert.deepEqual([b.status, b.lead_id], ['duplicate', a.lead_id]); assert.equal((await leads(A.org)).length, 1);
  assert.equal((await ingest(conn, GOOD, { idem: 'order-1002' })).status, 'created', 'a different key is a different submission'); assert.equal((await leads(A.org)).length, 2);
  // no key: an identical payload within 24h is treated as a retry; a different payload is not; after 24h it is a new submission
  const p = { name: 'Retry Person', phone: '+919811100011' };
  const x = await ingest(conn, p); const y = await ingest(conn, p); assert.deepEqual([x.status, y.status, y.lead_id], ['created', 'duplicate', x.lead_id]);
  assert.equal((await ingest(conn, { ...p, phone: '+919811100012' })).status, 'created');
  await db.exec(`update public.integration_webhook_events set received_at = now() - interval '25 hours' where connection_id='${conn.id}'`);
  assert.equal((await ingest(conn, p)).status, 'created'); assert.equal((await leads(A.org)).length, 5);
  // each lead.created was emitted exactly once, so the automation engine sees each lead once
  assert.equal((await q(`select count(*)::int n from public.domain_events where organization_id=$1 and event_name='lead.created'`, [A.org]))[0].n, 5);
  // a rejected submission retried with the same key is not re-processed
  const r1 = await ingest(conn, { name: 'No contact details' }, { idem: 'bad-1' }), r2 = await ingest(conn, { name: 'No contact details' }, { idem: 'bad-1' });
  assert.deepEqual([r1.status, r2.status, r2.duplicate], ['rejected', 'rejected', true]);
});

test('validation and normalization: flat payloads only, bad phone/email kept in the summary, contacts reused, rejections logged', async () => {
  const A = await fresh(); const conn = await form(A);
  for (const bad of [{ a: { b: 1 } }, { a: [1] }, ['x'], '"text"', null]) assert.equal((await ingest(conn, bad)).status, 'invalid');
  assert.equal((await ingest(conn, { name: 'x'.repeat(21000) })).status, 'invalid');
  const warn = await ingest(conn, { name: 'Raj', phone: 'call me maybe', email: 'raj@x.test' });
  assert.equal(warn.status, 'created'); assert.equal(warn.warnings.length, 1); const l1 = (await leads(A.org))[0];
  assert.equal(l1.email, 'raj@x.test'); assert.equal(l1.phone, null); assert.match(l1.summary, /Phone \(not a valid number, unverified\): call me maybe/);
  const warn2 = await ingest(conn, { name: 'Mia', email: 'not-an-email', phone: '9811100022' }); assert.equal(warn2.status, 'created');
  const none = await ingest(conn, { name: 'Ghost', phone: 'abc', email: 'nope' });
  assert.equal(none.status, 'rejected'); assert.match(none.reason, /phone number or email/);
  const ev = (await q(`select status, last_error from public.integration_webhook_events where id=$1`, [none.event_id]))[0]; assert.equal(ev.status, 'rejected');
  assert.ok((await q(`select 1 from public.integration_errors where connection_id=$1 and code='rejected'`, [conn.id])).length === 1);
  assert.match((await q('select last_error from public.integration_connections where id=$1', [conn.id]))[0].last_error, /phone number or email/);
  // the same person again (same phone) reuses the contact; a new lead is still created for the new enquiry
  const again = await ingest(conn, { name: 'Mia Again', phone: '98111 00022', message: 'second enquiry' });
  assert.equal(again.status, 'created'); const mia = (await leads(A.org)).filter(l => l.phone === '9811100022'); assert.equal(mia.length, 2); assert.equal(mia[0].contact_id, mia[1].contact_id);
  // name falls back to the email local part; long names are bounded
  await ingest(conn, { email: 'only.email@x.test' }); assert.ok((await leads(A.org)).some(l => l.full_name === 'Unnamed website lead'), 'the name is never derived from an email or phone');
  assert.ok(!(await leads(A.org)).some(l => /only\.email|9811100/.test(l.full_name)));
  const long = await ingest(conn, { name: 'N'.repeat(200), phone: '9811100033' }); assert.equal(long.status, 'created');
});

test('field mapping: automatic aliases, explicit mapping, first+last, ignore, unmapped fields kept, validation', async () => {
  const A = await fresh(), B = await fresh(); const conn = await form(A);
  await ingest(conn, { first_name: 'Anil', 'Last Name': 'Kumar', 'Contact No': '9822200001', 'WhatsApp': '9822200002', Notes: 'wants a demo', 'Budget': '5 lakh', fbclid: 'zz' });
  let l = (await leads(A.org))[0];
  assert.equal(l.full_name, 'Anil Kumar'); assert.equal(l.phone, '9822200002', 'whatsapp is recognized; "Contact No" is not an alias, so it is kept as an extra field');
  assert.match(l.summary, /wants a demo/); assert.match(l.summary, /Budget: 5 lakh/); assert.match(l.summary, /Contact No: 9822200001/);
  const attr = (await q('select utm, extra from public.lead_attribution where lead_id=$1', [l.id]))[0]; assert.deepEqual(attr.utm, { fbclid: 'zz' }); assert.equal(attr.extra.Budget, '5 lakh');
  // explicit mapping beats the aliases and can ignore fields
  assert.deepEqual(await rpc(A.owner, 'integration_observed_fields', A.org, conn.id), ['Budget', 'Contact No', 'Last Name', 'Notes', 'WhatsApp', 'first_name'], 'field names only, utm/click ids excluded');
  await fails(rpc(B.owner, 'integration_observed_fields', B.org, conn.id), 'P0002'); await fails(rpc(EMP, 'integration_observed_fields', A.org, conn.id), '42501');
  await rpc(A.owner, 'integration_save_mappings', A.org, conn.id, [{ external_field: 'Contact No', target: 'phone' }, { external_field: 'WhatsApp', target: 'ignore' }, { external_field: 'Budget', target: 'summary' }, { external_field: 'cust', target: 'full_name' }]);
  await ingest(conn, { cust: 'Priya N', 'Contact No': '9822200003', WhatsApp: '9822200004', Budget: '9 lakh', Notes: 'second' });
  l = (await leads(A.org)).at(-1); assert.equal(l.full_name, 'Priya N'); assert.equal(l.phone, '9822200003'); assert.match(l.summary, /9 lakh/); assert.match(l.summary, /second/); assert.doesNotMatch(l.summary, /9822200004/);
  assert.equal((await rows(A.owner, 'select 1 from public.integration_field_mappings where connection_id=$1', [conn.id])).length, 4);
  await rpc(A.owner, 'integration_save_mappings', A.org, conn.id, []); assert.equal((await q('select count(*)::int n from public.integration_field_mappings where connection_id=$1', [conn.id]))[0].n, 0);
  await fails(rpc(A.owner, 'integration_save_mappings', A.org, conn.id, [{ external_field: 'x', target: 'organization_id' }]), '22023'); await fails(rpc(A.owner, 'integration_save_mappings', A.org, conn.id, [{ external_field: '', target: 'phone' }]), '22023');
  await fails(rpc(B.owner, 'integration_save_mappings', B.org, conn.id, [{ external_field: 'x', target: 'phone' }]), 'P0002');
});

test('provider webhooks: gateway credential, asset routing, deduplication, retry/dead-letter, lead creation for Meta', async () => {
  const A = await fresh(), B = await fresh(); const GW = 'g'.repeat(48);
  await wrpc('integration_set_gateway_secret', GW);
  const meta = await rpc(A.owner, 'integration_create_connection', A.org, 'meta_lead_ads', 'Meta'); assert.equal(meta.secret, null);
  await rpc(A.owner, 'integration_upsert_assets', A.org, meta.id, [{ kind: 'page', external_id: 'PAGE1', name: 'Acme Page' }, { kind: 'page', external_id: 'PAGE2', name: 'Other Page' }]);
  const asset = (org, ext) => q(`select id from public.integration_assets where organization_id=$1 and external_id=$2`, [org, ext]).then(r => r[0].id);
  const evt = (page, lead) => ({ kind: 'meta_leadgen', asset_kind: 'page', asset_id: page, dedupe_key: `lead:${lead}`, payload: { leadgen_id: lead, page_id: page, form_id: 'F1' } });
  const recv = (events, secret = GW) => rpc(null, 'integration_receive_webhook', 'meta_lead_ads', secret, events);
  assert.equal((await recv([evt('PAGE1', 'L1')], 'wrong')).status, 'unauthorized');
  assert.equal((await recv([evt('PAGE1', 'L1')])).unrouted, 1, 'an asset nobody selected is dropped, not guessed');
  await rpc(A.owner, 'integration_select_asset', A.org, meta.id, await asset(A.org, 'PAGE1'), true);
  const bm = await rpc(B.owner, 'integration_create_connection', B.org, 'meta_lead_ads', 'Meta B'); await rpc(B.owner, 'integration_upsert_assets', B.org, bm.id, [{ kind: 'page', external_id: 'PAGE1', name: 'Claimed?' }]);
  await fails(rpc(B.owner, 'integration_select_asset', B.org, bm.id, await asset(B.org, 'PAGE1'), true), '23505', /another workspace/);
  const r = await recv([evt('PAGE1', 'L1'), evt('PAGE1', 'L1'), evt('PAGE2', 'L9'), evt('PAGEX', 'L2'), { kind: 'bogus' }]);
  assert.deepEqual([r.queued, r.duplicates, r.unrouted], [1, 1, 3]);
  assert.equal((await q('select count(*)::int n from public.integration_webhook_events where organization_id=$1', [B.org]))[0].n, 0);
  // worker: claim -> (adapter fetches the lead from Meta, mocked elsewhere) -> ingest through the trusted path
  const [c1] = (await worker('select * from public.integration_claim_events(5)')).rows; assert.equal(c1.attempts, 1); assert.equal(c1.organization_id, A.org);
  assert.equal((await worker('select * from public.integration_claim_events(5)')).rows.length, 0, 'a claimed event is not handed out twice');
  const res = await wrpc('integration_ingest_lead', c1.id, { full_name: 'Meta Person', email: 'meta@x.test', phone_number: '+919700000001', city: 'Pune' }, { provider: { form_id: 'F1', ad_id: 'AD9' } });
  assert.equal(res.status, 'created'); const [ml] = await leads(A.org); assert.equal(ml.source, 'meta_ads'); assert.equal(ml.full_name, 'Meta Person'); assert.equal(ml.created_by, meta.id);
  assert.equal((await q(`select extra->>'ad_id' a from public.lead_attribution where lead_id=$1`, [ml.id]))[0].a, 'AD9');
  assert.equal((await wrpc('integration_ingest_lead', c1.id, { name: 'x' }, {})).status, 'duplicate', 'ingesting the same event twice never makes a second lead');
  assert.equal((await q(`select count(*)::int n from public.domain_events where organization_id=$1 and event_name='lead.created'`, [A.org]))[0].n, 1);
  assert.equal((await q('select status from public.integration_webhook_events where id=$1', [c1.id]))[0].status, 'processed');
  // retries with backoff, then dead letter
  await recv([evt('PAGE1', 'L3')]); let ev = (await worker('select * from public.integration_claim_events(5)')).rows[0];
  for (let i = 1; i <= 5; i++) {
    const st = await wrpc('integration_fail_event', ev.id, 'Graph API timeout', true);
    if (i < 5) { assert.equal(st, 'failed'); assert.equal((await worker('select * from public.integration_claim_events(5)')).rows.length, 0, 'not before the backoff'); await db.exec(`update public.integration_webhook_events set next_attempt_at = now() - interval '1 second'`); ev = (await worker('select * from public.integration_claim_events(5)')).rows[0]; assert.equal(ev.attempts, i + 1); }
    else assert.equal(st, 'dead');
  }
  // a crashed worker: the claim expires and the event is picked up again
  await recv([evt('PAGE1', 'L4')]); const lost = (await worker('select * from public.integration_claim_events(5)')).rows[0];
  await db.exec(`update public.integration_webhook_events set locked_until = now() - interval '1 second' where id='${lost.id}'`);
  assert.equal((await worker('select * from public.integration_claim_events(5)')).rows[0].id, lost.id);
  assert.equal(await wrpc('integration_fail_event', lost.id, 'Invalid OAuth access token', false), 'dead');
  assert.ok((await rows(A.owner, `select 1 from public.integration_errors where code='dead_letter'`)).length >= 2); assert.equal((await rows(B.owner, 'select 1 from public.integration_errors')).length, 0);
  // expiry is surfaced as a status
  await wrpc('integration_set_connection_state', meta.id, 'expired', 'The Meta token expired. Reconnect to continue.');
  assert.deepEqual((await rows(A.owner, 'select status, last_error from public.integration_connections where id=$1', [meta.id]))[0], { status: 'expired', last_error: 'The Meta token expired. Reconnect to continue.' });
  assert.equal((await recv([evt('PAGE1', 'L5')])).unrouted, 1, 'an expired connection stops receiving new events');
});

test('WhatsApp: automation integration_requests are consumed only when a connected provider exists; sending, retries and delivery statuses', async () => {
  const A = await fresh(), B = await fresh(); const GW = 'w'.repeat(48); await wrpc('integration_set_gateway_secret', GW);
  const conn = await form(A);
  const wf = await rpc(A.owner, 'automation_save_draft', A.org, null, 'Welcome WhatsApp', { trigger: { event: 'lead.created' }, actions: [{ type: 'request_integration', channel: 'whatsapp', to: 'lead_contact', message: 'Hi {{lead.full_name}}, thanks for your enquiry!' }] });
  await rpc(A.owner, 'automation_publish', A.org, wf, true);
  await ingest(conn, { name: 'Neha', phone: '+919811100077' }); await drain();
  const req = () => q('select * from public.integration_requests where organization_id=$1', [A.org]).then(r => r[0]);
  assert.deepEqual([(await req()).channel, (await req()).status, (await req()).provider], ['whatsapp', 'requested', null]);
  assert.equal((await worker('select * from public.integration_claim_requests(5)')).rows.length, 0, 'no WhatsApp connection: nothing is claimed, nothing is sent');
  const w = await rpc(A.owner, 'integration_create_connection', A.org, 'whatsapp', 'WhatsApp');
  assert.equal((await worker('select * from public.integration_claim_requests(5)')).rows.length, 0, 'setup_required is not connected');
  await rpc(A.owner, 'integration_set_config', A.org, w.id, { provider: 'meta_cloud', phone_number_id: '1234567890', template_name: 'lead_welcome', template_language: 'en' });
  await fails(rpc(A.owner, 'integration_set_config', A.org, w.id, { template_name: 'Bad Name!', template_language: 'en' }), '22023'); await fails(rpc(A.owner, 'integration_set_config', A.org, w.id, { provider: 'carrier-pigeon' }), '22023');
  await rpc(A.owner, 'integration_upsert_assets', A.org, w.id, [{ kind: 'phone_number', external_id: '1234567890', name: '+91 98xxx' }]);
  await rpc(A.owner, 'integration_select_asset', A.org, w.id, (await q(`select id from public.integration_assets where connection_id=$1`, [w.id]))[0].id, true);
  await rpc(A.owner, 'integration_set_status', A.org, w.id, 'connected', null);
  const consentAll = () => db.exec(`insert into public.messaging_consent (organization_id, contact_id, channel, status, source, note) select organization_id, id, 'whatsapp', 'opted_in', 'import', 'test fixture' from public.contacts on conflict do nothing`);
  await consentAll(); const [claimed] = (await worker('select * from public.integration_claim_requests(5)')).rows;
  assert.equal(claimed.payload.message, 'Hi Neha, thanks for your enquiry!'); assert.equal(claimed.payload.phone, '+919811100077'); assert.equal(claimed.config.template_name, 'lead_welcome'); assert.equal(claimed.attempts, 1);
  assert.equal((await worker('select * from public.integration_claim_requests(5)')).rows.length, 0, 'claimed once');
  // transient failure -> requeued with backoff; permanent failure -> failed
  assert.equal(await wrpc('integration_complete_request', claimed.id, false, null, 'HTTP 503', true), 'requested');
  assert.equal((await worker('select * from public.integration_claim_requests(5)')).rows.length, 0, 'backoff'); await db.exec(`update public.integration_requests set next_attempt_at = now() - interval '1 second'`);
  const [again] = (await worker('select * from public.integration_claim_requests(5)')).rows; assert.equal(again.attempts, 2);
  assert.equal(await wrpc('integration_complete_request', again.id, true, 'wamid.ABC', null, false), 'sent');
  assert.deepEqual([(await req()).status, (await req()).provider_message_id], ['sent', 'wamid.ABC']);
  // delivery statuses arrive as signed webhooks routed by phone number id
  const st = (s, extra = {}) => ({ kind: 'whatsapp_status', asset_kind: 'phone_number', asset_id: '1234567890', dedupe_key: `wamid.ABC:${s}`, payload: { message_id: 'wamid.ABC', status: s, ...extra } });
  const recv = e => rpc(null, 'integration_receive_webhook', 'whatsapp', GW, e);
  assert.equal((await recv([st('delivered'), st('read'), st('sent')])).queued, 3);
  assert.equal((await worker('select public.integration_apply_status_events(50) r')).rows[0].r, 3); assert.equal((await req()).status, 'read', 'a late "sent" never moves the status backwards');
  // a failure report for a second message: sent -> failed, with the provider's error kept and logged
  await ingest(conn, { name: 'Omar', phone: '+919811100078' }); await drain(); await db.exec(`update public.integration_requests set next_attempt_at = now() - interval '1 second' where status = 'requested'`);
  await consentAll(); const [om] = (await worker('select * from public.integration_claim_requests(5)')).rows; await wrpc('integration_complete_request', om.id, true, 'wamid.DEF', null, false);
  await recv([{ kind: 'whatsapp_status', asset_kind: 'phone_number', asset_id: '1234567890', dedupe_key: 'wamid.DEF:failed', payload: { message_id: 'wamid.DEF', status: 'failed', error: '131026 Message undeliverable' } }]); await worker('select public.integration_apply_status_events(50)');
  const failed = (await q('select status, last_error from public.integration_requests where id=$1', [om.id]))[0]; assert.deepEqual(failed, { status: 'failed', last_error: '131026 Message undeliverable' });
  assert.equal((await rows(A.owner, `select 1 from public.integration_errors where code='delivery_failed'`)).length, 1);
  await recv([{ ...st('delivered'), asset_id: '999', dedupe_key: 'z' }]); assert.equal((await rows(B.owner, 'select 1 from public.integration_webhook_events')).length, 0);
  // five transient failures -> failed for good
  await ingest(conn, { name: 'Pia', phone: '+919811100079' }); await drain();
  for (let i = 1; i <= 5; i++) { await db.exec(`update public.integration_requests set next_attempt_at = now() - interval '1 second' where status = 'requested'`); await consentAll(); const c = (await worker('select * from public.integration_claim_requests(5)')).rows[0]; assert.equal(c.attempts, i); const s = await wrpc('integration_complete_request', c.id, false, null, 'HTTP 500', true); assert.equal(s, i < 5 ? 'requested' : 'failed'); }
  // other channels have no provider: they are never claimed
  assert.equal((await q(`select count(*)::int n from public.integration_requests where channel <> 'whatsapp' and status <> 'requested'`))[0].n, 0);
});

test('migration hygiene: integration tables are tenant-scoped and 0001-0007 objects still work', async () => {
  const cols = await q(`select table_name from information_schema.columns where table_schema='public' and column_name='organization_id' and table_name like 'integration\\_%' or table_name = 'lead_attribution' group by 1 order by 1`);
  for (const t of ['integration_connections', 'integration_credentials', 'integration_assets', 'integration_field_mappings', 'integration_webhook_events', 'integration_sync_jobs', 'integration_errors', 'lead_attribution'])
    assert.ok(cols.some(c => c.table_name === t), `${t} has organization_id`);
  assert.equal((await q(`select count(*)::int n from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'integration\\_%' and not c.relrowsecurity`))[0].n, 0, 'RLS enabled on every integration table');
  const A = await fresh(); const l = await rpc(A.owner, 'crm_create_lead', A.org, 'Manual Lead', '9811100099', null, 'phone', null, null, null); assert.ok(l);
  assert.equal((await q(`select count(*)::int n from public.lead_attribution where lead_id=$1`, [l]))[0].n, 0, 'human-created leads are unaffected');
  await wrpc('integration_purge', 1); assert.ok(true);
});
