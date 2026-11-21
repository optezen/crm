// Business Operations tests (Appointments, Inventory, Billing): real PostgreSQL (PGlite) with migrations 0001-0013. NOT Supabase: auth.uid() and default grants are a shim.
// PGlite has ONE connection, so truly parallel requests cannot be simulated here: concurrency safety rests on the exclusion constraint, row locks and triggers, which these tests
// exercise through their observable effects; tests/integration/operations.itest.mjs fires genuinely parallel calls against a live (local) Supabase project.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { validateConfig, diffConfig } from '../src/lib/workspace/schema.ts';
import { validateAutomation } from '../src/lib/automation/validate.ts';
import { TRIGGERS } from '../src/lib/automation/types.ts';
import { executeTool, toolsFor } from '../src/lib/ai/tools.ts';
import { applyOps } from '../src/lib/ai/config-ops.ts';
import { applyProposal } from '../src/lib/ai/proposals.ts';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [EMP, EMP2, MGR, ADM] = ['c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Won'] } };
const OPS = {
  appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: true, fields: [{ key: 'room', label: 'Room', kind: 'text' }] },
  inventory: { enabled: true, allow_negative_stock: false, track_batches: true, track_expiry: true, block_expired: true },
  billing: { enabled: true, currency: 'INR', invoice_prefix: 'INV', credit_note_prefix: 'CN', default_due_days: 14, taxes: [{ key: 'gst18', name: 'GST 18%', rate: '18' }, { key: 'gst5', name: 'GST 5%', rate: '5' }] },
};
const withOps = ops => ({ ...BASE, operations: ops });

async function as(user, sql, params = []) {
  await db.exec(`set role ${user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub', '${user ?? ''}', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role'); }
}
const q = async (sql, p) => (await db.query(sql, p)).rows;
const rows = (u, sql, p) => as(u, sql, p).then(r => r.rows);
const isJson = v => v !== null && typeof v === 'object';
const mkRpc = user => async (fn, args = {}) => {
  const keys = Object.keys(args);
  try { const r = await as(user, `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, keys.map(k => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k]))); return { data: r.rows[0].r, error: null }; }
  catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
};
const call = (u, fn, args) => mkRpc(u)(fn, args);
const ok = async p => { const r = await p; assert.ifError(r.error); return r.data; };
const bad = async (p, code, re) => { const r = await p; assert.ok(r.error, 'expected an error'); if (code) assert.equal(r.error.code, code, r.error.message); if (re) assert.match(r.error.message, re); return r.error; };
async function worker(sql, params = []) { await db.exec('set role service_role'); try { return await db.query(sql, params); } finally { await db.exec('reset role'); } }
const tick = () => worker('select public.automation_tick(500, 50) r').then(r => r.rows[0].r);
const drain = async () => { for (let i = 0; i < 6; i++) { const r = await tick(); if (!r.dispatched && !Object.keys(r.runs).length) return; } };
const events = (org, name) => q(`select event_name, aggregate_type, aggregate_id, actor_id, payload from public.domain_events where organization_id=$1 and event_name=$2 order by created_at, id`, [org, name]);

let seq = 50;
async function fresh(ops = OPS) {
  const owner = id(String(seq++)); await db.exec(`insert into auth.users values ('${owner}','o${seq}@x.test') on conflict do nothing`);
  const org = await ok(call(owner, 'create_workspace', { p_name: `Ops ${seq}`, p_description: null, p_preset: null, p_definition: BASE })).then(String);
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await ok(call(owner, 'crm_add_member', { p_org: org, p_email: e, p_role: r }));
  if (ops) { await ok(call(owner, 'save_workspace_draft', { p_org: org, p_definition: withOps(ops) })); await ok(call(owner, 'publish_workspace_config', { p_org: org })); }
  return { org, owner };
}
const setOps = async (o, ops) => { await ok(call(o.owner, 'save_workspace_draft', { p_org: o.org, p_definition: withOps(ops) })); return ok(call(o.owner, 'publish_workspace_config', { p_org: o.org })); };
// next given weekday (0 = Sunday) at least 3 days ahead, as a local date string
const futureDate = (dow, plus = 0) => { const d = new Date(Date.now() + 3 * 864e5); while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1); d.setUTCDate(d.getUTCDate() + plus); return d.toISOString().slice(0, 10); };
const ist = (date, hhmm) => `${date}T${hhmm}:00+05:30`;
const HOURS = [1, 2, 3, 4, 5].map(w => ({ weekday: w, start: '09:00', end: '17:00' }));

before(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    insert into auth.users values ('${EMP}','emp@x.test'),('${EMP2}','emp2@x.test'),('${MGR}','mgr@x.test'),('${ADM}','adm@x.test');`);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
});

// ============================================================ configuration (Builder integration)
test('Builder integration: operations settings are validated (SQL and TypeScript agree), versioned, and disabling keeps data and refuses writes', async () => {
  const cases = [OPS, {}, { appointments: { enabled: false } }, { appointments: { enabled: true, timezone: 'Mars/Base' } }, { appointments: { enabled: 'yes' } }, { gym: { enabled: true } }, { inventory: { enabled: true, track_expiry: true } },
    { inventory: { enabled: true, track_batches: true, track_expiry: true } }, { billing: { enabled: true, taxes: [{ key: 'a', name: 'A', rate: 18 }] } }, { billing: { enabled: true, taxes: [{ key: 'a', name: 'A', rate: '100.5' }] } },
    { billing: { enabled: true, taxes: [{ key: 'a', name: 'A', rate: '5' }, { key: 'a', name: 'B', rate: '6' }] } }, { billing: { enabled: true, invoice_prefix: 'inv' } }, { billing: { enabled: true, default_due_days: 400 } },
    { billing: { enabled: true, taxes: Array.from({ length: 11 }, (_, i) => ({ key: `t${i}`, name: 'T', rate: '1' })) } }, { appointments: { enabled: true, fields: [{ key: 'x', label: 'X', kind: 'hologram' }] } },
    { appointments: { enabled: true, fields: [{ key: 'c', label: 'C', kind: 'choice' }] } }, { appointments: { enabled: true, extra: 1 } }, { billing: { enabled: true, taxes: [{ key: 'gst', name: 'GST', rate: '12.345' }] } }, 'nope'];
  let valid = 0;
  for (const [i, ops] of cases.entries()) {
    const sqlOk = await db.query('select public.validate_workspace_definition($1::jsonb)', [JSON.stringify(withOps(ops))]).then(() => true, e => { assert.equal(e.code, '22023', `case ${i}: ${e.message}`); return false; });
    assert.equal(validateConfig(withOps(ops)).ok, sqlOk, `case ${i}: ${JSON.stringify(ops)}`); valid += sqlOk;
  }
  assert.ok(valid >= 5 && valid < cases.length - 8);
  assert.equal(validateConfig(BASE).ok, true); assert.equal('operations' in validateConfig(BASE).value, false, 'existing configurations are unchanged');
  assert.deepEqual(validateConfig(withOps(OPS)).value.operations.billing.taxes[0], { key: 'gst18', name: 'GST 18%', rate: '18' }, 'validated config keeps operations (it was silently dropped before)');

  const o = await fresh(null);
  assert.equal((await bad(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'Consult', p_duration: 30, p_active: true }), '22023', /not enabled/)).code, '22023');
  const rev1 = await setOps(o, { appointments: { enabled: true, timezone: 'Asia/Kolkata' } });
  const t = await ok(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'Consult', p_duration: 30, p_active: true })); assert.ok(t);
  const diff = diffConfig(validateConfig(BASE).value, validateConfig(withOps({ appointments: { enabled: true, timezone: 'Asia/Kolkata' }, billing: { enabled: true, taxes: [{ key: 'g', name: 'GST', rate: '18' }] } })).value);
  assert.ok(diff.includes('Enable the Appointments module') && diff.some(d => /add tax "GST" at 18%/.test(d)) && diff.some(d => /Enable the Billing module/.test(d)), diff.join('|'));
  // disabling: data stays and stays readable, writes are refused, re-enabling restores
  await setOps(o, { appointments: { enabled: false, timezone: 'Asia/Kolkata' } });
  assert.equal((await rows(EMP, 'select 1 from public.appointment_types where organization_id=$1', [o.org])).length, 1, 'data preserved and readable');
  await bad(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: t, p_name: 'Consult', p_duration: 45, p_active: true }), '22023', /not enabled/);
  await setOps(o, { appointments: { enabled: true, timezone: 'Asia/Kolkata' } }); await ok(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: t, p_name: 'Consult', p_duration: 45, p_active: true }));
  // rollback through the Builder's version history restores the earlier operations settings as a draft
  const restored = await ok(call(o.owner, 'restore_workspace_revision', { p_org: o.org, p_revision: rev1 })); assert.ok(restored);
  assert.equal((await q(`select definition #>> '{operations,appointments,enabled}' e from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [o.org]))[0].e, 'true');
  // only owners/admins change configuration
  for (const u of [EMP, MGR]) await bad(call(u, 'save_workspace_draft', { p_org: o.org, p_definition: withOps(OPS) }), '42501');
  // custom fields of an operations module cannot be removed or retyped once published, but can be hidden
  const o2 = await fresh(OPS);
  await bad(call(o2.owner, 'save_workspace_draft', { p_org: o2.org, p_definition: withOps({ ...OPS, appointments: { ...OPS.appointments, fields: [] } }) }).then(async () => call(o2.owner, 'publish_workspace_config', { p_org: o2.org })), '22023', /cannot be removed/);
  await ok(call(o2.owner, 'discard_workspace_draft', { p_org: o2.org }));
  await ok(call(o2.owner, 'save_workspace_draft', { p_org: o2.org, p_definition: withOps({ ...OPS, appointments: { ...OPS.appointments, fields: [{ key: 'room', label: 'Room', kind: 'number' }] } }) }));
  await bad(call(o2.owner, 'publish_workspace_config', { p_org: o2.org }), '22023', /cannot change/);
  await ok(call(o2.owner, 'save_workspace_draft', { p_org: o2.org, p_definition: withOps({ ...OPS, appointments: { ...OPS.appointments, fields: [{ key: 'room', label: 'Room', kind: 'text', archived: true }] } }) }));
  assert.ok(await ok(call(o2.owner, 'publish_workspace_config', { p_org: o2.org })));
});

