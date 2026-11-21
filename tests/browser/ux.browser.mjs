import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url); const AXE = require.resolve('axe-core/axe.min.js'); const BASE = process.env.BASE_URL;
let browser; before(async () => { browser = await chromium.launch({ channel: 'chromium' }); }); after(async () => { await browser?.close(); });
const open = async (path, viewport = { width: 1280, height: 800 }, o = {}) => { const ctx = await browser.newContext({ viewport, hasTouch: !!o.touch, isMobile: !!o.touch }); const page = await ctx.newPage(); await page.goto(BASE + path); return { page, close: () => ctx.close() }; };
const axe = async page => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForFunction(() => !!document.querySelector('head > title')?.textContent); await page.addScriptTag({ path: AXE }); const r = await page.evaluate(() => globalThis.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa'] })); return r.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.slice(0, 2).map(n => n.target.join(' ')).join(' | ')}`); };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('[browser] login page: labelled field, no serious accessibility violations, no horizontal scroll on a phone', async () => {
  for (const vp of [{ width: 1280, height: 800 }, { width: 375, height: 667 }]) { const { page, close } = await open('/login', vp); assert.equal(await page.locator('h1').count(), 1); assert.ok(await page.getByRole('heading', { level: 1 }).isVisible());
    assert.deepEqual(await axe(page), []); assert.ok((await overflow(page)) <= 0, `no horizontal scroll at ${vp.width}px`); await close(); }
});

test('[browser] onboarding wizard works with the keyboard only and offers a blank workspace without any template', async () => {
  const { page, close } = await open('/ux-fixtures/onboarding'); await page.getByLabel('Business name').fill('Keyboard Bakery'); await page.keyboard.press('Tab'); await page.getByRole('button', { name: 'Continue' }).press('Enter');
  assert.ok(await page.getByText('What does your business do?').isVisible()); await page.getByRole('button', { name: 'Continue' }).press('Enter');
  assert.ok(await page.getByRole('radio', { name: /Blank workspace/ }).isChecked(), 'blank is available and selected by default'); assert.equal(await page.getByRole('radio').count() >= 1, true);
  await page.getByRole('button', { name: 'Continue' }).press('Enter'); assert.ok(await page.getByRole('heading', { name: 'Keyboard Bakery' }).isVisible().catch(() => false) || await page.getByText('Keyboard Bakery').first().isVisible());
  assert.deepEqual(await axe(page), []); await close();
});

test('[browser][fixture data] desktop shell: sidebar, quick actions, my follow-ups with one-tap Done, labelled controls, accessible', async () => {
  const { page, close } = await open('/ux-fixtures/home'); assert.ok(await page.locator('.side').isVisible()); assert.ok(!(await page.locator('.mbar').isVisible()), 'the phone menu bar is hidden on desktop'); assert.ok(!(await page.locator('.tabbar').isVisible()));
  assert.ok(await page.getByRole('navigation', { name: 'Quick actions' }).getByRole('link', { name: '+ New lead' }).isVisible()); assert.ok(await page.getByRole('link', { name: '+ Vehicles' }).isVisible()); assert.ok(await page.getByRole('link', { name: '+ Book appointment' }).isVisible());
  assert.ok(!(await page.getByRole('link', { name: '+ New invoice' }).count()), 'modules that are off or not allowed are absent');
  assert.equal(await page.getByRole('button', { name: /Mark .Call about the quote. done/ }).count(), 1); assert.ok(await page.getByLabel('Outcome for Call about the quote').isVisible());
  assert.equal(await page.getByText('Overdue').first().isVisible(), true); assert.match(await page.locator('main').innerText(), /In-app only/, 'notifications do not claim email, push or WhatsApp delivery');
  assert.deepEqual(await axe(page), []); await close();
});

