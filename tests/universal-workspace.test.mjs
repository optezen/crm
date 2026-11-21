// Universal workspace SQL tests: real PostgreSQL engine (PGlite) running the real migrations 0001-0005.
// Migrations 0001-0004 are applied FIRST and legacy (industry-based) organizations are created with the old function,
// then 0005 is applied on top, exactly like upgrading an existing deployment. auth schema / grants are a small shim.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { validateConfig } from '../src/lib/workspace/schema.ts';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const dir = new URL('../supabase/migrations/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [LEG, LEG2, NEW, EMP, MGR, OTHER] = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const def = (o = {}) => ({ schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Won'] }, ...o });

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const rows = (u, sql, p) => as(u, sql, p).then(r => r.rows);
const rpc = (u, fn, ...args) => as(u, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(',')}) r`, args).then(r => r.rows[0].r);
const fails = (p, code, msg) => assert.rejects(p, e => (!code || e.code === code) && (!msg || msg.test(e.message)));
const create = (u, name, desc = null, preset = null, d = def()) => rpc(u, 'create_workspace', name, desc, preset, JSON.stringify(d)).then(String);
const latest = org => db.query(`select * from public.workspace_configuration_versions where organization_id=$1 and status='published' order by revision desc limit 1`, [org]).then(r => r.rows[0]);
const lead = (u, org, name, stage = null) => rpc(u, 'crm_create_lead', org, name, null, null, 'phone', null, stage, null);

let legacyA, legacyB, legacyDef, legacyLead;
const legacyDefinition = n => ({ schemaVersion: 1, businessName: n, industryTemplate: 'clinic', modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }, { key: 'patients', label: 'Patients', status: 'active' }], objects: [{ key: 'patients', label: 'Patients', fields: [{ key: 'full_name', label: 'Full name', kind: 'text' }] }], pipeline: { stages: ['New enquiry', 'Contacted', 'Won / Lost'] } });

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${LEG}','leg@x.test'),('${LEG2}','leg2@x.test'),('${NEW}','new@x.test'),('${EMP}','emp@x.test'),('${MGR}','mgr@x.test'),('${OTHER}','other@x.test');`);
  for (const f of files.filter(f => f < '0005')) await db.exec(readFileSync(new URL(f, dir), 'utf8')); // the deployed state before this change
  legacyDef = legacyDefinition('Legacy Clinic');
  legacyA = (await as(LEG, 'select public.create_organization($1,$2,$3::jsonb) id', ['Legacy Clinic', 'clinic', JSON.stringify(legacyDef)])).rows[0].id;
  legacyB = (await as(LEG2, 'select public.create_organization($1,$2,$3::jsonb) id', ['Legacy Salon', 'salon', JSON.stringify(legacyDefinition('Legacy Salon'))])).rows[0].id;
  legacyLead = await lead(LEG, legacyA, 'Pre-existing lead', 'Contacted');
  for (const f of files.filter(f => f >= '0005')) await db.exec(readFileSync(new URL(f, dir), 'utf8')); // upgrade
});

test('upgrade: existing organizations, memberships, configs and CRM data are preserved byte-for-byte', async () => {
  assert.equal((await rows(LEG, 'select name from public.organizations where id=$1', [legacyA]))[0].name, 'Legacy Clinic');
  const v = await latest(legacyA);
  assert.deepEqual(v.definition, legacyDef, 'published definition untouched (legacy industryTemplate included)');
  assert.equal(v.status, 'published'); assert.equal(v.revision, 1);
  assert.deepEqual((await rows(LEG, 'select role from public.organization_members where organization_id=$1', [legacyA])).map(r => r.role), ['owner']);
  const org = (await db.query('select industry_template, preset, description from public.organizations where id=$1', [legacyB])).rows[0];
  assert.deepEqual(org, { industry_template: 'salon', preset: 'salon', description: null }, 'legacy discriminator kept; provenance backfilled into preset');
  assert.equal((await rows(LEG, 'select stage from public.crm_lead_list where id=$1', [legacyLead]))[0].stage, 'Contacted');
});

