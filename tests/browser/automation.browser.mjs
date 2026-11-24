// REAL browser tests (Chromium via Playwright) for the Automation Builder: the real WorkflowStudio/WorkflowCanvas rendered on /ux-fixtures/automation with clearly labelled sample data.
// They test what a person sees and does: size, zoom, full screen, collapsible panels, keyboard-only use, plain-English summary, validation, preview (no writes), the AI panel (network MOCKED:
// there is no AI key in test, so these prove the UI flow only), phone layout and accessibility. They do NOT cover saving/publishing (needs a session: see tests/e2e/automation-builder.staging.mjs).
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url); const AXE = require.resolve('axe-core/axe.min.js'); const BASE = process.env.BASE_URL;
let browser; const live = []; // every context is closed after its test, even when an assertion fails, so one failure cannot leak pages into the next test
before(async () => { browser = await chromium.launch({ channel: 'chromium' }); }); afterEach(async () => { for (const c of live.splice(0)) await c.close().catch(() => {}); }); after(async () => { await browser?.close(); });

const DESKTOP = { width: 1440, height: 900 }, LAPTOP = { width: 1280, height: 720 }, PHONE = { width: 390, height: 844 };
const open = async (query = '', viewport = DESKTOP, o = {}) => {
  const ctx = await browser.newContext({ viewport, hasTouch: !!o.touch, isMobile: !!o.touch }); live.push(ctx); const page = await ctx.newPage();
  const requests = []; page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
  await page.goto(`${BASE}/ux-fixtures/automation${query}`); await page.locator('.wf-node').first().waitFor(); await page.waitForTimeout(350); // let the first fit and the summary's "Show all" measurement settle
  return { page, requests, close: () => ctx.close() };
};
const box = async loc => (await loc.boundingBox());
const zoom = async page => Number((await page.locator('.wf-zoom').textContent()).replace('%', '')); // textContent: the % label is hidden on phones
const nodes = page => page.locator('.wf-node');
const inside = (inner, outer, slack = 1) => inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;
const axe = async page => { await page.addScriptTag({ path: AXE }); return page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).slice(0, 3).join(' | ')}`)); };

test('[browser][desktop] the canvas is the workspace: wide, tall, readable zoom, centred, everything visible on load', async () => {
  const { page, close } = await open(); const c = await box(page.locator('.wf-canvas')); const vp = DESKTOP;
  assert.ok(c.width >= vp.width * 0.7, `canvas is ${Math.round(c.width)}px of ${vp.width}px wide`); assert.ok(c.height >= vp.height * 0.5, `canvas is ${Math.round(c.height)}px of ${vp.height}px tall`);
  const z = await zoom(page); assert.ok(z >= 85 && z <= 110, `initial zoom ${z}% is readable`);
  assert.equal(await nodes(page).count(), 4);
  for (let i = 0; i < 4; i++) assert.ok(inside(await box(nodes(page).nth(i)), c), `step ${i + 1} is fully inside the canvas on load`);
  const first = await box(nodes(page).first()); assert.ok(Math.abs(first.x + first.width / 2 - (c.x + c.width / 2)) < 12, 'the chain is centred horizontally');
  assert.ok(await page.locator('.wf-title').first().evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 15, 'step titles are at least 15px before zoom');
  await close();
});

test('[browser][desktop] the reported bug: an old horizontal layout saved at 43% zoom opens re-stacked and readable', async () => {
  const { page, close } = await open('?v=legacy'); const z = await zoom(page); assert.ok(z >= 85, `opened at ${z}%, not 43%`);
  const ys = []; for (let i = 0; i < 4; i++) ys.push((await box(nodes(page).nth(i))).y); assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), 'steps are stacked top to bottom'); await close();
});

test('[browser][laptop 1280x720] fits and stays readable; a long chain keeps readable zoom and every step is reachable by keyboard', async () => {
  const { page } = await open('?v=default', LAPTOP); const c = await box(page.locator('.wf-canvas')); assert.ok(c.height >= 300, `canvas ${Math.round(c.height)}px tall`); assert.ok((await zoom(page)) >= 85);
  const l = await open('?v=long', LAPTOP); const cv = () => box(l.page.locator('.wf-canvas')); assert.equal(await nodes(l.page).count(), 8); assert.ok((await zoom(l.page)) >= 85, 'long chains are not shrunk below readable');
  assert.ok(inside(await box(nodes(l.page).first()), await cv()), 'the trigger is visible on load');
  await nodes(l.page).first().focus(); for (let i = 0; i < 7; i++) await l.page.keyboard.press('ArrowDown');
  await l.page.waitForTimeout(150); assert.ok(await nodes(l.page).last().evaluate(e => e === document.activeElement), 'Down arrow walked to the last step');
  assert.ok(inside(await box(nodes(l.page).last()), await cv(), 4), 'the last step scrolled into view (measured against the canvas as it is now)');
});

test('[browser][desktop] Full screen: canvas fills the screen, Esc and the button leave it', async () => {
  const { page, close } = await open(); const before = await box(page.locator('.wf-canvas'));
  await page.getByRole('button', { name: 'Full screen' }).click(); await page.waitForTimeout(200);
  assert.equal(await page.locator('.wfs-root').getAttribute('data-expanded'), 'true'); const c = await box(page.locator('.wf-canvas'));
  assert.ok(c.width >= DESKTOP.width * 0.94 && c.height >= DESKTOP.height * 0.6, `expanded canvas ${Math.round(c.width)}x${Math.round(c.height)}`); assert.ok(c.width > before.width && c.height > before.height);
  assert.ok((await zoom(page)) >= 85); assert.ok(inside(await box(nodes(page).first()), c), 'still centred and visible after resizing');
  await page.locator('.wf-canvas').focus(); await page.keyboard.press('Escape'); await page.waitForTimeout(200); assert.equal(await page.locator('.wfs-root').getAttribute('data-expanded'), 'false');
  await page.getByRole('button', { name: 'Full screen' }).click(); await page.getByRole('button', { name: 'Exit full screen' }).click(); await page.waitForTimeout(200); assert.equal(await page.locator('.wfs-root').getAttribute('data-expanded'), 'false'); await close();
});

test('[browser][desktop] step library and details panel are collapsible; selecting a step opens its details', async () => {
  const { page, close } = await open(); const lib = page.locator('#wfs-lib'), right = page.locator('#wfs-right');
  assert.ok(!(await lib.isVisible()) && !(await right.isVisible()), 'both start closed so the canvas has the room'); const w0 = (await box(page.locator('.wf-canvas'))).width;
  const steps = page.getByRole('button', { name: 'Steps', exact: true }); await steps.click(); assert.ok(await lib.isVisible()); assert.equal(await steps.getAttribute('aria-pressed'), 'true'); assert.ok((await box(page.locator('.wf-canvas'))).width < w0, 'canvas yields the width');
  await page.waitForTimeout(150); assert.ok((await zoom(page)) >= 85, 'refits when the dock opens'); await lib.getByRole('button', { name: 'Close' }).click(); assert.ok(!(await lib.isVisible()));
  await nodes(page).nth(1).click(); assert.ok(await right.isVisible(), 'properties open on selection'); assert.ok(await right.getByRole('heading', { name: /Step 2 details/ }).isVisible()); assert.ok(await right.getByText('Only continue if this is true').isVisible());
  await right.getByRole('button', { name: 'Close' }).click(); assert.ok(!(await right.isVisible())); assert.equal(await nodes(page).nth(1).getAttribute('aria-pressed'), 'true', 'closing the panel keeps the selection'); await close();
});

test('[browser][desktop] plain-English summary names the trigger, the condition and each action, with no template syntax; long ones expand', async () => {
  const { page, close } = await open(); const s = page.locator('.wfs-summary'); const t = await s.innerText();
  assert.match(t, /When a lead is created, and only if Lead source equals “website”, Optizen will assign the lead to the next employee in turn/); assert.match(t, /then create a follow-up task “Call \[Contact name\]”, due in 1 day/); assert.ok(!t.includes('{{'));
  assert.ok((await box(s)).height < 130, 'the summary stays compact'); await close();
  const l = await open('?v=long'); const toggle = l.page.getByRole('button', { name: 'Show all' }); assert.ok(await toggle.isVisible(), 'a long summary offers Show all'); await toggle.click(); assert.ok(await l.page.getByRole('button', { name: 'Show less' }).isVisible());
  assert.match(await l.page.locator('.wfs-summary').innerText(), /request a whatsapp message “Hi \[Contact name\], thanks for getting in touch\.”/); await l.close();
});

test('[browser][desktop] no dragging needed: add from the + button, reorder with buttons, walk and open steps with the keyboard', async () => {
  const { page, close } = await open(); const order = async () => page.locator('.wf-node').evaluateAll(els => els.map(e => ({ y: e.getBoundingClientRect().top, t: e.querySelector('.wf-title').textContent })).sort((a, b) => a.y - b.y).map(x => x.t)); // top to bottom = run order
  await page.getByRole('button', { name: 'Add a step after step 3' }).click(); assert.ok(await page.locator('#wfs-lib').isVisible(), 'the + opens the library'); assert.ok(await page.getByText(/New steps go after/).isVisible());
  await page.locator('#wfs-lib').getByRole('button', { name: /Notify a team member/ }).click(); assert.equal(await nodes(page).count(), 5);
  let o = await order(); assert.match(o[3], /Notify/); assert.match(o[2], /Assign the lead/); assert.match(o[4], /Create a follow-up task/, 'inserted right after step 3, before the old step 4');
  assert.ok(await page.locator('#wfs-right').getByRole('heading', { name: /Step 4 details/ }).isVisible(), 'the new step opens for editing');
  await page.getByRole('button', { name: 'Move earlier' }).click(); o = await order(); assert.match(o[2], /Notify/); assert.match(o[3], /Assign the lead/); assert.match(o[4], /Create a follow-up task/);
  const ys = []; for (let i = 0; i < 5; i++) ys.push((await box(nodes(page).nth(i))).y); assert.ok(ys.every((y, i) => i === 0 || y > ys[i - 1]), 'the canvas re-stacked after the change');
  await page.getByRole('button', { name: 'Close' }).last().click().catch(() => {}); // details
  await nodes(page).first().focus(); await page.keyboard.press('ArrowDown'); assert.match(await page.locator('[data-node]:focus .wf-kind').innerText(), /^2\. only if$/i); await page.keyboard.press('Enter');
  assert.ok(await page.locator('#wfs-right').getByRole('heading', { name: /Step 2 details/ }).isVisible(), 'Enter opens the focused step'); await close();
});

test('[browser][desktop] validation: a missing condition value is explained on the strip, the step and the field, blocks saving, and clears once fixed', async () => {
  const { page, close } = await open('?v=blank'); const strip = page.getByRole('region', { name: 'Problems to fix' });
  assert.ok(await strip.isVisible()); assert.match(await strip.innerText(), /1 thing to fix before you can save/); assert.match(await strip.innerText(), /Condition 1 \(Lead source equals\) needs a value/); assert.match(await strip.innerText(), /choose “is empty”/);
  assert.equal(await page.locator('.wf-node.bad').count(), 1); assert.match(await page.locator('.wf-node.bad').textContent(), /Problem: Condition 1/, 'the offending step is marked and its problem is part of its accessible name'); assert.ok(await page.locator('.wf-warn').isVisible());
  assert.ok(await page.getByRole('button', { name: 'Save draft' }).isDisabled(), 'cannot save with a problem');
  await strip.getByRole('button', { name: /Go to step 2/ }).click(); const field = page.getByLabel('Condition 1 value'); assert.equal(await field.getAttribute('aria-invalid'), 'true'); assert.ok(await page.locator('#cond-err-0').isVisible());
  await field.fill('website'); assert.equal(await page.getByRole('region', { name: 'Problems to fix' }).count(), 0, 'the problem disappears as soon as it is fixed'); assert.ok(await page.getByRole('button', { name: 'Save draft' }).isEnabled());
  assert.equal(await page.locator('.wf-node.bad').count(), 0); await close();
});

test('[browser][desktop] preview runs on sample data, explains each step, can show "would not run", and makes NO writes', async () => {
  const { page, requests, close } = await open(); await page.getByRole('button', { name: 'Preview', exact: true }).click(); const p = page.locator('#wfs-right');
  assert.ok(await p.getByText('Nothing is saved, changed or sent.').isVisible());
  const mark = requests.length; await p.getByRole('button', { name: 'Run preview' }).click(); const res = p.getByRole('region', { name: 'Preview result' }); await res.waitFor();
  const t = await res.innerText(); assert.match(t, /This would run\. 2 actions would happen/); assert.match(t, /Call Asha Patel/); assert.match(t, /would happen/i);
  assert.ok(!(await p.getByLabel('Lead source').isVisible()), 'the sample folds away after a run so the result is in view'); await p.getByText('Sample event (edit to try other cases)').click(); await p.getByLabel('Lead source').fill('phone'); assert.ok(await res.getByText(/changed since this result/).isVisible(), 'a stale result says so'); await p.getByRole('button', { name: 'Run preview again' }).click();
  assert.match(await res.innerText(), /would not run for that sample/); assert.match(await res.innerText(), /stops here/i); assert.match(await res.innerText(), /would stop here and do nothing/);
  const after = requests.slice(mark); assert.deepEqual(after.filter(r => r.method !== 'GET'), [], 'no POST/server action during preview'); assert.deepEqual(after.filter(r => /supabase|\/api\//.test(r.url)), [], 'no API or database call during preview'); await close();
});

test('[browser][desktop] preview with a wait and an external message: waits are not slept, nothing is sent', async () => {
  const { page, close } = await open('?v=long'); await page.getByRole('button', { name: 'Preview', exact: true }).click(); await page.locator('#wfs-right').getByRole('button', { name: 'Run preview' }).click();
  const t = await page.getByRole('region', { name: 'Preview result' }).innerText(); assert.match(t, /would wait/i); assert.match(t, /Preview does not wait/); assert.match(t, /Nothing is sent until a whatsapp provider is connected, and never from a preview/); await close();
});

test('[browser][desktop] Optizen AI panel: honest when not set up; when set up, a drafted automation opens on the canvas for editing (network mocked)', async () => {
  let r = await open(); await r.page.getByRole('button', { name: 'Ask Optizen AI' }).click(); assert.ok(await r.page.getByText('Optizen AI is not set up on this deployment.').isVisible()); assert.equal(await r.page.getByRole('button', { name: 'Draft with Optizen AI' }).count(), 0); await r.close();
  r = await open('?ai=1'); const { page } = r; const bodies = [];
  await page.route('**/api/ai/stream', async route => { bodies.push(JSON.parse(route.request().postData())); const ev = [{ type: 'start', conversationId: '11111111-1111-4111-8111-111111111111' }, { type: 'text', text: 'Here is a draft.' },
    { type: 'done', conversationId: '11111111-1111-4111-8111-111111111111', text: 'Here is a draft you can edit.', replayed: false, plans: [], proposals: [{ id: '22222222-2222-4222-8222-222222222222', kind: 'workflow', title: 'Call new website leads', status: 'pending', payload: { summary: 'Assigns the lead and creates a call task.', preview: ['When a lead is created', '1. Assign in rotation'] } }] }];
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ev.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') }); });
  await page.getByRole('button', { name: 'Ask Optizen AI' }).click(); const p = page.locator('#wfs-right'); assert.ok(await p.getByRole('button', { name: 'Draft with Optizen AI' }).isDisabled());
  await p.getByLabel('What should this automation do?').fill('When a website lead arrives, call them tomorrow'); await p.getByRole('button', { name: 'Draft with Optizen AI' }).click();
  const prop = p.getByRole('group', { name: 'Proposed automation: Call new website leads' }); await prop.waitFor(); assert.equal(bodies[0].message, 'Create an automation: When a website lead arrives, call them tomorrow'); assert.equal(bodies[0].conversationId, null);
  assert.match(await prop.innerText(), /Assigns the lead and creates a call task/); assert.equal(await prop.getByRole('link', { name: 'Open on the canvas to edit' }).getAttribute('href'), '/automations/new?proposal=22222222-2222-4222-8222-222222222222');
  assert.match(await prop.innerText(), /Opening this replaces what is on the canvas now/, 'warns that unsaved work would be replaced'); await r.close();
});

test('[browser][phone 390x844] fits without sideways scrolling, readable, the canvas gets the room, panels become sheets, controls are large enough', async () => {
  const { page, close } = await open('?v=default', PHONE, { touch: true }); const c = await box(page.locator('.wf-canvas'));
  const noScroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert.ok((await noScroll()) <= 0, 'no horizontal scroll'); assert.ok(c.width >= PHONE.width - 40, `canvas ${Math.round(c.width)}px wide`); assert.ok((await zoom(page)) >= 85);
  assert.ok(c.height >= 330, `canvas is ${Math.round(c.height)}px tall in normal mode`); assert.ok(inside(await box(nodes(page).first()), c), 'the first step fits the screen width');
  for (const name of ['Steps', 'Save draft', 'Full screen', 'Fit to view']) assert.ok((await box(page.getByRole('button', { name, exact: true }))).height >= 44, `${name} is at least 44px tall`);
  const more = page.locator('.wfs-more summary'); assert.ok((await box(more)).height >= 44, 'More is at least 44px tall');
  await more.tap(); for (const name of ['Preview', 'Ask Optizen AI', 'Publish', 'Undo']) assert.ok((await box(page.getByRole('button', { name, exact: true }))).height >= 44, `${name} (More menu) is at least 44px tall`);
  await more.tap();
  await nodes(page).first().tap(); const right = page.locator('#wfs-right'); assert.ok(await right.isVisible()); const rb = await box(right); assert.ok(rb.x >= 0 && rb.x + rb.width <= PHONE.width && rb.y >= 0 && rb.y + rb.height <= PHONE.height, 'the details sheet stays on screen');
  assert.ok((await noScroll()) <= 0); await right.getByRole('button', { name: 'Close' }).tap(); assert.ok(!(await right.isVisible()));
  await page.getByRole('button', { name: 'Steps', exact: true }).tap(); assert.ok(await page.locator('#wfs-lib').isVisible()); await page.locator('#wfs-lib').getByRole('button', { name: /Wait \/ delay/ }).tap(); assert.equal(await nodes(page).count(), 5, 'a step added while the trigger was selected lands after the condition');
  await page.locator('#wfs-lib').getByRole('button', { name: 'Close' }).tap(); const add = await box(page.locator('.wf-add').first()); assert.ok(add.width >= 24 && add.height >= 24, `the + button is ${Math.round(add.width)}px (WCAG 2.2 minimum 24px)`);
  await page.getByRole('button', { name: 'Full screen' }).tap(); await page.waitForTimeout(250); const e = await box(page.locator('.wf-canvas')); assert.ok(e.width >= PHONE.width - 24 && e.height >= PHONE.height * 0.7, `expanded canvas ${Math.round(e.width)}x${Math.round(e.height)}`);
  assert.ok(!(await page.locator('.wfs-summary').isVisible()), 'full screen on a phone gives the canvas everything'); let seen = 0; for (let i = 0; i < 5; i++) { const n = await box(nodes(page).nth(i)); if (n.y >= e.y - 1 && n.y + n.height <= e.y + e.height + 1) seen++; } assert.ok(seen >= 4, `${seen} of 5 steps visible without scrolling in full screen`); await close();
});

test('[browser][accessibility] no serious axe violations: desktop with details open, preview open, validation errors, and the phone', async () => {
  let r = await open(); await nodes(r.page).nth(2).click(); await r.page.getByRole('button', { name: 'Steps', exact: true }).click(); assert.deepEqual(await axe(r.page), [], 'desktop: library + details open'); await r.close();
  r = await open(); await r.page.getByRole('button', { name: 'Preview', exact: true }).click(); await r.page.locator('#wfs-right').getByRole('button', { name: 'Run preview' }).click(); assert.deepEqual(await axe(r.page), [], 'desktop: preview result'); await r.close();
  r = await open('?v=blank'); await r.page.getByRole('button', { name: /Go to step 2/ }).click(); assert.deepEqual(await axe(r.page), [], 'desktop: validation errors'); await r.close();
  r = await open('?ai=1'); await r.page.getByRole('button', { name: 'Ask Optizen AI' }).click(); assert.deepEqual(await axe(r.page), [], 'desktop: AI panel'); await r.close();
  r = await open('?v=long', PHONE, { touch: true }); await nodes(r.page).first().tap(); assert.deepEqual(await axe(r.page), [], 'phone: details sheet'); await r.close();
});

test('[browser][desktop] screenshots for human review (written to test-results/automation-builder/, not asserted)', async () => {
  const { mkdirSync } = await import('node:fs'); mkdirSync('test-results/automation-builder', { recursive: true });
  for (const [name, q, vp, act] of [['desktop-default', '', DESKTOP, null], ['desktop-details', '', DESKTOP, async p => { await nodes(p).nth(1).click(); }], ['desktop-preview', '', DESKTOP, async p => { await p.getByRole('button', { name: 'Preview', exact: true }).click(); await p.locator('#wfs-right').getByRole('button', { name: 'Run preview' }).click(); }],
    ['desktop-problem', '?v=blank', DESKTOP, null], ['desktop-long', '?v=long', DESKTOP, null], ['laptop-long', '?v=long', LAPTOP, null], ['desktop-fullscreen', '', DESKTOP, async p => { await p.getByRole('button', { name: 'Full screen' }).click(); }], ['phone-default', '', PHONE, null], ['phone-details', '', PHONE, async p => { await nodes(p).first().tap(); }]]) {
    const { page, close } = await open(q, vp, { touch: vp === PHONE }); if (act) await act(page); await page.waitForTimeout(250); await page.screenshot({ path: `test-results/automation-builder/${name}.png` }); await close();
  }
});
