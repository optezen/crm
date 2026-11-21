// Automation worker: runs queued/delayed/retrying workflow runs via public.automation_tick (leases and retries live in Postgres; any number of copies may run).
//   SUPABASE_URL=... WORKER_JWT=... SUPABASE_ANON_KEY=...   (or SUPABASE_SERVICE_ROLE_KEY=...)   node worker/automation-worker.mjs [--once]
import { start } from './runtime.mjs';
const batch = Number(process.env.AUTOMATION_BATCH) || 20;
await start({ name: 'automation', pollMs: Number(process.env.AUTOMATION_POLL_MS) || 5000, tick: async db => {
  const { data, error } = await db.rpc('automation_tick', { p_dispatch: 500, p_runs: batch }); if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return { busy: data.dispatched > 0 || Object.keys(data.runs).length > 0, stats: { dispatched: data.dispatched, runs: Object.values(data.runs).reduce((a, b) => a + b, 0) } };
} });
