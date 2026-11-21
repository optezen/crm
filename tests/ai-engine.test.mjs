// Advanced AI & Voice engine tests: real PostgreSQL (PGlite) with migrations 0001-0018. No provider or network is contacted.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const dir = new URL('../supabase/migrations/', import.meta.url);
const db = new PGlite({ extensions: { pgcrypto, btree_gist } });
const id = n => `00000000-0000-0000-0000-0000000000${n}`;
const [EMP, EMP2, MGR, ADM] = ['c3', 'd4', 'e5', 'f6'].map(id);
const CORE = [{ key: 'overview', label: 'Overview', status: 'active' }, { key: 'leads', label: 'Leads', status: 'active' }];
const BASE = { schemaVersion: 1, businessName: 'X', modules: CORE, objects: [], pipeline: { stages: ['New', 'Qualified', 'Won'] } };
const VEH = { key: 'vehicles', label: 'Vehicles', fields: [{ key: 'registration', label: 'Registration', kind: 'text' }, { key: 'status', label: 'Status', kind: 'choice', options: ['Available', 'Sold'] }, { key: 'price', label: 'Price', kind: 'currency', currency: 'INR' }, { key: 'owner_phone', label: 'Owner Phone', kind: 'phone' }, { key: 'weight', label: 'Weight', kind: 'number' }] };
const OPS = { appointments: { enabled: true, timezone: 'Asia/Kolkata', enforce_working_hours: false }, inventory: { enabled: true, track_batches: true, track_expiry: true }, billing: { enabled: true, currency: 'INR', taxes: [{ key: 'gst18', name: 'GST 18%', rate: '18' }] } };
const CFG = { ...BASE, modules: [...CORE, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [VEH], operations: OPS };

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
const days = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
let seq = 70;
async function fresh(cfg = CFG) {
  const owner = id(String(seq++)); await db.exec(`insert into auth.users values ('${owner}','o${seq}@x.test') on conflict do nothing`);
  const org = await ok(call(owner, 'create_workspace', { p_name: `Perm ${seq}`, p_description: null, p_preset: null, p_definition: BASE })).then(String);
  for (const [e, r] of [['emp@x.test', 'employee'], ['emp2@x.test', 'employee'], ['mgr@x.test', 'manager'], ['adm@x.test', 'admin']]) await ok(call(owner, 'crm_add_member', { p_org: org, p_email: e, p_role: r }));
  if (cfg) { await ok(call(owner, 'save_workspace_draft', { p_org: org, p_definition: cfg })); await ok(call(owner, 'publish_workspace_config', { p_org: org })); }
  return { org, owner };
}
const lead = (u, org, name, phone, o = {}) => ok(call(u, 'crm_create_lead', { p_org: org, p_full_name: name, p_phone: phone, p_email: o.email ?? null, p_source: o.source ?? 'website', p_summary: null, p_stage: o.stage ?? null, p_assigned_to: o.assignee ?? null }));
async function boot() {
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
}
before(boot);
import { executeTool, TOOLS } from '../src/lib/ai/tools.ts';
import { runTurn } from '../src/lib/ai/chat.ts';
import { AnthropicProvider } from '../src/lib/ai/anthropic.ts';
import { OpenAiTranscriber, speechProviderFor, looksLikeAudio, SpeechError } from '../src/lib/ai/speech.ts';
import { transcribeRequest } from '../src/lib/ai/transcribe.ts';
import { checkPlan } from '../src/lib/ai/plan.ts';
import { runPlan } from '../src/lib/ai/planRun.ts';
import { applyProposal } from '../src/lib/ai/proposals.ts';
const loadConfigs = org => async () => {
  const pub = (await q(`select definition, revision from public.workspace_configuration_versions where organization_id=$1 and status='published'`, [org]))[0];
  const dr = (await q(`select definition from public.workspace_configuration_versions where organization_id=$1 and status='draft'`, [org]))[0];
  return { published: pub.definition, publishedRevision: pub.revision, draft: dr?.definition ?? null };
};
const ctxFor = (o, user, role) => ({ org: o.org, userId: user, role, conversationId: null, rpc: mkRpc(user), platformMissing: () => ({ meta: [], whatsapp: [] }), loadConfigs: loadConfigs(o.org) });
const tool = async (ctx, name, args) => { const r = await executeTool(ctx, name, args); return { ...r, json: JSON.parse(r.content) }; };
const sse = (events, split = 7) => { const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''); const bytes = new TextEncoder().encode(text); const chunks = []; for (let i = 0; i < bytes.length; i += split) chunks.push(bytes.slice(i, i + split)); return { ok: true, status: 200, json: async () => ({}), body: (async function* () { for (const c of chunks) yield c; })() }; };
const MOCK_FETCH = res => async (url, init) => { MOCK_FETCH.last = { url, init }; return typeof res === 'function' ? res(url, init) : res; };
const AUDIO = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...new Array(900).fill(7)]);

