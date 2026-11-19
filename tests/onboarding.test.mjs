import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildInitialConfig, validateOnboarding } from '../src/lib/workspace/build.ts';
import { resolveMembership, canBuild } from '../src/lib/workspace/resolve.ts';

const templates = JSON.parse(readFileSync(new URL('../config/industries.json', import.meta.url), 'utf8'));

test('onboarding validation trims and rejects bad input', () => {
  assert.deepEqual(validateOnboarding({ name: '  Glow   Clinic ', industry: 'clinic' }, templates).value, { name: 'Glow Clinic', industry: 'clinic' });
  assert.ok(validateOnboarding({ name: 'x', industry: 'clinic' }, templates).errors.name);
  assert.ok(validateOnboarding({ name: 'Ok name', industry: 'constructor' }, templates).errors.industry); // prototype keys rejected
  assert.ok(validateOnboarding({ name: 42, industry: null }, templates).ok === false);
});

for (const [key, t] of Object.entries(templates)) {
  test(`${key}: initial config is valid and marks future modules planned`, () => {
    const c = buildInitialConfig(t, key, 'Acme');
    assert.equal(c.schemaVersion, 1);
    assert.equal(new Set(c.modules.map(m => m.key)).size, c.modules.length);
    for (const m of c.modules.filter(m => /inventory|billing|workflows/i.test(m.label))) assert.equal(m.status, 'planned');
    assert.ok(c.modules.some(m => m.status === 'active'));
    assert.deepEqual(c.pipeline.stages, t.pipeline);
  });
}

test('workspace resolution only honors organizations the user belongs to', () => {
  const ms = [{ organizationId: 'a', role: 'employee' }, { organizationId: 'b', role: 'owner' }];
  assert.equal(resolveMembership(ms, 'b').organizationId, 'b');
  assert.equal(resolveMembership(ms, 'evil-org').organizationId, 'a'); // spoofed hint ignored
  assert.equal(resolveMembership(ms, null).organizationId, 'a');
  assert.equal(resolveMembership([], 'a'), null);
});

test('only owners and admins may use the builder', () => {
  assert.deepEqual(['owner', 'admin', 'manager', 'employee'].map(canBuild), [true, true, false, false]);
});
