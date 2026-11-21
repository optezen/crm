import test from 'node:test';
import assert from 'node:assert/strict';
import { activeFields, findModule, formatValue, parseRecordForm, parseRecordListParams, validateRecord } from '../src/lib/records/validate.ts';
import { canEditRecord, createRecord, getRecord, listRecords, updateRecord } from '../src/lib/records/service.ts';
import { blankConfig, diffConfig, fieldSlug, slug, validateConfig } from '../src/lib/workspace/schema.ts';

const F = (label, kind = 'text', extra = {}) => ({ key: fieldSlug(label), label, kind, ...extra });
const withModule = (label, fields, status = 'active') => { const c = blankConfig('Acme'); const key = slug(label); return { ...c, modules: [...c.modules, { key, label, status }], objects: [{ key, label, fields }] }; };
const vehicles = withModule('Vehicles', [F('Registration Number', 'text', { required: true }), F('Status', 'choice', { options: ['Available', 'Sold'] }), F('Insured', 'yes_no'), F('Price', 'currency', { currency: 'INR' }), F('Old', 'text', { archived: true })]);
const obj = vehicles.objects[0];
const UUID = '11111111-1111-4111-8111-111111111111';

test('validateRecord normalizes every field kind and enforces required/unknown/hidden', () => {
  const ok = validateRecord(obj, { registration_number: ' MH12 ', status: 'Sold', insured: false, price: 100.5 });
  assert.deepEqual(ok, { ok: true, value: { registration_number: 'MH12', status: 'Sold', insured: false, price: 100.5 } });
  assert.match(validateRecord(obj, {}).error, /Registration Number" is required/);
  assert.match(validateRecord(obj, { registration_number: 'x', status: 'Stolen' }).error, /listed options/);
  assert.match(validateRecord(obj, { registration_number: 'x', price: 1.234 }).error, /2 decimal/);
  assert.match(validateRecord(obj, { registration_number: 'x', nope: 1 }).error, /Unknown field/);
  assert.match(validateRecord(obj, { registration_number: 'x', old: 'y' }).error, /hidden/);
  assert.deepEqual(validateRecord(obj, { status: null }, { registration_number: 'keep', status: 'Sold' }).value, { registration_number: 'keep' }, 'empty clears, merge keeps the rest');
  assert.equal(validateRecord(obj, { status: 'Stolen' }, { registration_number: 'k', status: 'Stolen' }).ok, true, 'a value already stored stays valid');
  const kinds = [F('D', 'date'), F('P', 'phone'), F('E', 'email'), F('N', 'number')];
  const k = { key: 'k', label: 'K', fields: kinds };
  assert.deepEqual(validateRecord(k, { d: '2024-02-29', p: '+91 98765 43210', e: ' A@B.Co ', n: 3 }).value, { d: '2024-02-29', p: '+919876543210', e: 'a@b.co', n: 3 });
  for (const bad of [{ d: '2023-02-29' }, { d: 'tomorrow' }, { p: '12' }, { e: 'x@y' }, { n: '3' }, { n: Infinity }]) assert.equal(validateRecord(k, bad).ok, false, JSON.stringify(bad));
});

test('parseRecordForm converts submitted strings into typed input; checkboxes and blanks behave', () => {
  const get = d => n => d[n];
  const r = parseRecordForm(obj, get({ f_registration_number: 'A1', f_status: '', f_insured: 'on', f_price: '1,250.50', f_old: 'ignored' }));
  assert.deepEqual(r.value, { registration_number: 'A1', status: '', insured: true, price: 1250.5 }, 'hidden fields are never read from the form');
  assert.equal(parseRecordForm(obj, get({ f_registration_number: 'A1' })).value.insured, false);
  assert.equal(parseRecordForm(obj, get({ f_price: 'abc' })).ok, false);
  assert.equal(parseRecordForm(obj, get({ f_price: '' })).value.price, null);
});

test('list params: only dropdown/checkbox filters, junk falls back, search text is sanitized', () => {
  assert.deepEqual(parseRecordListParams({}, obj), { page: 1, q: '', filters: {} });
  const p = parseRecordListParams({ page: '0', q: 'a%,b)(', f_status: 'Sold', f_insured: 'yes', f_price: '5', f_old: 'x', f_registration_number: 'x', f_status2: 'z' }, obj);
  assert.deepEqual([p.page, p.filters], [1, { status: 'Sold', insured: 'yes' }]); assert.doesNotMatch(p.q, /[%,()]/);
  assert.deepEqual(parseRecordListParams({ f_status: 'Bogus', f_insured: 'maybe', page: '4' }, obj), { page: 4, q: '', filters: {} });
});

test('findModule: only active, non-core modules with a record type resolve', () => {
  assert.equal(findModule(vehicles, 'vehicles').object.key, 'vehicles');
  assert.equal(findModule(vehicles, 'leads'), null); assert.equal(findModule(vehicles, 'overview'), null); assert.equal(findModule(vehicles, 'nope'), null);
  assert.equal(findModule(withModule('Planned', [F('X')], 'planned'), 'planned'), null);
  assert.equal(findModule(withModule('Hidden', [F('X')], 'archived'), 'hidden'), null);
  assert.deepEqual(activeFields(obj).map(f => f.key), ['registration_number', 'status', 'insured', 'price']);
});

test('arbitrary module and field names produce valid, collision-free keys and configurations', () => {
  for (const name of ['Vehicles', 'Müller & Söhne', '🚗 Fleet', 'Q3 — Goals (2026)', '日本語モジュール', '!!!', 'a'.repeat(60)]) {
    const label = name.trim();
    const key = slug(label) || 'item';
    const cfg = withModule(label, [F(label, 'text')]);
    cfg.modules[2].key = cfg.objects[0].key = key; // the Builder falls back to uniqueKey('item') for names with no usable characters
    assert.equal(validateConfig(cfg).ok, true, name);
    assert.match(key, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  }
});

test('formatValue shows checkbox, currency and date readably', () => {
  assert.equal(formatValue(F('A', 'yes_no'), true), 'Yes'); assert.equal(formatValue(F('A', 'yes_no'), false), 'No');
  assert.match(formatValue(F('P', 'currency', { currency: 'INR' }), 1250.5), /1,250\.50/); assert.match(formatValue(F('P', 'currency', { currency: 'ZZZ' }), 5), /5/);
  assert.equal(formatValue(F('D', 'date'), '2026-02-28'), '28 Feb 2026'); assert.equal(formatValue(F('T'), undefined), '');
});

test('config diff describes field-level changes safely (rename, hide, required, options)', () => {
  const b = structuredClone(vehicles); const f = b.objects[0].fields;
  f[0].label = 'Plate'; f[1].archived = true; f[1].required = true; f[1].options.push('Reserved'); f.push(F('Color'));
  const d = diffConfig(vehicles, b).join('\n');
  for (const re of [/rename field "Registration Number" to "Plate"/, /hide field "Status"/, /now required/, /change dropdown options/, /add field "Color"/]) assert.match(d, re);
});

// ---- service layer against a recording fake of the Supabase client ----
function fakeDb(result = { data: [], count: 0, error: null }) {
  const calls = [];
  const chain = new Proxy({}, { get: (_, m) => m === 'then' ? (res, rej) => Promise.resolve(result).then(res, rej) : (...a) => { calls.push([m, ...a]); return chain; } });
  return { calls, db: { from: t => { calls.push(['from', t]); return chain; }, rpc: (fn, args) => { calls.push(['rpc', fn, args]); return Promise.resolve(result); } } };
}
const ctx = (db, role = 'employee') => ({ db, organizationId: 'ORG-FROM-MEMBERSHIP', userId: 'U1', role, config: vehicles });

test('listRecords: always scoped to the membership organization + module; filters come from the configuration; search is parameterized', async () => {
  const { db, calls } = fakeDb({ data: [], count: 60, error: null });
  const r = await listRecords(ctx(db), 'vehicles', { page: 3, q: 'mh12', filters: { status: 'Sold', insured: 'yes', evil: 'x', 'data->>x': 'y' } });
  assert.equal(r.ok, true); assert.equal(r.value.pageCount, 3);
  const has = (...a) => calls.some(c => a.every((x, i) => c[i] === x));
  assert.ok(has('from', 'records_view')); assert.ok(has('eq', 'organization_id', 'ORG-FROM-MEMBERSHIP')); assert.ok(has('eq', 'object_key', 'vehicles'));
  assert.ok(has('filter', 'data->>status', 'eq', 'Sold')); assert.ok(has('filter', 'data->>insured', 'eq', 'true'));
  assert.equal(calls.filter(c => c[0] === 'filter').length, 2, 'unknown filter keys are dropped, never forwarded');
  assert.ok(has('ilike', 'search_text', '%mh12%')); assert.ok(has('range', 50, 74));
  const bad = await listRecords(ctx(db), 'leads', { page: 1, q: '', filters: {} }); assert.equal(bad.ok, false);
  assert.equal((await listRecords(ctx(db), 'no-such-module', { page: 1, q: '', filters: {} })).ok, false);
});

test('createRecord/updateRecord: validate before calling the database, never send an organization from the request, map database errors', async () => {
  let f = fakeDb();
  assert.equal((await createRecord(ctx(f.db), 'vehicles', { status: 'Sold' })).ok, false);
  assert.equal(f.calls.length, 0, 'invalid input never reaches the database');
  f = fakeDb({ data: UUID, error: null });
  assert.deepEqual(await createRecord(ctx(f.db), 'vehicles', { registration_number: 'X1' }), { ok: true, value: { id: UUID } });
  assert.deepEqual(f.calls[0], ['rpc', 'record_create', { p_org: 'ORG-FROM-MEMBERSHIP', p_object: 'vehicles', p_data: { registration_number: 'X1' } }]);
  f = fakeDb({ data: null, error: { code: '42501', message: 'You can only edit records you created.' } });
  assert.deepEqual(await createRecord(ctx(f.db), 'vehicles', { registration_number: 'X1' }), { ok: false, error: 'You can only edit records you created.' });
  f = fakeDb({ data: null, error: { code: 'XX000', message: 'internal secret detail' } });
  assert.deepEqual(await createRecord(ctx(f.db), 'vehicles', { registration_number: 'X1' }), { ok: false, error: 'Something went wrong. Please try again.' });
  assert.equal((await getRecord(ctx(fakeDb().db), 'vehicles', 'not-a-uuid')).ok, false);
  assert.equal((await updateRecord(ctx(fakeDb().db), 'vehicles', 'not-a-uuid', {})).ok, false);
});

test('canEditRecord: creator or manager and above', () => {
  assert.equal(canEditRecord({ role: 'employee', userId: 'a' }, { createdBy: 'a' }), true);
  assert.equal(canEditRecord({ role: 'employee', userId: 'a' }, { createdBy: 'b' }), false);
  for (const role of ['manager', 'admin', 'owner']) assert.equal(canEditRecord({ role, userId: 'a' }, { createdBy: 'b' }), true);
});
