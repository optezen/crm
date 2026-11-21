// `npm run test:perf`: load, query plans and recovery on a REAL PostgreSQL server (18.x here; Supabase hosts 15/17, so confirm on staging).
// 1) a large workspace (20k leads, 60k tasks, 100k notifications): the queries the screens run stay fast and use indexes;
// 2) write throughput under 60 simultaneous writers; 3) a physical backup restored into a NEW server keeps every row, policy and function;
// 4) a hard crash (SIGKILL of the database server in the middle of a payment storm) loses nothing that was committed and breaks no invariant.
// Timing limits are generous (about 4x what was measured on a laptop) so they flag a lost index or a runaway query, not noise.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPg, uid, EMP, EMP2, MGR, ADM } from './pgenv.mjs';

let env, rpc, q, asUser; const cleanup = [];
before(async () => { env = await startPg({ keep: true }); ({ rpc, q, asUser } = env); });
after(async () => { for (const c of cleanup) await c().catch(() => {}); await env?.stop({ remove: true }).catch(() => {}); });

const ok = r => { assert.equal(r.error, null, r.error?.message); return r.data; };
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'] } };
const OPS = { ...BASE, operations: { billing: { enabled: true, currency: 'INR', invoice_prefix: 'INV', credit_note_prefix: 'CN', default_due_days: 14, taxes: [] } } };
let seq = 70;
async function fresh() {
  const owner = uid(String(seq++)); await q(`insert into auth.users values ($1,$2) on conflict do nothing`, [owner, `o${seq}@x.test`]);
  const org = String(ok(await rpc(owner, 'create_workspace', { p_name: `Perf ${seq}`, p_description: null, p_preset: null, p_definition: BASE })));
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) ok(await rpc(owner, 'crm_add_member', { p_org: org, p_email: e, p_role: r }));
  ok(await rpc(owner, 'save_workspace_draft', { p_org: org, p_definition: OPS })); ok(await rpc(owner, 'publish_workspace_config', { p_org: org })); return { org, owner };
}
const ms = async f => { const t = performance.now(); const v = await f(); return [performance.now() - t, v]; };
const median = async (f, n = 3) => { const t = []; for (let i = 0; i < n; i++) t.push((await ms(f))[0]); return t.sort((a, b) => a - b)[Math.floor(n / 2)]; };
const N = 20000; let O, report = {};
const MIGRATION_0019 = readFileSync(new URL('../../supabase/migrations/0019_user_experience.sql', import.meta.url), 'utf8');

test('[perf] a large workspace is seeded through the real functions (throughput is measured, not assumed)', async () => {
  O = await fresh(); const c = await env.pool.connect();
  try {
    await c.query('begin'); await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [O.owner]);
    const [t] = await ms(() => c.query(`select public.crm_create_lead($1, 'Lead ' || g, '+9199' || lpad(g::text, 8, '0'), null, (array['website','phone','walk_in','referral'])[1 + g % 4], null, null, null) from generate_series(1, $2) g`, [O.org, N]));
    await c.query('commit'); report.seedLeadsPerSecond = Math.round(N / (t / 1000)); console.log(`# created ${N} leads through crm_create_lead in ${Math.round(t)} ms (${report.seedLeadsPerSecond}/s)`);
  } finally { c.release(); }
  const team = [EMP, EMP2, MGR, ADM]; await q(`update public.leads set assigned_to = (array['${team.join("','")}']::uuid[])[1 + (extract(epoch from created_at)::bigint + (row_number() over ())::int) % 4] where false`).catch(() => {});
  await q(`with n as (select id, row_number() over (order by id) rn from public.leads where organization_id=$1) update public.leads l set assigned_to = (array['${team.join("','")}']::uuid[])[1 + n.rn % 4], stage = (array['New','Qualified','Won'])[1 + n.rn % 3] from n where l.id = n.id`, [O.org]);
  await q(`insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, status, created_by) select l.organization_id, l.id, 'Call ' || g, l.assigned_to, current_date + ((g * 7 + extract(epoch from l.created_at)::int) % 40 - 20), case when g % 5 = 0 then 'open' else 'open' end, l.assigned_to from public.leads l cross join generate_series(1, 3) g where l.organization_id=$1`, [O.org]);
  await q(`insert into public.notifications (organization_id, user_id, title, body, read_at, created_at) select $1, (array['${team.join("','")}']::uuid[])[1 + g % 4], 'Notification ' || g, null, case when g % 3 = 0 then now() else null end, now() - (g || ' seconds')::interval from generate_series(1, 100000) g`, [O.org]);
  await q('analyze');
  assert.equal((await q('select count(*)::int n from public.leads where organization_id=$1', [O.org]))[0].n, N); assert.equal((await q('select count(*)::int n from public.tasks where organization_id=$1', [O.org]))[0].n, N * 3); assert.ok((await q('select count(*)::int n from public.notifications where organization_id=$1', [O.org]))[0].n >= 100000);
  assert.ok(report.seedLeadsPerSecond > 50, `lead creation throughput ${report.seedLeadsPerSecond}/s`);
});

