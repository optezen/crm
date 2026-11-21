import test from 'node:test';
import assert from 'node:assert/strict';
import { safeNext } from '../src/lib/ux/nav.ts';
test('post-login redirects are limited to same-site pages we expect (no open redirect)', () => {
  const token = 'a'.repeat(64);
  for (const ok of [`/invite/${token}`, '/work', '/work/leads', '/tasks', '/search', '/notifications', '/account']) assert.equal(safeNext(ok), ok);
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil', '/invite/short', '/invite/' + 'g'.repeat(64), '/builder', '/api/ai/chat', '/work?x=1', '/work/../etc', 'javascript:alert(1)', '', null, undefined, 5, '/' + 'a'.repeat(300), '/work\n/x']) assert.equal(safeNext(bad), null, String(bad));
});
