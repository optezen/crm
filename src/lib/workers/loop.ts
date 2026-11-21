// The loop every Optizen worker runs. Pure and dependency-injected so restarts, failures and shutdown can be tested offline.
// A worker holds NO state that matters: queues, leases, retries and delays all live in Postgres. This loop only (1) calls one tick, (2) backs off after failures,
// (3) reports a heartbeat that contains counters and an error CLASS (never data), and (4) stops cleanly between ticks.
export type TickResult = { busy: boolean; stats?: Record<string, number> };
export type Health = { startedAt: number; lastOkAt: number | null; lastErrorAt: number | null; consecutiveFailures: number; ticks: number };
export type LoopDeps = {
  name: 'automation' | 'integrations' | 'maintenance'; instance: string; version: string;
  tick: () => Promise<TickResult>; heartbeat: (stats: Record<string, number>, error: string | null) => Promise<void>;
  sleep: (ms: number) => Promise<void>; now: () => number; pollMs: number; heartbeatMs?: number; once?: boolean; shouldStop: () => boolean; log: (o: Record<string, unknown>) => void; health: Health;
};
export const newHealth = (now: number): Health => ({ startedAt: now, lastOkAt: null, lastErrorAt: null, consecutiveFailures: 0, ticks: 0 });
/** Error CLASS only: messages can contain customer data, so they stay in the worker's own log, never in the shared heartbeat. */
export const errorClass = (e: unknown): string => { const m = String((e as { code?: string })?.code ?? (e as Error)?.name ?? 'Error').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40); return m || 'Error'; };
export const backoffMs = (failures: number) => Math.min(60_000, 1000 * 2 ** Math.min(failures, 6));
/** Healthy = it has completed a tick recently enough (3 poll intervals plus 30 s). Used by the HTTP health check and the diagnostics screen. */
export const isHealthy = (h: Health, now: number, pollMs: number) => (h.lastOkAt ?? h.startedAt) > now - (3 * pollMs + 30_000) && h.consecutiveFailures < 8;

export async function runLoop(d: LoopDeps): Promise<Health> {
  const hbEvery = d.heartbeatMs ?? 30_000; let lastHb = -Infinity; const totals: Record<string, number> = { ticks: 0, failures: 0 }; let lastError: string | null = null;
  const beat = async (force = false) => { if (!force && d.now() - lastHb < hbEvery) return; lastHb = d.now(); try { await d.heartbeat({ ...totals, consecutive_failures: d.health.consecutiveFailures }, lastError); } catch { /* a missed heartbeat only makes the worker look stale; it must not stop work */ } };
  await beat(true);
  do {
    let busy = false;
    try {
      const r = await d.tick(); busy = r.busy; d.health.ticks++; totals.ticks = d.health.ticks; d.health.lastOkAt = d.now(); d.health.consecutiveFailures = 0; lastError = null;
      for (const [k, v] of Object.entries(r.stats ?? {})) totals[k] = (totals[k] ?? 0) + v;
      if (busy) d.log({ level: 'info', worker: d.name, ...(r.stats ?? {}) });
    } catch (e) {
      d.health.consecutiveFailures++; d.health.lastErrorAt = d.now(); totals.failures++; lastError = errorClass(e);
      d.log({ level: 'error', worker: d.name, class: lastError, message: (e as Error)?.message?.slice(0, 200), failures: d.health.consecutiveFailures });
      await beat(true); if (d.once) throw e; await d.sleep(backoffMs(d.health.consecutiveFailures)); continue;
    }
    await beat();
    if (!d.once && !busy && !d.shouldStop()) await d.sleep(d.pollMs);
  } while (!d.once && !d.shouldStop());
  await beat(true); d.log({ level: 'info', worker: d.name, message: 'worker stopped' });
  return d.health;
}
