import { Frame } from '../fixture';
import { OperationsView } from '../../../components/studio/OperationsView';
import type { OpsData } from '../../../lib/ops/health';

// Sample data only (this route exists only when OPTIZEN_UX_FIXTURES=1). It shows the real view in a healthy, a degraded and an empty state.
const NOW = '2026-11-21T10:00:00.000Z';
const w = (worker: string, ago: number, extra = {}) => ({ worker, instance: `${worker}-1`, last_seen: new Date(Date.parse(NOW) - ago * 1000).toISOString(), started_at: '2026-11-20T10:00:00.000Z', version: 'abc1234', healthy: ago < 120, last_error: null, last_error_at: null, stats: { ticks: 120, claimed: 4 }, ...extra });
const base: OpsData = { now: NOW, workers: [w('automation', 10), w('integrations', 12), w('maintenance', 20)], queues: { automation_runs: { queued: 2, retrying: 1, dead: 1 }, oldest_queued_run_seconds: 45, webhook_events: { received: 3, failed: 1, dead: 1 }, messages: { requested: 2, failed: 2 }, uncertain_messages: 1, reminders_pending: 7 }, messages: [
  { id: 'l1', request_id: 'r1', event: 'uncertain', detail: 'Delivery uncertain: the worker stopped while sending.', template: 'lead_welcome', at: '2026-11-21T09:00:00.000Z', can_requeue: true },
  { id: 'l2', request_id: 'r2', event: 'failed', detail: 'The customer has not opted in.', template: 'appt_reminder', at: '2026-11-21T08:00:00.000Z', can_requeue: false }],
  failedLeads: [{ id: 'e1', connection: 'Meta Lead Ads (sample)', status: 'dead', attempts: 5, lastError: 'Meta rejected the access token (expired). Reconnect Meta.', receivedAt: '2026-11-21T07:00:00.000Z' }], deadRuns: [{ id: 'run1', lastError: 'Step 2 failed: no assignee available.', createdAt: '2026-11-21T06:00:00.000Z' }],
  connections: [{ id: 'c1', provider: 'meta_lead_ads', name: 'Meta Lead Ads (sample)', status: 'expired', lastError: 'Meta rejected the access token (expired). Reconnect Meta.', lastErrorAt: '2026-11-21T07:00:00.000Z' }, { id: 'c2', provider: 'whatsapp', name: 'WhatsApp (sample)', status: 'connected', lastError: null, lastErrorAt: null }],
  errors: [{ id: 'x1', source: 'meta', code: '190', message: 'Meta rejected the access token (expired). Reconnect Meta.', createdAt: '2026-11-21T07:00:00.000Z' }],
  payments: { held: [{ id: 'p1', kind: 'payment_captured', amount: 400, currency: 'INR', reason: 'The payment is for more than the outstanding balance.', received_at: '2026-11-21T05:00:00.000Z' }], applied_without_payment: 0, gateway_payments_without_event: 0, gateway_total_by_currency: { INR: 1000 }, manual_total_by_currency: { INR: 50 } } };
const empty: OpsData = { ...base, workers: [], queues: { automation_runs: {}, oldest_queued_run_seconds: null, webhook_events: {}, messages: {}, uncertain_messages: 0, reminders_pending: 0 }, messages: [], failedLeads: [], deadRuns: [], connections: [], errors: [], payments: null };
async function ok(): Promise<{ ok: true; message: string }> { 'use server'; return { ok: true, message: 'Queued (sample).' }; }
async function refuse(): Promise<{ ok: false; error: string }> { 'use server'; return { ok: false, error: 'Only a failed message the provider did not accept can be sent again.' }; }

export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams; const stopped = state === 'stopped';
  const data = state === 'empty' ? empty : stopped ? { ...base, workers: [w('automation', 10), w('integrations', 900, { healthy: false, last_error: 'ProviderError' }), w('maintenance', 20)] } : base;
  return <Frame><h1>Operations fixture</h1><OperationsView data={data} actions={{ message: refuse, lead: ok, run: ok, payment: ok }} /></Frame>;
}
