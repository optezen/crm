// Form Builder and Pipeline Builder models (pure): serialization to the same WorkspaceConfig the Builder and AI use, key stability, migration plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import { insertField, lockedKeys, moveField, newField, removeField, renameSection, sectionRuns, updateField } from '../src/lib/builder/forms.ts';
import { addRow, modelFromPipeline, moveRow, patchRow, pipelineFromModel, removeRow, setTarget, unplanned } from '../src/lib/builder/pipeline.ts';
import { validateConfig, diffConfig } from '../src/lib/workspace/schema.ts';

const F = (key, extra = {}) => ({ key, label: key.toUpperCase(), kind: 'text', ...extra });
test('sections are runs of neighbouring fields, identical in the builder and in Work Mode', () => {
  const f = [F('a', { section: 'Identity' }), F('b', { section: 'Identity' }), F('c'), F('d', { section: 'Sale' }), F('e', { section: 'Identity' })];
  assert.deepEqual(sectionRuns(f).map(r => [r.section, r.fields.map(x => x.key)]), [['Identity', ['a', 'b']], ['', ['c']], ['Sale', ['d']], ['Identity', ['e']]]);
});
test('new fields get permanent, never-reused keys; moving, renaming sections and editing never change keys', () => {
  let f = [F('registration'), F('status', { kind: 'choice', options: ['A'] }, ), F('notes', { archived: true })];
  const n1 = newField(f, 'text', 'Notes'); assert.notEqual(n1.key, 'notes', 'a hidden field still reserves its key'); assert.match(n1.key, /^notes/);
  const c = newField(f, 'choice', 'Colour'); assert.deepEqual(c.options, ['Option 1']); assert.equal(newField(f, 'currency', 'Price').currency, 'INR');
  f = insertField(f, n1, 1); assert.deepEqual(f.map(x => x.key), ['registration', n1.key, 'status', 'notes']);
  const before = f.map(x => x.key).sort();
  f = moveField(f, 0, 2); f = renameSection(updateField(f, 'status', { section: 'Sale', label: 'Sale status', description: 'Pick one' }), 'Sale', 'Sales'); f = updateField(f, 'status', { required: true });
  assert.deepEqual(f.map(x => x.key).sort(), before, 'keys are the same set');
  assert.deepEqual(f.find(x => x.key === 'status'), { key: 'status', label: 'Sale status', kind: 'choice', options: ['A'], section: 'Sales', description: 'Pick one', required: true });
  f = updateField(f, 'status', { section: '', description: '', required: false }); assert.deepEqual(Object.keys(f.find(x => x.key === 'status')).sort(), ['key', 'kind', 'label', 'options']);
  assert.equal(insertField(Array.from({ length: 30 }, (_, i) => F(`f${i}`)), F('x')).length, 30, 'max 30 fields');
  assert.deepEqual([...lockedKeys([F('a'), F('b')])], ['a', 'b']); assert.deepEqual(removeField(f, 'status').map(x => x.key).includes('status'), false);
});
test('dragging a field across sections adopts the destination section', () => {
  const f = [F('a', { section: 'One' }), F('b', { section: 'One' }), F('c', { section: 'Two' }), F('d')];
  assert.equal(moveField(f, 0, 2).find(x => x.key === 'a').section, 'Two'); assert.equal(moveField(f, 3, 0).find(x => x.key === 'd').section, 'One');
  assert.equal(moveField(f, 1, 1), f); assert.equal(moveField(f, 0, 9), f);
});
test('forms round-trip through the same validator as the Builder and keep what records need', () => {
  const base = { schemaVersion: 1, businessName: 'X', modules: [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }, { key: 'vehicles', label: 'Vehicles', status: 'active' }], pipeline: { stages: ['New', 'Won'] },
    objects: [{ key: 'vehicles', label: 'Vehicles', fields: [F('registration', { required: true }), F('status', { kind: 'choice', options: ['Available', 'Sold'] })] }] };
  const rearranged = { ...base, objects: [{ ...base.objects[0], fields: [updateField([base.objects[0].fields[1]], 'status', { section: 'Sale', label: 'Sale status' })[0], updateField([base.objects[0].fields[0]], 'registration', { description: 'Plate' })[0]] }] };
  const v = validateConfig(rearranged); assert.ok(v.ok, JSON.stringify(v));
  const d = diffConfig(validateConfig(base).value, v.value); assert.ok(d.some(x => /reorder fields/.test(x)) && d.some(x => /section/.test(x)) && d.some(x => /help text/.test(x)) && d.some(x => /rename field/.test(x)));
  assert.equal(validateConfig({ ...base, objects: [{ ...base.objects[0], fields: [F('registration', { description: 'x'.repeat(201) })] }] }).ok, false);
});