test('[browser][fixture data] phone layout: menu opens with the keyboard, bottom tabs and touch targets are large enough, nothing overflows, the skip link works', async () => {
  const { page, close } = await open('/ux-fixtures/home', { width: 390, height: 844 }, { touch: true });
  assert.ok(!(await page.locator('.side').isVisible())); assert.ok(await page.locator('.mbar').isVisible()); assert.ok(await page.locator('.tabbar').isVisible()); assert.ok((await overflow(page)) <= 0, 'no horizontal scroll');
  await page.keyboard.press('Tab'); assert.ok(await page.getByRole('link', { name: 'Skip to content' }).isVisible(), 'the skip link appears on first Tab'); await page.keyboard.press('Enter'); assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
  const summary = page.getByLabel('Open menu'); await summary.focus(); await page.keyboard.press('Enter'); assert.ok(await page.getByRole('navigation', { name: 'Workspace menu' }).getByRole('link', { name: 'Follow-ups' }).isVisible(), 'the menu opens without a touch gesture');
  await page.keyboard.press('Enter'); // closes again
  for (const [name, loc] of [['tab bar link', page.locator('.tabbar a').first()], ['Done button', page.getByRole('button', { name: /Mark .Call about the quote. done/ })], ['quick action', page.getByRole('link', { name: '+ New lead' })], ['menu button', summary]]) { const b = await loc.boundingBox(); assert.ok(b && b.height >= 44 && b.width >= 44 - 1, `${name} is at least 44px: ${JSON.stringify(b)}`); }
  assert.deepEqual(await axe(page), []); await close();
});

test('[browser][fixture data] board: moving a card needs no dragging (Move menu), a refused move explains why and leaves the card where it was, drag and drop also works', async () => {
  const { page, close } = await open('/ux-fixtures/board', { width: 390, height: 844 }, { touch: true });
  const col = n => page.getByRole('region', { name: new RegExp(`^${n},`) });
  await page.getByLabel('Move Sample Lead A to').selectOption('Qualified'); await page.getByText('Sample Lead A moved to Qualified.').waitFor(); assert.ok(await col('Qualified').getByRole('link', { name: 'Sample Lead A' }).isVisible()); assert.equal(await col('New').getByRole('link', { name: 'Sample Lead A' }).count(), 0);
  await page.getByLabel('Move Sample Lead C to').selectOption('Won'); await page.getByText(/needs an assignee/).waitFor(); assert.ok(await col('New').getByRole('link', { name: 'Sample Lead C' }).isVisible(), 'the card did not move');
  assert.deepEqual(await axe(page), []); await close();
  const d = await open('/ux-fixtures/board'); await d.page.locator('.kanban-card', { hasText: 'Sample Lead B' }).dragTo(d.page.getByRole('region', { name: /^Won,/ })); await d.page.getByText('Sample Lead B moved to Won.').waitFor(); await d.close();
});

test('[browser] fixture routes exist only under the test flag (enabled for this run; unknown fixture paths 404)', async () => {
  const res = await fetch(BASE + '/ux-fixtures/home'); assert.equal(res.status, 200, 'enabled for this test run'); const prod = await fetch(BASE + '/ux-fixtures/nope'); assert.equal(prod.status, 404);
});

test('[browser][fixture data] operations: worker health, queue backlog and what needs a person are shown, accessible, no overflow on a phone', async () => {
  for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const { page, close } = await open('/ux-fixtures/operations', vp, { touch: vp.width < 500 });
    assert.ok(await page.getByRole('heading', { name: 'Background workers' }).isVisible()); assert.ok(await page.getByText('All 3 workers are running.').isVisible());
    const workers = page.getByRole('table').first(); for (const w of ['Automations', 'Integrations and messages', 'Maintenance and reminders']) assert.ok(await workers.getByText(w).isVisible(), w); assert.equal(await workers.getByText('Running').count(), 3);
    const queues = page.getByRole('table').nth(1); assert.ok(await queues.getByText('Oldest due: 45s').isVisible()); assert.ok(await queues.getByText('(1 delivery uncertain)').isVisible()); assert.ok(await queues.getByRole('row', { name: /Appointment reminders scheduled 7/ }).isVisible());
    assert.ok(await page.getByRole('heading', { name: 'Needs a person (4)' }).isVisible()); assert.ok(await page.getByText('Fix the connection first').isVisible());
    assert.ok(await page.getByText(/may already have delivered this one/).isVisible(), 'an uncertain send warns before it can be repeated');
    assert.ok(await page.getByText('Gateway payment on hold').isVisible()); assert.ok(await page.getByRole('link', { name: 'Reconnect' }).isVisible(), 'an expired connection offers Reconnect');
    assert.ok(await page.getByRole('heading', { name: 'Recent WhatsApp activity' }).isVisible()); assert.ok(!(await page.locator('main').innerText()).match(/\+91|api_key|access_token|Bearer/), 'no secret or number is ever shown');
    assert.ok((await overflow(page)) <= 0, `no horizontal scroll at ${vp.width}px`); assert.deepEqual(await axe(page), []); await close();
  }
});

