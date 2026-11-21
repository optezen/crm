// Offline adapter tests: signature verification, credential encryption, form parsing, Meta + WhatsApp adapters against MOCKED HTTP, worker loops against a fake database.
// Nothing here contacts Meta, WhatsApp, Interakt or Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { verifyMetaSignature, signMeta } from '../src/lib/integrations/signature.ts';
import { encryptJson, decryptJson, parseKey, signState, verifyState } from '../src/lib/integrations/crypto.ts';
import { parseSubmission, flatten, parseBrackets, handleFormSubmission, extractCredential } from '../src/lib/integrations/forms.ts';
import { MetaClient, MetaLeadAdapter, authUrl, classify, normalizeLead, parseLeadgenWebhook, verifyChallenge } from '../src/lib/integrations/meta.ts';
import { MetaCloudAdapter, InteraktAdapter, toWhatsAppNumber, parseWhatsAppWebhook } from '../src/lib/integrations/whatsapp.ts';
import { handleProviderWebhook } from '../src/lib/integrations/webhooks.ts';
import { integrationTick, processLeadEvents, deliverWhatsApp } from '../src/lib/integrations/worker.ts';
import { ProviderError } from '../src/lib/integrations/types.ts';
import { missingFor } from '../src/lib/integrations/env.ts';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const mockFetch = routes => { const calls = []; const f = async (url, init = {}) => { calls.push({ url, ...init }); const r = routes.find(r => r.match(url, init)); if (!r) throw new Error('unexpected request ' + url); return typeof r.reply === 'function' ? r.reply(url, init) : r.reply; }; f.calls = calls; return f; };
const key = parseKey(randomBytes(32).toString('base64'));

test('webhook signature: valid, tampered body, wrong secret, malformed header, missing pieces', () => {
  const body = JSON.stringify({ object: 'page', entry: [] }), secret = 'app-secret-123', sig = signMeta(body, secret);
  assert.equal(verifyMetaSignature(body, sig, secret), true); assert.equal(verifyMetaSignature(body + ' ', sig, secret), false); assert.equal(verifyMetaSignature(body, sig, 'other'), false);
  for (const bad of [null, '', 'sha256=', 'sha1=' + sig.slice(7), sig.slice(7), 'sha256=' + 'z'.repeat(64), sig.toUpperCase().replace('SHA256', 'sha256').slice(0, 20)]) assert.equal(verifyMetaSignature(body, bad, secret), false);
  assert.equal(verifyMetaSignature(body, sig, undefined), false); assert.equal(verifyMetaSignature(body, sig.replace(/.$/, c => (c === '0' ? '1' : '0')), secret), false);
});

test('credential encryption: round trip, random IV, tamper and wrong-key detection, key validation, OAuth state', () => {
  const v = { access_token: 'EAAB-secret', phone_number_id: '123' }, a = encryptJson(v, key), b = encryptJson(v, key);
  assert.match(a, /^v1:[\w-]+\.[\w-]+\.[\w-]+$/); assert.notEqual(a, b); assert.ok(!a.includes('EAAB')); assert.deepEqual(decryptJson(a, key), v);
  assert.throws(() => decryptJson(a, parseKey(randomBytes(32).toString('base64'))), /could not be decrypted/);
  assert.throws(() => decryptJson(a.slice(0, -2) + (a.endsWith('AA') ? 'BB' : 'AA'), key), /could not be decrypted/); assert.throws(() => decryptJson('garbage', key), /Malformed/);
  for (const bad of [undefined, '', 'short', Buffer.alloc(16).toString('base64')]) assert.throws(() => parseKey(bad), /32 random bytes/);
  const st = signState({ org: 'o', nonce: 'n', exp: Date.now() + 1000 }, key);
  assert.equal(verifyState(st, key)?.org, 'o'); assert.equal(verifyState(st, key, Date.now() + 5000), null, 'expired'); assert.equal(verifyState((st[0] === 'A' ? 'B' : 'A') + st.slice(1), key), null, 'tampered state (first character always changes)'); assert.equal(verifyState(st, parseKey(randomBytes(32).toString('base64'))), null);
});

