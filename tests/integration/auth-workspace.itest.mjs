// LIVE Supabase: signup, login, workspace creation, signout, returning-user persistence.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { guard, admin, anon, newUser, createOrg, cleanup } from './env.mjs';
import { resolveMembership } from '../../src/lib/workspace/resolve.ts';

const opt = { skip: guard ?? false };
after(cleanup);

test('signup with email+password creates a user (requires email confirmations OFF)', opt, async t => {
  const email = `it-signup-${crypto.randomUUID()}@example.test`;
  const { data, error } = await anon().auth.signUp({ email, password: crypto.randomUUID() + 'Aa1!' });
  if (data?.user?.id) await admin().auth.admin.deleteUser(data.user.id);
  assert.ifError(error);
  if (!data.session) return t.skip('project requires email confirmation; signup created a user but no session (expected on live projects)');
  assert.ok(data.session.access_token);
});

test('login via the magic-link token path (same OTP exchange the email link performs)', opt, async () => {
  const u = await newUser('magic');
  const { data, error } = await admin().auth.admin.generateLink({ type: 'magiclink', email: u.email });
  assert.ifError(error);
  const c = anon();
  const r = await c.auth.verifyOtp({ token_hash: data.properties.hashed_token, type: 'magiclink' });
  assert.ifError(r.error);
  assert.equal(r.data.user.id, u.id);
});

test('new user has no organization; creation derives ownership from the JWT; returning user keeps it', opt, async () => {
  const u = await newUser('owner');
  const members = async c => (await c.from('organization_members').select('organization_id, role').eq('user_id', u.id)).data;
  assert.deepEqual(await members(u.client), []); // -> app sends this user to /onboarding

  const org = await createOrg(u, 'Integration Clinic');
  const rows = await members(u.client);
  assert.deepEqual(rows, [{ organization_id: org, role: 'owner' }]);
  const cfg = await u.client.from('workspace_configuration_versions').select('definition, status, revision').eq('organization_id', org).single();
  assert.equal(cfg.data.status, 'published'); assert.equal(cfg.data.definition.businessName, 'Integration Clinic');

  // signout: global scope revokes the session server-side
  const token = (await u.client.auth.getSession()).data.session.access_token;
  assert.ifError((await u.client.auth.signOut({ scope: 'global' })).error);
  assert.ok((await anon().auth.getUser(token)).error, 'revoked session must no longer validate');
  assert.deepEqual((await u.client.from('organizations').select('id')).data ?? [], [], 'signed-out client sees nothing');
  assert.ok((await u.client.rpc('create_organization', { p_name: 'Nope', p_industry: 'clinic', p_definition: { schemaVersion: 1 } })).error);

  // returning user: fresh client, fresh login, same workspace resolved from membership
  const again = anon();
  assert.ifError((await again.auth.signInWithPassword({ email: u.email, password: u.password })).error);
  const m = (await members(again)).map(r => ({ organizationId: r.organization_id, role: r.role }));
  assert.deepEqual(resolveMembership(m, 'spoofed-org-id'), { organizationId: org, role: 'owner' });
});

test('client cannot create an organization for someone else or bypass validation', opt, async () => {
  const u = await newUser('v');
  const bad = (n, i, d) => u.client.rpc('create_organization', { p_name: n, p_industry: i, p_definition: d });
  assert.equal((await bad('x', 'clinic', { schemaVersion: 1 })).error?.code, '22023');
  assert.equal((await bad('Valid', 'banking', { schemaVersion: 1 })).error?.code, '22023');
  assert.equal((await bad('Valid', 'clinic', []))?.error?.code, '22023');
  assert.ok((await anon().rpc('create_organization', { p_name: 'Valid', p_industry: 'clinic', p_definition: { schemaVersion: 1 } })).error, 'anon denied');
});