// ============================================================ appointments
async function apptSetup(o, opts = {}) {
  const type = await ok(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'Consultation', p_duration: 30, p_active: true }));
  for (const u of [EMP, EMP2, MGR]) await ok(call(o.owner, 'staff_hours_set', { p_org: o.org, p_user: u, p_hours: opts.hours ?? HOURS }));
  return type;
}
const book = (u, o, type, staff, start, extra = {}) => call(u, 'appointment_create', { p_org: o.org, p_type: type, p_staff: staff, p_contact: extra.contact ?? null, p_lead: extra.lead ?? null, p_start: start, p_notes: extra.notes ?? null, p_custom: extra.custom ?? {} });

test('appointments: conflicts, working hours, time off, rescheduling, cancellation, events and permissions', async () => {
  const o = await fresh(); const type = await apptSetup(o); const mon = futureDate(1), tue = futureDate(1, 1);
  const lead = await ok(call(o.owner, 'crm_create_lead', { p_org: o.org, p_full_name: 'Asha Rao', p_phone: '9822200001', p_email: null, p_source: 'phone', p_summary: null, p_stage: null, p_assigned_to: null }));
  const a1 = await ok(book(EMP, o, type, EMP, ist(mon, '10:00'), { lead, notes: 'First visit, call 9822200001', custom: { room: 'R1' } }));
  const [row] = await q('select * from public.appointments where id=$1', [a1]);
  assert.deepEqual([row.status, row.staff_id, row.created_by, row.custom, row.contact_id !== null], ['scheduled', EMP, EMP, { room: 'R1' }, true]); assert.equal(new Date(row.ends_at) - new Date(row.starts_at), 30 * 60e3);
  const [ev] = await events(o.org, 'appointment.created'); assert.equal(ev.aggregate_id, a1); assert.equal(ev.payload.staff_id, EMP); assert.equal(ev.payload.lead_id, lead); assert.equal(ev.payload.type, 'Consultation');
  assert.equal((await q(`select count(*)::int n from public.appointment_log where appointment_id=$1 and action='created'`, [a1]))[0].n, 1);
  // conflicts: overlap (start inside, end inside, containing) refused; back-to-back and other staff are fine
  for (const t of ['10:00', '10:15', '09:45']) await bad(book(EMP2 === EMP ? MGR : EMP, o, type, EMP, ist(mon, t)), '23P01', /already has an appointment/);
  await ok(book(EMP, o, type, EMP, ist(mon, '10:30'))); await ok(book(EMP, o, type, EMP, ist(mon, '09:30'))); await ok(book(EMP, o, type, EMP2, ist(mon, '10:00')));
  // the DATABASE guarantees it even if the application layer were bypassed (this is what makes concurrent requests safe)
  await assert.rejects(db.query(`insert into public.appointments (organization_id, type_id, staff_id, starts_at, ends_at, created_by) values ($1,$2,$3,$4,$5,$3)`, [o.org, type, EMP, ist(mon, '10:10'), ist(mon, '10:20')]), e => e.code === '23P01');
  // working hours, time off, unknown people, invalid types, bad dates
  await bad(book(EMP, o, type, EMP, ist(mon, '08:45')), '22023', /working hours/); await bad(book(EMP, o, type, EMP, ist(mon, '16:45')), '22023', /working hours/); await bad(book(EMP, o, type, EMP, ist(futureDate(0), '10:00')), '22023', /working hours/);
  const off = await ok(call(o.owner, 'staff_time_off_add', { p_org: o.org, p_user: EMP2, p_start: ist(mon, '12:00'), p_end: ist(mon, '14:00'), p_reason: 'Dentist' })); assert.equal(off.existing_appointments_affected, 0);
  await bad(book(EMP, o, type, EMP2, ist(mon, '12:30')), '22023', /time off/); await ok(book(EMP, o, type, EMP2, ist(mon, '14:00')));
  await bad(book(EMP, o, type, id('99'), ist(mon, '11:00')), '22023', /belong to this organization/); await bad(book(EMP, o, id('99'), EMP, ist(mon, '11:00')), '22023', /active appointment type/);
  await bad(book(EMP, o, type, EMP, '2001-01-01T10:00:00+05:30'), '22023', /next two years/);
  // free slots: only free, in-hours, future slots for that local day
  const free = await as(EMP, 'select * from public.appointment_free_slots($1,$2,$3,$4)', [o.org, EMP, type, mon]);
  const taken = (await q(`select starts_at from public.appointments where staff_id=$1 and status in ('scheduled','confirmed') and starts_at >= $2 and starts_at < $3`, [EMP, ist(mon, '00:00'), ist(tue, '00:00')])).map(r => new Date(r.starts_at).toISOString());
  assert.equal(free.rows.length, 16 - taken.length); assert.ok(free.rows.every(r => !taken.includes(new Date(r.slot_start).toISOString()))); assert.ok(free.rows.every(r => new Date(r.slot_end) - new Date(r.slot_start) === 30 * 60e3));
  // reschedule: conflict refused and nothing changes; success re-checks hours, bumps the counter, emits the event with the previous time
  await bad(call(EMP, 'appointment_reschedule', { p_org: o.org, p_id: a1, p_start: ist(mon, '10:30'), p_staff: null }), '23P01');
  assert.equal(new Date((await q('select starts_at from public.appointments where id=$1', [a1]))[0].starts_at).getTime(), new Date(ist(mon, '10:00')).getTime());
  await bad(call(EMP, 'appointment_reschedule', { p_org: o.org, p_id: a1, p_start: ist(mon, '18:00'), p_staff: null }), '22023', /working hours/);
  await ok(call(EMP, 'appointment_reschedule', { p_org: o.org, p_id: a1, p_start: ist(mon, '15:00'), p_staff: null }));
  const after = (await q('select * from public.appointments where id=$1', [a1]))[0]; assert.deepEqual([after.reschedule_count, after.status], [1, 'scheduled']);
  const [rev] = await events(o.org, 'appointment.rescheduled'); assert.equal(new Date(rev.payload.previous_starts_at).getTime(), new Date(ist(mon, '10:00')).getTime()); assert.equal(new Date(rev.payload.starts_at).getTime(), new Date(ist(mon, '15:00')).getTime());
  await ok(call(EMP, 'appointment_reschedule', { p_org: o.org, p_id: a1, p_start: ist(mon, '15:00'), p_staff: null })); assert.equal((await events(o.org, 'appointment.rescheduled')).length, 1, 'no-op reschedule emits nothing');
  await ok(call(MGR, 'appointment_reschedule', { p_org: o.org, p_id: a1, p_start: ist(mon, '11:00'), p_staff: EMP2 })); assert.equal((await q('select staff_id from public.appointments where id=$1', [a1]))[0].staff_id, EMP2, 'a manager can reassign staff');
  // permissions: an employee who neither created nor is assigned cannot change it
  const others = await ok(book(MGR, o, type, MGR, ist(mon, '13:00')));
  for (const fn of [['appointment_reschedule', { p_start: ist(mon, '13:30'), p_staff: null }], ['appointment_cancel', { p_reason: 'x' }], ['appointment_confirm', {}], ['appointment_set_notes', { p_notes: 'x', p_custom: null }]])
    await bad(call(EMP, fn[0], { p_org: o.org, p_id: others, ...fn[1] }), '42501');
  // cancel frees the slot; terminal states cannot move again
  await ok(call(EMP, 'appointment_cancel', { p_org: o.org, p_id: a1, p_reason: 'Patient called' }));
  const [canc] = await events(o.org, 'appointment.cancelled'); assert.equal(canc.payload.reason, 'Patient called'); assert.equal(canc.payload.status, 'cancelled');
  await ok(book(EMP, o, type, EMP2, ist(mon, '11:00'))); await bad(call(EMP, 'appointment_cancel', { p_org: o.org, p_id: a1, p_reason: 'again' }), '22023'); await bad(call(EMP, 'appointment_reschedule', { p_org: o.org, p_id: a1, p_start: ist(mon, '16:00'), p_staff: null }), '22023', /scheduled or confirmed/);
  // log is append-only
  await assert.rejects(db.query(`update public.appointment_log set note='x'`), e => e.code === '42501'); await assert.rejects(db.query(`delete from public.appointment_log`), e => e.code === '42501');
  // custom fields are validated with the configured field types; unknown ones refused; module without fields refuses any
  await bad(book(EMP, o, type, EMP, ist(tue, '10:00'), { custom: { room: { nested: 1 } } }), '22023'); await bad(book(EMP, o, type, EMP, ist(tue, '10:00'), { custom: { unknown: 'x' } }), '22023');
  // master data permissions
  for (const u of [EMP]) { await bad(call(u, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'X', p_duration: 10, p_active: true }), '42501'); await bad(call(u, 'staff_hours_set', { p_org: o.org, p_user: u, p_hours: HOURS }), '42501'); await bad(call(u, 'staff_time_off_add', { p_org: o.org, p_user: u, p_start: ist(mon, '12:00'), p_end: ist(mon, '13:00'), p_reason: null }), '42501'); }
  await bad(call(o.owner, 'staff_hours_set', { p_org: o.org, p_user: EMP, p_hours: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }] }), '22023', /must not overlap/);
  await bad(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'consultation', p_duration: 10, p_active: true }), '23505'); await bad(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'Bad', p_duration: 1, p_active: true }), '22023');
});