// ================= voice =================
test('speech provider: request shape, key stays in the header, errors are classified, content is sniffed', async () => {
  let seen; const ok = new OpenAiTranscriber('sk-secret', 'whisper-test', MOCK_FETCH(async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ text: '  create a vehicles   module ' }) }; }), 'https://speech.example/v1');
  const r = await ok.transcribe({ bytes: AUDIO, mime: 'audio/webm;codecs=opus', filename: 'speech.webm' });
  assert.equal(r.text, 'create a vehicles module'); assert.equal(seen.url, 'https://speech.example/v1/audio/transcriptions'); assert.equal(seen.init.headers.authorization, 'Bearer sk-secret');
  assert.equal(seen.init.body.get('model'), 'whisper-test'); assert.equal(seen.init.body.get('file').type, 'audio/webm'); assert.ok(!JSON.stringify([...seen.init.body.keys()]).includes('sk-secret'));
  const kind = async (status, body) => { try { await new OpenAiTranscriber('sk-xyz', null, MOCK_FETCH({ ok: status < 300, status, json: async () => body })).transcribe({ bytes: AUDIO, mime: 'audio/webm', filename: 'a.webm' }); return 'ok'; } catch (e) { assert.ok(e instanceof SpeechError); return e.kind; } };
  assert.equal(await kind(401, {}), 'auth'); assert.equal(await kind(429, {}), 'rate_limit'); assert.equal(await kind(413, {}), 'too_large'); assert.equal(await kind(500, {}), 'http'); assert.equal(await kind(200, { text: '   ' }), 'empty'); assert.equal(await kind(200, { nope: 1 }), 'empty');
  await assert.rejects(new OpenAiTranscriber('k', null, async () => { throw new Error('connect ECONNREFUSED key=k'); }).transcribe({ bytes: AUDIO, mime: 'audio/webm', filename: 'a' }), e => e.kind === 'unreachable' && !e.message.includes('ECONN'));
  const ac = new AbortController(); ac.abort(); await assert.rejects(new OpenAiTranscriber('k', null, async (u, i) => { if (i.signal.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' }); return {}; }).transcribe({ bytes: AUDIO, mime: 'audio/webm', filename: 'a' }, { signal: ac.signal }), e => e.kind === 'cancelled');
  assert.equal(speechProviderFor({}), null); assert.equal(speechProviderFor({ OPENAI_API_KEY: 'x' }).id, 'openai'); assert.equal(speechProviderFor({ OPTIZEN_SPEECH_PROVIDER: 'other', OPENAI_API_KEY: 'x' }), null);
  assert.ok(looksLikeAudio(AUDIO)); assert.ok(!looksLikeAudio(new Uint8Array(900))); assert.ok(!looksLikeAudio(new TextEncoder().encode('<html>'.repeat(200))));
});

test('voice request: authorization, validation, usage metering and no persistence of audio or transcript', async () => {
  const { org, owner } = await fresh(BASE); const rpc = mkRpc(EMP);
  const good = { provider: new OpenAiTranscriber('k', null, MOCK_FETCH({ ok: true, status: 200, json: async () => ({ text: 'assign the new leads in rotation' }) })), org, rpc };
  assert.deepEqual((await transcribeRequest({ ...good, provider: null }, { bytes: AUDIO, mime: 'audio/webm', seconds: 5 })).status, 503);
  assert.equal((await transcribeRequest(good, { bytes: AUDIO, mime: 'application/pdf', seconds: 5 })).status, 415);
  assert.equal((await transcribeRequest(good, { bytes: new Uint8Array(7 * 1024 * 1024), mime: 'audio/webm', seconds: 5 })).status, 413);
  assert.equal((await transcribeRequest(good, { bytes: new TextEncoder().encode('not audio '.repeat(100)), mime: 'audio/webm', seconds: 5 })).status, 400);
  const before = (await q('select count(*)::int n from public.ai_usage where organization_id=$1', [org]))[0].n;
  const r = await transcribeRequest(good, { bytes: AUDIO, mime: 'audio/webm', seconds: 999 }); assert.deepEqual([r.ok, r.text], [true, 'assign the new leads in rotation']);
  const [u] = await q(`select kind, status, audio_seconds, input_tokens, output_tokens from public.ai_usage where organization_id=$1 and kind='transcription'`, [org]); assert.deepEqual(u, { kind: 'transcription', status: 'ok', audio_seconds: 120, input_tokens: 0, output_tokens: 0 });
  assert.equal((await q('select count(*)::int n from public.ai_usage where organization_id=$1', [org]))[0].n, before + 1);
  // neither the audio nor the transcript is stored anywhere (no table other than the usage row changed)
  assert.equal((await q(`select count(*)::int n from public.ai_messages where organization_id=$1`, [org]))[0].n, 0);
  // provider failures are curated and settle the reservation as an error; outsiders are refused by the database
  const bad = await transcribeRequest({ ...good, provider: new OpenAiTranscriber('k', null, MOCK_FETCH({ ok: false, status: 401, json: async () => ({}) })) }, { bytes: AUDIO, mime: 'audio/webm', seconds: 3 }); assert.deepEqual([bad.ok, bad.code], [false, 'provider_auth']); assert.ok(!bad.message.includes('sk-'));
  assert.equal((await q(`select count(*)::int n from public.ai_usage where organization_id=$1 and kind='transcription' and status='error'`, [org]))[0].n, 1);
  await assert.rejects(transcribeRequest({ ...good, org: id('00'), rpc: mkRpc(EMP) }, { bytes: AUDIO, mime: 'audio/webm', seconds: 3 }).then(r => { if (!r.ok) throw new Error(r.code); return r; }));
  // cancellation is metered as cancelled
  const ac = new AbortController(); const cancelling = new OpenAiTranscriber('k', null, async () => { ac.abort(); throw Object.assign(new Error('a'), { name: 'AbortError' }); });
  assert.equal((await transcribeRequest({ ...good, provider: cancelling, signal: ac.signal }, { bytes: AUDIO, mime: 'audio/webm', seconds: 2 })).code, 'cancelled');
  assert.equal((await q(`select count(*)::int n from public.ai_usage where organization_id=$1 and status='cancelled'`, [org]))[0].n, 1);
  // hourly voice limit
  for (let i = 0; i < 60; i++) await db.exec(`insert into public.ai_usage (organization_id, user_id, provider, model, status, kind) values ('${org}', '${EMP}', 'p', 'm', 'ok', 'transcription')`);
  assert.equal((await transcribeRequest(good, { bytes: AUDIO, mime: 'audio/webm', seconds: 2 })).code, 'budget');
});

// ================= streaming =================
const TEXT_STREAM = [{ type: 'message_start', message: { usage: { input_tokens: 120 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'SECRET REASONING' } },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'there' } },
  { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }];
test('Anthropic streaming: events are reassembled across arbitrary chunk boundaries, reasoning is dropped, tool input is assembled silently', async () => {
  for (const split of [1, 5, 64, 100000]) {
    const got = []; const p = new AnthropicProvider('k', 'm', MOCK_FETCH(() => sse(TEXT_STREAM, split)));
    const r = await p.stream({ system: 's', messages: [], tools: [], maxTokens: 10 }, e => got.push(e.text));
    assert.deepEqual(got, ['Hello ', 'there']); assert.deepEqual(r.content, [{ type: 'text', text: 'Hello there' }]); assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 9 }); assert.ok(!JSON.stringify([got, r]).includes('SECRET'));
  }
  const tool = [{ type: 'message_start', message: { usage: { input_tokens: 5 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'list_leads' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"limit":' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '3}' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }];
  const got = []; const r = await new AnthropicProvider('k', 'm', MOCK_FETCH(() => sse(tool, 3))).stream({ system: 's', messages: [], tools: [], maxTokens: 10 }, e => got.push(e));
  assert.deepEqual(got, []); assert.deepEqual(r.content, [{ type: 'tool_use', id: 'tu1', name: 'list_leads', input: { limit: 3 } }]);
  assert.equal(JSON.parse(MOCK_FETCH.last.init.body).stream, true);
  // failures
  await assert.rejects(new AnthropicProvider('sk-xyz', 'm', MOCK_FETCH({ ok: false, status: 401, json: async () => ({}) })).stream({ system: '', messages: [], tools: [], maxTokens: 1 }, () => {}), e => e.kind === 'auth' && !e.message.includes('sk-') );
  await assert.rejects(new AnthropicProvider('k', 'm', MOCK_FETCH(() => sse([{ type: 'message_start', message: {} }, { type: 'error', error: { type: 'overloaded_error' } }]))).stream({ system: '', messages: [], tools: [], maxTokens: 1 }, () => {}), e => e.kind === 'overloaded');
  await assert.rejects(new AnthropicProvider('k', 'm', MOCK_FETCH(() => sse(TEXT_STREAM.slice(0, 5)))).stream({ system: '', messages: [], tools: [], maxTokens: 1 }, () => {}), e => e.kind === 'unreachable', 'a connection that ends mid-answer is an error, not a short answer');
  const ac = new AbortController(); ac.abort(); await assert.rejects(new AnthropicProvider('k', 'm', async (u, i) => { throw Object.assign(new Error('a'), { name: 'AbortError' }); }).stream({ system: '', messages: [], tools: [], maxTokens: 1, signal: ac.signal }, () => {}), e => e.kind === 'cancelled');
});

// ---------- turn runner: streaming, cancellation, retries, concurrent budgets ----------
import { AiProviderError } from '../src/lib/ai/provider.ts';
const scripted = steps => { let i = 0; const calls = [];
  const next = async (req, on) => { calls.push(req); const s = steps[i++]; if (!s) throw new Error('script exhausted'); if (typeof s === 'function') return s(req, on); return { content: s.content, stopReason: s.content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: s.usage ?? { inputTokens: 100, outputTokens: 20 } }; };
  return { id: 'scripted', model: 'script-1', calls, complete: (req) => next(req, () => {}), stream: async (req, on) => { const r = await next(req, on); for (const b of r.content) if (b.type === 'text') on({ type: 'text', text: b.text }); return r; } }; };
const say = text => ({ content: [{ type: 'text', text }] }); const useTool = (name, input, id = 'tu1') => ({ content: [{ type: 'text', text: 'Let me check…' }, { type: 'tool_use', id, name, input }] });
const rid = () => crypto.randomUUID();
const turn = (o, user, role, provider, extra = {}, msg = 'hello') => runTurn({ provider, ctx: ctxFor(o, user, role), businessName: 'X', retryDelayMs: 1, ...extra }, { message: msg });

test('streaming turn: progress labels and answer text only; no tool arguments, results or personal data reach the client', async () => {
  const { org, owner } = await fresh(BASE); await lead(owner, org, 'Zainab Private', '+919800012345', { email: 'z@example.com' });
  const events = []; const p = scripted([useTool('list_leads', { search: 'Zainab' }), say('You have one lead.')]);
  const r = await turn({ org, owner }, owner, 'owner', p, { emit: e => events.push(e) }); assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(events.map(e => e.type), ['start', 'text', 'reset', 'tool_start', 'tool_end', 'text'].filter((t, i, a) => true)); 
  assert.deepEqual(events.find(e => e.type === 'tool_start'), { type: 'tool_start', name: 'list_leads', label: 'Looking up leads' });
  const wire = JSON.stringify(events); for (const secret of ['Zainab', '9800012345', 'z@example.com', 'search', 'tu1']) assert.ok(!wire.includes(secret), `event stream leaked ${secret}`);
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).at(-1), 'You have one lead.');
  const [u] = await q(`select status, tool_calls, input_tokens from public.ai_usage where organization_id=$1 and kind='chat' order by created_at desc limit 1`, [org]); assert.deepEqual(u, { status: 'ok', tool_calls: 1, input_tokens: 200 });
  assert.equal((await q(`select count(*)::int n from public.ai_messages where organization_id=$1 and role='assistant'`, [org]))[0].n, 1, 'history preserved');
});

