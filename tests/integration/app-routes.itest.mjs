// LIVE: HTTP tests against a RUNNING app (`npm run build && npm start`) configured with the SAME Supabase project.
// Covers route protection, Builder authorization by role, org-cookie spoofing, and callback failure paths.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, APP_URL, admin, newUser, createOrg, cookieClient, cleanup } from './env.mjs';

const opt = { skip: guard ?? false };
const get = (path, cookie) => fetch(APP_URL + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const loc = r => r.headers.get('location') ?? '';
let owner, employee, outsider, orgA, orgB, jar = {};

async function session(u) { const j = cookieClient(); assert.ifError((await j.client.auth.signInWithPassword({ email: u.email, password: u.password })).error); return j; }

before(async () => {
  if (guard) return;
  owner = await newUser('own'); employee = await newUser('emp'); outsider = await newUser('out');
  orgA = await createOrg(owner, 'Route Org A'); orgB = await createOrg(outsider, 'Route Org B');
  // Fixture only: there is no client-side invite flow yet, so the service role seeds the employee membership.
  const { error } = await admin().from('organization_members').insert({ organization_id: orgA, user_id: employee.id, role: 'employee' });
  if (error) throw error;
  jar = { owner: await session(owner), employee: await session(employee), outsider: await session(outsider) };
});
after(cleanup);

test('unauthenticated users are redirected to /login from Work and Builder', opt, async () => {
  for (const p of ['/work', '/builder', '/work/leads']) { const r = await get(p); assert.ok([302, 303, 307, 308].includes(r.status), `${p} -> ${r.status}`); assert.match(loc(r), /\/login$/); }
  assert.equal((await get('/login')).status, 200);
});

test('Builder: owner allowed; employee denied; employee navigation omits Builder', opt, async () => {
  const o = await get('/builder', jar.owner.header()); assert.equal(o.status, 200); assert.match(await o.text(), /Workspace configuration/);
  const e = await get('/builder', jar.employee.header()); assert.equal(e.status, 200);
  const html = await e.text(); assert.match(html, /Builder is limited to owners and admins/); assert.doesNotMatch(html, /Workspace configuration/);
  assert.doesNotMatch(await (await get('/work', jar.employee.header())).text(), />Builder</);
});

test('a user with no organization is sent to /onboarding', opt, async () => {
  const lone = await newUser('lone'); const j = await session(lone);
  const r = await get('/work', j.header()); assert.match(loc(r), /\/onboarding$/);
});

test('spoofed bos_org cookie cannot switch a user into another organization', opt, async () => {
  const r = await get('/work', jar.owner.header({ bos_org: orgB }));
  const html = await r.text(); assert.match(html, /Route Org A/); assert.doesNotMatch(html, /Route Org B/);
  // outsider claiming org A must not get A's workspace either
  const r2 = await (await get('/work', jar.outsider.header({ bos_org: orgA }))).text(); assert.match(r2, /Route Org B/); assert.doesNotMatch(r2, /Route Org A/);
});

test('auth callback without a valid code redirects to /login', opt, async () => {
  assert.match(loc(await get('/auth/callback')), /\/login$/);
  assert.match(loc(await get('/auth/callback?code=not-a-real-code')), /\/login$/);
});