test('form parsing: JSON, urlencoded, WordPress/Elementor shapes, size and type limits, credential extraction', async () => {
  const post = (body, type, extra = {}) => new Request('https://app.test/api/webhooks/forms/abc', { method: 'POST', headers: { 'content-type': type, ...extra }, body });
  assert.deepEqual((await parseSubmission(post(JSON.stringify({ name: 'A', n: 3, ok: true, tags: ['x', 'y'], nested: { a: { b: 'deep' } } }), 'application/json'))).value, { name: 'A', n: 3, ok: true, tags: 'x, y', 'nested.a.b': 'deep' });
  assert.deepEqual((await parseSubmission(post('name=Asha&email=a%40x.test', 'application/x-www-form-urlencoded; charset=UTF-8'))).value, { name: 'Asha', email: 'a@x.test' });
  const elementor = 'form_id=1&fields%5Bname%5D%5Bid%5D=name&fields%5Bname%5D%5Btype%5D=text&fields%5Bname%5D%5Btitle%5D=Name&fields%5Bname%5D%5Bvalue%5D=Asha&fields%5Bemail%5D%5Bvalue%5D=a%40x.test&fields%5Bemail%5D%5Braw_value%5D=a%40x.test';
  assert.deepEqual((await parseSubmission(post(elementor, 'application/x-www-form-urlencoded'))).value, { form_id: '1', name: 'Asha', email: 'a@x.test' });
  assert.deepEqual(flatten(parseBrackets(new URLSearchParams('form_fields[name]=A&form_fields[message]=hi'))), { name: 'A', message: 'hi' });
  for (const [b, t] of [['x', 'text/plain'], ['{bad', 'application/json'], ['[]', 'application/json'], ['{}', 'application/json'], ['"s"', 'application/json']]) assert.equal((await parseSubmission(post(b, t))).ok, false);
  assert.equal((await parseSubmission(post(JSON.stringify({ a: 'x'.repeat(21000) }), 'application/json'))).ok, false);
  assert.equal((await parseSubmission(post(JSON.stringify(Object.fromEntries(Array.from({ length: 61 }, (_, i) => ['f' + i, 'v']))), 'application/json'))).ok, false);
  const r = (h, u = 'https://x.test/p') => extractCredential(new Request(u, { headers: h }));
  assert.deepEqual([r({ authorization: 'Bearer abc' }), r({ 'x-optizen-key': 'def' }), r({}, 'https://x.test/p?key=ghi'), r({})], [{ secret: 'abc', source: 'header' }, { secret: 'def', source: 'header' }, { secret: 'ghi', source: 'query' }, null]);
});

