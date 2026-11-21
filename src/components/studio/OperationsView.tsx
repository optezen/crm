'use client';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '../ui/Card';
import { LocalTime } from '../ui/LocalTime';
import { STATUS_LABEL } from '../../lib/integrations/types';
import type { OpsData } from '../../lib/ops/health';

type R = { ok: true; message: string } | { ok: false; error: string };
export type OpsActions = { message: (id: string) => Promise<R>; lead: (id: string) => Promise<R>; run: (id: string) => Promise<R>; payment: (id: string) => Promise<R> };
const WORKER_LABEL: Record<string, string> = { automation: 'Automations', integrations: 'Integrations and messages', maintenance: 'Maintenance and reminders' };
const n = (o: Record<string, number>, k: string) => o[k] ?? 0;
const age = (s: number | null) => (s == null ? 'nothing waiting' : s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const counters = (stats: Record<string, unknown>) => Object.entries(stats).filter(([, v]) => typeof v === 'number').slice(0, 6).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ');

export function OperationsView({ data, actions }: { data: OpsData; actions: OpsActions }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>(); const [busy, setBusy] = useState<string>();
  const go = (key: string, fn: () => Promise<R>) => { setBusy(key); start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); setBusy(undefined); if (r.ok) router.refresh(); }); };
  const q = data.queues, healthy = data.workers.filter(w => w.healthy), stale = data.workers.filter(w => !w.healthy);
  const retryableMessages = data.messages.filter(m => m.can_requeue).filter((m, i, a) => a.findIndex(x => x.request_id === m.request_id) === i);
  const needsPerson = data.deadRuns.length + data.failedLeads.length + retryableMessages.length + (data.payments?.held.length ?? 0);
  const Btn = ({ k, label, what, fn }: { k: string; label: string; what: string; fn: () => Promise<R> }) => <button type="button" className="btn small" disabled={pending} aria-label={`${label}: ${what}`} onClick={() => go(k, fn)}>{pending && busy === k ? 'Working…' : label}</button>;
  return <div className="stack">
    {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
    <Card title="Background workers" description="Small always-on programs that run automations, deliver messages and run maintenance. Each reports a heartbeat about every 30 seconds.">
      <div className="stack" style={{ gap: 12 }}>
        {data.workers.length === 0 ? <p role="alert" className="err" id="ops-workers"><strong>No worker has reported yet.</strong> Automations, WhatsApp delivery, reminders and overdue follow-up alerts do not run until the workers are deployed. See docs/WORKERS.md.</p>
          : stale.length ? <p role="alert" className="err" id="ops-workers"><strong>{stale.length} worker{stale.length > 1 ? 's' : ''} stopped reporting.</strong> Work is queued safely and resumes when a worker returns; nothing is lost or duplicated.</p>
          : <p role="status" className="ok" id="ops-workers"><strong>All {healthy.length} worker{healthy.length > 1 ? 's are' : ' is'} running.</strong></p>}
        {data.workers.length > 0 && <div className="table-wrap" tabIndex={0} role="region" aria-label="Worker heartbeats"><table><caption className="sr-only">Worker heartbeats</caption><thead><tr><th scope="col">Worker</th><th scope="col">State</th><th scope="col">Last heartbeat</th><th scope="col">Version</th><th scope="col">Last problem</th></tr></thead><tbody>
          {data.workers.map(w => <tr key={`${w.worker}:${w.instance}`}><th scope="row">{WORKER_LABEL[w.worker] ?? w.worker}<div className="muted" style={{ fontSize: 12 }}>{counters(w.stats)}</div></th>
            <td><span className={`badge ${w.healthy ? '' : 'late'}`}>{w.healthy ? 'Running' : 'Not reporting'}</span></td><td><LocalTime iso={w.last_seen} /></td><td>{w.version ?? '—'}</td>
            <td>{w.last_error ? <><span className="err">{w.last_error}</span>{w.last_error_at && <> · <LocalTime iso={w.last_error_at} /></>}</> : '—'}</td></tr>)}</tbody></table></div>}
      </div></Card>

    <Card title="Queue backlog" description="Work waiting to be processed for this workspace. A growing number with a healthy worker means a provider is slow or failing.">
      <div className="table-wrap" tabIndex={0} role="region" aria-label="Queues"><table><caption className="sr-only">Queues</caption><thead><tr><th scope="col">Queue</th><th scope="col">Waiting</th><th scope="col">Retrying / failing</th><th scope="col">Needs a person</th></tr></thead><tbody>
        <tr><th scope="row">Automation runs<div className="muted" style={{ fontSize: 12 }}>Oldest due: {age(q.oldest_queued_run_seconds)}</div></th><td>{n(q.automation_runs, 'queued') + n(q.automation_runs, 'waiting')}</td><td>{n(q.automation_runs, 'retrying')}</td><td>{n(q.automation_runs, 'dead')}</td></tr>
        <tr><th scope="row">Incoming events (Meta leads, delivery statuses)</th><td>{n(q.webhook_events, 'received') + n(q.webhook_events, 'processing')}</td><td>{n(q.webhook_events, 'failed')}</td><td>{n(q.webhook_events, 'dead')}</td></tr>
        <tr><th scope="row">WhatsApp messages</th><td>{n(q.messages, 'requested') + n(q.messages, 'sending')}</td><td>—</td><td>{n(q.messages, 'failed')}{q.uncertain_messages > 0 && <span className="muted"> ({q.uncertain_messages} delivery uncertain)</span>}</td></tr>
        <tr><th scope="row">Appointment reminders scheduled</th><td>{q.reminders_pending}</td><td>—</td><td>—</td></tr></tbody></table></div></Card>

    <Card title={`Needs a person${needsPerson ? ` (${needsPerson})` : ''}`} description="Items the system will not retry on its own, because retrying could repeat an action or needs a fix first.">
      {needsPerson === 0 ? <p className="muted">Nothing is stuck.</p> : <ul className="stack" style={{ gap: 12, listStyle: 'none', padding: 0, margin: 0 }}>
        {data.deadRuns.map(r => <li key={r.id} className="row"><span style={{ flex: 1 }}><strong>Automation failed</strong> · <LocalTime iso={r.createdAt} /><div className="err">{r.lastError ?? 'No details recorded.'}</div></span><Btn k={r.id} label="Retry" what="automation run" fn={() => actions.run(r.id)} /></li>)}
        {data.failedLeads.map(l => <li key={l.id} className="row"><span style={{ flex: 1 }}><strong>Lead from {l.connection} was not imported</strong> · <LocalTime iso={l.receivedAt} /> · {l.attempts} attempt{l.attempts === 1 ? '' : 's'}<div className="err">{l.lastError ?? 'No details recorded.'}</div><div className="muted">Fix the connection first (reconnect Meta, restore permissions), then retry.</div></span><Btn k={l.id} label="Retry" what="incoming lead" fn={() => actions.lead(l.id)} /></li>)}
        {retryableMessages.map(m => <li key={m.request_id} className="row"><span style={{ flex: 1 }}><strong>WhatsApp message not delivered</strong> · <LocalTime iso={m.at} />{m.template && <> · template {m.template}</>}<div className="err">{m.detail ?? 'No details recorded.'}</div>{m.detail?.startsWith('Delivery uncertain') && <div className="muted">The provider may already have delivered this one. Check the customer’s chat before sending again.</div>}</span><Btn k={m.request_id} label="Send again" what="WhatsApp message" fn={() => actions.message(m.request_id)} /></li>)}
        {data.payments?.held.map(h => <li key={h.id} className="row"><span style={{ flex: 1 }}><strong>Gateway payment on hold</strong>{h.amount != null && <> · {h.amount} {h.currency}</>} · <LocalTime iso={h.received_at} /><div className="err">{h.reason ?? 'No reason recorded.'}</div><div className="muted">Nothing was recorded against an invoice. Fix the cause, then retry.</div></span><Btn k={h.id} label="Retry" what="held payment" fn={() => actions.payment(h.id)} /></li>)}
      </ul>}</Card>

    <Card title="Connection status" description="A connection only says Connected after the provider accepted its credentials.">
      {data.connections.length === 0 ? <p className="muted">No connections yet. <Link href="/builder/connections">Set one up</Link>.</p> : <div className="table-wrap" tabIndex={0} role="region" aria-label="Connections"><table><caption className="sr-only">Connections</caption><thead><tr><th scope="col">Connection</th><th scope="col">Status</th><th scope="col">Last problem</th></tr></thead><tbody>
        {data.connections.map(c => <tr key={c.id}><th scope="row">{c.name}<div className="muted" style={{ fontSize: 12 }}>{c.provider.replace(/_/g, ' ')}</div></th><td><span className={`badge ${c.status === 'connected' ? '' : c.status === 'error' || c.status === 'expired' ? 'late' : 'done'}`}>{STATUS_LABEL[c.status]}</span>{(c.status === 'expired' || c.status === 'error') && <> <Link href="/builder/connections">Reconnect</Link></>}</td><td>{c.lastError ? <><span className="err">{c.lastError}</span>{c.lastErrorAt && <> · <LocalTime iso={c.lastErrorAt} /></>}</> : '—'}</td></tr>)}</tbody></table></div>}</Card>

    {data.errors.length > 0 && <Card title="Recent integration errors" description="Short, secret-free descriptions of what went wrong, newest first.">
      <ul style={{ margin: 0, paddingLeft: 18 }}>{data.errors.map(e => <li key={e.id}><LocalTime iso={e.createdAt} /> · {e.source}{e.code ? ` (${e.code})` : ''}: {e.message}</li>)}</ul></Card>}

    {data.payments && <Card title="Payment reconciliation" description="Gateway payments are recorded only from verified provider notifications. Manual payments are counted separately.">
      <p>Gateway: {Object.entries(data.payments.gateway_total_by_currency).map(([c, t]) => `${t} ${c}`).join(', ') || 'none'} · Manual: {Object.entries(data.payments.manual_total_by_currency).map(([c, t]) => `${t} ${c}`).join(', ') || 'none'}</p>
      {(data.payments.applied_without_payment > 0 || data.payments.gateway_payments_without_event > 0) && <p role="alert" className="err">Mismatch: {data.payments.applied_without_payment} applied event(s) without a payment and {data.payments.gateway_payments_without_event} gateway payment(s) without an event. Investigate before closing the books.</p>}</Card>}

    <Card title="Recent WhatsApp activity" description="What was sent, retried or failed. Message text and phone numbers are never shown here.">
      {data.messages.length === 0 ? <p className="muted">No messages yet.</p> : <div className="table-wrap" tabIndex={0} role="region" aria-label="Message log"><table><caption className="sr-only">Message log</caption><thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Template</th><th scope="col">Detail</th></tr></thead><tbody>
        {data.messages.map(m => <tr key={m.id}><td><LocalTime iso={m.at} /></td><td>{m.event}</td><td>{m.template ?? '—'}</td><td>{m.detail ?? '—'}</td></tr>)}</tbody></table></div>}</Card>
  </div>;
}