test('appointments: completion rules, no-show, optional working-hour enforcement, tenant isolation and automation on appointment events', async () => {
  const o = await fresh({ ...OPS, appointments: { enabled: true, timezone: 'UTC', enforce_working_hours: false } }); const type = await ok(call(o.owner, 'appointment_type_save', { p_org: o.org, p_id: null, p_name: 'Visit', p_duration: 60, p_active: true }));
  const past = new Date(Date.now() - 3 * 36e5).toISOString(), future = new Date(Date.now() + 5 * 864e5).toISOString();
  const a = await ok(book(EMP, o, type, EMP, past)), f = await ok(book(EMP, o, type, EMP, future)), u = await ok(book(EMP, o, type, null, past)), u2 = await ok(book(EMP, o, type, null, past));
  await bad(call(EMP, 'appointment_finish', { p_org: o.org, p_id: f, p_outcome: 'completed', p_notes: null }), '22023', /not started/);
  await bad(call(EMP2, 'appointment_finish', { p_org: o.org, p_id: a, p_outcome: 'completed', p_notes: null }), '42501'); await bad(call(EMP, 'appointment_finish', { p_org: o.org, p_id: a, p_outcome: 'maybe', p_notes: null }), '22023');
  await ok(call(EMP, 'appointment_finish', { p_org: o.org, p_id: a, p_outcome: 'completed', p_notes: 'Done' }));
  const [done] = await q('select status, completed_at, notes from public.appointments where id=$1', [a]); assert.deepEqual([done.status, !!done.completed_at, done.notes], ['completed', true, 'Done']);
  assert.equal((await events(o.org, 'appointment.completed')).length, 1); await bad(call(EMP, 'appointment_finish', { p_org: o.org, p_id: a, p_outcome: 'completed', p_notes: null }), '22023');
  await ok(call(MGR, 'appointment_finish', { p_org: o.org, p_id: u, p_outcome: 'no_show', p_notes: null })); assert.equal((await events(o.org, 'appointment.completed')).length, 1, 'a no-show is not a completion');
  await ok(call(MGR, 'appointment_confirm', { p_org: o.org, p_id: u2 })); await bad(call(MGR, 'appointment_confirm', { p_org: o.org, p_id: u2 }), '22023');
  // unassigned appointments are never in conflict with each other; hours are not enforced here
  await ok(book(EMP, o, type, null, future)); await ok(book(EMP, o, type, null, future));
  // tenant isolation
  const B = await fresh(); const typeB = await apptSetup(B);
  assert.equal((await rows(B.owner, 'select 1 from public.appointments where organization_id=$1', [o.org])).length, 0);
  await bad(call(B.owner, 'appointment_cancel', { p_org: B.org, p_id: a, p_reason: 'x' }), 'P0002'); await bad(call(B.owner, 'appointment_cancel', { p_org: o.org, p_id: a, p_reason: 'x' }), '42501');
  await bad(book(B.owner, B, type, EMP, future), '22023', /active appointment type/); await bad(book(B.owner, o, typeB, EMP, future), '42501');
  const foreignContact = (await q(`insert into public.contacts (organization_id, full_name, phone) values ($1,'Other Org','9000000001') returning id`, [B.org]))[0].id;
  await bad(book(EMP, o, type, null, future, { contact: foreignContact }), 'P0002', /Contact not found/);
  await assert.rejects(db.query(`insert into public.appointments (organization_id, type_id, contact_id, starts_at, ends_at, created_by) values ($1,$2,$3,now(),now()+interval '1 hour',$4)`, [o.org, type, foreignContact, EMP]), e => e.code === '23503', 'composite foreign keys');
  await assert.rejects(db.query(`insert into public.appointments (organization_id, type_id, starts_at, ends_at, created_by) values ($1,$2,now(),now()+interval '1 hour',$3)`, [o.org, typeB, EMP]), e => e.code === '23503');
  // automation: appointment.created is a real trigger, publishable only while the module is enabled; conditions use the appointment context
  const wf = await ok(call(o.owner, 'automation_save_draft', { p_org: o.org, p_workflow: null, p_name: 'Notify on booking', p_definition: { trigger: { event: 'appointment.created' }, match: { conditions: [{ field: 'appointment.type', op: 'eq', value: 'Visit' }] }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Booked {{appointment.type}}' }] } }));
  await ok(call(o.owner, 'automation_publish', { p_org: o.org, p_workflow: wf, p_enable: true }));
  await ok(book(EMP, o, type, EMP2, future)); await drain();
  assert.equal((await rows(EMP, `select title from public.notifications where organization_id=$1`, [o.org]))[0].title, 'Booked Visit');
  const Bwf = await ok(call(B.owner, 'automation_save_draft', { p_org: B.org, p_workflow: null, p_name: 'x', p_definition: { trigger: { event: 'appointment.created' }, actions: [{ type: 'wait', minutes: 5 }] } }));
  await setOps(B, { appointments: { ...OPS.appointments, enabled: false } }); await bad(call(B.owner, 'automation_publish', { p_org: B.org, p_workflow: Bwf, p_enable: true }), '22023', /Enable the appointments module/);
});

// ============================================================ inventory
async function invSetup(o) {
  const L1 = await ok(call(o.owner, 'inventory_location_save', { p_org: o.org, p_id: null, p_name: 'Main store', p_active: true })), L2 = await ok(call(o.owner, 'inventory_location_save', { p_org: o.org, p_id: null, p_name: 'Branch', p_active: true }));
  const sup = await ok(call(o.owner, 'supplier_save', { p_org: o.org, p_id: null, p_name: 'Acme Supply', p_reference: 'ACC-9', p_notes: null, p_active: true }));
  const P = await ok(call(o.owner, 'product_save', { p_org: o.org, p_id: null, p_sku: 'WID-1', p_name: 'Widget', p_unit: 'pcs', p_track_batches: true, p_threshold: 10, p_active: true, p_custom: null }));
  const Q = await ok(call(o.owner, 'product_save', { p_org: o.org, p_id: null, p_sku: 'BOX-1', p_name: 'Box', p_unit: 'pcs', p_track_batches: false, p_threshold: 5, p_active: true, p_custom: null }));
  return { L1, L2, sup, P, Q };
}
const recv = (u, o, p, loc, qty, extra = {}) => call(u, 'stock_receive', { p_org: o.org, p_product: p, p_location: loc, p_qty: qty, p_lot: extra.lot ?? null, p_expiry: extra.expiry ?? null, p_supplier: extra.supplier ?? null, p_purchase_ref: extra.po ?? null, p_reason: null });
const consume = (u, o, p, loc, qty, extra = {}) => call(u, 'stock_consume', { p_org: o.org, p_product: p, p_location: loc, p_qty: qty, p_batch: extra.batch ?? null, p_ref_type: extra.rt ?? null, p_ref_id: extra.rid ?? null, p_reason: extra.reason ?? null });
const on = (p) => q('select coalesce(sum(quantity),0)::text q from public.stock_levels where product_id=$1', [p]).then(r => r[0].q);
const days = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

test('inventory: receipts, lots and expiry, first-expiry-first-out consumption, atomic failures, no negative stock', async () => {
  const o = await fresh(); const { L1, sup, P, Q } = await invSetup(o);
  assert.equal(Number(await ok(recv(MGR, o, P, L1, 20, { lot: 'LOT-B', expiry: days(60), supplier: sup, po: 'PO-100' }))), 20);
  await ok(recv(MGR, o, P, L1, 5, { lot: 'LOT-A', expiry: days(10), supplier: sup, po: 'PO-101' })); await ok(recv(MGR, o, P, L1, 7, { lot: 'LOT-C' }));
  const [m1] = await q(`select m.*, b.lot_code from public.stock_movements m join public.stock_batches b on b.id = m.batch_id where m.purchase_reference='PO-100'`); assert.deepEqual([m1.kind, Number(m1.quantity_delta), Number(m1.balance_after), m1.supplier_id, m1.lot_code], ['receipt', 20, 20, sup, 'LOT-B']);
  await bad(recv(MGR, o, P, L1, 1), '22023', /lot code/); await bad(recv(MGR, o, Q, L1, 1, { lot: 'L' }), '22023', /not batch-tracked/); await bad(recv(MGR, o, P, L1, 1, { lot: 'LOT-A', expiry: days(11) }), '22023', /different expiry/);
  await bad(recv(MGR, o, P, L1, 1, { lot: 'OLD', expiry: days(-1) }), '22023', /in the past/); for (const qty of [0, -3, 1.2345, 1e12]) await bad(recv(MGR, o, P, L1, qty, { lot: 'X' }), '22023', /quantity/); await bad(recv(MGR, o, id('99'), L1, 1), 'P0002');
  // FEFO: the lot expiring first is used first; lots without an expiry last
  await ok(consume(EMP, o, P, L1, 8, { rt: 'appointment', rid: 'a-1', reason: 'job' }));
  const lots = await q(`select b.lot_code, l.quantity::float q from public.stock_levels l join public.stock_batches b on b.id = l.batch_id where l.product_id=$1 order by b.lot_code`, [P]); assert.deepEqual(lots, [{ lot_code: 'LOT-A', q: 0 }, { lot_code: 'LOT-B', q: 17 }, { lot_code: 'LOT-C', q: 7 }]);
  const cons = await q(`select b.lot_code, m.quantity_delta::float d, m.reference_type, m.reference_id from public.stock_movements m join public.stock_batches b on b.id=m.batch_id where m.kind='consumption' order by m.seq`); assert.deepEqual(cons, [{ lot_code: 'LOT-A', d: -5, reference_type: 'appointment', reference_id: 'a-1' }, { lot_code: 'LOT-B', d: -3, reference_type: 'appointment', reference_id: 'a-1' }]);
  // insufficient stock fails ATOMICALLY: nothing is taken from any lot and no ledger row is written
  const before = (await q('select count(*)::int n from public.stock_movements'))[0].n;
  await bad(consume(EMP, o, P, L1, 100), '22023', /Not enough usable stock/); assert.equal(await on(P), '24.000'); assert.equal((await q('select count(*)::int n from public.stock_movements'))[0].n, before);
  // the last units: the second taker fails (what concurrent requests serialize into); exact depletion is allowed and reaches zero, never below
  await ok(consume(EMP, o, P, L1, 24)); await bad(consume(EMP2, o, P, L1, 1), '22023'); assert.equal(await on(P), '0.000');
  // expired lots are not usable; an explicit lot works around nothing
  const exp = await ok(recv(MGR, o, P, L1, 3, { lot: 'EXP', expiry: days(1) })); await db.exec(`update public.stock_batches set expiry_date = current_date - 1 where lot_code = 'EXP'`);
  await bad(consume(EMP, o, P, L1, 1), '22023', /Not enough usable stock/); assert.ok(exp !== undefined);
  // non-batch product: never negative while the rule is off; the trigger refuses even direct writes
  await ok(recv(MGR, o, Q, L1, 4)); await bad(consume(EMP, o, Q, L1, 5), '22023', /Not enough stock/); assert.equal(await on(Q), '4.000');
  await assert.rejects(db.query(`update public.stock_levels set quantity = -1 where product_id = $1`, [Q]), e => e.code === '22023' && /Not enough stock/.test(e.message));
  // negative stock is only possible by an explicit business rule, and only for non-batch products
  const o2 = await fresh({ ...OPS, inventory: { ...OPS.inventory, allow_negative_stock: true } }); const s2 = await invSetup(o2);
  await ok(recv(MGR, o2, s2.Q, s2.L1, 2)); await ok(consume(EMP, o2, s2.Q, s2.L1, 5)); assert.equal(await on(s2.Q), '-3.000');
  await bad(consume(EMP, o2, s2.P, s2.L1, 1), '22023', /Not enough usable stock/);
  // permissions: staff consume, only managers+ receive/adjust/transfer/manage
  for (const [fn, args] of [['stock_receive', { p_product: Q, p_location: L1, p_qty: 1, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }], ['stock_adjust', { p_product: Q, p_location: L1, p_batch: null, p_counted: 1, p_reason: 'count' }],
    ['product_save', { p_id: null, p_sku: 'Z', p_name: 'Z', p_unit: 'u', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null }], ['inventory_location_save', { p_id: null, p_name: 'Z', p_active: true }], ['supplier_save', { p_id: null, p_name: 'Z', p_reference: null, p_notes: null, p_active: true }]])
    await bad(call(EMP, fn, { p_org: o.org, ...args }), '42501');
  await bad(call(o.owner, 'product_save', { p_org: o.org, p_id: null, p_sku: 'wid-1', p_name: 'Dup', p_unit: 'u', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null }), '23505', /SKU already exists/);
  await bad(call(o.owner, 'product_save', { p_org: o.org, p_id: Q, p_sku: 'BOX-1', p_name: 'Box', p_unit: 'pcs', p_track_batches: true, p_threshold: 5, p_active: true, p_custom: null }), '22023', /cannot change/);
  const noBatches = await fresh({ ...OPS, inventory: { enabled: true } }); await bad(call(noBatches.owner, 'product_save', { p_org: noBatches.org, p_id: null, p_sku: 'A', p_name: 'A', p_unit: 'u', p_track_batches: true, p_threshold: null, p_active: true, p_custom: null }), '22023', /not enabled/);
  const noExpiry = await fresh({ ...OPS, inventory: { enabled: true, track_batches: true } }); const s3 = await invSetup(noExpiry); await bad(recv(noExpiry.owner, noExpiry, s3.P, s3.L1, 1, { lot: 'L', expiry: days(5) }), '22023', /Expiry dates are not enabled/);
});

test('inventory: transfers, adjustments, low-stock events, ledger immutability, reconciliation and isolation', async () => {
  const o = await fresh(); const { L1, L2, P, Q } = await invSetup(o);
  await ok(recv(MGR, o, P, L1, 30, { lot: 'L1', expiry: days(90) })); await ok(recv(MGR, o, Q, L1, 12));
  // transfer: atomic, symmetric entries with one transfer id; the lot travels with the stock
  const tid = await ok(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L1, p_to: L2, p_batch: (await q(`select id from public.stock_batches where lot_code='L1'`))[0].id, p_qty: 10, p_reason: 'restock branch' }));
  const lv = await q(`select l.name, s.quantity::float q from public.stock_levels s join public.inventory_locations l on l.id = s.location_id where s.product_id=$1 order by l.name`, [P]); assert.deepEqual(lv, [{ name: 'Branch', q: 10 }, { name: 'Main store', q: 20 }]);
  const tm = await q(`select kind, quantity_delta::float d from public.stock_movements where transfer_id=$1 order by seq`, [tid]); assert.deepEqual(tm.map(x => x.kind).sort(), ['transfer_in', 'transfer_out']); assert.equal(tm.reduce((s, x) => s + x.d, 0), 0);
  const lot = (await q(`select id from public.stock_batches where lot_code='L1'`))[0].id;
  await bad(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L1, p_to: L2, p_batch: lot, p_qty: 999, p_reason: null }), '22023', /Not enough stock/); assert.equal(await on(P), '30.000', 'a failed transfer moves nothing');
  await bad(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L1, p_to: L1, p_batch: lot, p_qty: 1, p_reason: null }), '22023', /two different/); await bad(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L1, p_to: L2, p_batch: null, p_qty: 1, p_reason: null }), '22023', /Choose the lot/);
  await bad(call(EMP, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L1, p_to: L2, p_batch: lot, p_qty: 1, p_reason: null }), '42501');
  await ok(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L2, p_to: L1, p_batch: lot, p_qty: 10, p_reason: null })); await ok(call(MGR, 'stock_transfer', { p_org: o.org, p_product: P, p_from: L1, p_to: L2, p_batch: lot, p_qty: 1, p_reason: null }));
  // adjustment = counted quantity, mandatory reason, computed under the lock
  await bad(call(MGR, 'stock_adjust', { p_org: o.org, p_product: Q, p_location: L1, p_batch: null, p_counted: 10, p_reason: '' }), '22023', /reason/); await bad(call(MGR, 'stock_adjust', { p_org: o.org, p_product: Q, p_location: L1, p_batch: null, p_counted: -1, p_reason: 'recount' }), '22023');
  assert.equal(Number(await ok(call(MGR, 'stock_adjust', { p_org: o.org, p_product: Q, p_location: L1, p_batch: null, p_counted: 9.5, p_reason: 'damaged box' }))), 9.5);
  const adj = (await q(`select quantity_delta::float d, reason from public.stock_movements where kind='adjustment'`))[0]; assert.deepEqual(adj, { d: -2.5, reason: 'damaged box' }); assert.equal((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name='stock.adjusted'`, [o.org]))[0].n, 1);
  assert.equal((await events(o.org, 'inventory.stock_adjusted'))[0].payload.delta, -2.5);
  // low-stock event: fires when crossing DOWN through the threshold (5), once, and again only after replenishment
  await ok(consume(EMP, o, Q, L1, 4)); assert.equal((await events(o.org, 'inventory.low_stock')).length, 0, '5.5 left: above threshold');
  await ok(consume(EMP, o, Q, L1, 1)); const low = await events(o.org, 'inventory.low_stock'); assert.equal(low.length, 1); assert.deepEqual([low[0].payload.sku, low[0].payload.on_hand, low[0].payload.threshold], ['BOX-1', 4.5, 5]);
  await ok(consume(EMP, o, Q, L1, 1)); assert.equal((await events(o.org, 'inventory.low_stock')).length, 1, 'still low: no repeat'); await ok(recv(MGR, o, Q, L1, 20)); await ok(consume(EMP, o, Q, L1, 22)); assert.equal((await events(o.org, 'inventory.low_stock')).length, 2);
  assert.equal((await events(o.org, 'inventory.stock_received')).length, 3); assert.ok((await events(o.org, 'inventory.stock_consumed')).length >= 4); assert.equal((await events(o.org, 'inventory.stock_transferred')).length, 3);
  assert.deepEqual((await q('select low_stock, on_hand::float from public.inventory_on_hand where product_id=$1', [Q]))[0], { low_stock: true, on_hand: 1.5 });
  // ledger: immutable, and the levels reconcile with it
  await assert.rejects(db.query(`update public.stock_movements set quantity_delta = 99`), e => e.code === '42501'); await assert.rejects(db.query(`delete from public.stock_movements`), e => e.code === '42501');
  assert.deepEqual(await rows(MGR, 'select * from public.inventory_reconcile($1)', [o.org]), [], 'levels == sum(ledger)'); await bad(call(EMP, 'inventory_reconcile', { p_org: o.org }), '42501');
  await db.exec(`update public.stock_levels set quantity = quantity + 3 where product_id = '${Q}'`); const mismatch = await rows(MGR, 'select * from public.inventory_reconcile($1)', [o.org]);
  assert.deepEqual([mismatch.length, Number(mismatch[0].level_quantity) - Number(mismatch[0].ledger_quantity)], [1, 3], 'tampering outside the ledger is detected'); await db.exec(`update public.stock_levels set quantity = quantity - 3 where product_id = '${Q}'`);
  // isolation: other organizations see nothing and cannot use these products or locations
  const B = await fresh(); const sb = await invSetup(B);
  assert.equal((await rows(B.owner, 'select 1 from public.stock_movements where organization_id=$1', [o.org])).length, 0); assert.equal((await rows(B.owner, 'select 1 from public.inventory_on_hand where organization_id=$1', [o.org])).length, 0);
  await bad(consume(B.owner, B, P, sb.L1, 1), 'P0002'); await bad(consume(B.owner, B, sb.Q, L1, 1), '22023', /active location/); await bad(consume(B.owner, o, Q, L1, 1), '42501');
  await bad(call(B.owner, 'stock_transfer', { p_org: B.org, p_product: sb.Q, p_from: sb.L1, p_to: L1, p_batch: null, p_qty: 1, p_reason: null }), '22023', /active location/);
  await assert.rejects(db.query(`insert into public.stock_levels (organization_id, product_id, location_id, quantity) values ($1,$2,$3,5)`, [B.org, Q, sb.L1]), e => e.code === '23503', 'a product of one organization cannot be stocked in another');
  await assert.rejects(db.query(`insert into public.stock_levels (organization_id, product_id, location_id, quantity) values ($1,$2,$3,5)`, [B.org, sb.Q, L1]), e => e.code === '23503');
  // automation on inventory events
  const wf = await ok(call(o.owner, 'automation_save_draft', { p_org: o.org, p_workflow: null, p_name: 'Reorder alert', p_definition: { trigger: { event: 'inventory.low_stock' }, match: { conditions: [{ field: 'inventory.sku', op: 'eq', value: 'BOX-1' }] }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Low: {{inventory.name}} ({{inventory.on_hand}})' }] } }));
  await ok(call(o.owner, 'automation_publish', { p_org: o.org, p_workflow: wf, p_enable: true })); await ok(consume(EMP2, o, Q, L1, 1)); await ok(recv(MGR, o, Q, L1, 10)); await ok(consume(EMP2, o, Q, L1, 10)); await drain();
  assert.equal((await rows(EMP2, `select title from public.notifications where organization_id=$1`, [o.org])).map(n => n.title).length >= 1, true); assert.match((await rows(EMP2, `select title from public.notifications where organization_id=$1 order by created_at`, [o.org]))[0].title, /^Low: Box \(/);
});

// ============================================================ billing
const line = (o = {}) => ({ description: 'Service', quantity: 1, unit_price: 100, ...o });
const draft = (u, o, lines, extra = {}) => call(u, 'invoice_save_draft', { p_org: o.org, p_id: extra.id ?? null, p_contact: extra.contact ?? null, p_lead: extra.lead ?? null, p_currency: extra.currency ?? null, p_due_date: extra.due ?? null, p_notes: extra.notes ?? null, p_lines: lines });
const inv = id => q('select * from public.invoices where id=$1', [id]).then(r => r[0]);
const bal = id => q('select * from public.invoice_balances where invoice_id=$1', [id]).then(r => r[0]);
const pay = (u, o, i, amount, extra = {}) => call(u, 'payment_record', { p_org: o.org, p_invoice: i, p_amount: amount, p_method: extra.method ?? 'cash', p_reference: extra.ref ?? null, p_note: null, p_received: null, p_key: extra.key ?? null });
const issued = async (o, lines, extra) => { const d = await ok(draft(MGR, o, lines, extra)); await ok(call(MGR, 'invoice_issue', { p_org: o.org, p_id: d })); return d; };

test('billing: exact decimal calculation (no floating point), taxes, discounts and validation; totals never come from the browser', async () => {
  const o = await fresh();
  const d1 = await ok(draft(MGR, o, [line({ description: 'Chair', quantity: 3, unit_price: 199.99, discount_type: 'percent', discount_value: 10, tax_keys: ['gst18'] })]));
  const l1 = (await q('select * from public.invoice_lines where invoice_id=$1', [d1]))[0]; assert.deepEqual([l1.gross, l1.discount, l1.net, l1.tax, l1.line_total], ['599.97', '60.00', '539.97', '97.19', '637.16']);
  assert.deepEqual([(await inv(d1)).subtotal, (await inv(d1)).discount_total, (await inv(d1)).tax_total, (await inv(d1)).total], ['599.97', '60.00', '97.19', '637.16']);
  // the classic float trap: 3 x 0.10 and 0.1 + 0.2 are exact
  const d2 = await ok(draft(MGR, o, [line({ quantity: 3, unit_price: 0.1 }), line({ unit_price: 0.2 })])); assert.equal((await inv(d2)).total, '0.50'); assert.equal((await inv(d2)).subtotal, '0.50');
  const d3 = await ok(draft(MGR, o, [line({ unit_price: '10.005' })])); assert.equal((await inv(d3)).total, '10.01', 'half away from zero');
  const d4 = await ok(draft(MGR, o, [line({ unit_price: 99.99, tax_keys: ['gst18', 'gst5'] }), line({ description: 'B', quantity: 0.333, unit_price: 3, discount_type: 'amount', discount_value: '0.50', tax_keys: ['gst5'] })]));
  const L = await q('select position, net, tax, line_total, tax_detail from public.invoice_lines where invoice_id=$1 order by position', [d4]); assert.deepEqual([L[0].net, L[0].tax, L[0].line_total], ['99.99', '23.00', '122.99']); assert.deepEqual([L[1].net, L[1].tax], ['0.50', '0.03']);
  const t4 = await inv(d4); assert.equal(Number(t4.total * 100).toFixed(0), String(Math.round(Number(t4.subtotal) * 100 - Number(t4.discount_total) * 100 + Number(t4.tax_total) * 100)));
  assert.deepEqual(L[0].tax_detail.map(t => [t.key, t.rate, t.amount]), [['gst18', '18', 18], ['gst5', '5', 5]]);
  // validation
  const lines = x => draft(MGR, o, [x]);
  for (const [bad_, re] of [[line({ quantity: 0 }), /greater than zero/], [line({ quantity: 1.2345 }), /3 decimals/], [line({ quantity: -1 }), /greater than zero/], [line({ unit_price: -5 }), /unit price/], [line({ unit_price: 1.23456 }), /4 decimals/], [line({ quantity: '1e3' }), /quantity/],
    [line({ tax_keys: ['vat'] }), /not configured/], [line({ tax_keys: ['gst5', 'gst5'] }), /twice/], [line({ discount_type: 'percent', discount_value: 101 }), /larger than the line/], [line({ discount_type: 'amount', discount_value: 101 }), /larger than the line/], [line({ discount_value: 5 }), /needs a discount type/],
    [line({ description: '' }), /description/], [{ ...line(), total: 1 }, /invalid/], [{ ...line(), line_total: 1 }, /invalid/], [line({ product_id: id('99') }), /product/]]) { const e = await bad(lines(bad_), null); assert.match(e.message, re, JSON.stringify(bad_)); }
  await bad(draft(MGR, o, []), '22023', /between 1 and 100/); await bad(draft(MGR, o, Array.from({ length: 101 }, () => line())), '22023', /between 1 and 100/); await bad(draft(MGR, o, [line()], { currency: 'rupees' }), '22023', /3-letter/);
  assert.equal(JSON.stringify(await q(`select pg_get_function_arguments('public.invoice_save_draft(uuid,uuid,uuid,uuid,text,date,text,jsonb)'::regprocedure) a`)).includes('total'), false, 'the API has no total parameters');
  // permissions: employees have no access at all; managers can draft
  await bad(draft(EMP, o, [line()]), '42501'); assert.equal((await rows(EMP, 'select 1 from public.invoices')).length, 0); assert.equal((await rows(MGR, 'select 1 from public.invoices where organization_id=$1', [o.org])).length > 0, true);
  // editing a draft recalculates; the invoice.created event is emitted once
  await ok(draft(MGR, o, [line({ unit_price: 250 })], { id: d1 })); assert.equal((await inv(d1)).total, '250.00'); assert.equal((await q('select count(*)::int n from public.invoice_lines where invoice_id=$1', [d1]))[0].n, 1); assert.equal((await events(o.org, 'invoice.created')).filter(e => e.aggregate_id === d1).length, 1);
});

test('billing: issuing freezes a snapshot; numbering; immutability; tax rate changes do not touch issued invoices', async () => {
  const o = await fresh(); const c = await ok(call(o.owner, 'crm_create_lead', { p_org: o.org, p_full_name: 'Bill Payer', p_phone: '9833300001', p_email: 'bill@x.test', p_source: 'phone', p_summary: null, p_stage: null, p_assigned_to: null }));
  const d = await ok(draft(MGR, o, [line({ description: 'Consulting', quantity: 2, unit_price: 500, tax_keys: ['gst18'] })], { lead: c, notes: 'Thanks' }));
  await bad(call(MGR, 'invoice_issue', { p_org: o.org, p_id: id('99') }), 'P0002'); await bad(call(EMP, 'invoice_issue', { p_org: o.org, p_id: d }), '42501');
  const num = await ok(call(MGR, 'invoice_issue', { p_org: o.org, p_id: d })); assert.equal(num, 'INV-00001');
  const i = await inv(d); assert.deepEqual([i.status, i.number, i.total, !!i.snapshot, i.issued_by], ['issued', 'INV-00001', '1180.00', true, MGR]);
  assert.deepEqual([i.snapshot.bill_to.name, i.snapshot.bill_to.email, i.snapshot.total, i.snapshot.lines[0].tax_detail[0].rate, i.snapshot.tax_summary[0].amount, /^Ops \d+$/.test(i.snapshot.business)], ['Bill Payer', 'bill@x.test', 1180, '18', 180, true]);
  assert.equal((await q(`select amount::text a from public.invoice_ledger where invoice_id=$1`, [d]))[0].a, '1180.00'); assert.equal((await events(o.org, 'invoice.issued'))[0].payload.number, 'INV-00001');
  assert.equal(i.due_date.toISOString().slice(0, 10), days(14), 'default due days from the configuration');
  // immutable: the row, the snapshot and the lines
  await assert.rejects(db.query(`update public.invoices set notes='x' where id=$1`, [d]), e => e.code === '42501' && /immutable/.test(e.message)); await assert.rejects(db.query(`update public.invoices set snapshot='{}' where id=$1`, [d]), e => e.code === '42501');
  await assert.rejects(db.query(`delete from public.invoices where id=$1`, [d]), e => e.code === '42501'); await assert.rejects(db.query(`update public.invoice_lines set quantity = 9 where invoice_id=$1`, [d]), e => e.code === '42501'); await assert.rejects(db.query(`delete from public.invoice_lines where invoice_id=$1`, [d]), e => e.code === '42501');
  await assert.rejects(db.query(`insert into public.invoice_lines (organization_id, invoice_id, position, description, quantity, unit_price) values ($1,$2,2,'x',1,1)`, [o.org, d]), e => e.code === '42501');
  await bad(draft(MGR, o, [line()], { id: d }), '22023', /Only drafts/); await bad(call(MGR, 'invoice_issue', { p_org: o.org, p_id: d }), '22023', /already issued/); await bad(call(MGR, 'invoice_cancel_draft', { p_org: o.org, p_id: d }), 'P0002');
  // a configuration change to the tax rate does not alter an issued invoice, but applies to the next one
  await setOps(o, { ...OPS, billing: { ...OPS.billing, taxes: [{ key: 'gst18', name: 'GST', rate: '20' }, { key: 'gst5', name: 'GST 5%', rate: '5' }] } });
  assert.equal((await inv(d)).total, '1180.00'); const d2 = await issued(o, [line({ unit_price: 1000, tax_keys: ['gst18'] })]); assert.deepEqual([(await inv(d2)).total, (await inv(d2)).number], ['1200.00', 'INV-00002']);
  // drafts: cannot issue empty or zero totals; cancelled drafts consume no number; numbering is per organization
  const z = await ok(draft(MGR, o, [line({ unit_price: 0 })])); await bad(call(MGR, 'invoice_issue', { p_org: o.org, p_id: z }), '22023', /greater than zero/); await ok(call(MGR, 'invoice_cancel_draft', { p_org: o.org, p_id: z })); assert.equal((await inv(z)).status, 'cancelled');
  await assert.rejects(db.query(`update public.invoices set status='draft' where id=$1`, [z]), e => e.code === '42501'); await bad(call(MGR, 'invoice_issue', { p_org: o.org, p_id: z }), '22023');
  const d3 = await issued(o, [line()]); assert.equal((await inv(d3)).number, 'INV-00003');
  const B = await fresh(); const bd = await issued(B, [line()]); assert.equal((await inv(bd)).number, 'INV-00001', 'independent sequence per organization');
  assert.equal((await q(`select count(*)::int n from public.invoices where organization_id=$1 and number is not null`, [o.org]))[0].n, 3);
  // isolation and financial confidentiality
  assert.equal((await rows(B.owner, 'select 1 from public.invoices where organization_id=$1', [o.org])).length, 0); assert.equal((await rows(EMP, 'select 1 from public.invoice_ledger where organization_id=$1', [o.org])).length, 0);
  await bad(call(B.owner, 'invoice_issue', { p_org: B.org, p_id: d3 }), 'P0002'); await assert.rejects(db.query(`insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id) values ($1,$2,'payment',-1,gen_random_uuid())`, [B.org, d3]), e => e.code === '23503');
});

test('billing: partial payments, outstanding amounts, idempotency, credit notes, refunds and ledger reconciliation', async () => {
  const o = await fresh(); const d = await issued(o, [line({ description: 'Treatment', quantity: 1, unit_price: 1000, tax_keys: ['gst18'] })]); // total 1180.00, tax 180.00
  assert.deepEqual([(await bal(d)).balance_due, (await bal(d)).payment_state, (await bal(d)).overdue], ['1180.00', 'unpaid', false]);
  await bad(pay(MGR, o, d, 0), '22023'); await bad(pay(MGR, o, d, -5), '22023'); await bad(pay(MGR, o, d, 10.001), '22023'); await bad(pay(MGR, o, d, 1180.01), '22023', /more than the outstanding/); await bad(pay(MGR, o, d, 10, { method: 'bitcoin' }), '22023'); await bad(pay(EMP, o, d, 10), '42501');
  const draftOnly = await ok(draft(MGR, o, [line()])); await bad(pay(MGR, o, draftOnly, 10), '22023', /issued invoices/);
  const p1 = await ok(pay(MGR, o, d, 400, { method: 'upi', ref: 'UPI-1', key: 'pay-1' })); assert.deepEqual([(await bal(d)).balance_due, (await bal(d)).payment_state, (await bal(d)).paid], ['780.00', 'partially_paid', '400.00']);
  assert.equal(await ok(pay(MGR, o, d, 400, { method: 'upi', key: 'pay-1' })), p1, 'a repeated submit returns the first payment'); assert.equal((await bal(d)).balance_due, '780.00');
  const [pe] = await events(o.org, 'payment.received'); assert.deepEqual([pe.aggregate_type, pe.aggregate_id, pe.payload.amount, pe.payload.balance_due, pe.payload.source], ['payment', p1, 400, 780, 'manual']); assert.equal((await events(o.org, 'invoice.paid')).length, 0);
  await ok(pay(ADM, o, d, 300)); await bad(pay(MGR, o, d, 481), '22023'); await ok(pay(MGR, o, d, 480)); assert.deepEqual([(await bal(d)).balance_due, (await bal(d)).payment_state], ['0.00', 'paid']);
  assert.equal((await events(o.org, 'invoice.paid')).length, 1); assert.equal((await events(o.org, 'payment.received')).length, 3); await bad(pay(MGR, o, d, 1), '22023', /more than the outstanding/);
  // credit note: owner/admin only; tax reversed proportionally; cannot exceed the invoice; produces a customer credit
  await bad(call(MGR, 'credit_note_issue', { p_org: o.org, p_invoice: d, p_amount: 100, p_reason: 'Goodwill' }), '42501'); await bad(call(ADM, 'credit_note_issue', { p_org: o.org, p_invoice: d, p_amount: 100, p_reason: '' }), '22023', /reason/);
  const cn1 = await ok(call(ADM, 'credit_note_issue', { p_org: o.org, p_invoice: d, p_amount: 118, p_reason: 'Service issue' })); assert.equal(cn1, 'CN-00001');
  assert.deepEqual((await q('select amount::text a, net_amount::text n, tax_amount::text t from public.credit_notes'))[0], { a: '118.00', n: '100.00', t: '18.00' }); assert.deepEqual([(await bal(d)).balance_due, (await bal(d)).payment_state, (await bal(d)).credited], ['-118.00', 'credit', '118.00']);
  await bad(call(ADM, 'credit_note_issue', { p_org: o.org, p_invoice: d, p_amount: 1063, p_reason: 'too much' }), '22023', /left to credit/);
  const cn2 = await ok(call(o.owner, 'credit_note_issue', { p_org: o.org, p_invoice: d, p_amount: 1062, p_reason: 'Cancelled treatment' })); assert.equal(cn2, 'CN-00002');
  const cns = await q('select sum(amount)::text a, sum(net_amount)::text n, sum(tax_amount)::text t from public.credit_notes'); assert.deepEqual(cns[0], { a: '1180.00', n: '1000.00', t: '180.00' }); // exact: the last credit takes the remainder
  await bad(call(o.owner, 'credit_note_issue', { p_org: o.org, p_invoice: d, p_amount: 0.01, p_reason: 'nothing left' }), '22023');
  assert.equal((await events(o.org, 'credit_note.issued')).length, 2); assert.equal((await bal(d)).balance_due, '-1180.00');
  // refunds: owner/admin only, only up to what is OWED to the customer (credit), never more than was received
  await bad(call(MGR, 'refund_record', { p_org: o.org, p_invoice: d, p_amount: 10, p_method: 'cash', p_reference: null, p_reason: 'x y z', p_key: null }), '42501');
  await bad(call(ADM, 'refund_record', { p_org: o.org, p_invoice: d, p_amount: 1180.01, p_method: 'cash', p_reference: null, p_reason: 'too much', p_key: null }), '22023', /owed to the customer/);
  const r1 = await ok(call(ADM, 'refund_record', { p_org: o.org, p_invoice: d, p_amount: 500, p_method: 'bank_transfer', p_reference: 'RF-1', p_reason: 'Refund of cancelled treatment', p_key: 'rf-1' })); assert.equal(await ok(call(ADM, 'refund_record', { p_org: o.org, p_invoice: d, p_amount: 500, p_method: 'bank_transfer', p_reference: 'RF-1', p_reason: 'again', p_key: 'rf-1' })), r1);
  assert.deepEqual([(await bal(d)).balance_due, (await bal(d)).refunded], ['-680.00', '500.00']); await ok(call(ADM, 'refund_record', { p_org: o.org, p_invoice: d, p_amount: 680, p_method: 'cash', p_reference: null, p_reason: 'Final refund', p_key: null })); assert.deepEqual([(await bal(d)).balance_due, (await bal(d)).payment_state], ['0.00', 'paid']);
  await bad(call(ADM, 'refund_record', { p_org: o.org, p_invoice: d, p_amount: 1, p_method: 'cash', p_reference: null, p_reason: 'nothing owed', p_key: null }), '22023', /owed to the customer/);
  const pr = await events(o.org, 'payment.refunded'); assert.deepEqual([pr.length, pr[0].aggregate_type, pr[0].payload.amount, pr[0].payload.balance_due], [2, 'payment', 500, -680]);
  // accounting identity and reconciliation: money in - money out == payments - refunds; ledger == documents
  assert.deepEqual(await rows(MGR, 'select * from public.billing_reconcile($1)', [o.org]), []); await bad(call(EMP, 'billing_reconcile', { p_org: o.org }), '42501');
  const cash = (await q(`select coalesce(sum(case when kind='payment' then amount else -amount end),0)::text c from public.invoice_payments where invoice_id=$1`, [d]))[0].c; assert.equal(cash, '0.00', 'all received money was refunded; the credit notes cancelled the invoice');
  await db.exec(`insert into public.invoice_ledger (organization_id, invoice_id, kind, amount, ref_id) values ('${o.org}','${d}','payment',-5,gen_random_uuid())`); const bad_ = await rows(MGR, 'select * from public.billing_reconcile($1)', [o.org]); assert.equal(bad_.length, 1, 'a stray ledger entry is detected');
  // the ledger tables are append-only
  for (const [t, col] of [['invoice_payments', 'created_at'], ['credit_notes', 'issued_at'], ['invoice_ledger', 'created_at']]) { await assert.rejects(db.query(`update public.${t} set ${col} = now()`), e => e.code === '42501', t); await assert.rejects(db.query(`delete from public.${t}`), e => e.code === '42501', t); }
  // overdue: only while money is owed after the due date
  const od = await issued(o, [line({ unit_price: 50 })], { due: days(1) }); await db.exec(`set session_replication_role = replica; update public.invoices set due_date = current_date - 3 where id='${od}'; set session_replication_role = origin;`);
  assert.deepEqual([(await bal(od)).overdue, (await bal(od)).payment_state], [true, 'unpaid']); await ok(pay(MGR, o, od, 50)); assert.equal((await bal(od)).overdue, false);
});

test('billing: provider payments reuse the same posting path (inert until a payments provider is connected), tenant isolation and automation on money events', async () => {
  const o = await fresh(); const B = await fresh(); const d = await issued(o, [line({ unit_price: 200 })]);
  const prov = (conn, inv, amount, cur = 'INR', ref = 'pay_123') => worker('select public.billing_apply_provider_payment($1,$2,$3,$4,$5,$6) r', [conn, inv, amount, cur, ref, 'card']).then(r => r.rows[0].r);
  await assert.rejects(prov(id('77'), d, 50), e => /no connected payments provider/.test(e.message)); await bad(call(MGR, 'billing_apply_provider_payment', { p_connection: id('77'), p_invoice: d, p_amount: 1, p_currency: 'INR', p_provider_ref: 'x', p_method: 'card' }), '42501');
  assert.equal((await q('select count(*)::int n from public.invoice_payments where invoice_id=$1', [d]))[0].n, 0, 'nothing posted: no provider is connected');
  const mk = async org => (await q(`insert into public.integration_connections (organization_id, provider, name, status, created_by, last_event_at) values ($1,'payments','Gateway','connected',$2, now()) returning id`, [org, EMP]))[0].id;
  const conn = await mk(o.org), connB = await mk(B.org);
  await assert.rejects(prov(connB, d, 50), e => e.code === 'P0002', "another organization's provider cannot pay this invoice"); await assert.rejects(prov(conn, d, 50, 'USD'), e => /currency/.test(e.message));
  const pid = await prov(conn, d, 50); assert.equal(await prov(conn, d, 50), pid, 'provider references are idempotent');
  assert.deepEqual([(await bal(d)).balance_due, (await q('select source, recorded_by from public.invoice_payments where id=$1', [pid]))[0]], ['150.00', { source: 'provider', recorded_by: null }]);
  assert.equal((await events(o.org, 'payment.received'))[0].payload.source, 'provider');
  // automation on payment events (previously contract-only): condition on the payment amount and the invoice context
  const wf = await ok(call(o.owner, 'automation_save_draft', { p_org: o.org, p_workflow: null, p_name: 'Big payment', p_definition: { trigger: { event: 'payment.received' }, match: { conditions: [{ field: 'payment.amount', op: 'gt', value: 100 }, { field: 'invoice.currency', op: 'eq', value: 'INR' }] }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Paid {{payment.amount}} on {{invoice.number}}' }] } }));
  await ok(call(o.owner, 'automation_publish', { p_org: o.org, p_workflow: wf, p_enable: true })); await ok(pay(MGR, o, d, 20)); await ok(pay(MGR, o, d, 130)); await drain();
  const n = await rows(MGR, `select title from public.notifications where organization_id=$1`, [o.org]); assert.deepEqual(n.map(x => x.title), ['Paid 130.00 on INV-00001']);
  const wf2 = await ok(call(o.owner, 'automation_save_draft', { p_org: o.org, p_workflow: null, p_name: 'Paid in full', p_definition: { trigger: { event: 'invoice.paid' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Settled {{invoice.number}}' }] } })); await ok(call(o.owner, 'automation_publish', { p_org: o.org, p_workflow: wf2, p_enable: true }));
  const d2 = await issued(o, [line({ unit_price: 10 })]); await ok(pay(MGR, o, d2, 10)); await drain(); assert.ok((await rows(MGR, `select 1 from public.notifications where title = 'Settled INV-00002'`)).length === 1);
  // actions that need a lead or task are refused for money triggers; the grammar mirrors the TypeScript validator
  for (const [def, okExpected] of [[{ trigger: { event: 'payment.received' }, actions: [{ type: 'create_task', title: 'x', due_in_days: 1, owner: 'lead_assignee' }] }, false], [{ trigger: { event: 'invoice.issued' }, match: { conditions: [{ field: 'invoice.total', op: 'gt', value: 5 }] }, actions: [{ type: 'wait', minutes: 5 }] }, true],
    [{ trigger: { event: 'invoice.issued' }, match: { conditions: [{ field: 'payment.amount', op: 'gt', value: 5 }] }, actions: [{ type: 'wait', minutes: 5 }] }, false], [{ trigger: { event: 'payment.received' }, match: { conditions: [{ field: 'invoice.total', op: 'gt', value: 5 }] }, actions: [{ type: 'wait', minutes: 5 }] }, true],
    [{ trigger: { event: 'appointment.created' }, match: { conditions: [{ field: 'inventory.sku', op: 'eq', value: 'x' }] }, actions: [{ type: 'wait', minutes: 5 }] }, false], [{ trigger: { event: 'inventory.low_stock' }, actions: [{ type: 'wait', until_field: 'inventory.sku' }] }, true], [{ trigger: { event: 'appointment.created' }, actions: [{ type: 'request_integration', channel: 'whatsapp', message: 'hi' }] }, false]]) {
    const sqlOk = await db.query('select public.automation_validate($1::jsonb)', [JSON.stringify(def)]).then(() => true, e => { assert.equal(e.code, '22023'); return false; }); assert.equal(sqlOk, okExpected, JSON.stringify(def)); assert.equal(validateAutomation(def).ok, sqlOk, 'TS parity: ' + JSON.stringify(def)); }
  assert.ok(TRIGGERS.every(t => t.available) && TRIGGERS.some(t => t.event === 'payment.received') && TRIGGERS.some(t => t.event === 'appointment.created'));
  // tenant isolation of the financial ledger
  assert.equal((await rows(B.owner, 'select 1 from public.invoice_payments where organization_id=$1', [o.org])).length, 0); await bad(pay(B.owner, B, d, 1), 'P0002'); await bad(pay(B.owner, o, d, 1), '42501');
});

// ============================================================ AI tools (read-only, authorized) and proposals
const ctxFor = (o, user, role) => ({ org: o.org, userId: user, role, conversationId: null, rpc: mkRpc(user), platformMissing: () => ({ meta: [], whatsapp: [] }),
  loadConfigs: async () => { const pub = (await rows(user, `select definition, revision from public.workspace_configuration_versions where organization_id=$1 and status='published' order by revision desc limit 1`, [o.org]))[0]; const dr = (await rows(user, `select definition from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [o.org]))[0]; return { published: pub.definition, publishedRevision: pub.revision, draft: dr?.definition ?? null }; } });