test('form endpoint: status codes, idempotency key and metadata are passed through; the browser cannot choose the organization', async () => {
  const seen = []; const mk = result => async a => { seen.push(a); return { data: result, error: null }; };
  const call = (rpc, { body = { name: 'A', phone: '9811100000', organization_id: 'attacker-org' }, headers = {}, url = 'https://app.test/f' } = {}) => handleFormSubmission(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer oz_s', 'idempotency-key': 'k1', referer: 'https://site.test/contact', 'user-agent': 'WP', ...headers }, body: JSON.stringify(body) }), 'pubid0000000000a', rpc);
  const created = await call(mk({ status: 'created', lead_id: 'L1' })); assert.equal(created.status, 201); assert.deepEqual(await created.json(), { ok: true, status: 'created', lead_id: 'L1' });
  assert.deepEqual(Object.keys(seen[0]).sort(), ['p_idem', 'p_meta', 'p_payload', 'p_public_id', 'p_secret'], 'only these arguments exist: there is no organization parameter');
  assert.equal(seen[0].p_meta.credential_source, 'header'); assert.equal(seen[0].p_idem, 'k1'); assert.equal(seen[0].p_meta.referrer, 'https://site.test/contact'); assert.equal(seen[0].p_secret, 'oz_s'); assert.equal(seen[0].p_public_id, 'pubid0000000000a');
  for (const [res, status] of [[{ status: 'duplicate', lead_id: 'L1' }, 200], [{ status: 'rejected', reason: 'no contact' }, 422], [{ status: 'invalid', reason: 'x' }, 400], [{ status: 'rate_limited' }, 429], [{ status: 'unauthorized' }, 401]]) assert.equal((await call(mk(res))).status, status);
  assert.equal((await call(async () => ({ data: null, error: { message: 'db down' } }))).status, 503);
  assert.equal((await call(mk({}), { headers: { authorization: '' } })).status, 401); assert.equal((await call(mk({}), { body: [] })).status, 400);
  assert.equal((await handleFormSubmission(new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer s' }, body: 'x' }), 'p', mk({}))).status, 400);
});

test('Meta Lead Ads adapter (mocked Graph API): OAuth URL, token exchange, pages, subscription, lead retrieval, error classification', async () => {
  const u = new URL(authUrl({ appId: '111', redirectUri: 'https://app.test/api/integrations/meta/callback', state: 'st' }));
  assert.equal(u.searchParams.get('client_id'), '111'); assert.equal(u.searchParams.get('state'), 'st'); assert.ok(u.searchParams.get('scope').split(',').includes('leads_retrieval'));
  const f = mockFetch([
    { match: u => u.includes('/oauth/access_token') && u.includes('code='), reply: reply(200, { access_token: 'short' }) },
    { match: u => u.includes('fb_exchange_token=short'), reply: reply(200, { access_token: 'long', expires_in: 5184000 }) },
    { match: u => u.includes('/me/accounts'), reply: reply(200, { data: [{ id: 'P1', name: 'Acme', access_token: 'ptoken' }] }) },
    { match: (u, i) => u.includes('/P1/subscribed_apps') && i.method === 'POST', reply: reply(200, { success: true }) },
    { match: u => u.includes('/LEAD1?'), reply: reply(200, { id: 'LEAD1', form_id: 'F1', ad_id: 'AD', platform: 'fb', field_data: [{ name: 'full_name', values: ['Meta Person'] }, { name: 'email', values: ['m@x.test'] }, { name: 'phone_number', values: ['+919700000001'] }] }) },
  ]);
  const c = new MetaClient(f);
  const t = await c.exchangeCode({ appId: '111', appSecret: 's', redirectUri: 'r', code: 'c' }); assert.equal(t.token, 'long'); assert.ok(t.expiresAt);
  assert.deepEqual(await c.listPages('long'), [{ id: 'P1', name: 'Acme', access_token: 'ptoken' }]); await c.subscribePage('P1', 'ptoken');
  assert.ok(f.calls.find(x => x.url.includes('subscribed_apps')).body.includes('subscribed_fields=leadgen'));
  const lead = await new MetaLeadAdapter(c).fetchLead({ page_id: 'P1', leadgen_id: 'LEAD1' }, { user_token: 'long', pages: { P1: 'ptoken' } });
  assert.deepEqual(lead.fields, { full_name: 'Meta Person', email: 'm@x.test', phone_number: '+919700000001' }); assert.equal(lead.meta.provider.ad_id, 'AD');
  await assert.rejects(new MetaLeadAdapter(c).fetchLead({ page_id: 'OTHER', leadgen_id: 'x' }, { user_token: 'l', pages: { P1: 't' } }), e => e.kind === 'auth');
  for (const [status, code, kind] of [[400, 190, 'auth'], [401, undefined, 'auth'], [400, 4, 'rate_limit'], [429, undefined, 'rate_limit'], [400, 200, 'permanent'], [403, undefined, 'permanent'], [500, undefined, 'transient'], [400, 2, 'transient'], [400, 100, 'permanent']])
    assert.equal(classify(status, { error: { code, message: 'm' } }).kind, kind, `${status}/${code}`);
  assert.equal(classify(500, null).retryable, true); assert.equal(classify(400, { error: { code: 190 } }).retryable, false);
  await assert.rejects(new MetaClient(async () => { throw new Error('ECONNRESET'); }).getLead('x', 't'), e => e.kind === 'transient');
  await assert.rejects(new MetaClient(mockFetch([{ match: () => true, reply: reply(200, { success: false }) }])).subscribePage('P', 't'), /did not confirm/);
  assert.deepEqual(normalizeLead({ id: '1', field_data: [{ name: 'a', values: [] }, { name: 'b', values: ['x', 'y'] }] }).fields, { b: 'x, y' });
});

test('Meta webhook: handshake, signature, routing payload; unsigned or unconfigured traffic is never accepted', async () => {
  const env = { META_APP_SECRET: 'sec', META_WEBHOOK_VERIFY_TOKEN: 'vt', INTEGRATION_GATEWAY_SECRET: 'g'.repeat(40) };
  const body = JSON.stringify({ object: 'page', entry: [{ id: 'P1', changes: [{ field: 'leadgen', value: { leadgen_id: 'L1', page_id: 'P1', form_id: 'F', ad_id: 'A' } }, { field: 'feed', value: {} }] }] });
  const got = []; const rpc = async a => { got.push(a); return { data: { status: 'ok' }, error: null }; };
  const hs = (q) => handleProviderWebhook(new Request('https://x.test/w?' + q), 'meta_lead_ads', env, rpc);
  assert.equal(await (await hs('hub.mode=subscribe&hub.verify_token=vt&hub.challenge=777')).text(), '777'); assert.equal((await hs('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=7')).status, 403);
  assert.equal(verifyChallenge(new URLSearchParams('hub.mode=subscribe&hub.verify_token=x&hub.challenge=1'), undefined), null);
  const post = (b, sig, e = env) => handleProviderWebhook(new Request('https://x.test/w', { method: 'POST', headers: { 'x-hub-signature-256': sig ?? '' }, body: b }), 'meta_lead_ads', e, rpc);
  assert.equal((await post(body, signMeta(body, 'sec'))).status, 200); assert.deepEqual(got[0].p_events, [{ kind: 'meta_leadgen', asset_kind: 'page', asset_id: 'P1', dedupe_key: 'lead:L1', payload: { leadgen_id: 'L1', page_id: 'P1', form_id: 'F', ad_id: 'A' } }]);
  assert.equal(got[0].p_gateway_secret, env.INTEGRATION_GATEWAY_SECRET); assert.ok(!JSON.stringify(got[0]).includes('organization'));
  const n = got.length;
  assert.equal((await post(body, signMeta(body, 'wrong'))).status, 401); assert.equal((await post(body, '')).status, 401); assert.equal((await post(body + ' ', signMeta(body, 'sec'))).status, 401);
  assert.equal((await post(body, signMeta(body, 'sec'), { ...env, META_APP_SECRET: undefined })).status, 503); assert.equal((await post(body, signMeta(body, 'sec'), { ...env, INTEGRATION_GATEWAY_SECRET: undefined })).status, 503);
  assert.equal(got.length, n, 'rejected requests never reach the database');
  const noop = JSON.stringify({ object: 'page', entry: [] }); assert.equal((await post(noop, signMeta(noop, 'sec'))).status, 200); assert.equal(got.length, n);
  assert.equal((await handleProviderWebhook(new Request('https://x.test/w', { method: 'POST', headers: { 'x-hub-signature-256': signMeta(body, 'sec') }, body }), 'meta_lead_ads', env, async () => ({ data: { status: 'unauthorized' }, error: null }))).status, 503, 'Meta retries when we could not store the event');
  assert.equal((await handleProviderWebhook(new Request('https://x.test/w', { method: 'DELETE' }), 'meta_lead_ads', env, rpc)).status, 405);
  assert.deepEqual(parseLeadgenWebhook({ object: 'user' }), []);
});

test('WhatsApp adapters (mocked HTTP): template payloads, provider errors, number formatting, status webhook parsing', async () => {
  const ok = mockFetch([{ match: (u, i) => u.endsWith('/123/messages') && i.method === 'POST', reply: reply(200, { messages: [{ id: 'wamid.1' }] }) }, { match: u => u.includes('/123?fields='), reply: reply(200, { verified_name: 'Acme', display_phone_number: '+91 98450 12345' }) }]);
  const m = new MetaCloudAdapter(ok), creds = { access_token: 'tok', phone_number_id: '123' };
  assert.deepEqual(await m.send({ to: '919845012345', templateName: 'lead_welcome', language: 'en', bodyParams: ['Hi Asha'] }, creds), { messageId: 'wamid.1' });
  const sent = JSON.parse(ok.calls[0].body); assert.equal(sent.type, 'template'); assert.equal(sent.to, '919845012345'); assert.deepEqual(sent.template, { name: 'lead_welcome', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Hi Asha' }] }] });
  assert.equal(ok.calls[0].headers.authorization, 'Bearer tok'); assert.match((await m.verify(creds)).displayName, /Acme/);
  const bad = c => new MetaCloudAdapter(mockFetch([{ match: () => true, reply: c }]));
  await assert.rejects(bad(reply(401, { error: { code: 190, message: 'expired' } })).send({ to: '1', templateName: 't', language: 'en', bodyParams: [] }, creds), e => e.kind === 'auth' && !e.retryable);
  await assert.rejects(bad(reply(400, { error: { code: 132001, message: 'Template does not exist' } })).send({ to: '1', templateName: 't', language: 'en', bodyParams: [] }, creds), e => e.kind === 'permanent');
  await assert.rejects(bad(reply(503, {})).send({ to: '1', templateName: 't', language: 'en', bodyParams: [] }, creds), e => e.retryable);
  await assert.rejects(bad(reply(200, {})).send({ to: '1', templateName: 't', language: 'en', bodyParams: [] }, creds), /no message id/);
  await assert.rejects(bad(reply(401, { error: { code: 190 } })).verify(creds), e => e.kind === 'auth');
  const ik = mockFetch([{ match: u => u === 'https://api.interakt.ai/v1/public/message/', reply: reply(201, { result: true, id: 'ik-1' }) }]);
  assert.deepEqual(await new InteraktAdapter(ik).send({ to: '919845012345', templateName: 'welcome', language: 'en', bodyParams: ['x'] }, { api_key: 'KEY' }), { messageId: 'ik-1' });
  const ib = JSON.parse(ik.calls[0].body); assert.deepEqual([ib.countryCode, ib.phoneNumber, ib.type, ib.template.name], ['+91', '9845012345', 'Template', 'welcome']); assert.equal(ik.calls[0].headers.authorization, 'Basic KEY');
  for (const [s, k] of [[401, 'auth'], [429, 'rate_limit'], [500, 'transient'], [400, 'permanent']]) await assert.rejects(new InteraktAdapter(mockFetch([{ match: () => true, reply: reply(s, { result: false, message: 'm' }) }])).send({ to: '919845012345', templateName: 't', language: 'en', bodyParams: [] }, { api_key: 'k' }), e => e.kind === k);
  await assert.rejects(new InteraktAdapter(ik).verify(), /no read-only/);
  assert.equal(toWhatsAppNumber('+91 98450-12345'), '919845012345'); assert.equal(toWhatsAppNumber('09845012345', '91'), '919845012345');
  assert.throws(() => toWhatsAppNumber('9845012345'), e => e instanceof ProviderError && e.code === 'no_country_code');
  const hook = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: '123' }, statuses: [{ id: 'wamid.1', status: 'delivered' }, { id: 'wamid.2', status: 'failed', errors: [{ code: 131026, title: 'Undeliverable' }] }], messages: [{ from: '1', text: { body: 'inbound' } }] } }] }] };
  assert.deepEqual(parseWhatsAppWebhook(hook), [{ kind: 'whatsapp_status', asset_kind: 'phone_number', asset_id: '123', dedupe_key: 'wamid.1:delivered', payload: { message_id: 'wamid.1', status: 'delivered' } },
    { kind: 'whatsapp_status', asset_kind: 'phone_number', asset_id: '123', dedupe_key: 'wamid.2:failed', payload: { message_id: 'wamid.2', status: 'failed', error: '131026 Undeliverable' } }]);
  assert.deepEqual(parseWhatsAppWebhook({ object: 'page' }), []);
});

