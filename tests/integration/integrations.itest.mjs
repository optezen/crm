// LIVE Supabase (local project by default): Website Forms through the REAL anonymous entry point + RLS, then the automation engine. Not run by `npm test`.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, admin, anon, newUser, createOrg, cleanup } from './env.mjs';

const opt = { skip: guard ?? false };
after(cleanup);
let owner, other, orgA, orgB, conn, connB;
const submit = (c, payload, { secret = c.secret, idem } = {}) => anon().rpc('integration_ingest_form', { p_public_id: c.public_id, p_secret: secret, p_payload: payload, p_idem: idem ?? null, p_meta: { user_agent: 'itest' } });

before(async () => {
  if (guard) return;
  [owner, other] = await Promise.all(['own', 'oth'].map(newUser));
  [orgA, orgB] = await Promise.all([createOrg(owner, 'Hub Org A'), createOrg(other, 'Hub Org B')]);
  conn = (await owner.client.rpc('integration_create_connection', { p_org: orgA, p_provider: 'website_forms', p_name: 'Site', p_config: {} })).data;
  connB = (await other.client.rpc('integration_create_connection', { p_org: orgB, p_provider: 'website_forms', p_name: 'Site B', p_config: {} })).data;
});

test('anonymous submission with the connection secret creates one lead in the right organization and emits lead.created', opt, async () => {
  const a = await submit(conn, { name: 'Live Lead', email: 'live@example.test', phone: '+919811100001', utm_source: 'itest' }, { idem: 'live-1' }); assert.ifError(a.error); assert.equal(a.data.status, 'created');
  const b = await submit(conn, { name: 'Live Lead', email: 'live@example.test' }, { idem: 'live-1' }); assert.equal(b.data.status, 'duplicate'); assert.equal(b.data.lead_id, a.data.lead_id);
  assert.equal((await owner.client.from('leads').select('id').eq('organization_id', orgA)).data.length, 1);
  assert.equal((await other.client.from('leads').select('id').eq('organization_id', orgA)).data.length, 0);
  const ev = (await admin().from('domain_events').select('event_name, actor_id').eq('aggregate_id', a.data.lead_id)).data; assert.deepEqual(ev.map(e => e.event_name), ['lead.created']); assert.equal(ev[0].actor_id, null);
  assert.equal((await submit(connB, { name: 'x', email: 'x@example.test' }, { secret: conn.secret })).data.status, 'unauthorized');
});

test('clients cannot read secrets, credentials or call worker functions; the service role can run the automation tick', opt, async () => {
  assert.ok((await owner.client.from('integration_connections').select('secret_hash')).error, 'secret_hash is not selectable');
  assert.ok((await owner.client.from('integration_credentials').select('*')).error);
  assert.ok((await owner.client.rpc('integration_claim_events', { p_limit: 5 })).error); assert.ok((await anon().rpc('integration_claim_requests', { p_limit: 5 })).error);
  assert.ifError((await admin().rpc('integration_claim_events', { p_limit: 1 })).error);
});