test('[perf] the queries behind the screens stay fast on a large workspace, and none scans a whole big table', async () => {
  const { org } = O; const plan = async (user, sql, params) => { const c = await env.pool.connect(); try { await c.query('begin'); await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]); const r = await c.query(`explain (analyze, format json) ${sql}`, params); await c.query('commit'); return r.rows[0]['QUERY PLAN'][0]; } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); } };
  const seqScans = (node, out = []) => { if (node['Node Type'] === 'Seq Scan' && (node['Actual Rows'] ?? 0) * (node['Actual Loops'] ?? 1) + (node['Rows Removed by Filter'] ?? 0) > 20000) out.push(`${node['Relation Name']} (${node['Actual Rows']} rows, ${node['Rows Removed by Filter'] ?? 0} filtered)`); (node.Plans ?? []).forEach(p => seqScans(p, out)); return out; };
  const cases = [
    ['lead list, newest first, page 1 (manager)', MGR, `select * from public.crm_lead_list where organization_id=$1 order by created_at desc limit 25`, 400],
    ['lead list filtered by stage and source (manager)', MGR, `select * from public.crm_lead_list where organization_id=$1 and stage='Qualified' and source='website' order by created_at desc limit 25`, 400],
    ['lead list as an employee (row security applies)', EMP, `select * from public.crm_lead_list where organization_id=$1 order by created_at desc limit 25`, 600],
    ['my open follow-ups, soonest first', EMP, `select * from public.tasks where organization_id=$1 and owner_id='${EMP}' and status='open' order by due_date limit 50`, 300],
    ['unread notifications, newest first', EMP, `select * from public.notifications where organization_id=$1 and user_id='${EMP}' and read_at is null order by created_at desc limit 30`, 300],
    ['unread notification count', EMP, `select count(*) from public.notifications where organization_id=$1 and user_id='${EMP}' and read_at is null`, 300],
  ];
  for (const [name, user, sql, limit] of cases) {
    const t = await median(() => asUser(user, sql, [org])); const p = await plan(user, sql, [org]); const scans = seqScans(p.Plan); report[name] = Math.round(t); console.log(`# ${name}: ${Math.round(t)} ms${scans.length ? '  FULL SCAN: ' + scans.join(', ') : ''}`);
    assert.ok(t < limit, `${name} took ${Math.round(t)} ms (limit ${limit})`); assert.deepEqual(scans, [], `${name} scans a whole big table; add an index`);
  }
  const fn = async (name, user, f, limit) => { const t = await median(() => f(user)); report[name] = Math.round(t); console.log(`# ${name}: ${Math.round(t)} ms`); assert.ok(t < limit, `${name} took ${Math.round(t)} ms (limit ${limit})`); };
  await fn('global search by name', MGR, u => asUser(u, `select public.global_search($1, 'Lead 1234', null, 20, 0)`, [org]), 800);
  await fn('global search by phone fragment', MGR, u => asUser(u, `select public.global_search($1, '99000123', null, 20, 0)`, [org]), 800);
  // every visible row costs ~25 us through row security, and this employee owns 15,000 open tasks (a real person has dozens): the limit is for that extreme, the number is recorded
  await fn('home summary (employee owning 15,000 open tasks, 20,000 leads)', EMP, u => asUser(u, `select public.home_summary($1, 'Asia/Kolkata')`, [org]), 2500);
  await fn('worker status (administrator)', O.owner, u => asUser(u, `select public.worker_status($1)`, [org]), 400);
});

