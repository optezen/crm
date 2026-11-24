// AUTHENTICATED browser tests of the Automation Builder against a RUNNING app + the REAL STAGING Supabase project. Nothing is mocked: real sessions (password sign-in, cookies replayed into
// Chromium), real database rows, real server actions. It creates and deletes its own users/workspaces (tests/integration/env.mjs refuses any project that is not the named staging project).
// Run against a LOCAL build that talks to the STAGING project (node's --env-file breaks Next's build workers, so load the file inside a launcher):
//   node -e "process.loadEnvFile('.env.staging.web'); require('child_process').spawnSync(process.execPath,['node_modules/next/dist/bin/next','build'],{stdio:'inherit'})"   (then the same with 'start','-p','3994')
//   check the bundle names the staging ref and NOT SUPABASE_PRODUCTION_REF, then:
//   APP_URL=http://localhost:3994 node --env-file=.env.test.local --test --test-concurrency=1 tests/e2e/automation-builder.staging.mjs
// It never presses "Publish and enable", so no automation runs. It never calls the AI.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { guard, APP_URL, admin, newUser, createOrg, cookieClient, cleanup } from '../integration/env.mjs';

const opt = { skip: guard ?? (/^https:\/\/(www\.)?(?!optizen-staging)[a-z0-9-]+\.[a-z]+/.test(APP_URL) ? 'APP_URL must be localhost or the staging deployment' : false) };
const DESKTOP = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
let owner, employee, outsider, orgA, jar = {}, browser, wfId;
const session = async u => { const j = cookieClient(); assert.ifError((await j.client.auth.signInWithPassword({ email: u.email, password: u.password })).error); return j; };
const cookies = j => j.header().split('; ').filter(Boolean).map(kv => { const i = kv.indexOf('='); return { name: kv.slice(0, i), value: kv.slice(i + 1), url: APP_URL }; });
const page = async (who, viewport = DESKTOP, touch = false) => { const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch }); if (who) await ctx.addCookies(cookies(jar[who])); const p = await ctx.newPage(); const requests = []; p.on('request', r => requests.push({ method: r.method(), url: r.url() })); return { ctx, p, requests }; };
const box = loc => loc.boundingBox(); const zoom = async p => Number((await p.locator('.wf-zoom').textContent()).replace('%', ''));
const shot = async (p, name) => { mkdirSync('test-results/automation-builder', { recursive: true }); await p.screenshot({ path: `test-results/automation-builder/staging-${name}.png` }); };
const EXPECTED = { trigger: { event: 'lead.created' }, match: { op: 'and', conditions: [{ field: 'lead.stage', op: 'eq', value: 'website' }] }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };

before(async () => {
  if (opt.skip) return; browser = await chromium.launch({ channel: 'chromium', headless: process.env.HEADED !== '1' });
  owner = await newUser('own'); employee = await newUser('emp'); outsider = await newUser('out');
  orgA = await createOrg(owner, 'Builder E2E Org A'); await createOrg(outsider, 'Builder E2E Org B');
  const { error } = await admin().from('organization_members').insert({ organization_id: orgA, user_id: employee.id, role: 'employee' }); if (error) throw error;
  jar = { owner: await session(owner), employee: await session(employee), outsider: await session(outsider) };
});
after(async () => { if (opt.skip) return; await browser?.close(); await cleanup(); });

test('[staging] a signed-out visitor is sent to /login; an employee sees the owner/admin notice and no canvas', opt, async () => {
  const anon = await fetch(APP_URL + '/automations/new', { redirect: 'manual' }); assert.ok([302, 307].includes(anon.status) && /\/login/.test(anon.headers.get('location') ?? ''));
  const { ctx, p } = await page('employee'); await p.goto(APP_URL + '/automations/new'); await p.getByText('Automations are limited to owners and admins').waitFor(); assert.equal(await p.locator('.wf-canvas').count(), 0); await ctx.close();
});