test('upgrade: the three-industry restriction and the old function are gone; legacy orgs keep working with the CRM', async () => {
  const col = (await db.query(`select is_nullable from information_schema.columns where table_name='organizations' and column_name='industry_template'`)).rows[0];
  assert.equal(col.is_nullable, 'YES');
  assert.equal((await db.query(`select 1 from pg_constraint where conname='organizations_industry_template_check'`)).rows.length, 0);
  await fails(as(LEG, `select public.create_organization('Nope','clinic','{}')`), '42883');
  await rpc(LEG, 'crm_set_stage', legacyA, legacyLead, 'Won / Lost'); // pipeline from the legacy config still drives the CRM
  await fails(rpc(LEG, 'crm_set_stage', legacyA, legacyLead, 'Not a stage'), '22023');
  assert.equal((await lead(LEG, legacyA, 'Another legacy lead')).length > 0, true); // defaults to first legacy stage
  assert.equal((await rows(LEG, `select stage from public.crm_lead_list where full_name='Another legacy lead'`))[0].stage, 'New enquiry');
});

test('arbitrary businesses: any name/description/modules/fields/pipeline is accepted; nothing industry-specific is stored', async () => {
  const biz = def({
    modules: [...CORE, { key: 'drones', label: 'Drone fleet', status: 'planned' }, { key: 'race-events', label: 'Race events', status: 'planned' }],
    objects: [{ key: 'pilots', label: 'Pilots', fields: [{ key: 'callsign', label: 'Callsign', kind: 'text' }, { key: 'rank', label: 'Rank', kind: 'choice', options: ['Rookie', 'Pro'] }, { key: 'licensed', label: 'Licensed', kind: 'yes_no' }, { key: 'joined', label: 'Joined', kind: 'date' }, { key: 'wins', label: 'Wins', kind: 'number' }] }],
    pipeline: { stages: ['Interested', 'Trial flight', 'Member', 'Alumni'] },
  });
  const org = await create(NEW, 'Drone Racing League', 'We organise amateur FPV drone races.', null, biz);
  const o = (await db.query('select industry_template, preset, description from public.organizations where id=$1', [org])).rows[0];
  assert.deepEqual(o, { industry_template: null, preset: null, description: 'We organise amateur FPV drone races.' });
  const stored = (await latest(org)).definition;
  assert.equal(stored.description, 'We organise amateur FPV drone races.'); assert.ok(!/industry|clinic|salon|scrap/i.test(JSON.stringify(stored)));
  assert.equal(stored.objects[0].fields[1].options.length, 2);
  // the CRM runs on this business's own pipeline
  const l = await lead(NEW, org, 'First pilot');
  assert.equal((await rows(NEW, 'select stage from public.crm_lead_list where id=$1', [l]))[0].stage, 'Interested');
  await rpc(NEW, 'crm_set_stage', org, l, 'Trial flight');
  await fails(rpc(NEW, 'crm_set_stage', org, l, 'New'), '22023', /pipeline/);
});

test('blank and preset workspaces share the same model; preset is provenance only', async () => {
  const blank = await create(EMP, 'Blank Co');
  assert.equal((await db.query('select preset, description from public.organizations where id=$1', [blank])).rows[0].preset, null);
  const withPreset = await create(MGR, 'Preset Co', null, 'clinic', def({ preset: 'ignored-by-column' }));
  const row = (await db.query('select preset from public.organizations where id=$1', [withPreset])).rows[0];
  assert.equal(row.preset, 'clinic'); assert.equal((await latest(withPreset)).definition.preset, 'clinic');
  // a preset-created workspace can diverge freely: its owner drafts and publishes something unrelated
  await rpc(MGR, 'save_workspace_draft', withPreset, JSON.stringify(def({ pipeline: { stages: ['Idea', 'Prototype', 'Launch'] }, objects: [{ key: 'bikes', label: 'Bikes', fields: [{ key: 'frame', label: 'Frame', kind: 'text' }] }] })));
  await rpc(MGR, 'publish_workspace_config', withPreset);
  assert.deepEqual((await latest(withPreset)).definition.pipeline.stages, ['Idea', 'Prototype', 'Launch']);
});

