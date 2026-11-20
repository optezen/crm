// LIVE Supabase: universal workspace creation and the Builder draft/publish lifecycle, as real users through PostgREST + RLS.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { guard, newUser, createOrg, definition, trackOrg, cleanup } from './env.mjs';
import * as builder from '../../src/lib/workspace/builder.ts';
import { blankConfig, presetConfig } from '../../src/lib/workspace/schema.ts';
import { presets } from '../../src/lib/workspace/presets.ts';

const opt = { skip: guard ?? false };
let owner, emp, other;
after(cleanup);
before(async () => { if (guard) return; [owner, emp, other] = await Promise.all(['own', 'emp', 'oth'].map(newUser)); });
const ok = r => { assert.ok(r.ok, r.error); return r.value; };

test('any business can create a workspace: arbitrary description, blank, preset, custom config; no industry stored', opt, async () => {
  const make = async (u, name, description, cfg, preset = null) => {
    const { data, error } = await u.client.rpc('create_workspace', { p_name: name, p_description: description, p_preset: preset, p_definition: cfg });
    assert.ifError(error); const org = data; const row = (await u.client.from('organizations').select('industry_template, preset, description').eq('id', org).single()).data;
    const def = (await u.client.from('workspace_configuration_versions').select('definition').eq('organization_id', org).single()).data.definition;
    trackOrg(org); return { org, row, def };
  };
  const a = await make(owner, 'Drone League', 'FPV racing', definition('Drone League', { pipeline: { stages: ['Interested', 'Member'] } }));
  assert.deepEqual(a.row, { industry_template: null, preset: null, description: 'FPV racing' });
  const b = await make(owner, 'Blank Co', null, blankConfig('Blank Co'));
  assert.equal(b.row.preset, null);
  const p = presets[0]; const c = await make(owner, 'Preset Co', null, presetConfig(p, 'Preset Co'), p.key);
  assert.equal(c.row.preset, p.key); assert.equal(c.def.preset, p.key);
  for (const x of [a, b, c]) assert.doesNotMatch(JSON.stringify(x.def), /"industryTemplate"/);
});

test('builder lifecycle: only owners/admins draft and publish; employees cannot see drafts; stage guard; isolation', opt, async () => {
  const org = await createOrg(owner, 'Builder Org');
  const { error: e1 } = await owner.client.rpc('crm_add_member', { p_org: org, p_email: emp.email, p_role: 'employee' }); assert.ifError(e1);
  const next = definition('Builder Org', { pipeline: { stages: ['x', 'y', 'z'] } });
  assert.equal((await builder.saveDraft(emp.client, org, next)).ok, false);
  assert.equal((await builder.saveDraft(other.client, org, next)).ok, false);
  assert.equal(ok(await builder.saveDraft(owner.client, org, next)).revision, 2);
  assert.equal((await builder.saveDraft(owner.client, org, { ...next, pipeline: { stages: ['only'] } })).ok, false, 'invalid drafts are refused');
  assert.equal(ok(await builder.loadDraft(emp.client, org)), null, 'employee sees no draft');
  assert.equal(ok(await builder.loadDraft(other.client, org)), null);
  assert.deepEqual(ok(await builder.loadDraft(owner.client, org)).pipeline.stages, ['x', 'y', 'z']);
  assert.equal((await builder.publishDraft(emp.client, org)).ok, false);
  assert.equal((await builder.publishDraft(other.client, org)).ok, false);
  assert.equal(ok(await builder.publishDraft(owner.client, org)).revision, 2);
  const live = (await emp.client.from('workspace_configuration_versions').select('definition').eq('organization_id', org).eq('status', 'published').single()).data.definition;
  assert.deepEqual(live.pipeline.stages, ['x', 'y', 'z']);
  assert.deepEqual(ok(await builder.listVersions(owner.client, org)).map(v => [v.revision, v.status]), [[2, 'published'], [1, 'archived']]);
  // stage guard
  const { data: lead } = await owner.client.rpc('crm_create_lead', { p_org: org, p_full_name: 'Guarded', p_phone: null, p_email: null, p_source: 'phone', p_summary: null, p_stage: 'x', p_assigned_to: null });
  ok(await builder.saveDraft(owner.client, org, definition('Builder Org', { pipeline: { stages: ['y', 'z'] } })));
  assert.equal((await builder.publishDraft(owner.client, org)).ok, false, 'lead still in removed stage');
  ok(await builder.discardDraft(owner.client, org)); assert.ok(lead);
  assert.equal((await builder.discardDraft(emp.client, org)).ok, false);
});