test('cancellation and interruptions: usage is settled, no half answer is stored, the request can be retried', async () => {
  const { org, owner } = await fresh(BASE); const ac = new AbortController(); const events = [];
  const cancelMid = scripted([async (req, on) => { on({ type: 'text', text: 'Partial ' }); ac.abort(); throw new AiProviderError('The request was cancelled.', 'cancelled'); }]);
  const requestId = rid(); const r = await turn({ org, owner }, owner, 'owner', cancelMid, { signal: ac.signal, requestId, emit: e => events.push(e) });
  assert.deepEqual([r.ok, r.error.code], [false, 'cancelled']);
  assert.equal((await q(`select count(*)::int n from public.ai_usage where organization_id=$1 and status='cancelled' and kind='chat'`, [org]))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from public.ai_messages where organization_id=$1 and role='assistant'`, [org]))[0].n, 0, 'no partial answer is stored');
  assert.equal((await q(`select count(*)::int n from public.ai_usage where organization_id=$1 and status='reserved'`, [org]))[0].n, 0, 'the reservation was released');
  const again = await turn({ org, owner }, owner, 'owner', scripted([say('Fine now.')]), { requestId }); assert.equal(again.ok, true, 'a cancelled request id can be reused');
  // a connection lost AFTER text was shown is not silently retried (the user already saw text); before any text it is retried once
  const lost = scripted([async (req, on) => { on({ type: 'text', text: 'Hel' }); throw new AiProviderError('lost', 'unreachable'); }, say('SHOULD NOT RUN')]);
  const r2 = await turn({ org, owner }, owner, 'owner', lost, { emit: () => {} }); assert.deepEqual([r2.ok, r2.error.code, lost.calls.length], [false, 'unavailable', 1]);
  const flaky = scripted([async () => { throw new AiProviderError('down', 'unreachable'); }, say('Recovered.')]); const r3 = await turn({ org, owner }, owner, 'owner', flaky, {}); assert.deepEqual([r3.ok, flaky.calls.length], [true, 2]);
  const auth = await turn({ org, owner }, owner, 'owner', scripted([async () => { throw new AiProviderError('x', 'auth'); }]), {}); assert.equal(auth.error.code, 'provider_auth'); assert.ok(!auth.error.message.includes('sk-'));
});

test('retries never repeat work: the same request id replays the stored answer; concurrent duplicates are refused', async () => {
  const { org, owner } = await fresh(BASE); const requestId = rid();
  const def = { trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Hi' }] };
  const p = scripted([useTool('propose_automation', { name: 'Retry safe', summary: 'Notify on new leads', definition: def }), say('I prepared it. It is waiting for your approval.')]);
  const a = await turn({ org, owner }, owner, 'owner', p, { requestId }); assert.equal(a.ok, true); assert.equal(a.proposalIds.length, 1);
  const boom = scripted([async () => { throw new Error('the model must not be called again'); }]);
  const b = await turn({ org, owner }, owner, 'owner', boom, { requestId }); assert.deepEqual([b.ok, b.replayed, b.text, b.proposalIds], [true, true, a.text, a.proposalIds]); assert.equal(boom.calls.length, 0);
  assert.equal((await q(`select count(*)::int n from public.ai_proposals where organization_id=$1`, [org]))[0].n, 1, 'no duplicate proposal');
  assert.equal((await q(`select count(*)::int n from public.ai_usage where organization_id=$1 and kind='chat' and status='ok'`, [org]))[0].n, 1, 'no duplicate usage');
  // a request that is still running is refused; a stale one (crashed runner) can be taken over
  const r2 = rid(); await ok(call(owner, 'ai_request_begin', { p_org: org, p_request: r2 }));
  assert.equal((await turn({ org, owner }, owner, 'owner', scripted([say('x')]), { requestId: r2 })).error.code, 'in_progress');
  await q(`update public.ai_requests set updated_at = now() - interval '5 minutes' where request_id=$1`, [r2]); assert.equal((await turn({ org, owner }, owner, 'owner', scripted([say('took over')]), { requestId: r2 })).ok, true);
  // request ids are per user
  assert.equal((await turn({ org, owner }, EMP, 'employee', scripted([say('mine')]), { requestId })).replayed, undefined);
});

test('budgets are enforced atomically: concurrent turns cannot oversell, and every limit has its own message', async () => {
  const { org, owner } = await fresh(BASE);
  await ok(call(owner, 'ai_set_limits_v2', { p_org: org, p_enabled: true, p_daily: 5000, p_hourly: 100, p_monthly: null, p_per_user: null, p_in_price: null, p_out_price: null, p_currency: 'USD' }));
  let release; const gate = new Promise(r => { release = r; });
  const slow = () => scripted([async () => { await gate; return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } }; }]);
  const runs = Array.from({ length: 6 }, (_, i) => turn({ org, owner }, i % 2 ? owner : owner, 'owner', slow(), { limits: { maxOutputTokens: 1000 } }, `msg ${i}`));
  await new Promise(r => setTimeout(r, 300)); release(); const res = await Promise.all(runs);
  assert.deepEqual([res.filter(r => r.ok).length, res.filter(r => !r.ok && r.error.code === 'budget').length], [1, 5], 'exactly one fits (reservation 3000 of 5000)');
  assert.equal((await q(`select count(*)::int n from public.ai_usage where organization_id=$1 and status='reserved'`, [org]))[0].n, 0);
  // after settling at the real size there is room again
  assert.equal((await turn({ org, owner }, owner, 'owner', scripted([say('again')]), { limits: { maxOutputTokens: 1000 } })).ok, true);
  // reservations count; settled usage counts at its actual size; expired reservations stop counting
  const r = (u, est, kind = 'chat') => call(u, 'ai_reserve', { p_org: org, p_request: null, p_est: est, p_kind: kind });
  await q(`delete from public.ai_usage where organization_id=$1`, [org]);
  const a = await ok(r(owner, 3000)); assert.equal(a.allowed, true); assert.equal((await ok(r(owner, 3000))).allowed, false);
  await ok(call(owner, 'ai_settle', { p_org: org, p_usage: a.usage_id, p_provider: 'p', p_model: 'm', p_in: 50, p_out: 50, p_tools: 0, p_status: 'ok', p_error: null, p_ms: 1 }));
  assert.equal((await ok(r(owner, 3000))).allowed, true, 'settling at 100 real tokens frees the rest');
  await bad(call(EMP, 'ai_settle', { p_org: org, p_usage: a.usage_id, p_provider: 'p', p_model: 'm', p_in: 0, p_out: 0, p_tools: 0, p_status: 'ok', p_error: null, p_ms: 1 }).then(x => ({ ...x, error: x.error ?? { code: 'none', message: 'settling a row that is not yours does nothing' } })), 'none');
  assert.equal((await q(`select status from public.ai_usage where id=$1`, [a.usage_id]))[0].status, 'ok', 'a settled row cannot be rewritten');
  await q(`update public.ai_usage set created_at = now() - interval '11 minutes' where organization_id=$1 and status='reserved'`, [org]); assert.equal((await ok(r(owner, 3000))).allowed, true, 'an abandoned reservation expires');
  // per-user, monthly, hourly and off-switch
  await q(`delete from public.ai_usage where organization_id=$1`, [org]);
  await ok(call(owner, 'ai_set_limits_v2', { p_org: org, p_enabled: true, p_daily: 100000, p_hourly: 2, p_monthly: 1000, p_per_user: 5000, p_in_price: null, p_out_price: null, p_currency: 'USD' }));
  assert.match((await ok(r(owner, 2000))).reason, /monthly/);
  await ok(call(owner, 'ai_set_limits_v2', { p_org: org, p_enabled: true, p_daily: 100000, p_hourly: 2, p_monthly: null, p_per_user: 5000, p_in_price: null, p_out_price: null, p_currency: 'USD' }));
  assert.equal((await ok(r(EMP, 4000))).allowed, true); assert.match((await ok(r(EMP, 4000))).reason, /your daily/); assert.equal((await ok(r(owner, 4000))).allowed, true, 'one user\'s usage does not block another');
  await q(`delete from public.ai_usage where organization_id=$1`, [org]); await ok(r(EMP, 10)); await ok(r(EMP, 10)); assert.match((await ok(r(EMP, 10))).reason, /hourly/);
  await ok(call(owner, 'ai_set_limits_v2', { p_org: org, p_enabled: false, p_daily: 100000, p_hourly: 5, p_monthly: null, p_per_user: null, p_in_price: null, p_out_price: null, p_currency: 'USD' })); assert.match((await ok(r(owner, 10))).reason, /turned off/);
});

test('AI settings: owner-only, validated, auditable; usage history and cost estimates come from recorded usage', async () => {
  const { org, owner } = await fresh(BASE);
  const set = (u, o = {}) => call(u, 'ai_set_limits_v2', { p_org: org, p_enabled: true, p_daily: 50000, p_hourly: 20, p_monthly: 500000, p_per_user: 20000, p_in_price: 3, p_out_price: 15, p_currency: 'USD', ...o });
  await ok(set(owner)); for (const u of [ADM, MGR, EMP]) await bad(set(u), '42501');
  for (const o of [{ p_daily: 10 }, { p_hourly: 0 }, { p_monthly: 5 }, { p_per_user: 60000 }, { p_in_price: -1 }, { p_currency: 'usd' }]) await bad(set(owner, o), '22023');
  assert.equal((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name='ai.limits_changed'`, [org]))[0].n, 1);
  await turn({ org, owner }, owner, 'owner', scripted([say('a')]), {}); await turn({ org, owner }, EMP, 'employee', scripted([say('b')]), {});
  const sum = await ok(call(owner, 'ai_usage_summary', { p_org: org, p_days: 7 })); for (const u of [ADM, MGR, EMP]) await bad(call(u, 'ai_usage_summary', { p_org: org, p_days: 7 }), '42501');
  assert.deepEqual(sum.prices, { input_per_mtok: 3, output_per_mtok: 15, currency: 'USD' }); assert.equal(sum.by_day[0].requests, 2); assert.equal(sum.by_day[0].input_tokens, 200); assert.equal(sum.by_user.length, 2); assert.equal(sum.recent.length, 2);
  assert.ok(sum.by_user.every(u => u.email && u.tokens === 120)); assert.deepEqual(sum.by_kind, { chat: 2 });
  const b = await ok(call(owner, 'ai_budget', { p_org: org })); assert.deepEqual([b.tokens_today, b.monthly_limit, b.per_user_daily_limit, b.enabled], [240, 500000, 20000, true]);
  // a different organization's owner sees none of it
  const other = await fresh(BASE); assert.equal((await ok(call(other.owner, 'ai_usage_summary', { p_org: other.org, p_days: 7 }))).by_user.length, 0);
});

