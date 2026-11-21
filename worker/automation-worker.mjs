// Optizen automation worker. Runs anywhere Node 22 runs (Fly.io machine, container, VM, or a cron-triggered one-shot with --once).
// It holds NO state and NO timers that matter: all queueing, delays, retries and locking live in Postgres (public.automation_tick), so any number
// of copies can run at once and a restart loses nothing. It authenticates with the Supabase SERVICE ROLE key; keep that key out of the web app.
//
//   SUPABASE_URL=...  SUPABASE_SERVICE_ROLE_KEY=...  node worker/automation-worker.mjs [--once]
// Optional: AUTOMATION_POLL_MS (idle poll interval, default 5000), AUTOMATION_BATCH (runs per tick, default 20).
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required.'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const poll = Number(process.env.AUTOMATION_POLL_MS) || 5000, batch = Number(process.env.AUTOMATION_BATCH) || 20;
const once = process.argv.includes('--once');
let stop = false; for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

let failures = 0;
do {
  const { data, error } = await db.rpc('automation_tick', { p_dispatch: 500, p_runs: batch });
  if (error) { failures++; log({ level: 'error', code: error.code, message: error.message, failures }); if (once) process.exit(1); await sleep(Math.min(60000, 1000 * 2 ** failures)); continue; }
  failures = 0;
  const busy = data.dispatched > 0 || Object.keys(data.runs).length > 0;
  if (busy) log({ level: 'info', ...data });
  if (!once && !busy) await sleep(poll);
} while (!once && !stop);
log({ level: 'info', message: 'worker stopped' });
