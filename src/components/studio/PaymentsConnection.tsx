'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { LocalTime } from '../ui/LocalTime';
import { STATUS_LABEL, type ConnectionRow } from '../../lib/integrations/types';

type R = { ok: true; message: string } | { ok: false; error: string };
export type PaymentsActions = { create: () => Promise<R>; saveSecret: (id: string, secret: string) => Promise<R>; activate: (id: string) => Promise<R>; disconnect: (id: string) => Promise<R> };

/** Razorpay: create -> register the webhook there -> paste its signing secret here -> receive one correctly signed notification -> activate. "Active" is never shown without that evidence. */
export function PaymentsConnection({ connection, siteUrl, secretSaved, missing, actions }: { connection: ConnectionRow | null; siteUrl: string; secretSaved: boolean; missing: string[]; actions: PaymentsActions }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>(); const [secret, setSecret] = useState('');
  const run = (fn: () => Promise<R>, after?: () => void) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) { after?.(); router.refresh(); } });
  const c = connection && connection.status !== 'not_connected' ? connection : null; const url = c?.publicId ? `${siteUrl}/api/webhooks/payments/${c.publicId}` : '';
  const evidence = !!c?.lastEventAt;
  return <Card title="Payments (Razorpay)" description="Record gateway payments against invoices from verified notifications. A payment is recorded only when its signature is valid and it matches an open invoice; manual payments stay separate.">
    <div className="stack" style={{ gap: 12 }}>
      <div className="row"><span className={`badge ${c?.status === 'connected' ? '' : c?.status === 'error' || c?.status === 'expired' ? 'late' : 'done'}`}>{c ? STATUS_LABEL[c.status] : 'Not connected'}</span>
        {c && <span className="muted">Last verified notification: {c.lastEventAt ? <LocalTime iso={c.lastEventAt} /> : 'none yet'}</span>}</div>
      {c?.lastError && <p className="err" role="alert">Last problem: {c.lastError}</p>}
      {missing.length > 0 && <p role="alert" className="err">This deployment is missing: {missing.join(', ')}. Ask the person who runs the deployment to set them (docs/PROVIDERS.md).</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
      {!c ? <div><button type="button" className="btn primary" disabled={pending || missing.length > 0} onClick={() => run(actions.create)}>{pending ? 'Working…' : 'Connect Razorpay'}</button>
        <p className="muted">Needs billing turned on in Builder → Business operations, and a Razorpay account with webhooks enabled.</p></div> : <ol className="stack" style={{ gap: 14, paddingLeft: 20 }}>
        <li><strong>Add this webhook in Razorpay</strong> (Dashboard → Account &amp; Settings → Webhooks). Events: <code>payment.captured</code> (and optionally <code>payment.failed</code>, <code>refund.processed</code>).
          <div className="field" style={{ marginTop: 6 }}><label htmlFor="pay-url">Webhook URL</label><div className="row"><input id="pay-url" className="input" style={{ flex: 1, minWidth: 0 }} readOnly value={url} onFocus={e => e.currentTarget.select()} /><CopyButton value={url} label="payments webhook URL" /></div></div></li>
        <li><strong>Paste the webhook secret</strong> you chose in Razorpay. {secretSaved ? <span className="badge">Secret saved</span> : <span className="badge late">Not saved yet</span>}
          <div className="row" style={{ marginTop: 6 }}><div className="field" style={{ flex: 1, minWidth: 200 }}><label htmlFor="pay-secret">Webhook secret</label><input id="pay-secret" type="password" autoComplete="off" className="input" value={secret} onChange={e => setSecret(e.target.value)} placeholder={secretSaved ? 'Paste a new secret to replace it' : ''} /></div>
            <button type="button" className="btn" disabled={pending || secret.trim().length < 8} onClick={() => run(() => actions.saveSecret(c.id, secret), () => setSecret(''))}>Save secret</button></div>
          <span className="muted">Stored encrypted. It is never shown again.</span></li>
        <li><strong>Send one test payment</strong> in Razorpay test mode with <code>invoice_id</code> set to an issued invoice’s id in the payment notes. When Optizen receives a correctly signed notification, the step below turns green.
          <div role="status" className={evidence ? 'ok' : 'muted'}>{evidence ? <>Verified: a signed notification arrived <LocalTime iso={c.lastEventAt!} />.</> : 'Waiting for the first signed notification…'}</div></li>
        <li><strong>Activate</strong>{c.status === 'connected' ? ' — active.' : ''} Payments are applied to invoices only while the connection is active; anything received earlier is held and can be retried from Operations.
          <div className="row" style={{ marginTop: 6 }}>{c.status !== 'connected' && <button type="button" className="btn primary" disabled={pending || !evidence || !secretSaved} onClick={() => run(() => actions.activate(c.id))} aria-describedby="pay-activate-hint">Activate payments</button>}
            <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Disconnect the payment gateway? New notifications are no longer accepted; history is kept.')) run(() => actions.disconnect(c.id)); }}>Disconnect</button></div>
          {c.status !== 'connected' && <span id="pay-activate-hint" className="muted">{!secretSaved ? 'Save the secret first.' : !evidence ? 'Available after a verified notification arrives.' : 'Ready.'}</span>}</li>
      </ol>}
    </div>
  </Card>;
}
