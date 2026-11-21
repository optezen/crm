// Integration worker: fetches Meta leads for received webhook events, sends consented WhatsApp template messages (at most once), applies delivery statuses.
// Needs INTEGRATION_ENCRYPTION_KEY to decrypt provider credentials. Requires Node >= 22.18 (shared TypeScript adapters).
import { start, database } from './runtime.mjs';
import { integrationTick } from '../src/lib/integrations/worker.ts';
import { parseKey } from '../src/lib/integrations/crypto.ts';
let key; try { key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY); } catch (e) { console.error(e.message); process.exit(1); }
await start({ name: 'integrations', pollMs: Number(process.env.INTEGRATION_POLL_MS) || 5000, tick: async db => {
  const deps = { key, rpc: (fn, args) => db.rpc(fn, args), credentials: async id => (await db.from('integration_credentials').select('ciphertext').eq('connection_id', id).maybeSingle()).data?.ciphertext ?? null, fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(15000) }) };
  const r = await integrationTick(deps); return { busy: r.busy, stats: { statuses: r.statuses, lead_events: r.leads.claimed, leads_created: r.leads.created, messages_sent: r.messages.sent, messages_failed: r.messages.failed, payments_applied: r.payments.applied, payments_held: r.payments.held } };
} });
void database;