const tool = async (ctx, name, args) => { const r = await executeTool(ctx, name, args); return { ...r, json: JSON.parse(r.content) }; };

test('AI: authorized read-only tools for operations data, no fabricated data, and enabling modules is a human-approved proposal', async () => {
  const o = await fresh(); const type = await apptSetup(o); const { L1, P, Q } = await invSetup(o);
  const mon = futureDate(1); await ok(book(EMP, o, type, EMP, ist(mon, '10:00'), { notes: 'Call me on 9811100099 or mail secret@x.test' }));
  await ok(recv(MGR, o, Q, L1, 3)); await ok(recv(MGR, o, P, L1, 20, { lot: 'L-9', expiry: days(5) }));
  const d = await issued(o, [line({ unit_price: 1000, tax_keys: ['gst18'] })]); await ok(pay(MGR, o, d, 500, { method: 'cash' }));
  const E = ctxFor(o, EMP, 'employee'), M = ctxFor(o, MGR, 'manager'), W = ctxFor(o, o.owner, 'owner');
  assert.ok(toolsFor('employee').some(t => t.name === 'list_appointments') && !toolsFor('employee').some(t => /invoice|billing/.test(t.name)) && toolsFor('manager').some(t => t.name === 'list_invoices'));
  const st = (await tool(E, 'get_operations_status', {})).json.data; assert.deepEqual([st.appointments.enabled, st.appointments.types, st.inventory.products, st.billing.enabled, st.billing.taxes], [true, 1, 2, true, undefined]); assert.match(st.billing.note, /owners, admins and managers/);
  const ap = (await tool(E, 'list_appointments', { from: ist(mon, '00:00'), to: ist(futureDate(1, 1), '00:00') })).json.data; assert.equal(ap.total, 1); assert.doesNotMatch(JSON.stringify(ap), /9811100099|secret@x/); assert.equal(ap.items[0].type, 'Consultation');
  assert.equal((await tool(E, 'list_appointments', { from: '2026-01-01', to: '2027-12-31' })).ok, false); assert.equal((await tool(E, 'list_appointments', { from: 'banana' })).ok, false);
  const inv_ = (await tool(E, 'get_inventory_status', { low_stock_only: true })).json.data; assert.deepEqual(inv_.items.map(i => [i.sku, i.low_stock]), [['BOX-1', true]]); assert.equal((await tool(E, 'get_inventory_status', {})).json.data.items.find(i => i.sku === 'WID-1').expiring_within_30_days, 1);
  assert.equal((await tool(E, 'list_stock_movements', { limit: 5 })).json.data.items[0].kind, 'receipt');
  const eb = await tool(E, 'list_invoices', {}); assert.deepEqual([eb.ok, eb.code], [false, 'forbidden']); assert.equal((await executeTool({ ...E, role: 'manager' }, 'list_invoices', {})).ok, false, 'the database refuses even if the TypeScript role is wrong');
  const li = (await tool(M, 'list_invoices', {})).json.data; assert.deepEqual([li.items[0].number, li.items[0].balance_due, li.items[0].payment_state, li.items[0].paid], ['INV-00001', 680, 'partially_paid', 500]); assert.match(li.note, /no payment provider is connected/);
  const bs = (await tool(M, 'get_billing_summary', {})).json.data; assert.deepEqual(bs.by_currency[0], { currency: 'INR', issued_invoices: 1, invoiced_total: 1180, outstanding: 680, overdue_amount: 0, overdue_invoices: 0, credit_owed_to_customers: 0 });
  // other organizations are invisible
  const B = await fresh(); assert.equal((await tool(ctxFor(B, B.owner, 'owner'), 'list_invoices', {})).json.data.total, 0); assert.equal((await tool(ctxFor(B, B.owner, 'owner'), 'list_appointments', {})).json.data.total, 0);
  assert.equal((await call(B.owner, 'ai_tool_list_invoices', { p_org: o.org, p_state: null, p_limit: 5, p_offset: 0 })).error.code, '42501');
  // proposals: enabling a module changes nothing until a human approves and publishes it
  const empty = await fresh(null); const cfg = ctxFor(empty, empty.owner, 'owner');
  const p = await tool(cfg, 'propose_module_changes', { summary: 'Turn on appointments', operations: [{ op: 'enable_module', operations_module: 'appointments' }] }); assert.equal(p.ok, true, p.content); assert.ok(p.json.data.diff.includes('Enable the Appointments module'));
  assert.equal((await q(`select count(*)::int n from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [empty.org]))[0].n, 0); await bad(call(empty.owner, 'appointment_type_save', { p_org: empty.org, p_id: null, p_name: 'X', p_duration: 30, p_active: true }), '22023', /not enabled/);
  assert.equal((await applyProposal(ctxFor(empty, MGR, 'manager'), p.json.data.proposal_id, 'save_draft')).ok, false);
  assert.equal((await applyProposal(cfg, p.json.data.proposal_id, 'save_draft')).ok, true); assert.equal((await applyProposal(cfg, p.json.data.proposal_id, 'publish')).ok, true);
  assert.ok(await ok(call(empty.owner, 'appointment_type_save', { p_org: empty.org, p_id: null, p_name: 'X', p_duration: 30, p_active: true })));
  const off = await tool(cfg, 'propose_module_changes', { summary: 'Turn off appointments', operations: [{ op: 'disable_module', operations_module: 'appointments' }] }); assert.ok(off.json.data.diff.some(x => /Disable the Appointments module \(existing data is kept\)/.test(x)));
  assert.equal((await tool(cfg, 'propose_module_changes', { summary: 'bad', operations: [{ op: 'enable_module' }] })).ok, false); assert.equal((await tool(cfg, 'propose_module_changes', { summary: 'bad', operations: [{ op: 'enable_module', operations_module: 'payroll' }] })).ok, false);
  assert.equal(applyOps(validateConfig(BASE).value, validateConfig(BASE).value, [{ op: 'enable_module', operations_module: 'billing' }]).value.config.operations.billing.invoice_prefix, 'INV', 'safe defaults are applied');
  // an automation about money: AI proposals honour the module requirement and never claim external processing
  const aw = await tool(W, 'propose_automation', { name: 'Paid alert', summary: 'notify when a payment arrives', definition: { trigger: { event: 'payment.received' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Payment' }] } }); assert.equal(aw.ok, true, aw.content);
});
