// Shared setup for LIVE Supabase integration tests. Nothing here is mocked.
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { randomUUID } from 'node:crypto';

export const URL_ = process.env.SUPABASE_TEST_URL, ANON = process.env.SUPABASE_TEST_ANON_KEY, SERVICE = process.env.SUPABASE_TEST_SERVICE_ROLE_KEY;
export const APP_URL = process.env.APP_URL || 'http://localhost:3000';
export const configured = Boolean(URL_ && ANON && SERVICE);
const isLocal = configured && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(URL_);
export const guard = !configured ? 'SUPABASE_TEST_URL / _ANON_KEY / _SERVICE_ROLE_KEY not set'
  : !isLocal && process.env.SUPABASE_TEST_ALLOW_REMOTE !== '1' ? 'refusing to run against a non-local project without SUPABASE_TEST_ALLOW_REMOTE=1' : null;

const opts = { auth: { persistSession: false, autoRefreshToken: false } };
export const admin = () => createClient(URL_, SERVICE, opts); // ONLY for creating/deleting fixtures; never used to assert behaviour
export const anon = () => createClient(URL_, ANON, opts);

const users = [], orgs = [];
export const trackOrg = id => orgs.push(id);

/** Disposable user with a random password. Returns a client authenticated as that user (RLS applies). */
export async function newUser(label = 'u') {
  const email = `it-${label}-${randomUUID()}@example.test`, password = randomUUID() + 'Aa1!';
  const { data, error } = await admin().auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  const client = anon();
  const { error: e2 } = await client.auth.signInWithPassword({ email, password });
  if (e2) throw e2;
  return { id: data.user.id, email, password, client };
}

export async function createOrg(user, name, industry = 'clinic') {
  const { data, error } = await user.client.rpc('create_organization', { p_name: name, p_industry: industry, p_definition: { schemaVersion: 1, businessName: name, industryTemplate: industry, modules: [{ key: 'overview', label: 'Overview', status: 'active' }], objects: [], pipeline: { stages: ['a', 'b'] } } });
  if (error) throw error;
  trackOrg(data);
  return data;
}

/** An @supabase/ssr client backed by an in-memory cookie jar, so tests can replay real session cookies against the Next app. */
export function cookieClient() {
  const jar = new Map();
  const client = createServerClient(URL_, ANON, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: l => l.forEach(c => c.value ? jar.set(c.name, c.value) : jar.delete(c.name)) } });
  return { client, header: (extra = {}) => [...jar].map(([k, v]) => `${k}=${v}`).concat(Object.entries(extra).map(([k, v]) => `${k}=${v}`)).join('; ') };
}

export async function cleanup() {
  const a = admin();
  for (const id of orgs) await a.from('organizations').delete().eq('id', id); // cascades to members/config/audit
  for (const id of users) await a.auth.admin.deleteUser(id);
}
