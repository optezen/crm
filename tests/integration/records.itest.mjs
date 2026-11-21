// LIVE Supabase: custom modules end to end, as real authenticated users through PostgREST + RLS.
// ACCEPTANCE: an owner creates a "Vehicles" module with Registration Number and Status, publishes it, and an employee creates a
// vehicle record that persists after sign-out and a fresh sign-in.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, anon, newUser, createOrg, definition, cleanup } from './env.mjs';
import * as builder from '../../src/lib/workspace/builder.ts';
import * as records from '../../src/lib/records/service.ts';

const opt = { skip: guard ?? false };
const ok = r => { assert.ok(r.ok, r.error); return r.value; };
const F = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra });
const vehicles = { key: 'vehicles', label: 'Vehicles', fields: [F('registration_number', 'Registration Number', 'text', { required: true }), F('status', 'Status', 'choice', { options: ['Available', 'Sold', 'In repair'] })] };
const withVehicles = name => definition(name, { modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [vehicles] });
let owner, emp, other, orgA, orgB;
after(cleanup);
before(async () => { if (guard) return; [owner, emp, other] = await Promise.all(['own', 'emp', 'oth'].map(newUser)); orgA = await createOrg(owner, 'Records Org A'); orgB = await createOrg(other, 'Records Org B'); });

async function login(u) { const c = anon(); assert.ifError((await c.auth.signInWithPassword({ email: u.email, password: u.password })).error); return { ...u, client: c }; }

// Context exactly as the app builds it: organization from membership, role from membership, LIVE published configuration.
async function ctxFor(u, org) {
  const role = (await u.client.from('organization_members').select('role').eq('organization_id', org).eq('user_id', u.id).single()).data.role;
  const config = (await u.client.from('workspace_configuration_versions').select('definition').eq('organization_id', org).eq('status', 'published').order('revision', { ascending: false }).limit(1).single()).data.definition;
  return { db: u.client, organizationId: org, userId: u.id, role, config };
}

test('ACCEPTANCE: owner publishes Vehicles; employee creates a record; it persists after logout and login', opt, async () => {
  assert.ifError((await owner.client.rpc('crm_add_member', { p_org: orgA, p_email: emp.email, p_role: 'employee' })).error);
  ok(await builder.saveDraft(owner.client, orgA, withVehicles('Records Org A')));
  ok(await builder.publishDraft(owner.client, orgA));

  const E = await ctxFor(emp, orgA);
  const created = ok(await records.createRecord(E, 'vehicles', { registration_number: 'MH12AB1234', status: 'Available' }));
  assert.equal((await records.createRecord(E, 'vehicles', { status: 'Sold' })).ok, false, 'required field enforced');

  // logout (server-side revocation), then a brand-new client signs in again
  const token = (await emp.client.auth.getSession()).data.session.access_token;
  assert.ifError((await emp.client.auth.signOut({ scope: 'global' })).error);
  assert.ok((await anon().auth.getUser(token)).error, 'old session is revoked');
  assert.deepEqual((await emp.client.from('records_view').select('id')).data ?? [], [], 'signed-out client sees nothing');
  const again = anon();
  assert.ifError((await again.auth.signInWithPassword({ email: emp.email, password: emp.password })).error);
  const E2 = await ctxFor({ ...emp, client: again }, orgA);
  const list = ok(await records.listRecords(E2, 'vehicles', { page: 1, q: '', filters: {} }));
  assert.equal(list.total, 1); assert.deepEqual(list.rows[0].data, { registration_number: 'MH12AB1234', status: 'Available' }); assert.equal(list.rows[0].id, created.id);
  ok(await records.updateRecord(E2, 'vehicles', created.id, { status: 'Sold' }));
  assert.equal(ok(await records.getRecord(E2, 'vehicles', created.id)).data.status, 'Sold');
  // search + filter
  assert.equal(ok(await records.listRecords(E2, 'vehicles', { page: 1, q: 'mh12', filters: {} })).total, 1);
  assert.equal(ok(await records.listRecords(E2, 'vehicles', { page: 1, q: '', filters: { status: 'Available' } })).total, 0);
  assert.equal(ok(await records.listRecords(E2, 'vehicles', { page: 1, q: '', filters: { status: 'Sold' } })).total, 1);
});

test('organization isolation and permissions on live data', opt, async () => {
  const O = await ctxFor(owner, orgA);
  const mine = ok(await records.createRecord(O, 'vehicles', { registration_number: 'OWNER-1' }));
  // org B has its own Vehicles module with different fields
  ok(await builder.saveDraft(other.client, orgB, definition('Records Org B', { modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [{ key: 'vehicles', label: 'Vehicles', fields: [F('chassis', 'Chassis', 'text')] }] })));
  ok(await builder.publishDraft(other.client, orgB));
  const X = await ctxFor(other, orgB);
  ok(await records.createRecord(X, 'vehicles', { chassis: 'CH-1' }));
  assert.equal(ok(await records.listRecords(X, 'vehicles', { page: 1, q: '', filters: {} })).total, 1, 'B sees only its own');
  assert.deepEqual((await other.client.from('records_view').select('id').eq('organization_id', orgA)).data, []);
  assert.equal((await records.getRecord(X, 'vehicles', mine.id)).ok, false, 'A\'s record id is invisible to B');
  assert.equal((await records.updateRecord(X, 'vehicles', mine.id, { chassis: 'x' })).ok, false);
  const spoof = { ...X, organizationId: orgA }; // B's user claiming org A
  assert.equal((await records.createRecord(spoof, 'vehicles', { registration_number: 'X' })).ok, false);
  assert.equal(ok(await records.listRecords(spoof, 'vehicles', { page: 1, q: '', filters: {} })).total, 0);
  // employees edit only their own records; no direct writes
  const empNow = await login(emp), E = await ctxFor(empNow, orgA);
  assert.equal((await records.updateRecord(E, 'vehicles', mine.id, { registration_number: 'steal' })).ok, false);
  ok(await records.updateRecord(O, 'vehicles', mine.id, { registration_number: 'OWNER-1b' }));
  for (const r of await Promise.all([E.db.from('records').update({ data: {} }).eq('id', mine.id), E.db.from('records').delete().eq('id', mine.id), E.db.from('records').insert({ organization_id: orgA, object_key: 'vehicles', created_by: emp.id, updated_by: emp.id })])) assert.ok(r.error || r.count === 0);
});

test('data protection and rollback on live data', opt, async () => {
  const O = await ctxFor(owner, orgA);
  const live = O.config; const d = structuredClone(live); d.objects[0].fields = d.objects[0].fields.filter(f => f.key !== 'status');
  ok(await builder.saveDraft(owner.client, orgA, d));
  assert.equal((await builder.publishDraft(owner.client, orgA)).ok, false, 'a field records use cannot be removed');
  ok(await builder.discardDraft(owner.client, orgA));
  d.objects[0].fields = live.objects[0].fields.map(f => (f.key === 'status' ? { ...f, archived: true } : f));
  ok(await builder.saveDraft(owner.client, orgA, d)); ok(await builder.publishDraft(owner.client, orgA)); // hiding is allowed
  const versions = ok(await builder.listVersions(owner.client, orgA));
  const old = versions.find(v => v.status === 'archived');
  ok(await builder.restoreRevision(owner.client, orgA, old.revision));
  assert.equal((await builder.restoreRevision((await login(emp)).client, orgA, old.revision)).ok, false);
  assert.equal(ok(await records.listRecords(await ctxFor(owner, orgA), 'vehicles', { page: 1, q: '', filters: {} })).total >= 2, true, 'no records lost');
});