test('[perf] the faster search and home summary give exactly the same answers as the originals, for every role', async () => {
  const slice = name => MIGRATION_0019.slice(MIGRATION_0019.indexOf(`create or replace function public.${name}(`), MIGRATION_0019.indexOf('end $$;', MIGRATION_0019.indexOf(`create or replace function public.${name}(`)) + 7);
  await q(slice('global_search').replace('public.global_search(', 'public.global_search_original(')); await q(slice('home_summary').replace('public.home_summary(', 'public.home_summary_original(')); await q('grant execute on function public.global_search_original(uuid, text, text[], integer, integer), public.home_summary_original(uuid, text) to authenticated');
  const S = await fresh(); const c = await env.pool.connect(); try { await c.query('begin'); await c.query('set local role authenticated'); await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [S.owner]); await c.query(`select public.crm_create_lead($1, 'Lead ' || g, '+9199' || lpad(g::text, 8, '0'), case when g % 7 = 0 then 'p' || g || '@mail.test' end, 'website', case when g % 11 = 0 then 'wants lead pricing' end, null, null) from generate_series(1, 1200) g`, [S.org]); await c.query('commit'); } finally { c.release(); }
  const team = [EMP, EMP2, MGR, ADM]; await q(`with n as (select id, row_number() over (order by id) rn from public.leads where organization_id=$1) update public.leads l set assigned_to = case when n.rn % 5 = 0 then null else (array['${team.join("','")}']::uuid[])[1 + n.rn % 4] end from n where l.id = n.id`, [S.org]);
  await q(`insert into public.tasks (organization_id, lead_id, title, owner_id, due_date, status, created_by) select l.organization_id, l.id, 'Call ' || g, coalesce(l.assigned_to, $2), current_date + g, 'open', coalesce(l.assigned_to, $2) from public.leads l cross join generate_series(1, 2) g where l.organization_id=$1`, [S.org, S.owner]);
  const inv = ok(await rpc(S.owner, 'invoice_save_draft', { p_org: S.org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '10', tax_keys: [] }] })); ok(await rpc(S.owner, 'invoice_issue', { p_org: S.org, p_id: inv }));
  const queries = ['Lead 123', 'lead 19', '99000123', '+919900001', '@mail.test', 'pricing', 'Call 7', 'zzzz', 'Lead', 'ad 12', '%', 'a_b', 'INV']; let compared = 0;
  for (const user of [S.owner, MGR, ADM, EMP, EMP2]) { for (const text of queries) for (const types of [null, ['lead'], ['task'], ['invoice']]) { const args = [S.org, text, types, 20, 0]; const a = (await asUser(user, 'select public.global_search_original($1,$2,$3::text[],$4,$5) r', args))[0].r, b = (await asUser(user, 'select public.global_search($1,$2,$3::text[],$4,$5) r', args))[0].r; assert.deepEqual(b, a, `search differs for ${user.slice(-2)} / "${text}" / ${types}`); compared++; }
    const ha = (await asUser(user, `select public.home_summary_original($1,'Asia/Kolkata') r`, [S.org]))[0].r, hb = (await asUser(user, `select public.home_summary($1,'Asia/Kolkata') r`, [S.org]))[0].r; assert.deepEqual(hb, ha, `home summary differs for ${user.slice(-2)}`); compared++; }
  assert.ok(compared >= 200); const emp = (await asUser(EMP, `select public.global_search($1,'Lead 1',null,50,0) r`, [S.org]))[0].r.items; assert.ok(emp.every(i => i.type !== 'invoice'), 'employees never see invoices'); assert.ok(emp.length > 0);
  const stranger = uid('b8'); await q(`insert into auth.users values ($1,'s@x.test') on conflict do nothing`, [stranger]); await assert.rejects(asUser(stranger, `select public.search_candidates($1,'%a%','a%','',false,10)`, [S.org]), e => e.code === '42501', 'a stranger cannot even ask for candidates'); assert.rejects(asUser(stranger, `select public.home_summary($1,'UTC')`, [S.org]), e => e.code === '42501');
  console.log(`# ${compared} role/query/type comparisons identical before and after the change`);
});

