// Process wrapper shared by the three workers: credentials, heartbeat, health endpoint, graceful shutdown. All logic that matters is in src/lib/workers/loop.ts.
import { createClient } from '@supabase/supabase-js';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { tokenDaysLeft, TOKEN_WARN_DAYS } from '../src/lib/workers/token.ts';
import { checkTarget } from '../src/lib/env-guard.ts';
import { runLoop, newHealth, isHealthy } from '../src/lib/workers/loop.ts';

export const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
/** Least privilege: with WORKER_JWT (a token for the restricted `optizen_worker` role, see worker/mint-worker-token.mjs) the worker can run only the worker functions. Falling back to the service-role key works but is logged. */
/** The current worker token: WORKER_JWT_FILE (re-read on every request, so a token can be renewed by replacing the file, with no restart) or WORKER_JWT. */
const currentToken = () => { const f = process.env.WORKER_JWT_FILE; if (f) { try { const t = readFileSync(f, 'utf8').trim(); if (t) return t; } catch { /* fall back to the environment */ } } return process.env.WORKER_JWT; };
export function database() {
  { const problem = checkTarget(process.env); if (problem) { console.error(`Startup refused: ${problem}`); process.exit(1); } } // never run against the wrong project
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL; const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  if (currentToken() && process.env.SUPABASE_ANON_KEY && url) {
    const withToken = (input, init) => { const h = new Headers(init?.headers); h.set('Authorization', `Bearer ${currentToken()}`); return fetch(input, { ...init, headers: h }); };
    return { db: createClient(url, process.env.SUPABASE_ANON_KEY, { ...opts, global: { fetch: withToken } }), mode: 'restricted-role', tokenDaysLeft: () => tokenDaysLeft(currentToken()) };
  }
  if (url && process.env.SUPABASE_SERVICE_ROLE_KEY) { log({ level: 'warn', message: 'Using the service-role key. Prefer WORKER_JWT + SUPABASE_ANON_KEY (restricted role).' }); return { db: createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, opts), mode: 'service-role', tokenDaysLeft: () => null }; }
  console.error('Set SUPABASE_URL and either (WORKER_JWT + SUPABASE_ANON_KEY) or SUPABASE_SERVICE_ROLE_KEY.'); process.exit(1);
}
export async function start({ name, tick, pollMs }) {
  const { db, mode, tokenDaysLeft: daysLeft } = database(); const once = process.argv.includes('--once'); const instance = `${process.env.FLY_MACHINE_ID || hostname()}-${process.pid}`; const version = (process.env.FLY_IMAGE_REF || process.env.GIT_SHA || 'dev').slice(-40);
  let stop = false; for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
  const health = newHealth(Date.now()); const poll = pollMs;
  if (!once && process.env.PORT !== '0') createServer((req, res) => { const ok = isHealthy(health, Date.now(), poll); res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok, worker: name, ticks: health.ticks, lastOkAt: health.lastOkAt, consecutiveFailures: health.consecutiveFailures })); }).listen(Number(process.env.PORT) || 8080);
  log({ level: 'info', worker: name, instance, mode, message: 'worker started' });
  { const d = daysLeft(); if (d !== null && d < TOKEN_WARN_DAYS) log({ level: d < 0 ? 'error' : 'warn', worker: name, message: d < 0 ? 'The worker token has expired. Mint a new one (worker/mint-worker-token.mjs).' : `The worker token expires in ${d} day(s). Mint and deploy a new one.` }); }
  try {
    await runLoop({ name, instance, version, pollMs, once, health, now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), shouldStop: () => stop, log, tick: () => tick(db),
      heartbeat: async (stats, error) => { const r = await db.rpc('worker_heartbeat', { p_worker: name, p_instance: instance, p_version: version, p_stats: { ...stats, ...(daysLeft() === null ? {} : { token_days_left: daysLeft() }) }, p_error: error }); if (r.error) throw new Error(r.error.message); } });
  } catch (e) { log({ level: 'error', message: e.message }); process.exit(1); }
  process.exit(0);
}