test('[browser][fixture data] operations: every control performs its action and reports the outcome; a refused action explains why and changes nothing', async () => {
  const { page, close } = await open('/ux-fixtures/operations');
  await page.getByRole('button', { name: 'Retry: incoming lead' }).click(); await page.getByText('Queued (sample).').waitFor(); assert.equal(await page.getByRole('status').filter({ hasText: 'Queued (sample).' }).count(), 1);
  await page.getByRole('button', { name: 'Send again: WhatsApp message' }).click(); await page.getByRole('alert').filter({ hasText: 'Only a failed message the provider did not accept' }).waitFor();
  assert.ok(await page.getByRole('button', { name: 'Send again: WhatsApp message' }).isEnabled(), 'the control is usable again after a refusal');
  await page.getByRole('button', { name: 'Retry: automation run' }).focus(); await page.keyboard.press('Enter'); await page.getByText('Queued (sample).').waitFor();
  await page.getByRole('button', { name: 'Retry: held payment' }).click(); await page.getByText('Queued (sample).').waitFor(); assert.deepEqual(await axe(page), []); await close();
});

test('[browser][fixture data] operations: a stopped worker and a deployment with no workers are called out plainly, never shown as healthy', async () => {
  let t = await open('/ux-fixtures/operations?state=stopped'); assert.ok(await t.page.getByRole('alert').filter({ hasText: '1 worker stopped reporting.' }).isVisible()); assert.ok(await t.page.getByText('Not reporting').isVisible()); assert.equal(await t.page.getByText('All 3 workers are running.').count(), 0); assert.deepEqual(await axe(t.page), []); await t.close();
  t = await open('/ux-fixtures/operations?state=empty'); assert.ok(await t.page.getByRole('alert').filter({ hasText: 'No worker has reported yet.' }).isVisible()); assert.ok(await t.page.getByText('Nothing is stuck.').isVisible()); assert.ok(await t.page.getByText('No connections yet.').isVisible());
  assert.equal(await t.page.getByRole('heading', { name: 'Payment reconciliation' }).count(), 0, 'payment reconciliation only appears when billing is on'); assert.deepEqual(await axe(t.page), []); await t.close();
});

test('[browser][fixture data] WhatsApp consent: opt-in needs a confirmation and a reason, opt-out needs neither, the current state and history are plain, accessible on a phone', async () => {
  let t = await open('/ux-fixtures/consent', { width: 390, height: 844 }, { touch: true }); const p = t.page;
  assert.ok(await p.getByText('No consent recorded').isVisible()); assert.ok(await p.getByText('No WhatsApp message will be sent to this customer.').isVisible()); assert.ok(await p.getByText(/WhatsApp is not connected for this workspace/).isVisible());
  await p.getByLabel('Customer choice').selectOption('opted_in'); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByRole('alert').filter({ hasText: 'Confirm that the customer agreed' }).waitFor();
  await p.getByLabel(/I confirm the customer told us/).check(); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByRole('alert').filter({ hasText: 'Say how the customer agreed' }).waitFor();
  await p.getByLabel(/How did they say so/).fill('Asked on the phone on 22 Nov'); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByRole('status').filter({ hasText: 'Consent saved.' }).waitFor();
  await p.getByLabel('Customer choice').selectOption('opted_out'); await p.getByLabel(/I confirm the customer told us/).uncheck(); await p.getByLabel(/How did they say so/).fill(''); await p.getByRole('button', { name: 'Save consent' }).click(); await p.getByRole('status').filter({ hasText: 'Consent saved.' }).waitFor();
  assert.ok((await overflow(p)) <= 0); assert.deepEqual(await axe(p), []); await t.close();
  t = await open('/ux-fixtures/consent?state=opted_out'); assert.ok(await t.page.getByText('Opted out', { exact: true }).first().isVisible()); assert.ok(await t.page.getByText(/Customer reply/).first().isVisible()); await t.page.getByText('History').click(); assert.ok(await t.page.getByText(/Asked on the phone/).isVisible()); assert.deepEqual(await axe(t.page), []); await t.close();
  t = await open('/ux-fixtures/consent?state=nophone'); assert.ok(await t.page.getByText(/no phone number on this lead/).isVisible()); await t.close();
});

