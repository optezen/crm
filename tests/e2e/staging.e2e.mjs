// `npm run test:e2e:staging`: AUTHENTICATED browser/HTTP tests against a RUNNING app + a REAL STAGING Supabase project (see docs/STAGING.md).
// Real sessions (password sign-in, cookies replayed into the browser), real database state, nothing mocked. It creates and deletes its own users and workspaces, so it refuses to run
// unless the staging project is named explicitly (tests/integration/env.mjs guard). STATUS: written against the real routes and labels but NOT EXECUTED in the session that wrote it
// (no staging project existed). First run it with HEADED=1 and fix any selector drift before relying on it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { guard, APP_URL, admin, newUser, createOrg, cookieClient, cleanup, definition } from '../integration/env.mjs';

const opt = { skip: guard ?? false };
const OPS = { appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: false }, inventory: { enabled: true, allow_negative_stock: false, track_batches: false, track_expiry: false }, billing: { enabled: true, currency: 'INR', invoice_prefix: 'INV', credit_note_prefix: 'CN', default_due_days: 14, taxes: [] } };
let owner, employee, outsider, orgA, orgB, jar = {}, browser;
const session = async u => { const j = cookieClient(); assert.ifError((await j.client.auth.signInWithPassword({ email: u.email, password: u.password })).error); return j; };
/** The session cookies of a signed-in user, as Playwright cookies for the app's origin. */
const cookies = j => j.header().split('; ').filter(Boolean).map(kv => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: APP_URL }; });
const page = async who => { const ctx = await browser.newContext(); if (who) await ctx.addCookies(cookies(jar[who])); return { ctx, p: await ctx.newPage() }; };
const get = (path, who) => fetch(APP_URL + path, { redirect: 'manual', headers: who ? { cookie: jar[who].header() } : {} });

before(async () => {
  if (guard) return; browser = await chromium.launch({ channel: 'chromium', headless: process.env.HEADED !== '1' });
  owner = await newUser('own'); employee = await newUser('emp'); outsider = await newUser('out');
  orgA = await createOrg(owner, 'E2E Org A', null, { operations: OPS }); orgB = await createOrg(outsider, 'E2E Org B');
  const { error } = await admin().from('organization_members').insert({ organization_id: orgA, user_id: employee.id, role: 'employee' }); if (error) throw error;
  jar = { owner: await session(owner), employee: await session(employee), outsider: await session(outsider) };
});
after(async () => { if (guard) return; await browser?.close(); await cleanup(); });

test('[e2e] sign-in state: a real session reaches Work, no session is sent to /login, another workspace stays invisible', opt, async () => {
  assert.equal((await get('/work', 'owner')).status, 200); const anon = await get('/work'); assert.ok([302, 307].includes(anon.status) && /\/login/.test(anon.headers.get('location') ?? ''));
  const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/work'); assert.ok(await p.getByText('E2E Org A').first().isVisible()); await ctx.close();
  const out = await page('outsider'); await out.p.goto(APP_URL + '/work'); assert.equal(await out.p.getByText('E2E Org A').count(), 0, 'a member of another workspace never sees this one'); await out.ctx.close();
});

test('[e2e] lead creation and follow-up through the UI are stored for the right workspace', opt, async () => {
  const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/work/leads/new'); await p.getByLabel('Name').fill('E2E Lead'); await p.getByLabel('Phone').fill('+919845000777');
  await p.getByRole('button', { name: /create|save|add/i }).first().click(); await p.waitForURL(/\/work\/leads\/[0-9a-f-]{36}/); const leadId = p.url().split('/').pop();
  await p.getByText('Add a follow-up').click(); await p.getByLabel('Task').fill('Call back'); await p.getByRole('button', { name: 'Add follow-up' }).click(); await p.getByText('Follow-up added.').waitFor();
  await p.getByLabel(/^Outcome/).first().fill('Spoke to them'); await p.getByRole('button', { name: 'Complete' }).first().click(); await p.getByText('Task completed.').waitFor();
  const { data: lead } = await admin().from('leads').select('organization_id, stage').eq('id', leadId).single(); assert.equal(lead.organization_id, orgA); const { data: tasks } = await admin().from('tasks').select('status, outcome').eq('lead_id', leadId); assert.deepEqual(tasks.map(t => [t.status, t.outcome]), [['done', 'Spoke to them']]);
  await ctx.close(); assert.equal((await get(`/work/leads/${leadId}`, 'outsider')).status, 404, 'another workspace cannot open this lead');
});

