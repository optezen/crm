// `npm run test:security`: security audit on a REAL PostgreSQL server with the Supabase default grants emulated.
// Catalog invariants (what the database allows), direct API attempts as a signed-in stranger, tenant isolation across EVERY table, field-level privacy,
// invitation security and a PII canary scan of every column. Throwaway server; no network.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPg, uid, EMP, EMP2, MGR, ADM } from './pgenv.mjs';

let env, rpc, q, asUser;
before(async () => { env = await startPg(); ({ rpc, q, asUser } = env); });
after(async () => { await env?.stop(); });

const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'] } };
const OPS = { ...BASE, operations: { appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: false }, inventory: { enabled: true, allow_negative_stock: false, track_batches: false, track_expiry: false }, billing: { enabled: true, currency: 'INR', invoice_prefix: 'INV', credit_note_prefix: 'CN', default_due_days: 14, taxes: [] } } };
const ok = r => { assert.equal(r.error, null, r.error?.message); return r.data; };
let seq = 70;
async function fresh(members = true) {
  const owner = uid(String(seq++)); await q(`insert into auth.users values ($1,$2) on conflict do nothing`, [owner, `o${seq}@x.test`]);
  const org = String(ok(await rpc(owner, 'create_workspace', { p_name: `Sec ${seq}`, p_description: null, p_preset: null, p_definition: BASE })));
  if (members) for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) ok(await rpc(owner, 'crm_add_member', { p_org: org, p_email: e, p_role: r }));
  ok(await rpc(owner, 'save_workspace_draft', { p_org: org, p_definition: OPS })); ok(await rpc(owner, 'publish_workspace_config', { p_org: org }));
  return { org, owner };
}
const CANARY_PHONE = '+919876500123', CANARY_EMAIL = 'canary.person@canary-mail.test', CANARY_NOTE = 'CANARY-NOTE-7731';
const seed = async () => {
  const A = await fresh(); const B = await fresh(false); const o = A.owner, org = A.org;
  const lead = ok(await rpc(o, 'crm_create_lead', { p_org: org, p_full_name: 'Canary Person', p_phone: CANARY_PHONE, p_email: CANARY_EMAIL, p_source: 'website', p_summary: CANARY_NOTE, p_stage: null, p_assigned_to: MGR }));
  const contact = (await q('select contact_id c from public.leads where id=$1', [lead]))[0].c;
  ok(await rpc(o, 'crm_create_task', { p_org: org, p_lead: lead, p_title: 'Call', p_due: new Date(Date.now() + 864e5).toISOString(), p_owner: MGR }).then(r => r.error ? { error: null, data: null } : r));
  const L = ok(await rpc(o, 'inventory_location_save', { p_org: org, p_id: null, p_name: 'Main', p_active: true })); const P = ok(await rpc(o, 'product_save', { p_org: org, p_id: null, p_sku: 'S-1', p_name: 'Thing', p_unit: 'pcs', p_track_batches: false, p_threshold: null, p_active: true, p_custom: null }));
  ok(await rpc(o, 'stock_receive', { p_org: org, p_product: P, p_location: L, p_qty: 10, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }));
  const inv = ok(await rpc(o, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: contact, p_lead: lead, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'x', quantity: '1', unit_price: '500', tax_keys: [] }] })); ok(await rpc(o, 'invoice_issue', { p_org: org, p_id: inv }));
  ok(await rpc(o, 'payment_record', { p_org: org, p_invoice: inv, p_amount: 100, p_method: 'cash', p_reference: 'r', p_note: null, p_received: null, p_key: 'k1' }));
  const conn = ok(await rpc(o, 'integration_create_connection', { p_org: org, p_provider: 'website_forms', p_name: 'Site', p_config: {} }));
  ok(await rpc(null, 'integration_ingest_form', { p_public_id: conn.public_id, p_secret: conn.secret, p_payload: { name: 'Form Person', email: 'form.person@x.test', phone: '+919876500999' }, p_idem: 'seed-1', p_meta: {} }));
  const wf = ok(await rpc(o, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: 'W', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'create_task', title: 'T {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] } })); ok(await rpc(o, 'automation_publish', { p_org: org, p_workflow: wf, p_enable: true }));
  await rpc(o, 'crm_create_lead', { p_org: org, p_full_name: 'Second', p_phone: '+919876500777', p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null }); await rpc(null, 'automation_tick', { p_dispatch: 50, p_runs: 20 }, 'service_role');
  return { A, B, lead, contact, inv, conn, wf };
};
let S; const seeded = async () => (S ??= await seed());
const sig = 'p.proname || \'(\' || pg_get_function_identity_arguments(p.oid) || \')\'';
const fnq = where => q(`select ${sig} s from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e') and ${where} order by 1`).then(r => r.map(x => x.s));
const names = l => l.map(s => s.split('(')[0]);

test('[security][catalog] every SECURITY DEFINER function pins search_path; every table has RLS; no table or write privilege is granted to browsers', async () => {
  assert.deepEqual(await fnq(`p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')`), [], 'definer functions without a fixed search_path');
  assert.deepEqual((await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity`)).map(r => r.relname), [], 'tables without row level security');
  assert.deepEqual(await q(`select table_name from information_schema.role_table_grants where grantee='anon' and table_schema='public'`), [], 'anonymous table access');
  assert.deepEqual(await q(`select table_name, privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`), [], 'signed-in users can only write through functions');
  assert.deepEqual((await q(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','m') and not coalesce(c.reloptions::text,'') like '%security_invoker=true%'`)).map(r => r.relname), [], 'views must run with the caller\'s permissions');
  assert.deepEqual(await q(`select p.relname, a.attname from pg_attribute a join pg_class p on p.oid=a.attrelid join pg_namespace n on n.oid=p.relnamespace where n.nspname='public' and p.relkind='r' and a.attnum>0 and not a.attisdropped and (a.attname ~ '(secret_hash|ciphertext|token_hash|password|api_key|access_token)') and has_column_privilege('authenticated', p.oid, a.attnum, 'SELECT') and p.relname <> 'integration_credentials'`), [], 'secret-bearing columns readable by browsers');
  assert.equal((await q(`select has_column_privilege('authenticated','public.integration_credentials','ciphertext','SELECT') a, has_column_privilege('authenticated','public.integration_connections','secret_hash','SELECT') b, has_column_privilege('authenticated','public.invitations','token_hash','SELECT') c`))[0].a, false);
  const r = (await q(`select has_column_privilege('authenticated','public.integration_connections','secret_hash','SELECT') b, has_column_privilege('authenticated','public.invitations','token_hash','SELECT') c`))[0]; assert.deepEqual([r.b, r.c], [false, false]);
});