test('[browser][fixture data] reminder settings: friendly validation before anything is saved, valid settings are accepted, non-admins see a read-only summary', async () => {
  let t = await open('/ux-fixtures/reminders'); const p = t.page; const save = () => p.getByRole('button', { name: 'Save reminder settings' }).click();
  assert.equal(await p.getByLabel('Send appointment reminders').isChecked(), false, 'off until an owner turns it on'); assert.ok(await p.getByLabel('1 day before').isChecked()); assert.ok(await p.getByLabel('1 hour before').isChecked()); assert.ok(await p.getByText(/Asia\/Kolkata/).first().isVisible());
  await p.getByLabel('Send appointment reminders').check(); await p.getByLabel('1 day before').uncheck(); await p.getByLabel('1 hour before').uncheck(); await save(); await p.getByRole('alert').filter({ hasText: 'Choose at least one reminder time.' }).waitFor();
  await p.getByLabel('Another time (minutes before, 5–10080)').fill('3'); await save(); await p.getByRole('alert').filter({ hasText: 'whole number of minutes from 5 to 10080' }).waitFor();
  await p.getByLabel('Another time (minutes before, 5–10080)').fill('45'); for (const l of ['1 week before', '2 days before', '1 day before', '1 hour before']) await p.getByLabel(l).check(); await save(); await p.getByRole('alert').filter({ hasText: 'at most 4' }).waitFor();
  await p.getByLabel('1 week before').uncheck(); await p.getByLabel('2 days before').uncheck(); await p.getByLabel('1 hour before').uncheck(); await p.getByLabel('The customer (WhatsApp)').check(); await save(); await p.getByRole('alert').filter({ hasText: 'Customer reminders need the name and language' }).waitFor();
  await p.getByLabel('Approved template name').fill('appointment_reminder'); await p.getByLabel('From').fill('21:00'); await save(); await p.getByRole('alert').filter({ hasText: 'both quiet-hours times' }).waitFor();
  await p.getByLabel('Until').fill('08:00'); await save(); await p.getByRole('status').filter({ hasText: 'Saved (sample): on; offsets 1440, 45; customer yes.' }).waitFor(); assert.deepEqual(await axe(p), []); await t.close();
  t = await open('/ux-fixtures/reminders?state=readonly'); assert.ok(await t.page.getByText('Only owners and admins can change reminder settings.').isVisible()); assert.equal(await t.page.getByRole('button', { name: 'Save reminder settings' }).count(), 0); await t.close();
  t = await open('/ux-fixtures/reminders', { width: 390, height: 844 }, { touch: true }); assert.ok((await overflow(t.page)) <= 0, 'no horizontal scroll on a phone'); assert.deepEqual(await axe(t.page), []); await t.close();
});

