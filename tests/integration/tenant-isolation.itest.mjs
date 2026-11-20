// LIVE Supabase: two organizations cannot read or modify each other's data. All assertions run as the users (RLS on).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, anon, newUser, createOrg, cleanup } from './env.mjs';

const opt = { skip: guard ?? false };
let A, B, orgA, orgB;
before(async () => { if (guard) return; A = await newUser('a'); B = await newUser('b'); orgA = await createOrg(A, 'Org A'); orgB = await createOrg(B, 'Org B'); });
after(cleanup);

const T = ['organizations', 'organization_members', 'workspace_configuration_versions', 'audit_events'];
const key = t => t === 'organizations' ? 'id' : 'organization_id';

test('A sees only its own rows in every table; B\'s rows are invisible by id', opt, async () => {
  for (const t of T) {
    const mine = (await A.client.from(t).select('*')).data;
    assert.ok(mine.length >= 1 && mine.every(r => r[key(t)] === orgA), `${t}: only org A rows`);
    assert.deepEqual((await A.client.from(t).select('*').eq(key(t), orgB)).data, [], `${t}: org B hidden`);
  }
  assert.equal((await A.client.rpc('is_org_member', { p_org_id: orgB })).data, false);
});

test('A cannot write to B\'s data (or its own) through the API', opt, async () => {
  const before = (await B.client.from('organizations').select('name').eq('id', orgB).single()).data.name;
  const attempts = [
    A.client.from('organization_members').insert({ organization_id: orgB, user_id: A.id, role: 'owner' }),
    A.client.from('organization_members').insert({ organization_id: orgA, user_id: B.id, role: 'owner' }),
    A.client.from('organizations').update({ name: 'pwned' }).eq('id', orgB),
    A.client.from('organization_members').update({ role: 'owner' }).eq('organization_id', orgB),
    A.client.from('organization_members').delete().eq('organization_id', orgB),
    A.client.from('workspace_configuration_versions').update({ definition: { schemaVersion: 1 } }).eq('organization_id', orgB),
    A.client.from('workspace_configuration_versions').insert({ organization_id: orgB, revision: 99, status: 'published', definition: { schemaVersion: 1 } }),
    A.client.from('audit_events').insert({ organization_id: orgB, event_name: 'forged' }),
    A.client.from('organizations').insert({ name: 'direct insert' }), // must go through create_workspace
  ];
  for (const r of await Promise.all(attempts)) assert.ok(r.error || r.count === 0, 'write must be rejected');
  assert.equal((await B.client.from('organizations').select('name').eq('id', orgB).single()).data.name, before);
  assert.equal((await B.client.from('organization_members').select('user_id').eq('organization_id', orgB)).data.length, 1);
});

test('unauthenticated (anon key) client sees and writes nothing', opt, async () => {
  const c = anon();
  for (const t of T) { const r = await c.from(t).select('*'); assert.ok(r.error || r.data.length === 0, `${t} not readable by anon`); }
  assert.ok((await c.from('organizations').insert({ name: 'anon org' })).error);
});
