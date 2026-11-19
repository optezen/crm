import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLead, validateNewLead, validateNote, validateTask, validateOutcome, parseListParams } from '../src/lib/crm/validate.ts';

const stages = ['New enquiry', 'Contacted', 'Won / Lost'];
const U = '11111111-1111-4111-8111-111111111111';

test('lead input is trimmed and normalized; blanks become null', () => {
  const r = validateLead({ fullName: '  Priya   Nair ', phone: '+91 (98765) 43-210', email: ' P@Ex.COM ', source: 'website', summary: '  hi ' });
  assert.deepEqual(r, { ok: true, value: { fullName: 'Priya Nair', phone: '+919876543210', email: 'p@ex.com', source: 'website', summary: 'hi' } });
  assert.deepEqual(validateLead({ fullName: 'A', phone: '', email: '  ', summary: '' }).value, { fullName: 'A', phone: null, email: null, source: 'other', summary: null });
});

test('lead input rejects bad values', () => {
  for (const bad of [{ fullName: '' }, { fullName: 'x'.repeat(121) }, { fullName: 'A', phone: '12' }, { fullName: 'A', phone: 'call me' }, { fullName: 'A', email: 'nope' }, { fullName: 'A', source: 'pigeon' }, { fullName: 'A', summary: 'x'.repeat(2001) }, {}, { fullName: 42 }])
    assert.equal(validateLead(bad).ok, false, JSON.stringify(bad));
});

test('new lead: stage must be in the configured pipeline, assignee must be a uuid', () => {
  assert.equal(validateNewLead({ fullName: 'A', stage: 'Contacted' }, stages).ok, true);
  assert.equal(validateNewLead({ fullName: 'A', stage: 'Hacked' }, stages).ok, false);
  assert.equal(validateNewLead({ fullName: 'A', assignedTo: 'me' }, stages).ok, false);
  assert.equal(validateNewLead({ fullName: 'A', assignedTo: U }, stages).value.assignedTo, U);
  assert.equal(validateNewLead({ fullName: 'A' }, stages).value.stage, null); // database defaults to the first stage
});

test('notes, tasks and outcomes', () => {
  assert.equal(validateNote('  hi ').value, 'hi'); assert.equal(validateNote('  ').ok, false); assert.equal(validateNote('x'.repeat(4001)).ok, false);
  assert.equal(validateOutcome(' done ').value, 'done'); assert.equal(validateOutcome('').ok, false);
  assert.deepEqual(validateTask({ leadId: U, title: ' Call  back ', ownerId: '', dueDate: '2030-01-02' }).value, { leadId: U, title: 'Call back', ownerId: null, dueDate: '2030-01-02' });
  for (const bad of [{ leadId: U, title: '', dueDate: '2030-01-02' }, { leadId: 'x', title: 't', dueDate: '2030-01-02' }, { leadId: U, title: 't', dueDate: '02/01/2030' }, { leadId: U, title: 't', dueDate: '2030-13-45' }, { leadId: U, title: 't', ownerId: 'me', dueDate: '2030-01-02' }])
    assert.equal(validateTask(bad).ok, false, JSON.stringify(bad));
});

test('list params: junk falls back to defaults; search text cannot inject filter syntax', () => {
  assert.deepEqual(parseListParams({}, stages), { page: 1, q: '', stage: null, source: null, assignee: null });
  const p = parseListParams({ page: '-3', stage: 'Nope', source: 'x', assignee: 'someone', q: 'a%,full_name.eq.x)(\\*"' }, stages);
  assert.deepEqual([p.page, p.stage, p.source, p.assignee], [1, null, null, null]);
  assert.doesNotMatch(p.q, /[%,()"\\*]/);
  assert.equal(parseListParams({ page: '3', stage: 'Contacted', source: 'phone', assignee: 'me' }, stages).page, 3);
  assert.equal(parseListParams({ assignee: U }, stages).assignee, U);
  assert.equal(parseListParams({ q: 'x'.repeat(500) }, stages).q.length, 80);
});