test('definition validation: structural rules are enforced in the database', async () => {
  const bad = async (d, msg) => fails(rpc(OTHER, 'create_workspace', 'Bad Co', null, null, JSON.stringify(d)), '22023', msg);
  await bad(def({ modules: [CORE[0]] }), /Overview and Leads/);
  await bad(def({ modules: [CORE[0], { ...CORE[1], status: 'planned' }] }), /Overview and Leads/);
  await bad(def({ modules: [...CORE, { key: 'leads', label: 'Dup', status: 'planned' }] }), /Duplicate module/);
  await bad(def({ modules: [...CORE, { key: 'Bad Key', label: 'x', status: 'planned' }] }), /key/);
  await bad(def({ modules: [...CORE, { key: 'x', label: '', status: 'planned' }] }), /name/);
  await bad(def({ modules: [...CORE, { key: 'x', label: 'x', status: 'live' }] }), /status/);
  await bad(def({ modules: [...CORE, ...Array.from({ length: 41 }, (_, i) => ({ key: `m${i}`, label: 'm', status: 'planned' }))] }), /at most 40/);
  await bad(def({ pipeline: { stages: ['Only one'] } }), /between 2 and 20/);
  await bad(def({ pipeline: { stages: ['A', 'A'] } }), /unique/);
  await bad(def({ pipeline: { stages: ['A', ' B '] } }), /stage/);
  await bad(def({ pipeline: { stages: Array.from({ length: 21 }, (_, i) => `S${i}`) } }), /between 2 and 20/);
  await bad(def({ pipeline: undefined }), /between 2 and 20/);
  await bad(def({ objects: [{ key: 'a', label: 'A', fields: [{ key: 'Bad', label: 'x', kind: 'text' }] }] }), /key/);
  await bad(def({ objects: [{ key: 'a', label: 'A', fields: [{ key: 'f', label: 'x', kind: 'blob' }] }] }), /type/);
  await bad(def({ objects: [{ key: 'a', label: 'A', fields: [{ key: 'f', label: 'x', kind: 'choice' }] }] }), /options/);
  await bad(def({ objects: [{ key: 'a', label: 'A', fields: [{ key: 'f', label: 'x', kind: 'text' }, { key: 'f', label: 'y', kind: 'text' }] }] }), /Duplicate field/);
  await bad(def({ objects: [{ key: 'a', label: 'A', fields: [] }, { key: 'a', label: 'B', fields: [] }] }), /Duplicate record type/);
  await bad(def({ objects: 'nope' }), /Record types/);
  await bad(def({ modules: 'nope' }), /Modules/);
});