test('[browser][fixture data] payment gateway connection: setup steps in order, the secret is write-only, activation stays locked until a verified notification arrives, missing deployment settings are explained', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE }); let p = await ctx.newPage();
  await p.goto(BASE + '/ux-fixtures/payments?state=none'); assert.ok(await p.getByText('Not connected', { exact: true }).isVisible()); await p.getByRole('button', { name: 'Connect Razorpay' }).click(); await p.getByRole('status').filter({ hasText: 'Created (sample).' }).waitFor();
  await p.goto(BASE + '/ux-fixtures/payments'); assert.equal(await p.getByLabel('Webhook URL', { exact: true }).inputValue(), 'https://app.example.test/api/webhooks/payments/abc123def456'); await p.getByRole('button', { name: 'Copy payments webhook URL' }).click(); await p.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await p.evaluate(() => navigator.clipboard.readText()), 'https://app.example.test/api/webhooks/payments/abc123def456');
  assert.ok(await p.getByText('Waiting for the first signed notification…').isVisible()); const activate = p.getByRole('button', { name: 'Activate payments' }); assert.ok(await activate.isDisabled(), 'locked without evidence'); assert.ok(await p.getByText('Save the secret first.').isVisible());
  assert.equal(await p.getByLabel('Webhook secret', { exact: true }).getAttribute('type'), 'password'); const saveBtn = p.getByRole('button', { name: 'Save secret' }); assert.ok(await saveBtn.isDisabled(), 'too short to save'); await p.getByLabel('Webhook secret', { exact: true }).fill('whsec_1234567'); assert.ok(await saveBtn.isEnabled()); await saveBtn.click(); await p.getByRole('status').filter({ hasText: 'Secret saved (sample).' }).waitFor();
  assert.equal(await p.getByLabel('Webhook secret', { exact: true }).inputValue(), '', 'the secret is cleared from the page after saving'); assert.deepEqual(await axe(p), []);
  await p.goto(BASE + '/ux-fixtures/payments?state=verified'); assert.ok(await p.getByText(/Verified: a signed notification arrived/).isVisible()); assert.ok(await p.getByText('Secret saved').isVisible()); await p.getByRole('button', { name: 'Activate payments' }).click(); await p.getByRole('status').filter({ hasText: 'Payments are active (sample).' }).waitFor();
  await p.goto(BASE + '/ux-fixtures/payments?state=active'); assert.ok(await p.getByText('Connected', { exact: true }).isVisible()); assert.equal(await p.getByRole('button', { name: 'Activate payments' }).count(), 0); assert.ok(await p.getByRole('button', { name: 'Disconnect' }).isVisible());
  await p.goto(BASE + '/ux-fixtures/payments?state=missing'); assert.ok(await p.getByRole('alert').filter({ hasText: 'INTEGRATION_GATEWAY_SECRET' }).isVisible()); assert.ok(await p.getByRole('button', { name: 'Connect Razorpay' }).isDisabled());
  await p.setViewportSize({ width: 390, height: 844 }); await p.goto(BASE + '/ux-fixtures/payments'); assert.ok((await overflow(p)) <= 0, 'no horizontal scroll on a phone'); assert.deepEqual(await axe(p), []); await ctx.close();
});

test('[browser] every page carries the security headers: no framing, no sniffing, restricted browser features, and a framed page is refused', async () => {
  const ctx = await browser.newContext(); const p = await ctx.newPage(); const r = await p.goto(BASE + '/login'); const h = r.headers();
  assert.equal(h['x-frame-options'], 'DENY'); assert.equal(h['x-content-type-options'], 'nosniff'); assert.equal(h['referrer-policy'], 'strict-origin-when-cross-origin'); assert.match(h['content-security-policy'], /frame-ancestors 'none'/); assert.match(h['content-security-policy'], /object-src 'none'/); assert.match(h['permissions-policy'], /camera=\(\)/); assert.match(h['permissions-policy'], /microphone=\(self\)/);
  const api = await fetch(BASE + '/api/health'); assert.equal(api.headers.get('x-frame-options'), 'DENY', 'API responses too');
  await p.setContent(`<iframe id="f" src="${BASE}/login" width="400" height="300"></iframe>`); await p.waitForTimeout(1500); const framed = await p.frame({ url: /\/login/ }); const body = framed ? await framed.evaluate(() => document.body?.innerText ?? '').catch(() => '') : ''; assert.ok(!/Sign in|Email/i.test(body), 'the login page does not render inside a frame'); await ctx.close();
});