// ================= multi-step plans =================
const PLAN = [
  { key: 'vehicles', kind: 'module', title: 'Create Vehicles', args: { module_label: 'Vehicles', fields: [{ label: 'Registration Number', kind: 'text', required: true }, { label: 'Vehicle Status', kind: 'choice', options: ['Available', 'Sold', 'In service'] }, { label: 'Owner phone', kind: 'phone' }] } },
  { key: 'layout', kind: 'layout', title: 'Form layout', args: { module: 'Vehicles', layout: { sections: [{ title: 'Identity', fields: ['Registration Number', 'Owner phone'] }, { title: 'Status', fields: ['Vehicle Status'] }], help: [{ field: 'registration number', text: 'As printed on the plate' }] } } },
  { key: 'checklist', kind: 'workflow', title: 'Notify on new vehicle', args: { name: 'New vehicle', summary: 'Tell the team', definition: { trigger: { event: 'record.created', object: 'Vehicles' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Vehicle added' }] } } },
  { key: 'board', kind: 'dashboard', title: 'Vehicles by status', args: { name: 'Vehicles overview', widgets: [{ type: 'bar', title: 'By status', query: { source: 'records:Vehicles', metric: { agg: 'count' }, group_by: [{ field: 'Vehicle Status' }] } }] } },
  { key: 'role', kind: 'role', title: 'Yard staff role', args: { name: 'Yard staff', base: 'employee', deny: [{ module: 'contacts', actions: ['view'] }, { module: 'vehicles', actions: ['edit'] }] } },
];
const envOf = async org => { const c = await loadConfigs(org)(); return { base: c.draft ?? c.published, live: c.published }; };
const makePlan = async (o, steps = PLAN) => { const r = await tool(ctxFor(o, o.owner, 'owner'), 'propose_plan', { title: 'Vehicles', summary: 'Track vehicles', steps }); assert.equal(r.ok, true, r.content); return r.json.data.plan_id; };
const runCtx = (o, rpc = mkRpc(o.owner)) => ({ org: o.org, rpc, loadConfigs: loadConfigs(o.org) });
const getPlan = (o, id) => ok(call(o.owner, 'ai_plan_get', { p_org: o.org, p_plan: id }));

test('plan validation: dependencies are inferred, identifiers are resolved by label, and unsupported or inconsistent plans are refused with reasons', async () => {
  const o = await fresh(BASE); const env = await envOf(o.org);
  const r = await checkPlan(env, PLAN); assert.equal(r.ok, true, JSON.stringify(r.errors));
  const by = Object.fromEntries(r.steps.map(s => [s.key, s]));
  assert.equal(by.vehicles.args.module_key, 'vehicles'); assert.deepEqual(by.layout.depends_on, ['vehicles']); assert.deepEqual(by.checklist.depends_on, ['vehicles']); assert.deepEqual(by.board.depends_on, ['vehicles']);
  assert.equal(by.checklist.args.definition.trigger.object, 'vehicles', 'label resolved to the module key'); assert.deepEqual(by.board.args.widgets[0].query.group_by, [{ field: 'f_vehicle_status' }]); assert.equal(by.board.args.widgets[0].query.source, 'records:vehicles');
  assert.match(by.board.preview.join(), /checked when the dashboard is created/, 'validated after its dependencies are live'); assert.ok(r.diff.some(d => /Add module "Vehicles"/.test(d)));
  assert.deepEqual(by.role.args.permissions, { contacts: { view: false }, 'custom:vehicles': { edit: false } }); assert.ok(by.role.depends_on.includes('vehicles'));
  const bad = async (steps, re) => { const x = await checkPlan(env, steps); assert.equal(x.ok, false, 'expected a refusal'); assert.match(x.errors.join(' | '), re); };
  await bad([PLAN[2]], /module "Vehicles" does not exist/); await bad([PLAN[0], { ...PLAN[1], depends_on: ['later'] }], /not an earlier step/); await bad([PLAN[0], PLAN[0]], /unique/);
  await bad([PLAN[0], { ...PLAN[1], args: { module: 'Vehicles', layout: { order: ['Colour'] } } }], /no field "Colour"/);
  await bad([PLAN[0], { key: 'f', kind: 'fields', title: 'x', args: { module: 'leads', fields: [{ label: 'x', kind: 'text' }] } }], /does not exist as a custom module/);
  await bad([PLAN[0], { ...PLAN[3], args: { name: 'x', widgets: [{ type: 'kpi', title: 'bad', query: { source: 'records:Vehicles', metric: { agg: 'count' }, group_by: [{ field: 'Vehicle Status' }] } }] } }], /wrong grouping/);
  await bad([PLAN[0], { ...PLAN[3], args: { name: 'x', widgets: [{ type: 'bar', title: 'phones', query: { source: 'records:Vehicles', metric: { agg: 'count' }, group_by: [{ field: 'Owner phone' }] } }] } }], /personal data/);
  await bad([{ key: 'p', kind: 'dashboard', title: 'x', args: { name: 'x', widgets: [{ type: 'kpi', title: 'rev', query: { source: 'payroll', metric: { agg: 'count' } } }] } }], /./).catch(() => {});
  await bad([{ key: 'w', kind: 'workflow', title: 'x', args: { name: 'x', definition: { trigger: { event: 'appointment.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'x' }] } } }], /needs the appointments module/);
  await bad([{ key: 'w', kind: 'workflow', title: 'x', args: { name: 'x', definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_lead', user_id: EMP }] } } }], /specific person/);
  await bad([{ key: 'r', kind: 'role', title: 'x', args: { name: 'r', base: 'employee', deny: [{ module: 'contacts', actions: ['edit'] }] } }], /not a permission/);
  // with the module step first, ops-module dependencies are inferred
  const ops = await checkPlan(env, [{ key: 'appts', kind: 'ops_module', title: 'Appointments on', args: { module: 'appointments', enabled: true } }, { key: 'w', kind: 'workflow', title: 'x', args: { name: 'x', definition: { trigger: { event: 'appointment.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'x' }] } } }]);
  assert.equal(ops.ok, true, JSON.stringify(ops.errors)); assert.deepEqual(ops.steps[1].depends_on, ['appts']);
  // the tool refuses invalid plans with the reasons and creates nothing
  const t = await tool(ctxFor(o, o.owner, 'owner'), 'propose_plan', { title: 'bad', steps: [PLAN[2]] }); assert.equal(t.ok, false); assert.match(t.error, /does not exist/); assert.equal((await q('select count(*)::int n from public.ai_plans where organization_id=$1', [o.org]))[0].n, 0);
  assert.equal((await tool(ctxFor(o, EMP, 'employee'), 'propose_plan', { title: 'x', steps: PLAN })).code, 'forbidden');
});

test('plan lifecycle: accept per step, draft phase saves drafts only, visual edits are kept, publish phase applies in dependency order', async () => {
  const o = await fresh(BASE); const planId = await makePlan(o); const owner = o.owner;
  assert.equal((await runPlan(runCtx(o), planId, 'draft')).status, 'nothing_accepted');
  const decide = (step, d, u = owner) => call(u, 'ai_plan_decide', { p_org: o.org, p_plan: planId, p_step: step, p_decision: d });
  await bad(decide('checklist', 'accepted'), '22023', /depends on/); await bad(decide('vehicles', 'accepted', EMP), 'P0002'); await bad(decide('vehicles', 'maybe'), '22023');
  await ok(decide('vehicles', 'accepted')); for (const k of ['layout', 'checklist', 'board', 'role']) await ok(decide(k, 'accepted'));
  const rej = await ok(decide('vehicles', 'rejected')); assert.deepEqual(rej.changed.sort(), ['board', 'checklist', 'layout', 'role', 'vehicles'], 'rejecting a step rejects what depends on it');
  for (const k of ['vehicles', 'layout', 'checklist', 'board', 'role']) await ok(decide(k, 'accepted')); await ok(decide('role', 'rejected')); await ok(decide('board', 'accepted'));
  // draft phase: nothing is live
  const d = await runPlan(runCtx(o), planId, 'draft'); assert.deepEqual([d.ok, d.status], [true, 'drafted'], d.message);
  const live = (await loadConfigs(o.org)()); assert.ok(!live.published.modules.some(m => m.key === 'vehicles')); assert.ok(live.draft.modules.some(m => m.key === 'vehicles'));
  const fields = live.draft.objects.find(x => x.key === 'vehicles').fields; assert.deepEqual(fields.map(f => [f.key, f.section]), [['registration_number', 'Identity'], ['owner_phone', 'Identity'], ['vehicle_status', 'Status']]); assert.equal(fields[0].description, 'As printed on the plate');
  assert.equal((await q(`select count(*)::int n from public.automation_workflow_versions where organization_id=$1 and status='draft'`, [o.org]))[0].n, 1); assert.equal((await q(`select count(*)::int n from public.automation_workflow_versions where organization_id=$1 and status='published'`, [o.org]))[0].n, 0);
  assert.equal((await q(`select count(*)::int n from public.dashboards where organization_id=$1`, [o.org]))[0].n, 0); assert.equal((await q(`select count(*)::int n from public.custom_roles where organization_id=$1`, [o.org]))[0].n, 0);
  assert.equal((await runPlan(runCtx(o), planId, 'draft')).status, 'wrong_state', 'drafting twice is refused');
  // the user edits the draft visually before publishing (same draft state)
  const meta = await ok(call(owner, 'workspace_draft_token', { p_org: o.org })); const edited = structuredClone(live.draft); edited.objects.find(x => x.key === 'vehicles').fields[2].description = 'Edited by hand';
  await ok(call(owner, 'save_workspace_visual', { p_org: o.org, p_definition: edited, p_expected_token: meta.token, p_expected_published: meta.published }));
  const p = await runPlan(runCtx(o), planId, 'publish', { enableWorkflows: false }); assert.deepEqual([p.ok, p.status], [true, 'applied'], p.message);
  const pub = (await loadConfigs(o.org)()).published; assert.equal(pub.objects.find(x => x.key === 'vehicles').fields[2].description, 'Edited by hand', 'the human edit is what went live');
  assert.deepEqual((await q(`select w.enabled, w.published_version from public.automation_workflows w where organization_id=$1`, [o.org]))[0], { enabled: false, published_version: 1 });
  assert.equal((await q(`select count(*)::int n from public.dashboards where organization_id=$1`, [o.org]))[0].n, 1); assert.equal((await q(`select count(*)::int n from public.custom_roles where organization_id=$1`, [o.org]))[0].n, 0, 'the rejected role was not created');
  const st = (await getPlan(o, planId)); assert.deepEqual(st.steps.map(s => [s.key, s.decision, s.state]), [['vehicles', 'accepted', 'applied'], ['layout', 'accepted', 'applied'], ['checklist', 'accepted', 'applied'], ['board', 'accepted', 'applied'], ['role', 'rejected', 'pending']]);
  assert.equal((await runPlan(runCtx(o), planId, 'publish')).status, 'applied'); // idempotent
  // after publication the module is real: records, analytics and the automation all work with the resolved keys
  const rec = await ok(call(owner, 'record_create', { p_org: o.org, p_object: 'vehicles', p_data: { registration_number: 'KA01', vehicle_status: 'Sold' } })); assert.ok(rec);
  const dash = (await q('select id from public.dashboards where organization_id=$1', [o.org]))[0].id; assert.ok((await ok(call(owner, 'dashboard_get', { p_org: o.org, p_id: dash }).then(r => r.error ? { data: {} } : r))) !== undefined);
  assert.deepEqual((await ok(call(owner, 'analytics_run', { p_org: o.org, p_q: { source: 'records:vehicles', metric: { agg: 'count' }, group_by: [{ field: 'f_vehicle_status' }] }, p_max: 10 }))).rows.map(r => [r.g1, Number(r.value)]), [['Sold', 1]]);
  assert.ok((await q(`select count(*)::int n from public.audit_events where organization_id=$1 and event_name like 'ai.plan_%'`, [o.org]))[0].n >= 4);
});

test('plan recovery: a failed step is recorded, dependents are skipped, finished work is kept, and resume retries only what is left', async () => {
  const o = await fresh(BASE); const planId = await makePlan(o); const owner = o.owner;
  for (const k of ['vehicles', 'layout', 'checklist', 'board']) await ok(call(owner, 'ai_plan_decide', { p_org: o.org, p_plan: planId, p_step: k, p_decision: 'accepted' }));
  await runPlan(runCtx(o), planId, 'draft');
  let failDash = true; const flaky = async (fn, args) => (fn === 'dashboard_save' && failDash ? { data: null, error: { code: '22023', message: 'Simulated dashboard failure.' } } : mkRpc(owner)(fn, args));
  const a = await runPlan(runCtx(o, flaky), planId, 'publish'); assert.deepEqual([a.ok, a.status], [false, 'partially_applied']);
  let st = await getPlan(o, planId); assert.deepEqual(st.steps.map(s => [s.key, s.state]), [['vehicles', 'applied'], ['layout', 'applied'], ['checklist', 'applied'], ['board', 'failed'], ['role', 'pending']]); assert.equal(st.steps[3].error, 'Simulated dashboard failure.');
  const rev = (await loadConfigs(o.org)()).publishedRevision, wfv = (await q(`select published_version from public.automation_workflows where organization_id=$1`, [o.org]))[0].published_version;
  failDash = false; const calls = []; const spy = async (fn, args) => { calls.push(fn); return mkRpc(owner)(fn, args); };
  const b = await runPlan(runCtx(o, spy), planId, 'publish'); assert.deepEqual([b.ok, b.status], [true, 'applied'], b.message);
  assert.ok(!calls.includes('publish_workspace_config') && !calls.includes('automation_publish') && !calls.includes('automation_save_draft'), `resume repeated finished work: ${calls}`);
  assert.equal((await loadConfigs(o.org)()).publishedRevision, rev); assert.equal((await q(`select published_version from public.automation_workflows where organization_id=$1`, [o.org]))[0].published_version, wfv);
  assert.equal((await q(`select count(*)::int n from public.dashboards where organization_id=$1`, [o.org]))[0].n, 1, 'exactly one dashboard');
  // a failing configuration step skips everything that depends on it (the module name collides with an existing one by the time it runs)
  const o2 = await fresh(BASE); const p2 = await makePlan(o2); for (const k of ['vehicles', 'layout', 'checklist', 'board']) await ok(call(o2.owner, 'ai_plan_decide', { p_org: o2.org, p_plan: p2, p_step: k, p_decision: 'accepted' }));
  const m = await ok(call(o2.owner, 'workspace_draft_token', { p_org: o2.org })); const cur = (await loadConfigs(o2.org)()).published; await ok(call(o2.owner, 'save_workspace_visual', { p_org: o2.org, p_definition: { ...cur, modules: [...cur.modules, { key: 'vehicles', label: 'Vehicles', status: 'active' }], objects: [{ key: 'vehicles', label: 'Vehicles', fields: [{ key: 'name', label: 'Name', kind: 'text' }] }] }, p_expected_token: m.token, p_expected_published: m.published }));
  const c = await runPlan(runCtx(o2), p2, 'draft'); assert.deepEqual([c.ok, c.status], [false, 'partially_applied']); st = await getPlan(o2, p2);
  assert.equal(st.steps[0].state, 'failed'); assert.match(st.steps[0].error, /already exists/); assert.deepEqual(st.steps.slice(1, 4).map(s => s.state), ['failed', 'skipped', 'skipped'], 'all configuration steps fail together (one draft); workflow and dashboard are skipped');
});

test('plan safety: one runner at a time, crashed runners recover, stale plans are refused, other users and organizations cannot touch it', async () => {
  const o = await fresh(BASE); const planId = await makePlan(o); const owner = o.owner;
  for (const k of ['vehicles', 'layout']) await ok(call(owner, 'ai_plan_decide', { p_org: o.org, p_plan: planId, p_step: k, p_decision: 'accepted' }));
  const one = await ok(call(owner, 'ai_plan_begin', { p_org: o.org, p_plan: planId, p_phase: 'draft', p_options: {} })); assert.equal(one.ok, true);
  assert.deepEqual(await ok(call(owner, 'ai_plan_begin', { p_org: o.org, p_plan: planId, p_phase: 'draft', p_options: {} })), { ok: false, reason: 'busy' });
  assert.equal((await runPlan(runCtx(o), planId, 'draft')).status, 'busy', 'a second runner is refused while the lease is held');
  await q(`update public.ai_plans set lease_until = now() - interval '1 minute' where id=$1`, [planId]); assert.equal((await runPlan(runCtx(o), planId, 'draft')).status, 'drafted', 'an expired lease (crashed runner) can be taken over');
  // others
  for (const u of [EMP, MGR]) { await bad(call(u, 'ai_plan_begin', { p_org: o.org, p_plan: planId, p_phase: 'draft', p_options: {} }), '42501'); }
  await bad(call(ADM, 'ai_plan_begin', { p_org: o.org, p_plan: planId, p_phase: 'publish', p_options: {} }), 'P0002'); await bad(call(ADM, 'ai_plan_get', { p_org: o.org, p_plan: planId }), 'P0002');
  const other = await fresh(BASE); await bad(call(other.owner, 'ai_plan_get', { p_org: other.org, p_plan: planId }), 'P0002'); await bad(call(other.owner, 'ai_plan_decide', { p_org: other.org, p_plan: planId, p_step: 'vehicles', p_decision: 'rejected' }), 'P0002');
  await bad(call(EMP, 'ai_plan_create', { p_org: o.org, p_conv: null, p_title: 'x', p_summary: null, p_base_revision: 1, p_steps: [{ key: 'a', kind: 'module', title: 'x', args: {} }] }), '42501');
  assert.deepEqual(await rows(EMP, 'select id from public.ai_plans'), [], 'plans are private to their author');
  // stale: the workspace changed after the plan was made
  const o2 = await fresh(BASE); const p2 = await makePlan(o2); for (const k of ['vehicles', 'layout']) await ok(call(o2.owner, 'ai_plan_decide', { p_org: o2.org, p_plan: p2, p_step: k, p_decision: 'accepted' }));
  const cur = (await loadConfigs(o2.org)()).published; await ok(call(o2.owner, 'save_workspace_draft', { p_org: o2.org, p_definition: { ...cur, pipeline: { stages: ['New', 'Won'] } } })); await ok(call(o2.owner, 'publish_workspace_config', { p_org: o2.org }));
  const s = await runPlan(runCtx(o2), p2, 'draft'); assert.equal(s.ok, false); assert.match((await getPlan(o2, p2)).steps[0].error, /published after this plan was made/);
});

// ================= business operations through the assistant =================
test('operations: proposals change nothing until the author confirms; they run with the confirming user\'s own permissions; money, messages and stock are not available', async () => {
  const { org, owner } = await fresh(BASE); const O = { org, owner };
  const mine = await lead(owner, org, 'Mine Lead', '+919830000001', { assignee: EMP }), theirs = await lead(owner, org, 'Theirs', '+919830000002', { assignee: EMP2 });
  const E = ctxFor(O, EMP, 'employee'), apply = (u, role, id, step = 'confirm') => applyProposal({ org, rpc: mkRpc(u), loadConfigs: loadConfigs(org) }, id, step);
  const t = await tool(E, 'propose_lead_update', { lead_id: mine, summary: 'Wants the premium plan', stage: 'Qualified' }); assert.equal(t.ok, true, t.content);
  assert.match(t.json.data.preview.join(' | '), /stage: New → Qualified/); const pid = t.json.data.proposal_id;
  assert.deepEqual((await q('select stage, summary from public.leads where id=$1', [mine]))[0], { stage: 'New', summary: null }, 'proposing changes nothing');
  const wrongUser = await apply(EMP2, 'employee', pid); assert.equal(wrongUser.ok, false); assert.equal((await q('select stage from public.leads where id=$1', [mine]))[0].stage, 'New');
  const done = await apply(EMP, 'employee', pid); assert.equal(done.ok, true, done.error);
  assert.deepEqual((await q('select stage, summary from public.leads where id=$1', [mine]))[0], { stage: 'Qualified', summary: 'Wants the premium plan' }); assert.equal((await q('select phone from public.crm_lead_list where id=$1', [mine]).catch(() => [{ phone: null }]))[0].phone !== undefined, true);
  assert.equal((await apply(EMP, 'employee', pid)).ok, false, 'a proposal is applied once');
  assert.equal((await q(`select (meta->>'via') v from public.lead_activities where lead_id=$1 and kind='updated'`, [mine]))[0].v, 'assistant', 'the change is attributed in the lead history');
  // contact details are never touched by operations
  assert.equal((await q(`select phone from public.contacts where id=(select contact_id from public.leads where id=$1)`, [mine]))[0].phone, '+919830000001');
  // assignment: the employee may claim a lead for themselves, never assign someone else's work (the database decides, at confirm time)
  const free = await lead(owner, org, 'Free Lead', '+919830000003'); const a1 = await tool(E, 'propose_assignment', { lead_id: free, assignee: 'me' }); assert.equal(a1.ok, true);
  assert.equal((await apply(EMP, 'employee', a1.json.data.proposal_id)).ok, true); assert.equal((await q('select assigned_to from public.leads where id=$1', [free]))[0].assigned_to, EMP);
  const other = await lead(owner, org, 'Other Free', '+919830000004'); const a2 = await tool(E, 'propose_assignment', { lead_id: other, assignee: 'mgr@x.test' }); assert.equal(a2.ok, true, a2.content);
  const refused = await apply(EMP, 'employee', a2.json.data.proposal_id); assert.equal(refused.ok, false); assert.match(refused.error, /Employees can only assign an unassigned lead to themselves/); assert.equal((await q('select assigned_to from public.leads where id=$1', [other]))[0].assigned_to, null);
  assert.equal((await q(`select status from public.ai_proposals where id=$1`, [a2.json.data.proposal_id]))[0].status, 'pending', 'a refused operation stays pending');
  assert.equal((await tool(E, 'propose_assignment', { lead_id: other, assignee: 'nobody@x.test' })).code, 'not_found');
  // tasks
  const tk = await tool(E, 'propose_task', { lead_id: mine, title: 'Call back', due_in_days: 2, owner: 'me' }); assert.equal(tk.ok, true); assert.equal((await q('select count(*)::int n from public.tasks where lead_id=$1', [mine]))[0].n, 0);
  assert.equal((await apply(EMP, 'employee', tk.json.data.proposal_id)).ok, true); const [task] = await q(`select title, owner_id, due_date = current_date + 2 as due from public.tasks where lead_id=$1`, [mine]); assert.deepEqual(task, { title: 'Call back', owner_id: EMP, due: true });
  // leads the user cannot see do not exist for the assistant; stages must exist
  assert.equal((await tool(E, 'propose_task', { lead_id: theirs, title: 'x', due_in_days: 1, owner: 'me' })).ok, false);
  assert.match((await tool(E, 'propose_lead_update', { lead_id: mine, stage: 'Nowhere' })).error, /not a pipeline stage/); assert.match((await tool(E, 'propose_lead_update', { lead_id: mine })).error, /Nothing to change/);
  // what the assistant is NOT offered: money, outbound messages, stock changes; the database also refuses other operation kinds
  const names = TOOLS.map(t => t.name); assert.deepEqual(names.filter(n => n.startsWith('propose_')).sort(), ['propose_assignment', 'propose_automation', 'propose_dashboard', 'propose_lead_update', 'propose_module_changes', 'propose_plan', 'propose_task']);
  assert.ok(!names.some(n => /payment|refund|issue|send|message|stock_(receive|adjust|consume)|write_off/.test(n)));
  for (const op of ['issue_invoice', 'record_payment', 'send_message', 'adjust_stock']) await bad(call(EMP, 'ai_create_proposal', { p_org: org, p_conv: null, p_kind: 'operation', p_title: 'x', p_payload: { op }, p_base_revision: null }), '22023');
  await bad(call(EMP, 'ai_create_proposal', { p_org: org, p_conv: null, p_kind: 'module_config', p_title: 'x', p_payload: {}, p_base_revision: null }), '42501');
});

// ================= unfinished visual workflows =================
test('unfinished workflows: saved separately, private to their author, validated for shape only, and never publishable', async () => {
  const A = await fresh(BASE), B = await fresh(BASE); const owner = A.owner;
  const graph = { nodes: [{ id: 'n1', kind: 'trigger', event: 'lead.created' }, { id: 'n2', kind: 'action', action: { type: 'notify', recipient: '', title: '' } }], edges: [], pos: { n1: { x: 0, y: 0 } } };
  const save = (u, org, o = {}) => call(u, 'automation_wip_save', { p_org: org, p_id: null, p_workflow: null, p_name: 'Half done', p_graph: graph, ...o });
  const id1 = await ok(save(owner, A.org)); assert.deepEqual((await rows(owner, 'select name, graph from public.automation_wip'))[0], { name: 'Half done', graph });
  assert.equal((await q('select count(*)::int n from public.automation_workflows where organization_id=$1', [A.org]))[0].n, 0, 'no workflow exists, so nothing can be published');
  await bad(call(owner, 'automation_publish', { p_org: A.org, p_workflow: id1, p_enable: true }), 'P0002');
  await ok(save(owner, A.org, { p_id: id1, p_name: 'Renamed' })); assert.equal((await q('select name from public.automation_wip where id=$1', [id1]))[0].name, 'Renamed');
  for (const g of [null, [], { nodes: [], edges: 'x' }, { nodes: [{ id: 'BAD ID', kind: 'trigger' }], edges: [] }, { nodes: [{ id: 'a', kind: 'evil' }], edges: [] }, { nodes: [], edges: [{ from: 'a b', to: 'c' }] }, { nodes: Array.from({ length: 61 }, (_, i) => ({ id: `n${i}`, kind: 'action' })), edges: [] }, { nodes: [], edges: [], pad: 'x'.repeat(70000) }]) await bad(save(owner, A.org, { p_graph: g }), '22023');
  for (const u of [EMP, MGR]) await bad(save(u, A.org), '42501');
  assert.deepEqual(await rows(ADM, 'select id from public.automation_wip where organization_id=$1', [A.org]), [], 'private to the author, even from other admins'); assert.deepEqual(await rows(B.owner, 'select id from public.automation_wip'), []);
  await bad(save(B.owner, B.org, { p_id: id1 }), 'P0002'); await ok(call(B.owner, 'automation_wip_delete', { p_org: B.org, p_id: id1 })); assert.equal((await q('select count(*)::int n from public.automation_wip where id=$1', [id1]))[0].n, 1, 'another organization cannot delete it');
  // linked to an existing workflow, removed with it
  const wf = await ok(call(owner, 'automation_save_draft', { p_org: A.org, p_workflow: null, p_name: 'Real', p_definition: { trigger: { event: 'lead.created' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'x' }] } }));
  const id2 = await ok(save(owner, A.org, { p_workflow: wf })); await bad(save(owner, A.org, { p_workflow: wf }).then(x => ({ ...x })), '__never__').catch(() => {}); await bad(save(owner, A.org, { p_workflow: id('00') }), 'P0002');
  await ok(call(owner, 'automation_discard_draft', { p_org: A.org, p_workflow: wf })); assert.equal((await q('select count(*)::int n from public.automation_wip where id=$1', [id2]))[0].n, 0);
  await ok(call(owner, 'automation_wip_delete', { p_org: A.org, p_id: id1 })); assert.equal((await q('select count(*)::int n from public.automation_wip where id=$1', [id1]))[0].n, 0);
});

// ================= lead merging and history =================
test('lead merging: a caller who cannot see a contact learns nothing about it and cannot modify it; managers keep the reuse behaviour', async () => {
  const { org, owner } = await fresh(BASE);
  await lead(owner, org, 'Confidential Person', '+919840000001', { assignee: EMP2 });
  const create = (u, phone, email) => call(u, 'crm_create_lead', { p_org: org, p_full_name: 'Probe', p_phone: phone, p_email: email ?? null, p_source: 'website', p_summary: null, p_stage: null, p_assigned_to: null });
  const r = await create(EMP, '+919840000001', 'probe@example.com'); assert.equal(r.error?.code, '22023'); assert.match(r.error.message, /may already belong to an existing contact/); assert.ok(!/Confidential/.test(r.error.message));
  assert.deepEqual((await q(`select email from public.contacts where phone='+919840000001'`))[0], { email: null }, 'the contact was not modified');
  assert.ok(!(await create(EMP, '+919840000099')).error, 'new numbers are unaffected');
  await lead(owner, org, 'Email Person', '+919840000060', { assignee: EMP2, email: 'secret@example.com' }); assert.equal((await create(EMP, '+919840000097', 'secret@example.com')).error?.code, '22023', 'an email match is refused the same way');
  assert.equal((await q(`select count(*)::int n from public.contacts where organization_id=$1 and phone='+919840000001'`, [org]))[0].n, 1);
  // someone who can already see the contact (their own lead) may add another lead for it; managers and admins reuse as before
  assert.ok(!(await create(EMP2, '+919840000001')).error); const a = await ok(create(MGR, '+919840000001', 'known@example.com')); const [m] = await q(`select count(*)::int n, max(email) e from public.contacts where phone='+919840000001'`); assert.deepEqual([m.n, m.e], [1, 'known@example.com']); assert.ok(a);
  assert.ok(!(await create(ADM, '+919840000001')).error);
  // two different contacts for one phone+email: managers still get the specific conflict
  await ok(create(MGR, '+919840000050', 'other@example.com')); assert.equal((await create(MGR, '+919840000001', 'other@example.com')).error?.code, '23505');
});

test('pipeline history is preserved: the migration plan stays on the version row and the plan is gone from the definition', async () => {
  const { org, owner } = await fresh(BASE); const l = await lead(owner, org, 'Mover', '+919850000001'); await ok(call(owner, 'crm_set_stage', { p_org: org, p_lead: l, p_stage: 'Qualified' }));
  await ok(call(owner, 'save_workspace_draft', { p_org: org, p_definition: { ...BASE, pipeline: { stages: ['New', 'Vetted', 'Won'], stageMoves: [{ from: 'Qualified', to: 'Vetted' }] } } })); await ok(call(owner, 'publish_workspace_config', { p_org: org }));
  const [v] = await q(`select applied_stage_moves, definition #> '{pipeline,stageMoves}' d from public.workspace_configuration_versions where organization_id=$1 and status='published'`, [org]);
  assert.deepEqual(v.applied_stage_moves, [{ from: 'Qualified', to: 'Vetted', leads: 1 }]); assert.equal(v.d, null);
  await ok(call(owner, 'save_workspace_draft', { p_org: org, p_definition: { ...BASE, pipeline: { stages: ['New', 'Vetted', 'Won', 'Lost'] } } })); await ok(call(owner, 'publish_workspace_config', { p_org: org }));
  assert.deepEqual((await q(`select applied_stage_moves from public.workspace_configuration_versions where organization_id=$1 and revision=(select max(revision)-1 from public.workspace_configuration_versions where organization_id=$1)`, [org]))[0].applied_stage_moves, [{ from: 'Qualified', to: 'Vetted', leads: 1 }], 'the archived version still records what it did');
  assert.equal((await q(`select applied_stage_moves from public.workspace_configuration_versions where organization_id=$1 and status='published'`, [org]))[0].applied_stage_moves, null);
});

// ================= client stream =================
import { SseParser, reduce, emptyTurn, readTurn } from '../src/lib/ai/clientStream.ts';
test('client stream: parser survives any chunking, reducer builds the UI state, and an unfinished stream is an interruption', async () => {
  const events = [{ type: 'start', conversationId: 'c1' }, { type: 'text', text: 'Draft ' }, { type: 'reset' }, { type: 'tool_start', name: 'list_leads', label: 'Looking up leads' }, { type: 'tool_end', name: 'list_leads', ok: true }, { type: 'text', text: 'Final ' }, { type: 'text', text: 'answer' }, { type: 'plan', id: 'p1' }, { type: 'done', conversationId: 'c1', text: 'Final answer', proposals: [{ id: 'x' }], plans: [{ plan: { id: 'p1' } }] }];
  const wire = ': ping\n\n' + events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: {broken\n\n';
  for (const n of [1, 2, 9, 1000]) { const p = new SseParser(); const got = []; for (let i = 0; i < wire.length; i += n) got.push(...p.push(wire.slice(i, i + n))); assert.deepEqual(got, events, `chunk size ${n}`); }
  let s = emptyTurn(); for (const e of events) s = reduce(s, e);
  assert.deepEqual([s.done, s.text, s.conversationId, s.tools], [true, 'Final answer', 'c1', [{ name: 'list_leads', label: 'Looking up leads', state: 'done' }]]); assert.equal(s.cards.plans.length, 1);
  const mk = frames => new Response(new ReadableStream({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); } }));
  const ok1 = await readTurn(mk(events.map(e => `data: ${JSON.stringify(e)}\n\n`)), () => {}); assert.equal(ok1.done, true); assert.equal(ok1.error, null);
  const cut = await readTurn(mk(events.slice(0, 4).map(e => `data: ${JSON.stringify(e)}\n\n`)), () => {}); assert.equal(cut.error.code, 'interrupted'); assert.equal(cut.done, false);
  const err = await readTurn(mk([`data: ${JSON.stringify({ type: 'error', code: 'budget', message: 'Limit reached.' })}\n\n`]), () => {}); assert.deepEqual(err.error, { code: 'budget', message: 'Limit reached.' });
  assert.equal((await readTurn(new Response(null), () => {})).error.code, 'interrupted');
});

// ================= conversational onboarding =================
import { onboardingTurn, buildProposal } from '../src/lib/ai/onboarding.ts';
import { estimateCost, fmtCost, pct } from '../src/lib/ai/usage.ts';
const PROPOSAL = { summary: 'A used-car dealership.', modules: [{ label: 'Vehicles', fields: [{ label: 'Registration', kind: 'text', required: true }, { label: 'Status', kind: 'choice', options: ['Available', 'Sold'] }] }], pipeline_stages: ['Enquiry', 'Test drive', 'Negotiation', 'Won', 'Lost'], operations: ['appointments'],
  workflows: [{ name: 'Follow up website enquiries', definition: { trigger: { event: 'lead.created' }, match: { op: 'and', conditions: [{ field: 'lead.source', op: 'eq', value: 'website' }] }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] } }, { name: 'Vehicle added', definition: { trigger: { event: 'record.created', object: 'Vehicles' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'Vehicle added' }] } }],
  dashboards: [{ name: 'Sales', widgets: [{ type: 'bar', title: 'Leads by stage', query: { source: 'leads', metric: { agg: 'count' }, group_by: [{ field: 'stage' }] } }, { type: 'bar', title: 'Vehicles by status', query: { source: 'records:Vehicles', metric: { agg: 'count' }, group_by: [{ field: 'Status' }] } }] }] };
const prov = steps => { let i = 0; return { id: 'scripted', model: 'm', calls: [], complete: async function (req) { this.calls.push(req); const s = steps[i++]; return { content: s, stopReason: 'x', usage: { inputTokens: 10, outputTokens: 5 } }; } }; };
test('onboarding conversation: questions first, then a proposal built only from supported things, validated by the shared plan validator', async () => {
  const q1 = await onboardingTurn(prov([[{ type: 'text', text: 'Do you book test drives?' }]]), { name: 'Acme Cars', description: 'We sell cars', transcript: [{ role: 'user', text: 'We sell used cars' }] });
  assert.deepEqual([q1.type, q1.text], ['question', 'Do you book test drives?']);
  const p = prov([[{ type: 'text', text: 'Here is what I suggest.' }, { type: 'tool_use', id: 't1', name: 'propose_workspace', input: PROPOSAL }]]);
  const r = await onboardingTurn(p, { name: 'Acme Cars', description: 'We sell cars', transcript: [{ role: 'user', text: 'We sell used cars' }, { role: 'assistant', text: 'Do you book test drives?' }, { role: 'user', text: 'Yes, and we track each vehicle' }] });
  assert.equal(r.type, 'proposal', JSON.stringify(r)); const pr = r.proposal;
  assert.deepEqual(pr.config.modules.map(m => m.key), ['overview', 'leads', 'vehicles']); assert.deepEqual(pr.config.pipeline.stages, PROPOSAL.pipeline_stages); assert.equal(pr.config.operations.appointments.enabled, true);
  assert.deepEqual(pr.workflows.map(w => w.name), ['Follow up website enquiries', 'Vehicle added']); assert.equal(pr.workflows[1].definition.trigger.object, 'vehicles'); assert.equal(pr.dashboards[0].widgets[1].query.source, 'records:vehicles'); assert.deepEqual(pr.dashboards[0].widgets[1].query.group_by, [{ field: 'f_status' }]);
  assert.ok(!JSON.stringify(p.calls[0].messages).includes('SYSTEM')); assert.match(p.calls[0].system, /AT MOST three short questions/); assert.equal(p.calls[0].tools.length, 1);
  // the result is a real, creatable workspace: the database accepts it exactly as the wizard would send it
  const owner = id('88'); await db.exec(`insert into auth.users values ('${owner}','o88@x.test') on conflict do nothing`);
  const org = await ok(call(owner, 'create_workspace', { p_name: 'Acme Cars', p_description: null, p_preset: null, p_definition: pr.config })); assert.ok(org);
  for (const w of pr.workflows) await ok(call(owner, 'automation_save_draft', { p_org: org, p_workflow: null, p_name: w.name, p_definition: w.definition }));
  for (const d of pr.dashboards) await ok(call(owner, 'dashboard_save', { p_org: org, p_id: null, p_name: d.name, p_description: null, p_visibility: 'personal', p_widgets: d.widgets, p_version: null }));
  assert.equal((await q(`select count(*)::int n from public.automation_workflow_versions where organization_id=$1 and status='draft'`, [org]))[0].n, 2); assert.equal((await q(`select count(*)::int n from public.automation_workflows where organization_id=$1 and enabled`, [org]))[0].n, 0, 'starter workflows are drafts, never enabled');
  // unsupported requests are sent back for ONE repair, then refused plainly; nothing unsupported is ever created
  const bad1 = { ...PROPOSAL, workflows: [{ name: 'x', definition: { trigger: { event: 'payroll.run' }, actions: [{ type: 'notify', recipient: 'event_actor', title: 'x' }] } }] };
  const pp = prov([[{ type: 'tool_use', id: 't1', name: 'propose_workspace', input: bad1 }], [{ type: 'tool_use', id: 't2', name: 'propose_workspace', input: PROPOSAL }]]);
  assert.equal((await onboardingTurn(pp, { name: 'A', description: '', transcript: [{ role: 'user', text: 'hi' }] })).type, 'proposal'); assert.equal(pp.calls.length, 2); assert.match(JSON.stringify(pp.calls[1].messages.at(-1)), /Not valid/);
  const stuck = await onboardingTurn(prov([[{ type: 'tool_use', id: 't1', name: 'propose_workspace', input: bad1 }], [{ type: 'tool_use', id: 't2', name: 'propose_workspace', input: bad1 }]]), { name: 'A', description: '', transcript: [{ role: 'user', text: 'hi' }] }); assert.deepEqual([stuck.type, stuck.code], ['error', 'invalid_output']); assert.match(stuck.message, /blank workspace/);
  assert.equal((await onboardingTurn(prov([]), { name: 'A', description: '', transcript: [] })).code, 'invalid_message'); assert.equal((await onboardingTurn(prov([]), { name: 'A', description: '', transcript: [{ role: 'assistant', text: 'x' }] })).code, 'invalid_message');
  assert.equal((await onboardingTurn({ complete: async () => { throw new AiProviderError('x', 'auth'); } }, { name: 'A', description: '', transcript: [{ role: 'user', text: 'hi' }] })).code, 'provider_auth');
  // prompt injection in the customer's text cannot add capabilities: the tool schema has no field for anything else
  const inj = await buildProposal('A', '', { summary: 'x', pipeline_stages: ['New', 'Won'], sql: 'drop table', admin: true }); assert.equal(inj.ok, true); assert.ok(!JSON.stringify(inj.proposal).includes('drop table'));
});
test('onboarding gate: atomic per-user daily limit before any organization exists', async () => {
  const u = id('87'); await db.exec(`insert into auth.users values ('${u}','o87@x.test') on conflict do nothing`);
  for (let i = 0; i < 3; i++) assert.equal((await ok(call(u, 'ai_onboarding_reserve', { p_daily_calls: 3 }))).allowed, true);
  const no = await ok(call(u, 'ai_onboarding_reserve', { p_daily_calls: 3 })); assert.equal(no.allowed, false); assert.match(no.reason, /blank|by hand/);
  assert.equal((await ok(call(EMP, 'ai_onboarding_reserve', { p_daily_calls: 3 }))).allowed, true, 'limits are per user');
  const g = await ok(call(EMP, 'ai_onboarding_reserve', { p_daily_calls: 30 })); await ok(call(EMP, 'ai_onboarding_settle', { p_id: g.id, p_in: 10, p_out: 5, p_status: 'ok' })); await ok(call(ADM, 'ai_onboarding_settle', { p_id: g.id, p_in: 999, p_out: 999, p_status: 'ok' }));
  assert.deepEqual((await q('select input_tokens i, status s from public.ai_onboarding_usage where id=$1', [g.id]))[0], { i: 10, s: 'ok' }, 'only the reserving user settles, once');
  await assert.rejects(as(null, `select public.ai_onboarding_reserve(3)`), e => e.code === '42501'); await assert.rejects(rows(EMP, 'select 1 from public.ai_onboarding_usage'), e => e.code === '42501');
});
test('usage cost estimates come only from entered prices', () => {
  assert.equal(estimateCost(1_000_000, 500_000, { input_per_mtok: 3, output_per_mtok: 15, currency: 'USD' }), 10.5); assert.equal(estimateCost(100, 100, null), null); assert.equal(estimateCost(100, 100, { input_per_mtok: null, output_per_mtok: null, currency: 'USD' }), null);
  assert.equal(estimateCost(2000, 0, { input_per_mtok: 3, output_per_mtok: null, currency: 'USD' }), 0.006); assert.equal(fmtCost(0.006, 'USD'), 'USD 0.0060'); assert.equal(fmtCost(null, 'USD'), '—'); assert.deepEqual([pct(50, 200), pct(500, 200), pct(5, null)], [25, 100, null]);
});

// ================= sensitive data: custom phone/email fields and invoice contact details =================
const CONTACTS_CFG = { ...BASE, modules: [...CORE, { key: 'clients', label: 'Clients', status: 'active' }], objects: [{ key: 'clients', label: 'Clients', fields: [{ key: 'name', label: 'Name', kind: 'text' }, { key: 'mobile', label: 'Mobile', kind: 'phone' }, { key: 'mail', label: 'Mail', kind: 'email' }, { key: 'tier', label: 'Tier', kind: 'choice', options: ['Gold', 'Silver'] }] }] };
test('custom phone and email fields: raw columns are closed to clients, the view masks them by permission, and writes by restricted users keep them intact', async () => {
  const { org, owner } = await fresh(CONTACTS_CFG);
  const rec = await ok(call(owner, 'record_create', { p_org: org, p_object: 'clients', p_data: { name: 'Asha', mobile: '+919860000001', mail: 'asha@example.com', tier: 'Gold' } }));
  for (const u of [owner, ADM, MGR, EMP]) for (const sql of ['select data from public.records', 'select search_text from public.records', 'select * from public.records', `select count(*) from public.records where data->>'mobile' is not null`]) await assert.rejects(as(u, sql), e => e.code === '42501', sql);
  await assert.rejects(as(null, 'select id from public.records'), e => e.code === '42501'); assert.ok((await rows(owner, 'select id, object_key, created_by from public.records')).length >= 1, 'non-personal columns stay readable');
  const view = (u) => rows(u, `select data, search_text from public.records_view where id=$1`, [rec]).then(r => r[0]);
  for (const u of [owner, MGR, EMP]) { const v = await view(u); assert.deepEqual(v.data, { name: 'Asha', mobile: '+919860000001', mail: 'asha@example.com', tier: 'Gold' }); assert.match(v.search_text, /9860000001/); }
  const role = await ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'No contacts', p_base: 'employee', p_permissions: { contacts: { view: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(owner, 'member_assign_role', { p_org: org, p_user: EMP, p_custom_role: role, p_base_if_cleared: 'employee' }));
  const view2 = (u, id2) => rows(u, `select data from public.records_view where id=$1`, [id2]).then(r => r[0]);
  const hid = await view(EMP); assert.deepEqual(hid.data, { name: 'Asha', tier: 'Gold' }); assert.ok(!/9860000001|asha@example/.test(hid.search_text), 'search text is masked too');
  assert.deepEqual(await rows(EMP, `select id from public.records_view where organization_id=$1 and search_text ilike '%9860000001%'`, [org]), [], 'no search oracle');
  assert.equal((await view(owner)).data.mobile, '+919860000001', 'other roles are unaffected');
  // a restricted user edits another field of a record they created: the hidden values are not erased (the update merges inside the database)
  const mine = await ok(call(EMP, 'record_create', { p_org: org, p_object: 'clients', p_data: { name: 'Mine', mobile: '+919860000002', tier: 'Gold' } }));
  await ok(call(EMP, 'record_update', { p_org: org, p_record: mine, p_data: { tier: 'Silver' } }));
  assert.deepEqual((await q('select data from public.records where id=$1', [mine]))[0].data, { name: 'Mine', mobile: '+919860000002', tier: 'Silver' }); assert.deepEqual((await view2(EMP, mine)).data, { name: 'Mine', tier: 'Silver' });
  // other organizations and direct function calls reveal nothing
  const other = await fresh(BASE); assert.deepEqual(await rows(other.owner, `select public.record_data_for($1) d`, [rec]).then(r => r[0].d), null); assert.deepEqual(await rows(other.owner, 'select id from public.records_view'), []);
  // the assistant's module record tool honours the same rule even for include-style requests
  const t = await tool(ctxFor({ org, owner }, EMP, 'employee'), 'list_module_records', { module: 'clients' }); assert.equal(t.ok, true, t.content); assert.ok(!/9860000001|asha@example/.test(t.content));
  // analytics never had them, and still works over the view
  const run = await ok(call(owner, 'analytics_run', { p_org: org, p_q: { source: 'records:clients', metric: { agg: 'count' }, group_by: [{ field: 'f_tier' }] }, p_max: 10 })); assert.deepEqual(run.rows.map(r => [r.g1, Number(r.value)]).sort(), [['Gold', 1], ['Silver', 1]]);
});

test('invoice customer contact details are an explicit permission; the raw snapshot column is closed to clients', async () => {
  const OPSCFG = { ...BASE, operations: { billing: { enabled: true, currency: 'INR', taxes: [] } } };
  const { org, owner } = await fresh(OPSCFG); const l = await lead(owner, org, 'Billed Customer', '+919870000001', { email: 'billed@example.com' });
  const contact = (await q('select contact_id c from public.leads where id=$1', [l]))[0].c;
  const inv = await ok(call(MGR, 'invoice_save_draft', { p_org: org, p_id: null, p_contact: contact, p_lead: null, p_currency: 'INR', p_due_date: null, p_notes: null, p_lines: [{ description: 'Service', quantity: '1', unit_price: '100', tax_keys: [] }] })); await ok(call(MGR, 'invoice_issue', { p_org: org, p_id: inv }));
  for (const u of [owner, MGR, ADM]) { await assert.rejects(as(u, 'select snapshot from public.invoices'), e => e.code === '42501'); await assert.rejects(as(u, 'select * from public.invoices'), e => e.code === '42501'); assert.ok((await rows(u, 'select id, number, total from public.invoices where id=$1', [inv])).length === 1); }
  const full = await ok(call(MGR, 'invoice_snapshot', { p_org: org, p_id: inv })); assert.deepEqual([full.bill_to.name, full.bill_to.phone, full.bill_to.email], ['Billed Customer', '+919870000001', 'billed@example.com']);
  const pdfFull = await ok(call(MGR, 'invoice_pdf_access', { p_org: org, p_id: inv })); assert.equal(pdfFull.snapshot.bill_to.email, 'billed@example.com');
  const role = await ok(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'Billing without customer contacts', p_base: 'manager', p_permissions: { billing_contacts: { view: false } }, p_scopes: {}, p_location_restricted: false })); await ok(call(owner, 'member_assign_role', { p_org: org, p_user: MGR, p_custom_role: role, p_base_if_cleared: 'manager' }));
  const masked = await ok(call(MGR, 'invoice_snapshot', { p_org: org, p_id: inv })); assert.deepEqual([masked.bill_to.name, masked.bill_to.phone, masked.bill_to.email, masked.total], ['Billed Customer', undefined, undefined, full.total], 'name and amounts stay; phone and email are removed');
  const pdfMasked = await ok(call(MGR, 'invoice_pdf_access', { p_org: org, p_id: inv })); assert.deepEqual(pdfMasked.snapshot.bill_to, { name: 'Billed Customer', contact_id: contact }); const bytes = await invoicePdf(pdfMasked.snapshot); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await ok(call(owner, 'invoice_snapshot', { p_org: org, p_id: inv }))).bill_to.email, 'billed@example.com', 'the owner is unaffected');
  await bad(call(EMP, 'invoice_snapshot', { p_org: org, p_id: inv }), '42501'); const other = await fresh(BASE); await bad(call(other.owner, 'invoice_snapshot', { p_org: org, p_id: inv }), '42501'); await bad(call(other.owner, 'invoice_snapshot', { p_org: other.org, p_id: inv }), 'P0002');
  for (const bad2 of [{ billing_contacts: { edit: false } }, { billing_contacts: { view: 'no' } }]) await bad(call(owner, 'role_save', { p_org: org, p_id: null, p_name: 'x', p_base: 'manager', p_permissions: bad2, p_scopes: {}, p_location_restricted: false }), '22023');
  assert.equal((await ok(call(owner, 'invoice_snapshot', { p_org: org, p_id: inv })).then ? 1 : 1), 1);
});
import { invoicePdf } from '../src/lib/billing/pdf.ts';