const LIVE = { stages: ['New', 'Qualified', 'Won'] };
test('pipeline: untouched model serializes to exactly the live pipeline (no accidental moves)', () => {
  const m = modelFromPipeline(LIVE, LIVE); assert.deepEqual(pipelineFromModel(m), LIVE); assert.deepEqual(m.removed, []);
});
test('pipeline: rename, reorder, colors and requirements serialize to a migration plan and survive a reload', () => {
  let m = modelFromPipeline(LIVE, LIVE);
  m = patchRow(m, 's2', { name: 'Vetted', color: 'blue', requires_assignee: true }); m = patchRow(m, 's3', { color: 'green', requires_summary: true }); m = { ...m, rows: moveRow(m.rows, 2, 1) };
  const p = pipelineFromModel(m); assert.deepEqual(p, { stages: ['New', 'Won', 'Vetted'], stageSettings: { Vetted: { color: 'blue', requires_assignee: true }, Won: { color: 'green', requires_summary: true } }, stageMoves: [{ from: 'Qualified', to: 'Vetted' }] });
  assert.ok(validateConfig({ schemaVersion: 1, businessName: 'X', modules: [{ key: 'overview', label: 'O', status: 'active' }, { key: 'leads', label: 'L', status: 'active' }], objects: [], pipeline: p }).ok);
  const back = modelFromPipeline(p, LIVE); assert.deepEqual(pipelineFromModel(back), p, 'reopening the saved draft reproduces the same plan');
  assert.equal(back.rows.find(r => r.name === 'Vetted').liveName, 'Qualified');
});
test('pipeline: removing a stage with leads needs a target; merge plans serialize; new stages just disappear', () => {
  let m = modelFromPipeline(LIVE, LIVE); const q = m.rows[1];
  m = removeRow(m, q.key); const counts = { Qualified: 4, New: 0, Won: 1 };
  assert.deepEqual(m.removed, [{ liveName: 'Qualified', targetKey: null }]); assert.match(unplanned(m, counts)[0], /4 lead\(s\) are in "Qualified"/);
  m = setTarget(m, 'Qualified', m.rows[0].key); assert.deepEqual(unplanned(m, counts), []); assert.deepEqual(pipelineFromModel(m), { stages: ['New', 'Won'], stageMoves: [{ from: 'Qualified', to: 'New' }] });
  assert.deepEqual(modelFromPipeline(pipelineFromModel(m), LIVE).removed, [{ liveName: 'Qualified', targetKey: modelFromPipeline(pipelineFromModel(m), LIVE).rows[0].key }], 'merge plan reloads');
  // removing the chosen target re-opens the question
  const L4 = { stages: ['New', 'Qualified', 'Quoted', 'Won'] }; let m4 = removeRow(modelFromPipeline(L4, L4), 's2'); m4 = setTarget(m4, 'Qualified', 's3');
  const after = removeRow(m4, 's3'); assert.equal(after.removed.find(r => r.liveName === 'Qualified').targetKey, null); assert.ok(unplanned(after, { Qualified: 2 }).length === 1);
  // a stage with no leads can go without a plan; a brand-new stage leaves no trace
  let e = removeRow(modelFromPipeline(LIVE, LIVE), 's1'); assert.deepEqual(unplanned(e, { New: 0 }), []); assert.deepEqual(pipelineFromModel(e), { stages: ['Qualified', 'Won'] });
  let a = addRow(modelFromPipeline(LIVE, LIVE), 'Fresh'); assert.equal(a.rows.at(-1).liveName, null); a = removeRow(a, a.rows.at(-1).key); assert.deepEqual(pipelineFromModel(a), LIVE);
  // re-adding a removed stage's name cancels the removal
  const re = addRow(removeRow(modelFromPipeline(LIVE, LIVE), 's2'), 'Qualified'); assert.deepEqual(re.removed, []); assert.equal(re.rows.at(-1).liveName, 'Qualified');
  assert.equal(removeRow(removeRow(modelFromPipeline({ stages: ['A', 'B'] }, { stages: ['A', 'B'] }), 's1'), 's2').rows.length, 2, 'removeRow refuses to go below 2 stages'); 
});