test('builder lifecycle: draft -> review -> publish creates an immutable new revision; roles and visibility enforced', async () => {
  const org = await create(NEW, 'Lifecycle Co');
  await rpc(NEW, 'crm_add_member', org, 'emp@x.test', 'employee'); await rpc(NEW, 'crm_add_member', org, 'mgr@x.test', 'manager');
  const next = def({ pipeline: { stages: ['New', 'Qualified', 'Won'] }, modules: [...CORE, { key: 'orders', label: 'Orders', status: 'planned' }] });
  await fails(rpc(EMP, 'save_workspace_draft', org, JSON.stringify(next)), '42501');
  await fails(rpc(MGR, 'save_workspace_draft', org, JSON.stringify(next)), '42501');
  await fails(rpc(NEW, 'publish_workspace_config', org), '22023', /no saved draft/);
  assert.equal(await rpc(NEW, 'save_workspace_draft', org, JSON.stringify({ ...next, businessName: 'Renamed Via Draft' })), 2);
  assert.equal(await rpc(NEW, 'save_workspace_draft', org, JSON.stringify(next)), 2, 'saving again updates the single draft');
  assert.equal((await rows(NEW, `select 1 from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org])).length, 1);
  assert.equal((await rows(EMP, `select 1 from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org])).length, 0, 'employees cannot see drafts');
  assert.equal((await rows(MGR, `select 1 from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org])).length, 0);
  assert.equal((await rows(EMP, `select 1 from public.workspace_configuration_versions where organization_id=$1 and status='published'`, [org])).length, 1, 'published stays visible to members');
  assert.equal((await rows(NEW, `select definition->>'businessName' n from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org]))[0].n, 'Lifecycle Co', 'name is not editable via the Builder');
  // the live config is unchanged until publish
  assert.deepEqual((await latest(org)).definition.pipeline.stages, ['New', 'Won']);
  await fails(rpc(EMP, 'publish_workspace_config', org), '42501');
  assert.equal(await rpc(NEW, 'publish_workspace_config', org), 2);
  const live = await latest(org);
  assert.equal(live.revision, 2); assert.deepEqual(live.definition.pipeline.stages, ['New', 'Qualified', 'Won']);
  assert.deepEqual((await rows(NEW, 'select revision, status from public.workspace_configuration_versions where organization_id=$1 order by revision', [org])), [{ revision: 1, status: 'archived' }, { revision: 2, status: 'published' }]);
  assert.equal((await db.query(`select 1 from public.domain_events where organization_id=$1 and event_name='workspace.published'`, [org])).rows.length, 1);
  assert.equal((await db.query(`select 1 from public.audit_events where organization_id=$1 and event_name='workspace.published'`, [org])).rows.length, 1);
  // CRM immediately uses the new pipeline
  const l = await lead(NEW, org, 'After publish'); await rpc(NEW, 'crm_set_stage', org, l, 'Qualified');
  // published revisions are immutable, even for service_role
  await db.exec('set role service_role');
  try { await fails(db.query(`update public.workspace_configuration_versions set definition='{"schemaVersion":1}' where organization_id='${org}' and revision=2`), '42501'); } finally { await db.exec('reset role'); }
  // discard
  await rpc(NEW, 'save_workspace_draft', org, JSON.stringify(def({ pipeline: { stages: ['A', 'B'] } })));
  await rpc(NEW, 'discard_workspace_draft', org);
  assert.equal((await rows(NEW, `select 1 from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org])).length, 0);
  await fails(rpc(EMP, 'discard_workspace_draft', org), '42501');
});

test('publishing cannot strand leads: a stage in use cannot be removed until its leads are moved', async () => {
  const org = await create(NEW, 'Guard Co'); // pipeline New -> Won
  const l = await lead(NEW, org, 'Sits in New');
  await rpc(NEW, 'save_workspace_draft', org, JSON.stringify(def({ pipeline: { stages: ['Lead', 'Won'] } })));
  await fails(rpc(NEW, 'publish_workspace_config', org), '22023', /1 lead\(s\) are still in the stage "New"/);
  assert.deepEqual((await latest(org)).definition.pipeline.stages, ['New', 'Won'], 'nothing changed');
  await rpc(NEW, 'crm_set_stage', org, l, 'Won');
  await rpc(NEW, 'save_workspace_draft', org, JSON.stringify(def({ pipeline: { stages: ['Lead', 'Won'] } })));
  await rpc(NEW, 'publish_workspace_config', org);
  assert.deepEqual((await latest(org)).definition.pipeline.stages, ['Lead', 'Won']);
});

test('tenant isolation holds for the builder lifecycle and for universal workspaces', async () => {
  const a = await create(NEW, 'Iso A'); const b = await create(OTHER, 'Iso B');
  await rpc(NEW, 'save_workspace_draft', a, JSON.stringify(def({ pipeline: { stages: ['Secret1', 'Secret2'] } })));
  await fails(rpc(OTHER, 'save_workspace_draft', a, JSON.stringify(def())), '42501');
  await fails(rpc(OTHER, 'publish_workspace_config', a), '42501');
  await fails(rpc(OTHER, 'discard_workspace_draft', a), '42501');
  assert.equal((await rows(OTHER, 'select 1 from public.workspace_configuration_versions where organization_id=$1', [a])).length, 0);
  assert.equal((await rows(OTHER, 'select 1 from public.organizations where id=$1', [a])).length, 0);
  // B's own lifecycle is unaffected by A's draft, and anon can do nothing
  await rpc(OTHER, 'save_workspace_draft', b, JSON.stringify(def()));
  await fails(as(null, 'select public.save_workspace_draft($1,$2::jsonb)', [b, JSON.stringify(def())]), '42501');
  await fails(as(null, 'select public.publish_workspace_config($1)', [b]), '42501');
  await fails(as(null, 'select public.validate_workspace_definition($1::jsonb)', [JSON.stringify(def())]), '42501');
  await fails(as(OTHER, 'select public.validate_workspace_definition($1::jsonb)', [JSON.stringify(def())]), '42501');
  // legacy org of another user is also untouched by all of this
  assert.deepEqual((await latest(legacyB)).definition.industryTemplate, 'salon');
  assert.equal((await rows(LEG2, 'select name from public.organizations where id=$1', [legacyB]))[0].name, 'Legacy Salon');
});

test('the TypeScript validator (used by the Builder UI) and the SQL validator (the real gate) agree on a corpus', async () => {
  const f = (key, kind = 'text', extra = {}) => ({ key, label: key, kind, ...extra });
  const corpus = [
    def(), def({ objects: [{ key: 'o', label: 'O', fields: [f('a'), f('b_2', 'choice', { options: ['x'] }), f('c', 'yes_no'), f('d', 'date'), f('e', 'number')] }] }),
    def({ modules: [...CORE, { key: 'a-b-1', label: 'AB', status: 'planned' }] }), def({ modules: [CORE[0]] }), def({ modules: [...CORE, { key: 'leads', label: 'd', status: 'planned' }] }),
    def({ modules: [...CORE, { key: 'UP', label: 'd', status: 'planned' }] }), def({ modules: [...CORE, { key: 'x', label: 'd', status: 'on' }] }), def({ modules: [CORE[0], { ...CORE[1], status: 'planned' }] }),
    def({ pipeline: { stages: ['A'] } }), def({ pipeline: { stages: ['A', 'A'] } }), def({ pipeline: { stages: ['A', 'B', 'C'] } }), def({ pipeline: { stages: ['A', ''] } }), def({ pipeline: { stages: ['A', 5] } }),
    def({ pipeline: { stages: Array.from({ length: 20 }, (_, i) => `S${i}`) } }), def({ pipeline: { stages: Array.from({ length: 21 }, (_, i) => `S${i}`) } }),
    def({ objects: [{ key: 'o', label: 'O', fields: [f('A')] }] }), def({ objects: [{ key: 'o', label: 'O', fields: [f('1a')] }] }), def({ objects: [{ key: 'o', label: 'O', fields: [f('a', 'blob')] }] }),
    def({ objects: [{ key: 'o', label: 'O', fields: [f('a', 'choice')] }] }), def({ objects: [{ key: 'o', label: 'O', fields: [f('a', 'choice', { options: [] })] }] }),
    def({ objects: [{ key: 'o', label: 'O', fields: [f('a'), f('a')] }] }), def({ objects: [{ key: 'o', label: 'O', fields: [] }, { key: 'o', label: 'P', fields: [] }] }),
    def({ objects: [{ key: 'o', label: 'x'.repeat(61), fields: [] }] }), def({ objects: [{ key: 'o', label: 'O', fields: Array.from({ length: 31 }, (_, i) => f(`f${i}`)) }] }),
    def({ objects: 'x' }), def({ modules: null }), { ...def(), schemaVersion: 2 },
  ];
  for (const d of corpus) {
    const ts = validateConfig(d).ok;
    const sql = await as(OTHER, 'select 1').then(() => db.query('select public.validate_workspace_definition($1::jsonb)', [JSON.stringify(d)])).then(() => true, () => false);
    assert.equal(ts, sql, `TS=${ts} SQL=${sql} for ${JSON.stringify(d).slice(0, 160)}`);
  }
});