test('[perf] 60 simultaneous writers: no failures, no lost writes, latency stays bounded', async () => {
  const before = (await q('select count(*)::int n from public.leads where organization_id=$1', [O.org]))[0].n;
  const rs = await Promise.all(Array.from({ length: 60 }, (_, i) => rpc([O.owner, MGR, ADM][i % 3], 'crm_create_lead', { p_org: O.org, p_full_name: `Burst ${i}`, p_phone: `+9188${String(10000000 + i)}`, p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null })));
  assert.deepEqual(rs.filter(r => r.error).map(r => r.error.message), [], 'no write failed'); const lat = rs.map(r => r.t1 - r.t0).sort((a, b) => a - b); const p95 = lat[Math.floor(lat.length * 0.95)]; report.burstP95 = p95; console.log(`# 60 concurrent lead creations: p95 ${p95} ms, max ${lat.at(-1)} ms`);
  assert.equal((await q('select count(*)::int n from public.leads where organization_id=$1', [O.org]))[0].n, before + 60, 'exactly the 60 new leads exist'); assert.ok(p95 < 3000, `p95 ${p95} ms`);
  assert.equal((await q(`select count(*)::int n from public.lead_activities a join public.leads l on l.id=a.lead_id join public.contacts c on c.id=l.contact_id where l.organization_id=$1 and c.full_name like 'Burst %' and a.kind='created'`, [O.org]))[0].n, 60, 'each has its activity: the writes were atomic');
});

const invariants = async (qq, org) => ({
  paymentsEqualLedger: (await qq(`select count(*)::int n from public.invoice_payments p where p.organization_id=$1 and not exists (select 1 from public.invoice_ledger l where l.ref_id=p.id)`, [org]))[0].n,
  negativeBalances: (await qq(`select count(*)::int n from public.invoices i where i.organization_id=$1 and i.status='issued' and public.billing_balance(i.id) < 0`, [org]))[0].n,
  leadsWithoutContact: (await qq(`select count(*)::int n from public.leads l where l.organization_id=$1 and not exists (select 1 from public.contacts c where c.id=l.contact_id)`, [org]))[0].n,
  leadsWithoutCreatedActivity: (await qq(`select count(*)::int n from public.leads l where l.organization_id=$1 and not exists (select 1 from public.lead_activities a where a.lead_id=l.id and a.kind='created')`, [org]))[0].n,
});

test('[recovery] a physical backup restored into a NEW server keeps every row, policy and function, and the restored database works', async () => {
  const { org, owner } = O; const inv = ok(await rpc(owner, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '1000', tax_keys: [] }] })); ok(await rpc(owner, 'invoice_issue', { p_org: org, p_id: inv }));
  ok(await rpc(owner, 'payment_record', { p_org: org, p_invoice: inv, p_amount: 250, p_method: 'cash', p_reference: 'r', p_note: null, p_received: null, p_key: 'bk' }));
  const counts = async qq => (await qq(`select (select count(*) from public.leads)::int leads, (select count(*) from public.tasks)::int tasks, (select count(*) from public.notifications)::int notifications, (select count(*) from public.invoice_payments)::int payments, (select count(*) from pg_policies where schemaname='public')::int policies, (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')::int functions, (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='i')::int indexes`))[0];
  const want = await counts(q); await q('checkpoint');
  // a consistent file-level backup: stop the server cleanly, copy the data directory, start a SECOND server from the copy (what a snapshot restore does)
  await env.pool.end().catch(() => {}); await env.server.stop(); const copy = join(tmpdir(), `optizen-restore-${process.pid}-${Date.now()}`); cpSync(env.dir, copy, { recursive: true }); chmodSync(copy, 0o700); /* PostgreSQL refuses a data directory that is group/world accessible */ assert.ok(existsSync(join(copy, 'PG_VERSION')), 'a data directory was copied');
  const restored = await startPg({ attach: copy }); cleanup.push(() => restored.stop({ remove: true }));
  assert.deepEqual(await counts(restored.q), want, 'every row, policy, function and index came back'); assert.deepEqual(await invariants(restored.q, org), { paymentsEqualLedger: 0, negativeBalances: 0, leadsWithoutContact: 0, leadsWithoutCreatedActivity: 0 });
  assert.equal(Number((await restored.q('select public.billing_balance($1) b', [inv]))[0].b), 750, 'money balances match');
  // row-level security and the function grants survived: a stranger still sees nothing and an authorized call still works
  const stranger = uid('b9'); await restored.q(`insert into auth.users values ($1,'stranger@x.test') on conflict do nothing`, [stranger]); assert.deepEqual(await restored.asUser(stranger, 'select id from public.leads where organization_id=$1 limit 5', [org]), [], 'row security is intact after the restore');
  await assert.rejects(restored.asUser(owner, 'insert into public.leads (organization_id) values ($1)', [org]), e => e.code === '42501', 'table privileges are intact');
  const made = await restored.rpc(owner, 'crm_create_lead', { p_org: org, p_full_name: 'After restore', p_phone: '+919777700001', p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null }); assert.equal(made.error, null, made.error?.message);
  const dup = await restored.rpc(owner, 'payment_record', { p_org: org, p_invoice: inv, p_amount: 250, p_method: 'cash', p_reference: 'r', p_note: null, p_received: null, p_key: 'bk' }); assert.equal(dup.error, null); assert.equal(Number((await restored.q('select public.billing_balance($1) b', [inv]))[0].b), 750, 'idempotency keys survive the restore: replaying a payment does not double it');
  report.restoredRows = want; await restored.stop({ remove: true }); const again = await startPg(); env = again; ({ rpc, q, asUser } = again); // fresh server for the crash drill
});