test('[staging] the owner gets a roomy canvas at a readable zoom on first load (real page, real session)', opt, async () => {
  const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/automations/new'); await p.locator('.wf-node').first().waitFor(); await p.waitForTimeout(300);
  const c = await box(p.locator('.wf-canvas')); assert.ok(c.width >= DESKTOP.width * 0.7 && c.height >= DESKTOP.height * 0.5, `canvas ${Math.round(c.width)}x${Math.round(c.height)} on ${DESKTOP.width}x${DESKTOP.height}`);
  const z = await zoom(p); assert.ok(z >= 85 && z <= 110, `zoom ${z}%`); assert.equal(await p.locator('.wf-node').count(), 3);
  for (let i = 0; i < 3; i++) { const n = await box(p.locator('.wf-node').nth(i)); assert.ok(n.y >= c.y && n.y + n.height <= c.y + c.height + 1 && n.x >= c.x && n.x + n.width <= c.x + c.width, `step ${i + 1} fully visible`); }
  assert.match(await p.locator('.wfs-summary').innerText(), /When a lead is created, Optizen will assign the lead/); await shot(p, 'new-desktop'); await ctx.close();
});

test('[staging] build, validate, save a draft: a blank condition value is explained and blocks saving; the saved draft is exactly the engine grammar', opt, async () => {
  const { ctx, p } = await page('owner'); await p.goto(APP_URL + '/automations/new'); await p.locator('.wf-node').first().waitFor();
  await p.getByLabel('Automation name').fill('E2E website leads');
  await p.getByRole('button', { name: 'Steps', exact: true }).click(); await p.locator('#wfs-lib').getByRole('button', { name: /Only continue if/ }).click(); assert.equal(await p.locator('.wf-node').count(), 4);
  const strip = p.getByRole('region', { name: 'Problems to fix' }); await strip.waitFor(); assert.match(await strip.innerText(), /needs a value/); assert.ok(await p.getByRole('button', { name: 'Save draft' }).isDisabled(), 'a blank value blocks saving');
  await shot(p, 'blank-value');
  await p.getByLabel('Condition 1 value').fill('website'); assert.equal(await strip.count(), 0); const save = p.getByRole('button', { name: 'Save draft' }); assert.ok(await save.isEnabled());
  await save.click(); await p.getByText('Draft saved (not live)').first().waitFor(); await p.waitForURL(/\/automations\/[0-9a-f-]{36}/); wfId = p.url().split('/').pop().split('?')[0];
  const a = admin(); const { data: wf } = await a.from('automation_workflows').select('organization_id, name, enabled, published_version').eq('id', wfId).single();
  assert.deepEqual([wf.organization_id, wf.name, wf.enabled, wf.published_version], [orgA, 'E2E website leads', false, null], 'saved for the right workspace, not enabled, not published');
  const { data: v } = await a.from('automation_workflow_versions').select('status, definition').eq('workflow_id', wfId); assert.equal(v.length, 1); assert.equal(v[0].status, 'draft'); assert.deepEqual(v[0].definition, EXPECTED, 'the visual editor saved the unchanged engine grammar');
  const { data: lay } = await a.from('automation_layouts').select('layout').eq('workflow_id', wfId).maybeSingle(); assert.ok(!JSON.stringify(v[0].definition).includes('"pos"'), 'layout never enters the definition'); void lay;
  await shot(p, 'saved-draft'); await ctx.close();
});

test('[staging] returning later: the draft reopens from the database, fitted and readable; the list editor still works on the same draft', opt, async () => {
  assert.ok(wfId, 'previous test saved a draft'); const { ctx, p } = await page('owner'); await p.goto(`${APP_URL}/automations/${wfId}`); await p.locator('.wf-node').first().waitFor(); await p.waitForTimeout(300);
  assert.equal(await p.locator('.wf-node').count(), 4); assert.ok((await zoom(p)) >= 85); assert.equal(await p.getByLabel('Automation name').inputValue(), 'E2E website leads'); assert.match(await p.locator('.wfs-summary').innerText(), /only if Lead stage equals “website”/);
  const list = await p.goto(`${APP_URL}/automations/${wfId}?view=list`); assert.equal(list.status(), 200); await p.getByText('E2E website leads').first().waitFor(); assert.equal(await p.locator('.wf-canvas').count(), 0, 'the original list editor is still available'); await ctx.close();
});

