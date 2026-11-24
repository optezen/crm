// `npm run test:browser` — REAL browser tests (Chromium via Playwright) against a production build served locally with OPTIZEN_UX_FIXTURES=1.
// What they cover: the real login and onboarding pages, and the real shell/home/board components rendered with clearly labelled fixture data (layout, mobile navigation, keyboard use,
// touch-target sizes, accessibility scan, drag-and-drop fallbacks). What they do NOT cover: anything that needs the database (sign-in, invitations, search results, saving): those are tested
// at the database/logic level in tests/*.test.mjs. Fails (non-zero) when the browser or build is missing instead of silently skipping.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const PORT = process.env.BROWSER_TEST_PORT || '3991';
if (!existsSync('.next/BUILD_ID')) { console.error('Browser tests need a production build: run `npm run build` first.'); process.exit(2); }
let chromium; try { ({ chromium } = await import('playwright')); const b = await chromium.launch({ channel: 'chromium' }); await b.close(); } catch { console.error('Chromium for Playwright is not installed: run `npx playwright install chromium`.'); process.exit(2); }
// A server left over from an earlier run would answer instead of this build and silently skew every result: refuse to start.
try { await fetch(`http://localhost:${PORT}/login`, { signal: AbortSignal.timeout(1500) }); console.error(`Port ${PORT} is already in use (a stale server?). Stop it, or set BROWSER_TEST_PORT.`); process.exit(2); } catch { /* nothing listening: good */ }
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', PORT], { env: { ...process.env, OPTIZEN_UX_FIXTURES: '1', NEXT_PUBLIC_SUPABASE_URL: '', NEXT_PUBLIC_SUPABASE_ANON_KEY: '' }, stdio: 'ignore' });
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
const base = `http://localhost:${PORT}`;
for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/login')).status < 500) break; } catch { /* not up yet */ } await new Promise(r => setTimeout(r, 500)); if (i === 59) { console.error('The app did not start.'); stop(); process.exit(1); } }
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/browser/ux.browser.mjs', 'tests/browser/automation.browser.mjs'], { stdio: 'inherit', env: { ...process.env, BASE_URL: base } });
stop(); process.exit(r.status ?? 1);