test('[recovery] killing the database server in the middle of a payment storm loses no committed payment and breaks no invariant', async () => {
  const { org, owner } = await fresh(); const invs = []; for (let i = 0; i < 6; i++) { const d = ok(await rpc(owner, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: null, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '10000', tax_keys: [] }] })); ok(await rpc(owner, 'invoice_issue', { p_org: org, p_id: d })); invs.push(d); }
  const acked = []; let stop = false; const writers = Array.from({ length: 12 }, async (_, w) => { for (let i = 0; !stop; i++) { const key = `w${w}-${i}`; const r = await rpc(owner, 'payment_record', { p_org: org, p_invoice: invs[(w + i) % 6], p_amount: 5, p_method: 'cash', p_reference: key, p_note: null, p_received: null, p_key: key }).catch(() => ({ error: { message: 'connection lost' } })); if (!r.error) acked.push(key); else if (/terminat|connection|ECONN|closed/i.test(r.error.message)) return; } });
  await new Promise(r => setTimeout(r, 1500)); const pid = Number(readFileSync(join(env.dir, 'postmaster.pid'), 'utf8').split('\n')[0]); process.kill(pid, 'SIGKILL'); stop = true; await Promise.allSettled(writers); assert.ok(acked.length > 20, `${acked.length} payments were acknowledged before the crash`);
  await env.pool.end().catch(() => {}); const copy = join(tmpdir(), `optizen-crash-${process.pid}-${Date.now()}`); cpSync(env.dir, copy, { recursive: true }); chmodSync(copy, 0o700); // the crashed data directory, exactly as the kill left it
  const back = await startPg({ attach: copy }); cleanup.push(() => back.stop({ remove: true }));
  const have = new Set((await back.q(`select idempotency_key k from public.invoice_payments where organization_id=$1`, [org])).map(r => r.k)); const lost = acked.filter(k => !have.has(k)); assert.deepEqual(lost, [], 'every payment that was acknowledged to a caller survived the crash');
  assert.deepEqual(await invariants(back.q, org), { paymentsEqualLedger: 0, negativeBalances: 0, leadsWithoutContact: 0, leadsWithoutCreatedActivity: 0 }, 'no half-written payment: each has its ledger entry');
  assert.equal((await back.q(`select count(*)::int n from public.invoice_payments p where p.organization_id=$1 and not exists (select 1 from public.audit_events a where a.payload->>'payment_id' = p.id::text and a.event_name='payment.received')`, [org]))[0].n, 0, 'each payment has its audit entry');
  const r = await back.rpc(owner, 'payment_record', { p_org: org, p_invoice: invs[0], p_amount: 5, p_method: 'cash', p_reference: 'post', p_note: null, p_received: null, p_key: 'post-crash' }); assert.equal(r.error, null, 'the recovered database accepts new work'); console.log(`# crash drill: ${acked.length} acknowledged payments, ${have.size} present after recovery`);
});