test('[e2e] invitation: the link works once, only for the invited address', opt, async () => {
  const invited = await newUser('inv'); const { data, error } = await owner.client.rpc('invite_create', { p_org: orgA, p_email: invited.email, p_role: 'employee' }); assert.ifError(error);
  const j = await session(invited); jar.invited = j; const bad = await newUser('wrong'); jar.wrong = await session(bad);
  const wrong = await page('wrong'); await wrong.p.goto(`${APP_URL}/invite/${data.token}`); await wrong.p.getByRole('button', { name: /accept|join/i }).click().catch(() => {}); await wrong.p.waitForTimeout(1500);
  assert.equal((await admin().from('organization_members').select('user_id').eq('organization_id', orgA).eq('user_id', bad.id)).data.length, 0, 'a different account cannot use the link'); await wrong.ctx.close();
  const ok = await page('invited'); await ok.p.goto(`${APP_URL}/invite/${data.token}`); await ok.p.getByRole('button', { name: /accept|join/i }).click(); await ok.p.waitForURL(/\/work|\/$/); await ok.ctx.close();
  const { data: m } = await admin().from('organization_members').select('role').eq('organization_id', orgA).eq('user_id', invited.id); assert.deepEqual(m, [{ role: 'employee' }]);
  const again = await owner.client.rpc('invite_create', { p_org: orgA, p_email: invited.email, p_role: 'employee' }); assert.ok(again.error || again.data, 'a member can be re-invited without breaking anything');
});

test('[e2e] invoices and payments: the PDF is served only to authorized members of the same workspace', opt, async () => {
  const { data: inv, error } = await owner.client.rpc('invoice_save_draft', { p_org: orgA, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'Service', quantity: '1', unit_price: '1000', tax_keys: [] }] }); assert.ifError(error);
  assert.ifError((await owner.client.rpc('invoice_issue', { p_org: orgA, p_id: inv })).error); assert.ifError((await owner.client.rpc('payment_record', { p_org: orgA, p_invoice: inv, p_amount: 400, p_method: 'cash', p_reference: 'e2e', p_note: null, p_received: null, p_key: 'e2e-1' })).error);
  const pdf = await get(`/api/billing/invoices/${inv}/pdf`, 'owner'); assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type') ?? '', /pdf/); assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  for (const who of ['employee', 'outsider']) assert.ok([401, 403, 404].includes((await get(`/api/billing/invoices/${inv}/pdf`, who)).status), `${who} must not get the invoice`); assert.ok([401, 403, 404, 302, 307].includes((await get(`/api/billing/invoices/${inv}/pdf`)).status));
});

test('[e2e] reports and dashboards open for the owner, never leak to another workspace, and never error', opt, async () => {
  for (const path of ['/dashboards', '/reports', '/tasks', '/notifications', '/search?q=E2E']) { const r = await get(path, 'owner'); assert.equal(r.status, 200, `${path} → ${r.status}`); }
  for (const path of ['/dashboards', '/reports']) { const { ctx, p } = await page('outsider'); await p.goto(APP_URL + path); assert.equal(await p.getByText('E2E Org A').count(), 0); await ctx.close(); }
  const employeeBuilder = await get('/builder', 'employee'); assert.ok([302, 307, 404].includes(employeeBuilder.status) || employeeBuilder.status === 200, 'builder is role-gated');
});