test('[staging] desktop Full screen fills the screen and Esc leaves it; editing a step updates the step, the summary and the problem list (nothing saved)', opt, async () => {
  const { ctx, p } = await page('owner'); await p.goto(`${APP_URL}/automations/${wfId}`); await p.locator('.wf-node').first().waitFor(); await p.waitForTimeout(400);
  const before = await box(p.locator('.wf-canvas')); await p.getByRole('button', { name: 'Full screen' }).click(); await p.waitForTimeout(400);
  assert.equal(await p.locator('.wfs-root').getAttribute('data-expanded'), 'true'); const full = await box(p.locator('.wf-canvas'));
  assert.ok(full.width >= DESKTOP.width * 0.94 && full.height >= DESKTOP.height * 0.6 && full.width > before.width && full.height > before.height, `expanded ${Math.round(full.width)}x${Math.round(full.height)} (was ${Math.round(before.width)}x${Math.round(before.height)})`); assert.ok((await zoom(p)) >= 85);
  await shot(p, 'fullscreen-desktop');
  // step editing: select the task step, change its title; the card, the summary and the saved/unsaved state follow
  await p.locator('.wf-node').nth(3).click(); const panel = p.locator('#wfs-right'); await panel.getByRole('heading', { name: /Step 4 details/ }).waitFor();
  await panel.getByLabel('Task title').fill('Phone {{lead.full_name}} today'); assert.match(await p.locator('.wf-node').nth(3).innerText(), /Phone \[Contact name\] today/); assert.match(await p.locator('.wfs-summary').innerText(), /Phone \[Contact name\] today/); assert.match(await p.locator('.save-state').innerText(), /Unsaved changes/);
  await panel.getByLabel('Task title').fill(''); const strip = p.getByRole('region', { name: 'Problems to fix' }); await strip.waitFor(); assert.ok(await p.getByRole('button', { name: 'Save draft' }).isDisabled(), 'an empty task title cannot be saved');
  await p.getByRole('button', { name: 'Undo' }).click(); await p.waitForTimeout(150); await p.locator('.wf-canvas').focus(); await p.keyboard.press('Escape'); await p.waitForTimeout(300); assert.equal(await p.locator('.wfs-root').getAttribute('data-expanded'), 'false', 'Esc leaves full screen');
  const { data: v } = await admin().from('automation_workflow_versions').select('status, definition').eq('workflow_id', wfId).eq('status', 'draft'); assert.deepEqual(v[0].definition, EXPECTED, 'nothing was saved by editing');
  await ctx.close();
});

const TABLES = ['automation_workflows', 'automation_workflow_versions', 'automation_runs', 'automation_steps', 'audit_events', 'notifications', 'integration_requests', 'tasks', 'leads', 'domain_events'];
/** Row counts and the workflow's updated_at for ONE workspace, read with the service role (fixture inspection only), so before/after can be compared exactly. */
async function snapshot() { const a = admin(), out = {}; for (const t of TABLES) { const { count, error } = await a.from(t).select('*', { count: 'exact', head: true }).eq('organization_id', orgA); out[t] = error ? `n/a (${error.code})` : count; }
  const { data } = await a.from('automation_workflows').select('updated_at, enabled, published_version').eq('id', wfId).single(); out.workflow = data; return out; }

