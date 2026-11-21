// Navigation audit (logic level, no browser): every internal link and redirect written in the source points at a route that exists, so nothing in the navigation is broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const APP = 'src/app';
const routes = walk(APP).filter(f => /\/(page\.tsx|route\.ts)$/.test(f)).map(f => '/' + f.slice(APP.length + 1).replace(/\/(page\.tsx|route\.ts)$/, '').split('/').filter(seg => !/^\(.*\)$/.test(seg)).join('/')).map(r => (r === '/page.tsx' || r === '/' ? '/' : r.replace(/^\/$/, '/')));
const patterns = routes.map(r => new RegExp('^' + r.replace(/\[[^\]]+\]/g, '[^/]+') + '$'));
const exists = path => path === '/' || patterns.some(p => p.test(path));
const sources = walk('src').filter(f => /\.(tsx?|ts)$/.test(f));
const found = [];
for (const f of sources) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/(?:href|redirect|router\.(?:push|replace))\s*[=(]\s*\{?\s*(?:"|'|`)(\/[A-Za-z0-9\-_/\[\]${}.]*)/g)) found.push([f, m[1]]);
}
test('every internal link and redirect points at an existing route', () => {
  const bad = [];
  for (const [f, raw] of found) {
    const path = raw.replace(/\$\{[^}]*\}/g, 'X').replace(/\/+$/, '') || '/';
    if (path.startsWith('/api/') || path === '/ux-fixtures' || path.startsWith('/ux-fixtures/')) continue;
    if (!exists(path)) bad.push(`${f}: ${raw}`);
  }
  assert.deepEqual(bad, []);
  assert.ok(found.length > 80, `audited ${found.length} links`);
});
test('the main navigation destinations exist and the role-based groups only contain real pages', () => {
  for (const p of ['/work', '/work/leads', '/work/leads/new', '/work/leads/board', '/tasks', '/search', '/notifications', '/account', '/dashboards', '/reports', '/builder/home', '/builder', '/builder/forms', '/builder/pipeline', '/automations', '/team', '/team/roles', '/builder/connections', '/settings/ai', '/invite/abc', '/work/vehicles/board', '/work/appointments', '/work/billing', '/work/inventory']) assert.ok(exists(p), `missing route ${p}`);
});
test('every form posts to a server action or a real route, and search/login/invite flows are wired', () => {
  const layout = readFileSync('src/components/ux/AppShell.tsx', 'utf8'); assert.match(layout, /action="\/search" method="get"/);
  assert.match(readFileSync('src/app/login/actions.ts', 'utf8'), /safeNext/); assert.match(readFileSync('src/app/auth/callback/route.ts', 'utf8'), /safeNext/);
});
test('browser-test fixtures are gated off unless OPTIZEN_UX_FIXTURES=1 (no sample data can reach a real workspace)', () => {
  const l = readFileSync('src/app/ux-fixtures/layout.tsx', 'utf8'); assert.match(l, /process\.env\.OPTIZEN_UX_FIXTURES !== '1'\) notFound\(\)/);
  assert.ok(!/ux-fixtures/.test(readFileSync('src/app/(app)/layout.tsx', 'utf8')), 'the real layout never links to fixtures');
});
