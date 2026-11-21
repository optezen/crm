// Logic behind the operational screens: reminder form parsing and WhatsApp consent writes. No database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReminderForm } from '../src/lib/operations/reminder-form.ts';
import { setConsent } from '../src/lib/crm/consent.ts';

const form = o => ({ getAll: k => [].concat(o[k] ?? []), get: k => (Array.isArray(o[k]) ? o[k][0] : o[k]) ?? null });
const bad = (o, re) => { const r = parseReminderForm(form(o)); assert.equal(r.ok, false); assert.match(r.error, re); };

test('reminder form: offsets are de-duplicated, sorted and bounded; customer reminders need a template; quiet hours come as a pair of valid times', () => {
  const r = parseReminderForm(form({ enabled: 'on', staff: 'on', offset: ['60', '1440', '60', '999', 'x'], customOffset: '45' })); assert.deepEqual(r.value.p_offsets, [1440, 60, 45], 'unknown choices are ignored, duplicates removed, largest first'); assert.deepEqual([r.value.p_enabled, r.value.p_staff, r.value.p_customer], [true, true, false]);
  assert.deepEqual(parseReminderForm(form({ offset: ['60', '60'], customOffset: '60' })).value.p_offsets, [60], 'the custom value equal to a preset is one reminder');
  assert.deepEqual(parseReminderForm(form({})).value, { p_enabled: false, p_offsets: [1440, 60], p_staff: false, p_customer: false, p_template: null, p_language: null, p_quiet_from: null, p_quiet_to: null }, 'turned off with nothing chosen keeps the defaults');
  bad({ enabled: 'on' }, /at least one/); bad({ offset: ['60', '120', '240', '1440'], customOffset: '45' }, /at most 4/); for (const c of ['4', '10081', '12.5', '-5', 'abc']) bad({ customOffset: c }, /whole number of minutes/);
  bad({ customer: 'on', offset: '60' }, /name and language/); bad({ customer: 'on', template: 't', language: '', offset: '60' }, /name and language/); bad({ language: 'english' }, /language code/); assert.equal(parseReminderForm(form({ language: 'en_GB', template: ' t ', customer: 'on', offset: '60' })).value.p_template, 't');
  bad({ quietFrom: '21:00' }, /both quiet-hours/); bad({ quietFrom: '25:00', quietTo: '08:00' }, /like 21:00/); assert.deepEqual([parseReminderForm(form({ quietFrom: '21:00', quietTo: '08:00' })).value.p_quiet_from, parseReminderForm(form({ quietFrom: '21:00', quietTo: '08:00' })).value.p_quiet_to], ['21:00', '08:00'], 'wrapping windows are allowed');
});

test('consent writes: always source "staff", opt-in needs a confirmation and a reason, bad input never reaches the database, database messages are shown only when deliberate', async () => {
  const calls = []; const ctx = res => ({ organizationId: 'org-1', db: { rpc: async (fn, args) => { calls.push([fn, args]); return res ?? { error: null }; } } }); const C = '11111111-1111-4111-8111-111111111111';
  assert.equal((await setConsent(ctx(), C, 'opted_in', 'Asked on the phone', true)).ok, true); assert.deepEqual(calls[0], ['consent_set', { p_org: 'org-1', p_contact: C, p_status: 'opted_in', p_source: 'staff', p_note: 'Asked on the phone' }]);
  assert.equal((await setConsent(ctx(), C, 'opted_out', '', false)).ok, true); assert.equal(calls[1][1].p_note, null); assert.equal(calls[1][1].p_source, 'staff');
  const n = calls.length; for (const [c, s, note, ok] of [['nope', 'opted_in', 'x y z', true], [C, 'maybe', 'x y z', true], [C, 'opted_in', 'x y z', false], [C, 'opted_in', 'ab', true], [C, 'opted_in', 'x'.repeat(301), true], [C, undefined, '', true]]) assert.equal((await setConsent(ctx(), c, s, note, ok)).ok, false);
  assert.equal(calls.length, n, 'invalid requests are refused before any database call');
  assert.equal((await setConsent(ctx({ error: { code: 'P0002', message: 'Contact not found.' } }), C, 'opted_out', '', false)).error, 'Contact not found.'); assert.equal((await setConsent(ctx({ error: { code: '42501', message: 'secret internals' } }), C, 'opted_out', '', false)).error, 'You do not have permission to do that.'); assert.equal((await setConsent(ctx({ error: { code: 'XX000', message: 'relation x does not exist' } }), C, 'opted_out', '', false)).error, 'Something went wrong. Please try again.');
});