// A tiny in-memory stand-in for the database RPC surface used by the worker loops.
function fakeDb(state) {
  const log = [];
  return { log, rpc: async (fn, args = {}) => { log.push([fn, args]); const h = state[fn]; return h ? { data: await h(args), error: null } : { data: null, error: null }; } };
}
test('worker loops (fake database, mocked HTTP): Meta lead fetch, failures set connection state, WhatsApp sending rules', async () => {
  const creds = encryptJson({ user_token: 'u', pages: { P1: 'ptok' } }, key), wcreds = encryptJson({ access_token: 'tok' }, key);
  const graph = mockFetch([{ match: u => u.includes('/L1?'), reply: reply(200, { id: 'L1', field_data: [{ name: 'full_name', values: ['A'] }] }) }, { match: u => u.includes('/L2?'), reply: reply(400, { error: { code: 190, message: 'Session expired' } }) },
    { match: u => u.includes('/L3?'), reply: reply(500, {}) }, { match: (u, i) => u.endsWith('/55/messages'), reply: reply(200, { messages: [{ id: 'wamid.9' }] }) }]);
  const ev = (id, lead) => ({ id, connection_id: 'C1', payload: { page_id: 'P1', leadgen_id: lead } });
  const db = fakeDb({ integration_claim_events: () => [ev('e1', 'L1'), ev('e2', 'L2'), ev('e3', 'L3')], integration_ingest_lead: () => ({ status: 'created' }), integration_apply_status_events: () => 2, integration_claim_requests: () => [], payment_gateway_apply: () => ({ applied: 0, held: 0, ignored: 0 }) });
  const deps = { rpc: db.rpc, credentials: async () => creds, fetch: graph, key };
  assert.deepEqual(await processLeadEvents(deps), { claimed: 3, created: 1, failed: 2 });
  const calls = fn => db.log.filter(([f]) => f === fn).map(([, a]) => a);
  assert.deepEqual(calls('integration_ingest_lead')[0], { p_event: 'e1', p_fields: { full_name: 'A' }, p_meta: { provider: {} } });
  assert.deepEqual(calls('integration_fail_event').map(a => [a.p_event, a.p_retryable]), [['e2', false], ['e3', true]], 'auth errors dead-letter; 5xx retries');
  assert.deepEqual(calls('integration_set_connection_state').map(a => [a.p_status]), [['expired']], 'an expired token is surfaced as Expired');
  assert.equal(calls('integration_job').filter(a => a.p_status === 'failed').length, 2);
  assert.equal((await integrationTick(deps)).statuses, 2);
  // no stored credentials -> the event fails with an auth error, nothing is fetched
  const f0 = mockFetch([]); const db0 = fakeDb({ integration_claim_events: () => [ev('e9', 'L1')] });
  assert.equal((await processLeadEvents({ rpc: db0.rpc, credentials: async () => null, fetch: f0, key })).failed, 1); assert.equal(f0.calls.length, 0);
  // WhatsApp: sends only with credentials + template; other cases are failed without any HTTP call
  const req = (id, over = {}) => ({ id, connection_id: 'W1', payload: { message: 'Hello A', phone: '+919845012345' }, config: { provider: 'meta_cloud', phone_number_id: '55', template_name: 'welcome', template_language: 'en', ...over.config }, ...over.top });
  const run = async (reqs, credsOverride = wcreds) => { const d = fakeDb({ integration_claim_requests: () => reqs }); const f = mockFetch([{ match: u => u.endsWith('/55/messages'), reply: reply(200, { messages: [{ id: 'wamid.9' }] }) }]); const r = await deliverWhatsApp({ rpc: d.rpc, credentials: async () => credsOverride, fetch: f, key }); return { r, d, f }; };
  const good = await run([req('r1')]); assert.deepEqual(good.r, { claimed: 1, sent: 1, failed: 0 }); assert.deepEqual(good.d.log.find(([f]) => f === 'integration_complete_request')[1], { p_request: 'r1', p_ok: true, p_message_id: 'wamid.9', p_error: null, p_retryable: false });
  assert.equal(JSON.parse(good.f.calls[0].body).template.name, 'welcome');
  for (const [name, r] of [['no template', req('r2', { config: { template_name: undefined } })], ['no phone', req('r3', { top: { payload: { message: 'x' } } })], ['no country code', req('r4', { top: { payload: { message: 'x', phone: '9845012345' } } })], ['no provider', req('r5', { config: { provider: undefined } })]]) {
    const x = await run([r]); assert.equal(x.r.failed, 1, name); assert.equal(x.f.calls.length, 0, name + ': nothing sent'); const c = x.d.log.find(([f]) => f === 'integration_complete_request')[1]; assert.equal(c.p_ok, false); assert.equal(c.p_retryable, false, name);
  }
  const noCreds = await run([req('r6')], null).catch(e => e); assert.ok(noCreds.r === undefined || noCreds.r.failed === 1);
});

test('platform configuration reports exactly what is missing', () => {
  assert.deepEqual(missingFor('meta', {}).sort(), ['INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_GATEWAY_SECRET', 'META_APP_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN', 'NEXT_PUBLIC_SITE_URL']);
  assert.deepEqual(missingFor('forms', {}), []); assert.deepEqual(missingFor('whatsapp', { INTEGRATION_ENCRYPTION_KEY: 'x' }), ['INTEGRATION_GATEWAY_SECRET']);
});