test('[security][catalog] the anonymous API exposes exactly the secret-gated entry points; internal and worker functions are not callable from the browser', async () => {
  assert.deepEqual(names(await fnq(`p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`)), ['integration_ingest_form', 'integration_receive_webhook', 'payment_gateway_connection', 'payment_gateway_receive']);
  assert.deepEqual(await fnq(`not p.prosecdef and has_function_privilege('anon', p.oid, 'execute')`), [], 'no invoker function is callable anonymously');
  const noAuth = await fnq(`p.prosecdef and has_function_privilege('authenticated', p.oid, 'execute') and p.prorettype <> 'trigger'::regtype and p.prosrc !~* '(auth\\.uid|crm_member_role|org_role|ops_require|integration_admin|perm_|member_role|require_|contact_details_visible|record_data_for|ai_ctx)'`);
  assert.deepEqual(names(noAuth), ['integration_ingest_form', 'integration_receive_webhook', 'payment_gateway_connection', 'payment_gateway_receive'], 'definer functions callable by signed-in users without an authorization check must be only the secret-gated ones');
  const internal = ['automation_tick', 'automation_dispatch', 'automation_execute', 'maintenance_tick', 'reminders_process', 'worker_heartbeat', 'integration_claim_events', 'integration_claim_requests', 'integration_complete_request', 'integration_fail_event', 'integration_ingest_lead', 'integration_purge', 'integration_apply_status_events', 'integration_set_gateway_secret', 'payment_gateway_apply', 'notif_enabled', 'notif_task_assigned', 'notif_lead_assigned'];
  const exposed = await q(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any($1) and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))`, [internal]); assert.deepEqual(exposed, [], 'internal functions are not part of the browser API');
});

test('[security][isolation] a signed-in stranger sees no row of another organization in ANY table, and cannot write or call anything against it', async () => {
  const { A, B } = await seeded(); const tables = (await q(`select c.relname t, c.relkind k from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attname='organization_id' where n.nspname='public' and c.relkind in ('r','v')`)); const base = tables.filter(t => t.k === 'r').map(t => t.t); const tableNames = tables.map(t => t.t);
  assert.ok(base.length > 40, `found ${base.length} organization-scoped tables`); let withData = 0;
  for (const t of tableNames) {
    const mine = await q(`select count(*)::int n from public.${t} where organization_id=$1`, [A.org]); if (mine[0].n) withData++;
    const rows = await asUser(B.owner, `select count(*)::int n from public.${t} where organization_id=$1`, [A.org]).catch(e => { if (e.code === '42501') return [{ n: 0 }]; throw e; }); assert.equal(rows[0].n, 0, `${t}: a stranger can read ${rows[0].n} rows of another organization (${mine[0].n} exist)`);
    const own = await asUser(A.owner, `select count(*)::int n from public.${t} where organization_id=$1`, [A.org]).catch(e => { if (e.code === '42501') return [{ n: 0 }]; throw e; }); assert.ok(own[0].n <= mine[0].n);
  }
  assert.ok(withData >= 20, `the seed filled ${withData} tables, so the isolation check is meaningful`);
  // direct writes to tables are impossible for signed-in users (no privilege), whatever the organization
  for (const t of base) for (const sql of [`insert into public.${t} (organization_id) values ('${A.org}')`, `update public.${t} set organization_id = organization_id where organization_id='${A.org}'`, `delete from public.${t} where organization_id='${A.org}'`]) await assert.rejects(asUser(B.owner, sql), e => ['42501', '42809'].includes(e.code), `${t}: ${sql.split(' ')[0]} must be refused`);
  // functions: the stranger passes the real organization id and real object ids
  const attempts = [['crm_create_lead', { p_org: A.org, p_full_name: 'X', p_phone: '+919800000001', p_email: null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null }], ['crm_add_member', { p_org: A.org, p_email: 'adm@x.test', p_role: 'admin' }], ['invoice_issue', { p_org: A.org, p_id: S.inv }], ['payment_record', { p_org: A.org, p_invoice: S.inv, p_amount: 1, p_method: 'cash', p_reference: 'x', p_note: null, p_received: null, p_key: null }],
    ['automation_publish', { p_org: A.org, p_workflow: S.wf, p_enable: false }], ['integration_rotate_secret', { p_org: A.org, p_conn: S.conn.id }], ['integration_create_connection', { p_org: A.org, p_provider: 'website_forms', p_name: 'x', p_config: {} }], ['worker_status', { p_org: A.org }], ['outbound_messages_recent', { p_org: A.org, p_limit: 5 }], ['payment_reconcile', { p_org: A.org }],
    ['consent_set', { p_org: A.org, p_contact: S.contact, p_status: 'opted_in', p_source: 'staff', p_note: null }], ['integration_requeue_request', { p_org: A.org, p_request: uid('01') }], ['save_workspace_draft', { p_org: A.org, p_definition: BASE }], ['invite_create', { p_org: A.org, p_email: 'z@x.test', p_role: 'employee' }],
    ['integration_read_credentials', { p_org: A.org, p_conn: S.conn.id }], ['ai_create_conversation', { p_org: A.org, p_title: 'x' }], ['stock_receive', { p_org: A.org, p_product: uid('01'), p_location: uid('01'), p_qty: 1, p_lot: null, p_expiry: null, p_supplier: null, p_purchase_ref: null, p_reason: null }]];
  const before = (await q(`select count(*)::int n from public.leads where organization_id=$1`, [A.org]))[0].n;
  for (const [fn, args] of attempts) { const r = await rpc(B.owner, fn, args); assert.ok(r.error, `${fn} must fail for a stranger`); assert.ok(['42501', 'P0002', '22023'].includes(r.error.code), `${fn}: expected a clean authorization failure, got ${r.error.code} ${r.error.message}`); }
  assert.equal((await q(`select count(*)::int n from public.leads where organization_id=$1`, [A.org]))[0].n, before, 'nothing was created');
});

test('[security][privacy] contact details and secrets: no direct column access; visible only through the authorized functions; other organizations and unrelated employees get nothing', async () => {
  const { A, B, contact, conn } = await seeded();
  for (const col of ['phone', 'email']) await assert.rejects(asUser(A.owner, `select ${col} from public.contacts`), e => e.code === '42501', `contacts.${col} is not directly readable, even by the owner`);
  assert.equal((await asUser(A.owner, 'select public.contact_phone($1) p, public.contact_email($1) e', [contact]))[0].p, CANARY_PHONE); assert.equal((await asUser(B.owner, 'select public.contact_phone($1) p, public.contact_email($1) e', [contact]))[0].p, null, 'another organization gets null');
  const emp = (await asUser(EMP, 'select public.contact_phone($1) p', [contact]))[0].p; assert.notEqual(emp, CANARY_PHONE, 'an employee with no relationship to the lead does not see the phone number');
  for (const sql of ['select ciphertext from public.integration_credentials', 'select secret_hash from public.integration_connections', 'select token_hash from public.invitations']) for (const u of [A.owner, EMP, B.owner]) await assert.rejects(asUser(u, sql), e => e.code === '42501', sql);
  assert.equal((await asUser(A.owner, 'select count(*)::int n from public.integration_connections where id=$1', [conn.id]))[0].n, 1);
  const raw = await q('select secret_hash from public.integration_connections where id=$1', [conn.id]); assert.ok(!raw[0].secret_hash.includes(conn.secret) && raw[0].secret_hash.length >= 40, 'only a hash of the connection secret is stored');
  // invoices: financial data is limited to billing roles; an unrelated employee sees no invoice or payment rows
  assert.deepEqual(await asUser(EMP2, 'select id from public.invoices'), []); assert.deepEqual(await asUser(EMP2, 'select id from public.invoice_payments'), []); assert.ok((await asUser(A.owner, 'select id from public.invoice_payments')).length >= 1);
  assert.equal((await rpc(EMP2, 'invoice_snapshot', { p_org: A.org, p_invoice: S.inv })).data ?? null, null);
});

test('[security][invitations] tokens are random, stored hashed, single-use, expiring, revocable and bound to one email; only owners and admins invite and only owners invite admins', async () => {
  const { A } = await seeded(); const mk = (email = 'newbie@x.test', role = 'employee', by = A.owner) => rpc(by, 'invite_create', { p_org: A.org, p_email: email, p_role: role });
  const NEW = uid('a1'), OTHER = uid('a2'); await q(`insert into auth.users values ($1,'newbie@x.test'),($2,'stranger@x.test') on conflict do nothing`, [NEW, OTHER]);
  const inv = ok(await mk()); assert.ok(inv.token.length >= 32, 'long token'); const tokens = new Set([inv.token]); for (let i = 0; i < 5; i++) tokens.add(ok(await mk(`t${i}@x.test`)).token); assert.equal(tokens.size, 6, 'tokens are unique');
  const stored = await q('select token_hash from public.invitations where organization_id=$1', [A.org]); assert.ok(stored.every(r => r.token_hash !== inv.token && /^[0-9a-f]{64}$/.test(r.token_hash)), 'only hashes are stored');
  const bad = async (p, code) => { const r = await p; assert.ok(r.error, 'expected failure'); assert.equal(r.error.code, code, r.error.message); };
  await bad(rpc(OTHER, 'invite_accept', { p_token: inv.token }), '42501'); await bad(rpc(null, 'invite_accept', { p_token: inv.token }, 'anon'), '42501'); await bad(rpc(NEW, 'invite_accept', { p_token: 'x'.repeat(40) }), '22023');
  const race = await Promise.all([rpc(NEW, 'invite_accept', { p_token: inv.token }), rpc(NEW, 'invite_accept', { p_token: inv.token }), rpc(OTHER, 'invite_accept', { p_token: inv.token })]); assert.equal(race.filter(r => !r.error).length >= 1 && race[2].error !== null, true);
  assert.equal((await q(`select count(*)::int n from public.organization_members where organization_id=$1 and user_id=$2`, [A.org, NEW]))[0].n, 1, 'joined exactly once'); assert.equal((await q(`select role from public.organization_members where organization_id=$1 and user_id=$2`, [A.org, NEW]))[0].role, 'employee');
  await bad(rpc(OTHER, 'invite_accept', { p_token: inv.token }), '22023'); // used tokens are dead for everyone
  const inv2 = ok(await mk('later@x.test')); await q(`update public.invitations set expires_at = now() - interval '1 minute' where token_hash = public.invite_hash($1)`, [inv2.token]); const LATER = uid('a3'); await q(`insert into auth.users values ($1,'later@x.test') on conflict do nothing`, [LATER]); await bad(rpc(LATER, 'invite_accept', { p_token: inv2.token }), '22023');
  const inv3 = ok(await mk('revoked@x.test')); ok(await rpc(A.owner, 'invite_revoke', { p_org: A.org, p_id: inv3.id })); const REV = uid('a4'); await q(`insert into auth.users values ($1,'revoked@x.test') on conflict do nothing`, [REV]); await bad(rpc(REV, 'invite_accept', { p_token: inv3.token }), '22023');
  await bad(rpc(EMP, 'invite_create', { p_org: A.org, p_email: 'e@x.test', p_role: 'employee' }), '42501'); await bad(rpc(MGR, 'invite_create', { p_org: A.org, p_email: 'm@x.test', p_role: 'employee' }), '42501'); await bad(rpc(ADM, 'invite_create', { p_org: A.org, p_email: 'a@x.test', p_role: 'admin' }), '42501'); await bad(rpc(A.owner, 'invite_create', { p_org: A.org, p_email: 'o@x.test', p_role: 'owner' }), '22023');
});

test('[security][exposure] personal data (phone, email, notes) is not copied into logs, audit trails, errors, notifications, heartbeats or AI records', async () => {
  const { A, lead } = await seeded(); const o = A.owner;
  // generate every kind of record that could carry text: AI tool calls, messaging requests, delivery logs, errors, notifications, exports
  const conv = ok(await rpc(o, 'ai_create_conversation', { p_org: A.org, p_title: 'x' })); await rpc(o, 'ai_tool_get_lead', { p_org: A.org, p_lead: lead, p_include_contact: false }); await rpc(o, 'ai_tool_list_leads', { p_org: A.org, p_stage: null, p_source: null, p_assignee: null, p_search: null, p_limit: 10, p_offset: 0 });
  await rpc(null, 'worker_heartbeat', { p_worker: 'automation', p_instance: 'i', p_version: 'v', p_stats: { ticks: 1 }, p_error: 'Error' }, 'service_role'); await rpc(null, 'maintenance_tick', {}, 'service_role');
  const cols = await q(`select c.relname t, a.attname col from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped and a.atttypid in ('text'::regtype,'jsonb'::regtype,'varchar'::regtype) order by 1,2`); assert.ok(cols.length > 150, `scanned ${cols.length} text columns`);
  const hits = {}; for (const { t, col } of cols) { const n = (await q(`select count(*)::int n from public.${t} where ${col}::text like any($1)`, [[`%${CANARY_PHONE}%`, `%${CANARY_EMAIL}%`, `%${CANARY_NOTE}%`]]))[0].n; if (n) (hits[t] ??= []).push(col); }
  // data that legitimately holds the contact: the contact/lead themselves, queued provider requests, raw inbound submissions (purged after 30 days) and the invoice snapshot taken for the customer
  assert.ok(hits.contacts && hits.leads, 'the scan finds the canary where it belongs, so an empty result elsewhere is meaningful');
  const allowed = new Set(['contacts', 'leads', 'lead_activities', 'lead_attribution', 'invoices', 'invoice_snapshots', 'integration_requests', 'integration_webhook_events', 'search_index', 'domain_events', 'automation_runs', 'automation_steps', 'lead_notes']);
  const unexpected = Object.entries(hits).filter(([t]) => !allowed.has(t)); assert.deepEqual(unexpected, [], `personal data found in tables that should never hold it: ${JSON.stringify(unexpected)}`);
  const never = ['audit_events', 'integration_errors', 'outbound_message_log', 'worker_heartbeats', 'notifications', 'ai_usage', 'ai_tool_calls', 'ai_messages', 'ai_conversations'].filter(t => hits[t]); assert.deepEqual(never, [], 'logs, audit, notifications and AI records never contain contact details');
  console.log('# tables holding the canary (reviewed):', Object.keys(hits).sort().join(', '));
});