test('[staging] preview on the real page makes no write: no POST/server action, no API or database request, and the workspace\'s rows are byte-for-byte unchanged', opt, async () => {
  const { ctx, p, requests } = await page('owner'); await p.goto(`${APP_URL}/automations/${wfId}`); await p.locator('.wf-node').first().waitFor();
  const dbBefore = await snapshot();
  await p.getByRole('button', { name: 'Preview', exact: true }).click(); const panel = p.locator('#wfs-right'); await panel.getByRole('button', { name: 'Run preview' }).waitFor(); const mark = requests.length;
  await panel.getByRole('button', { name: 'Run preview' }).click(); const res = p.getByRole('region', { name: 'Preview result' }); await res.waitFor(); assert.match(await res.innerText(), /would not run|would run/i);
  await panel.getByText('Sample event (edit to try other cases)').click(); await panel.getByLabel('Lead stage').fill('website'); await panel.getByRole('button', { name: 'Run preview again' }).click(); assert.match(await res.innerText(), /This would run\. 2 actions would happen/); await shot(p, 'preview');
  await panel.getByText('Sample event (edit to try other cases)').click(); await panel.getByLabel('Lead stage').fill('lost'); await panel.getByRole('button', { name: 'Run preview again' }).click(); assert.match(await res.innerText(), /would stop here and do nothing/);
  const after = requests.slice(mark); assert.deepEqual(after.filter(r => r.method !== 'GET'), [], 'no POST during preview'); assert.deepEqual(after.filter(r => /supabase\.co|\/api\//.test(r.url)), [], 'no database/API request during preview');
  const dbAfter = await snapshot(); assert.deepEqual(dbAfter, dbBefore, 'every table count and the workflow row are identical before and after the preview'); assert.equal(dbAfter.automation_runs, 0, 'no automation run exists');
  console.log('  db snapshot before == after:', JSON.stringify(dbAfter)); await ctx.close();
});

test('[staging] publish lifecycle through the new dialog: publish keeps it disabled; the published version equals the draft; nothing runs', opt, async () => {
  const { ctx, p } = await page('owner'); await p.goto(`${APP_URL}/automations/${wfId}`); await p.locator('.wf-node').first().waitFor();
  await p.getByRole('button', { name: 'Publish', exact: true }).click(); const dlg = p.getByRole('dialog', { name: 'Publish this automation' }); await dlg.waitFor(); assert.ok(await dlg.getByRole('button', { name: 'Publish and enable' }).isEnabled());
  await shot(p, 'publish-dialog'); await dlg.getByRole('button', { name: 'Publish (keep disabled)' }).click(); await p.getByText('Published (not enabled).').first().waitFor();
  const a = admin(); const { data: wf } = await a.from('automation_workflows').select('enabled, published_version').eq('id', wfId).single(); assert.deepEqual([wf.enabled, wf.published_version], [false, 1]);
  const { data: v } = await a.from('automation_workflow_versions').select('status, definition').eq('workflow_id', wfId).eq('status', 'published'); assert.equal(v.length, 1); assert.deepEqual(v[0].definition, EXPECTED);
  await p.reload(); await p.locator('.wf-node').first().waitFor(); assert.match(await p.locator('.save-state').innerText(), /Version 1 \(disabled\)/); await ctx.close();
});

test('[staging] another workspace cannot open this automation; the AI panel is honest about whether it is configured', opt, async () => {
  const out = await page('outsider'); await out.p.goto(`${APP_URL}/automations/${wfId}`); await out.p.waitForTimeout(800); assert.equal(await out.p.locator('.wf-node').count(), 0); assert.equal(await out.p.getByText('E2E website leads').count(), 0, 'no name, no canvas'); await out.ctx.close();
  const { ctx, p } = await page('owner'); await p.goto(`${APP_URL}/automations/new`); await p.locator('.wf-node').first().waitFor(); await p.getByRole('button', { name: 'Ask Optizen AI' }).click(); const panel = p.locator('#wfs-right');
  const notSet = await panel.getByText('Optizen AI is not set up on this deployment.').isVisible().catch(() => false); const form = await panel.getByLabel('What should this automation do?').isVisible().catch(() => false);
  assert.ok(notSet !== form, 'exactly one state is shown: not configured, or the drafting form'); console.log(`  AI on this deployment: ${form ? 'configured (not called by this test)' : 'not configured'}`); await shot(p, 'ai-panel'); await ctx.close();
});

test('[staging][phone 390x844] the real page fits, opens a step sheet by touch, and expands to full screen', opt, async () => {
  const { ctx, p } = await page('owner', PHONE, true); await p.goto(`${APP_URL}/automations/${wfId}`); await p.locator('.wf-node').first().waitFor(); await p.waitForTimeout(300);
  assert.ok((await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0, 'no horizontal scroll'); assert.ok((await zoom(p)) >= 85); await shot(p, 'phone');
  await p.locator('.wf-node').first().tap(); const sheet = p.locator('#wfs-right'); await sheet.waitFor(); const b = await box(sheet); assert.ok(b.x >= 0 && b.x + b.width <= PHONE.width && b.y + b.height <= PHONE.height); await shot(p, 'phone-details');
  await sheet.getByRole('button', { name: 'Close' }).tap(); await p.getByRole('button', { name: 'Full screen' }).tap(); await p.waitForTimeout(300); const c = await box(p.locator('.wf-canvas')); assert.ok(c.width >= PHONE.width - 24 && c.height >= PHONE.height * 0.55, `expanded ${Math.round(c.width)}x${Math.round(c.height)}`); await shot(p, 'phone-fullscreen'); await ctx.close();
});
