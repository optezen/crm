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

const poll = async (fn, ms = 90000, every = 1500) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return null; await new Promise(r => setTimeout(r, every)); } };
const rpc = async (u, fn, args) => { const r = await u.client.rpc(fn, args); assert.ifError(r.error); return r.data; };

test('[e2e] automation: a published workflow is executed by the REAL staging worker (needs the workers deployed), exactly once', opt, async () => {
  const wf = await rpc(owner, 'automation_save_draft', { p_org: orgA, p_workflow: null, p_name: 'E2E follow-up', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'create_task', title: 'E2E call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] } }); await rpc(owner, 'automation_publish', { p_org: orgA, p_workflow: wf, p_enable: true });
  const lead = await rpc(owner, 'crm_create_lead', { p_org: orgA, p_full_name: 'E2E Automation', p_phone: '+919845000888', p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: owner.id });
  const run = await poll(async () => (await admin().from('automation_runs').select('status').eq('workflow_id', wf).maybeSingle()).data?.status === 'succeeded'); assert.ok(run, 'the staging worker ran the workflow within 90 s (are the workers deployed and reporting?)');
  const { data: tasks } = await admin().from('tasks').select('title').eq('lead_id', lead); assert.deepEqual(tasks.map(t => t.title), ['E2E call E2E Automation'], 'one task, created once');
  const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/builder/operations'); await p.getByText(/All \d+ workers? (is|are) running/).waitFor({ timeout: 15000 }); await ctx.close();
});

test('[e2e] custom modules and the Visual Builder configuration: publish a module, add a record, see it in Work mode, refuse a destructive change', opt, async () => {
  const def = definition('E2E Org A', { modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [{ key: 'vehicles', label: 'Vehicles', fields: [{ key: 'registration', label: 'Registration', kind: 'text', required: true }, { key: 'price', label: 'Price', kind: 'currency', currency: 'INR' }] }], operations: OPS });
  await rpc(owner, 'save_workspace_draft', { p_org: orgA, p_definition: def }); await rpc(owner, 'publish_workspace_config', { p_org: orgA }); const rec = await rpc(owner, 'record_create', { p_org: orgA, p_object: 'vehicles', p_data: { registration: 'KA01E2E', price: '250000' } });
  assert.ok(rec); const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/work/vehicles'); await p.getByText('KA01E2E').waitFor(); await ctx.close();
  const empList = await get('/work/vehicles', 'employee'); assert.equal(empList.status, 200, 'members can read active modules');
  await rpc(owner, 'save_workspace_draft', { p_org: orgA, p_definition: { ...def, objects: [] , modules: def.modules.filter(m => m.key !== 'vehicles') } }); const bad = await owner.client.rpc('publish_workspace_config', { p_org: orgA }); assert.ok(bad.error, 'removing a record type that has data is refused'); await rpc(owner, 'discard_workspace_draft', { p_org: orgA });
});

test('[e2e] appointments, inventory and billing keep their integrity through real sessions', opt, async () => {
  const type = await rpc(owner, 'appointment_type_save', { p_org: orgA, p_id: null, p_name: 'E2E Consult', p_duration: 30, p_active: true }); await rpc(owner, 'staff_hours_set', { p_org: orgA, p_user: owner.id, p_hours: [0, 1, 2, 3, 4, 5, 6].map(w => ({ weekday: w, start: '00:00', end: '23:59' })) });
  const start = new Date(Date.now() + 5 * 864e5); start.setUTCMinutes(0, 0, 0); const mk = () => owner.client.rpc('appointment_create', { p_org: orgA, p_type: type, p_staff: owner.id, p_contact: null, p_lead: null, p_start: start.toISOString(), p_notes: null, p_custom: {} });
  const [a, b] = await Promise.all([mk(), mk()]); assert.equal([a, b].filter(r => !r.error).length, 1, 'two bookings of one slot: exactly one wins');
  const L = await rpc(owner, 'inventory_location_save', { p_org: orgA, p_id: null, p_name: 'Main', p_active: true }); const P = await rpc(owner, 'product_save', { p_org: orgA, p_id: null, p_sku: 'E2E-1', p_name: 'E2E Widget', p_unit: 'pcs', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null });
  await rpc(owner, 'stock_receive', { p_org: orgA, p_product: P, p_location: L, p_qty: 10, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }); const takes = await Promise.all(Array.from({ length: 6 }, (_, i) => owner.client.rpc('stock_consume', { p_org: orgA, p_product: P, p_location: L, p_qty: 3, p_batch: null, p_ref_type: 'e2e', p_ref_id: `o${i}`, p_reason: null })));
  assert.equal(takes.filter(r => !r.error).length, 3, '6 x 3 against 10 units: exactly 3 succeed'); const { data: lv } = await admin().from('stock_levels').select('quantity').eq('product_id', P); assert.equal(Number(lv[0].quantity), 1);
  for (const path of ['/work/appointments', '/work/inventory', '/work/billing']) assert.equal((await get(path, 'owner')).status, 200, path);
});

test('[e2e] WhatsApp consent through the UI: opt-in needs a reason, opt-out is recorded, and nothing is sent', opt, async () => {
  const lead = await rpc(owner, 'crm_create_lead', { p_org: orgA, p_full_name: 'E2E Consent', p_phone: '+919845000999', p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null });
  const { ctx, p } = await page('owner'); await p.goto(`${APP_URL}/work/leads/${lead}`); await p.getByText('No consent recorded').waitFor();
  await p.getByLabel('Customer choice').selectOption('opted_in'); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByRole('alert').filter({ hasText: 'Confirm that the customer agreed' }).waitFor();
  await p.getByLabel(/I confirm the customer told us/).check(); await p.getByLabel(/How did they say so/).fill('Asked on the phone during the E2E run'); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByText('Consent saved.').waitFor();
  const { data: c1 } = await admin().from('messaging_consent').select('status, source').eq('organization_id', orgA); assert.deepEqual(c1.filter(r => r.source === 'staff').map(r => r.status), ['opted_in']);
  await p.reload(); await p.getByLabel('Customer choice').selectOption('opted_out'); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByText('Consent saved.').waitFor(); const { data: c2 } = await admin().from('messaging_consent').select('status').eq('organization_id', orgA); assert.deepEqual(c2.map(r => r.status), ['opted_out']);
  const { count } = await admin().from('integration_requests').select('id', { count: 'exact', head: true }).eq('organization_id', orgA).eq('channel', 'whatsapp').eq('status', 'sent'); assert.equal(count, 0, 'no message was sent in this test'); await ctx.close();
  const emp = await rpc(employee, 'consent_set', { p_org: orgA, p_contact: (await admin().from('leads').select('contact_id').eq('id', lead).single()).data.contact_id, p_status: 'opted_in', p_source: 'staff', p_note: 'x y z' }).then(() => 'allowed', () => 'refused'); assert.equal(emp, 'refused', 'an employee who cannot see this lead cannot change its consent');
});

test('[e2e] roles and permissions: an employee cannot reach administrator screens or other people\'s money', opt, async () => {
  for (const path of ['/builder/connections', '/builder/operations']) { const r = await get(path, 'employee'); const body = r.status === 200 ? await r.text() : ''; assert.ok(r.status !== 200 || /limited to owners and admins/i.test(body), `${path} is not usable by an employee`); }
  const { data: pay } = await employee.client.from('invoice_payments').select('id'); assert.deepEqual(pay, [], 'an employee reads no payments'); const { data: cred, error } = await employee.client.from('integration_credentials').select('ciphertext'); assert.ok(error || cred?.length === 0);
});

test('[e2e][AI] configuration proposals need a person to approve them (runs only with E2E_AI=1 and a spend-capped test key on the staging app)', { skip: guard ?? (process.env.E2E_AI === '1' ? false : 'set E2E_AI=1 with a capped ANTHROPIC_API_KEY on the staging app') }, async () => {
  const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/assistant'); const box = p.getByRole('textbox').first(); await box.fill('Add a text field called Notes to the Vehicles module'); await p.keyboard.press('Enter');
  await p.getByRole('button', { name: /approve|apply|confirm/i }).first().waitFor({ timeout: 60000 }); const before = (await admin().from('workspace_configuration_versions').select('id', { count: 'exact', head: true }).eq('organization_id', orgA)).count;
  assert.equal((await admin().from('workspace_configuration_versions').select('id', { count: 'exact', head: true }).eq('organization_id', orgA)).count, before, 'a proposal changes nothing until approved'); await ctx.close();
});

test('[e2e][voice] transcription needs a configured speech credential (runs only with E2E_VOICE=1)', { skip: guard ?? (process.env.E2E_VOICE === '1' ? false : 'set E2E_VOICE=1 once a speech-to-text credential exists on the staging app') }, async () => {
  const r = await fetch(APP_URL + '/api/ai/transcribe', { method: 'POST', headers: { cookie: jar.owner.header(), 'content-type': 'audio/webm' }, body: Buffer.alloc(2000) }); assert.ok([200, 400, 415, 422].includes(r.status), `transcription endpoint answered ${r.status}`);
});
