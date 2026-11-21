// Optizen integration worker: fetches Meta leads for received webhook events, sends queued WhatsApp template requests, applies delivery statuses.
// Stateless; safe to run several copies (claims use SKIP LOCKED and expire if a worker dies). Uses the SERVICE ROLE key: never deploy it to the web app.
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... INTEGRATION_ENCRYPTION_KEY=... node worker/integration-worker.mjs [--once]
// Imports the shared TypeScript adapters directly: requires Node >= 22.18 (type stripping), i.e. the node:24 image in worker/Dockerfile.
import { createClient } from '@supabase/supabase-js';
import { integrationTick } from '../src/lib/integrations/worker.ts';
import { parseKey } from '../src/lib/integrations/crypto.ts';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, sk = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !sk) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }
let key; try { key = parseKey(process.env.INTEGRATION_ENCRYPTION_KEY); } catch (e) { console.error(e.message); process.exit(1); }
const db = createClient(url, sk, { auth: { persistSession: false, autoRefreshToken: false } });
const deps = {
  key,
  rpc: (fn, args) => db.rpc(fn, args),
  credentials: async id => (await db.from('integration_credentials').select('ciphertext').eq('connection_id', id).maybeSingle()).data?.ciphertext ?? null,
  fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(15000) }),
};
const poll = Number(process.env.INTEGRATION_POLL_MS) || 5000, once = process.argv.includes('--once');
let stop = false; for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
let failures = 0, lastPurge = 0;
do {
  try {
    const r = await integrationTick(deps); failures = 0;
    if (r.busy) log({ level: 'info', ...r });
    if (Date.now() - lastPurge > 3600e3) { lastPurge = Date.now(); await db.rpc('integration_purge', { p_days: 30 }); }
    if (!once && !r.busy) await new Promise(r => setTimeout(r, poll));
  } catch (e) { failures++; log({ level: 'error', message: e.message, failures }); if (once) process.exit(1); await new Promise(r => setTimeout(r, Math.min(60000, 1000 * 2 ** failures))); }
} while (!once && !stop);
