// Worker health for external monitoring. Pure evaluation plus the request handler, so both are tested without a network.
export type WorkerHealthPayload = { status: string; expected?: string[]; workers?: { worker: string; age_seconds: number; healthy: boolean }[] };
export type WorkerHealth = { ok: boolean; stale: string[]; missing: string[]; workers: { worker: string; ageSeconds: number; healthy: boolean }[] };
export function evaluateWorkers(p: WorkerHealthPayload): WorkerHealth {
  const workers = (p.workers ?? []).map(w => ({ worker: w.worker, ageSeconds: w.age_seconds, healthy: w.healthy })); const seen = new Set(workers.map(w => w.worker));
  const missing = (p.expected ?? []).filter(n => !seen.has(n)); const stale = workers.filter(w => !w.healthy).map(w => w.worker);
  return { ok: missing.length === 0 && stale.length === 0 && workers.length > 0, stale, missing, workers };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
/** 200 when every expected worker has a fresh heartbeat, 503 otherwise (so an uptime monitor alerts), 401 without the monitor token. Only worker names and ages are returned. */
export async function handleWorkerHealth(req: Request, env: { OPS_HEALTH_TOKEN?: string; INTEGRATION_GATEWAY_SECRET?: string }, rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>, timingSafeEqual: (a: Buffer, b: Buffer) => boolean): Promise<Response> {
  if (!env.OPS_HEALTH_TOKEN || env.OPS_HEALTH_TOKEN.length < 16 || !env.INTEGRATION_GATEWAY_SECRET) return json(503, { ok: false, error: 'Not configured' });
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1] ?? ''; const a = Buffer.from(given), b = Buffer.from(env.OPS_HEALTH_TOKEN);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return json(401, { ok: false });
  const r = await rpc('worker_health_check', { p_gateway_secret: env.INTEGRATION_GATEWAY_SECRET });
  if (r.error || (r.data as WorkerHealthPayload | null)?.status !== 'ok') return json(503, { ok: false, error: 'Health check unavailable' });
  const h = evaluateWorkers(r.data as WorkerHealthPayload); return json(h.ok ? 200 : 503, h);
}
