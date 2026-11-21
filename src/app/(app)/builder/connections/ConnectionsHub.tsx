'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Card } from '../../../../components/ui/Card';
import { LocalTime } from '../../../../components/ui/LocalTime';
import { CRM_TARGETS, PROVIDER_INFO, STATUS_LABEL, TARGET_LABEL, type ConnectionRow, type CrmTarget } from '../../../../lib/integrations/types';
import { META_PERMISSIONS } from '../../../../lib/integrations/env';
import type { HubData } from '../../../../lib/integrations/service';
import { createFormConnectionAction, disconnectAction, loadObservedFieldsAction, rotateSecretAction, saveMappingsAction, saveWhatsAppAction, setAllowQueryKeyAction, selectMetaPageAction, setRateLimitAction, type HubResult } from './actions';

type Msg = { ok: boolean; text: string } | undefined;
const badge = (s: ConnectionRow['status'] | 'not_connected') => `badge ${s === 'connected' ? '' : s === 'error' || s === 'expired' ? 'late' : 'done'}`;
const Status = ({ s }: { s: ConnectionRow['status'] }) => <span className={badge(s)}>{STATUS_LABEL[s]}</span>;
function useRun() {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<Msg>();
  const run = <T extends object>(fn: () => Promise<HubResult<T>>, after?: (r: Extract<HubResult<T>, { ok: true }>) => void) => start(async () => { const r = await fn(); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) after?.(r as Extract<HubResult<T>, { ok: true }>); router.refresh(); });
  return { run, pending, msg, Msg: () => msg ? <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p> : null };
}
const Health = ({ c, counts }: { c: ConnectionRow; counts?: { received: number; created: number; rejected: number } }) => <div className="muted" style={{ fontSize: 13 }}>
  Last event: {c.lastEventAt ? <LocalTime iso={c.lastEventAt} /> : 'none yet'} · Last sync: {c.lastSyncAt ? <LocalTime iso={c.lastSyncAt} /> : 'n/a'}{counts && ` · Last 24h: ${counts.received} received, ${counts.created} leads, ${counts.rejected} rejected`}
  {c.lastError && <div className="err">Last problem: {c.lastError}</div>}</div>;
const Contract = ({ id, extra }: { id: 'google_ads' | 'telephony' | 'payments'; extra: string }) => <Card title={PROVIDER_INFO[id].label} description={PROVIDER_INFO[id].blurb}>
  <div className="stack"><span className="badge done">Not connected</span><p className="muted">{extra} There is nothing to connect yet: no setup is offered here until a real adapter exists. The adapter contract is documented in docs/INTEGRATIONS.md.</p></div></Card>;

function Snippets({ url, secret, urlKeyAllowed }: { url: string; secret?: string; urlKeyAllowed: boolean }) {
  const k = secret ?? '<YOUR_SECRET>';
  return <div className="stack" style={{ gap: 8 }}>
    <details><summary>WordPress (Elementor, Contact Form 7, Gravity Forms)</summary><ol><li><strong>Preferred:</strong> use a webhook plugin that can send an <code>Authorization: Bearer {k}</code> header to <code>{url}</code>, or post from your theme/plugin code on the server (see the PHP example in the docs).</li><li><strong>Elementor Pro’s Webhook action cannot set headers.</strong> Only if you must use it: enable “Allow the credential in the URL” below, then use <code>{url}?key={k}</code>. A credential in a URL can end up in server logs and browser history, so keep the URL private and rotate the secret regularly. {urlKeyAllowed ? 'Currently ENABLED for this connection.' : 'Currently disabled: URL credentials are refused.'}</li><li>Common field names (name, email, phone, message) map automatically; use the mapping below for others.</li></ol></details>
    <details><summary>Next.js (server action or route handler)</summary><pre style={{ overflow: 'auto' }}>{`// Server-side only: never put the secret in browser code.
await fetch("${url}", {
  method: "POST",
  headers: { "Authorization": "Bearer ${k}", "Content-Type": "application/json", "Idempotency-Key": submissionId },
  body: JSON.stringify({ name, email, phone, message, utm_source, utm_campaign, page_url }),
});`}</pre></details>
    <details><summary>Any server (curl)</summary><pre style={{ overflow: 'auto' }}>{`curl -X POST "${url}" \\
  -H "Authorization: Bearer ${k}" -H "Content-Type: application/json" -H "Idempotency-Key: order-1001" \\
  -d '{"name":"Asha Rao","email":"asha@example.com","phone":"+919845012345","message":"Interested","utm_source":"google"}'`}</pre></details>
    <p className="muted">Send the same <code>Idempotency-Key</code> when retrying so the lead is never created twice. Responses: 201 created, 200 duplicate, 422 rejected (no phone or email), 401 bad credential, 429 rate limited.</p>
  </div>;
}

function Mapping({ c, mapped }: { c: ConnectionRow; mapped: { external_field: string; target: string }[] }) {
  const { run, pending, Msg } = useRun();
  const [rows, setRows] = useState(mapped.map(m => ({ ...m })));
  const [fields, setFields] = useState<string[]>();
  const [nf, setNf] = useState('');
  const known = new Set(rows.map(r => r.external_field));
  return <details onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && !fields) loadObservedFieldsAction(c.id).then(setFields); }}>
    <summary>Field mapping ({rows.length} custom)</summary>
    <div className="stack" style={{ marginTop: 8 }}>
      <p className="muted">Common names (name, email, phone, message, utm_*) are recognized automatically. Add a mapping to override one or to teach Optizen your own field names. Fields with no mapping are kept in the lead summary, never dropped.{fields?.length ? ` Fields seen in recent submissions: ${fields.join(', ')}.` : ' Fields seen in submissions will be suggested here.'}</p>
      {rows.map((r, i) => <div className="inline" key={i}>
        <div className="field"><input className="input" list={`f-${c.id}`} aria-label={`Form field ${i + 1}`} value={r.external_field} maxLength={80} onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, external_field: e.target.value } : x)))} /></div>
        <span>→</span>
        <select className="input" aria-label={`CRM field for ${r.external_field}`} value={r.target} onChange={e => setRows(rows.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))}>{CRM_TARGETS.map(t => <option key={t} value={t}>{TARGET_LABEL[t as CrmTarget]}</option>)}</select>
        <button type="button" className="btn" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></div>)}
      <datalist id={`f-${c.id}`}>{(fields ?? []).filter(f => !known.has(f)).map(f => <option key={f} value={f} />)}</datalist>
      <div className="inline"><div className="field"><input className="input" aria-label="New form field name" placeholder="Form field name, e.g. contact_no" value={nf} list={`f-${c.id}`} maxLength={80} onChange={e => setNf(e.target.value)} /></div>
        <button type="button" className="btn" disabled={!nf.trim() || known.has(nf.trim()) || rows.length >= 60} onClick={() => { setRows([...rows, { external_field: nf.trim(), target: 'phone' }]); setNf(''); }}>Add mapping</button></div>
      <div><button type="button" className="btn primary" disabled={pending || rows.some(r => !r.external_field.trim())} onClick={() => run(() => saveMappingsAction(c.id, rows))}>Save mapping</button></div><Msg />
    </div></details>;
}

function FormConnection({ c, data, siteUrl, reveal, onReveal }: { c: ConnectionRow; data: HubData; siteUrl: string; reveal?: { secret: string }; onReveal: (s: string) => void }) {
  const { run, pending, Msg } = useRun(); const url = `${siteUrl}/api/webhooks/forms/${c.publicId}`; const [limit, setLimit] = useState(String(c.config.rate_limit_per_min ?? 60));
  const events = data.events.filter(e => e.connectionId === c.id).slice(0, 5), errors = data.errors.filter(e => e.connectionId === c.id).slice(0, 3);
  return <div className="stack" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
    <div className="row"><strong>{c.name}</strong><Status s={c.status} /></div>
    <Health c={c} counts={data.counts[c.id]} />
    {c.status === 'not_connected' ? <p className="muted">Disconnected. Rotate the secret to enable it again.</p> : <>
      <div className="field"><label>Webhook URL</label><input className="input" readOnly value={url} onFocus={e => e.currentTarget.select()} /></div>
      {reveal ? <div className="notice" role="status"><strong>Your secret (shown once)</strong><code style={{ wordBreak: 'break-all' }}>{reveal.secret}</code><span className="muted">Store it in your site’s settings now. Optizen keeps only a hash and cannot show it again.</span></div> : <p className="muted">The secret was shown when the connection was created. Lost it? Rotate to get a new one (the old one stops working immediately).</p>}
      {c.status === 'setup_required' && <p className="muted">Status becomes Connected after the first real submission is received.</p>}
      <Snippets url={url} secret={reveal?.secret} urlKeyAllowed={c.config.allow_query_key === true} />
      <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={c.config.allow_query_key === true} disabled={pending} onChange={e => run(() => setAllowQueryKeyAction(c.id, e.target.checked))} /> Allow the credential in the URL (less secure; only for plugins that cannot send headers)</label>
      <Mapping key={JSON.stringify(data.mappings[c.id] ?? [])} c={c} mapped={data.mappings[c.id] ?? []} />
      <div className="inline"><div className="field"><label htmlFor={`rl-${c.id}`}>Rate limit (submissions per minute)</label><input id={`rl-${c.id}`} className="input" type="number" min={1} max={600} value={limit} onChange={e => setLimit(e.target.value)} /></div>
        <button type="button" className="btn" disabled={pending} onClick={() => run(() => setRateLimitAction(c.id, Number(limit)))}>Save</button></div>
    </>}
    {events.length > 0 && <details><summary>Recent submissions</summary><ul>{events.map(e => <li key={e.id}><LocalTime iso={e.receivedAt} /> · {e.status}{e.leadId && <> · <a href={`/work/leads/${e.leadId}`}>open lead</a></>}{e.lastError && <span className="err"> · {e.lastError}</span>}</li>)}</ul></details>}
    {errors.length > 0 && <details><summary>Errors ({errors.length})</summary><ul>{errors.map(e => <li key={e.id}><LocalTime iso={e.createdAt} /> · {e.code}: {e.message}</li>)}</ul></details>}
    <div className="row">
      <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Create a new secret? The current one stops working immediately.')) run(() => rotateSecretAction(c.id), r => onReveal(r.secret)); }}>Rotate secret</button>
      {c.status !== 'not_connected' && <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Disconnect this form? New submissions will be refused. Existing leads are kept.')) run(() => disconnectAction(c.id)); }}>Disconnect</button>}</div>
    <Msg />
  </div>;
}

function WebsiteForms({ data, siteUrl }: { data: HubData; siteUrl: string }) {
  const { run, pending, Msg } = useRun(); const [name, setName] = useState('Website contact form'); const [reveal, setReveal] = useState<Record<string, string>>({});
  const forms = data.connections.filter(c => c.provider === 'website_forms');
  return <Card title="Website Forms" description={PROVIDER_INFO.website_forms.blurb}>
    <div className="stack">
      <div className="row"><span className={forms.some(f => f.status === 'connected') ? 'badge' : 'badge done'}>{forms.length === 0 ? 'Not connected' : forms.some(f => f.status === 'connected') ? 'Connected' : 'Setup required'}</span><span className="muted">Works with WordPress, Elementor, Next.js and any server. Leads appear in Leads and trigger your automations.</span></div>
      {forms.map(c => <FormConnection key={c.id} c={c} data={data} siteUrl={siteUrl} reveal={reveal[c.id] ? { secret: reveal[c.id]! } : undefined} onReveal={s => setReveal({ ...reveal, [c.id]: s })} />)}
      <div className="inline" style={{ borderTop: forms.length ? '1px solid var(--line)' : undefined, paddingTop: forms.length ? 12 : 0 }}>
        <div className="field"><label htmlFor="newform">New form connection</label><input id="newform" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} /></div>
        <button type="button" className="btn primary" disabled={pending || !name.trim()} onClick={() => run(() => createFormConnectionAction(name), r => setReveal({ ...reveal, [r.id]: r.secret }))}>Create connection</button></div>
      <Msg />
    </div></Card>;
}

function MetaCard({ data, missing }: { data: HubData; missing: string[] }) {
  const { run, pending, Msg } = useRun(); const c = data.connections.find(x => x.provider === 'meta_lead_ads'); const pages = data.assets.filter(a => a.connectionId === c?.id && a.kind === 'page');
  return <Card title="Meta Lead Ads" description={PROVIDER_INFO.meta_lead_ads.blurb}>
    <div className="stack">
      <div className="row"><Status s={c?.status ?? 'not_connected'} />{c && <Health c={c} counts={data.counts[c.id]} />}</div>
      {missing.length > 0 ? <p className="muted"><strong>Setup required on this deployment:</strong> set {missing.join(', ')}. Connecting is disabled until then, so nothing here can pretend to work.</p>
        : <div><a className="btn primary" href="/api/integrations/meta/start">{c ? 'Reconnect Facebook' : 'Connect Facebook'}</a></div>}
      <details><summary>Meta requirements</summary><ul><li>A Meta app with the Lead Ads / Webhooks products, Business Verification, and App Review for: {META_PERMISSIONS.join(', ')}.</li><li>Webhook callback URL: <code>{'<site>'}/api/webhooks/meta</code>, field <code>leadgen</code>, using your verify token.</li><li>The person connecting must administer the Facebook Page and have access to its lead forms.</li><li>Until the app is approved, only app roles (admins/developers/testers) can authorize it.</li></ul></details>
      {pages.length > 0 && <div className="stack" style={{ gap: 6 }}><strong>Pages</strong>{pages.map(p => <div className="row" key={p.id}><span>{p.name ?? p.externalId}</span>{p.selected ? <span className="badge">Receiving leads</span> : null}
        <button type="button" className="btn" disabled={pending || missing.length > 0} onClick={() => run(() => selectMetaPageAction(c!.id, p.id, !p.selected))}>{p.selected ? 'Stop' : 'Receive leads'}</button></div>)}</div>}
      {c && c.status !== 'not_connected' && <div><button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Disconnect Meta? Credentials are deleted and Pages stop sending leads.')) run(() => disconnectAction(c.id)); }}>Disconnect</button></div>}
      <p className="muted">Not yet verified against a real Meta app. “Connected” appears only after Meta accepts the Page subscription.</p><Msg />
    </div></Card>;
}

function WhatsAppCard({ data, missing }: { data: HubData; missing: string[] }) {
  const { run, pending, Msg } = useRun(); const c = data.connections.find(x => x.provider === 'whatsapp'); const cfg = (c?.config ?? {}) as Record<string, string>;
  const [f, setF] = useState({ provider: cfg.provider ?? 'meta_cloud', accessToken: '', phoneNumberId: cfg.phone_number_id ?? '', apiKey: '', templateName: cfg.template_name ?? '', templateLanguage: cfg.template_language ?? 'en', defaultCountryCode: cfg.default_country_code ?? '', confirm: false });
  return <Card title="WhatsApp" description={PROVIDER_INFO.whatsapp.blurb}>
    <div className="stack">
      <div className="row"><Status s={c?.status ?? 'not_connected'} />{c && <Health c={c} />}</div>
      {missing.length > 0 ? <p className="muted"><strong>Setup required on this deployment:</strong> set {missing.join(', ')}. Saving credentials is disabled until then.</p> : <>
        <div className="form-grid">
          <div className="field"><label htmlFor="wa-p">Provider</label><select id="wa-p" className="input" value={f.provider} onChange={e => setF({ ...f, provider: e.target.value })}><option value="meta_cloud">Meta WhatsApp Cloud API</option><option value="interakt">Interakt</option></select></div>
          {f.provider === 'meta_cloud' ? <>
            <div className="field"><label htmlFor="wa-pn">Phone number id</label><input id="wa-pn" className="input" value={f.phoneNumberId} onChange={e => setF({ ...f, phoneNumberId: e.target.value })} /></div>
            <div className="field"><label htmlFor="wa-t">Permanent access token (stored encrypted; re-enter to change)</label><input id="wa-t" className="input" type="password" autoComplete="off" value={f.accessToken} onChange={e => setF({ ...f, accessToken: e.target.value })} /></div></>
            : <div className="field"><label htmlFor="wa-k">Interakt API key</label><input id="wa-k" className="input" type="password" autoComplete="off" value={f.apiKey} onChange={e => setF({ ...f, apiKey: e.target.value })} /></div>}
          <div className="field"><label htmlFor="wa-tn">Approved template name</label><input id="wa-tn" className="input" placeholder="lead_welcome" value={f.templateName} onChange={e => setF({ ...f, templateName: e.target.value })} /></div>
          <div className="field"><label htmlFor="wa-tl">Template language</label><input id="wa-tl" className="input" placeholder="en or en_US" value={f.templateLanguage} onChange={e => setF({ ...f, templateLanguage: e.target.value })} /></div>
          <div className="field"><label htmlFor="wa-cc">Default country code (optional)</label><input id="wa-cc" className="input" placeholder="91" value={f.defaultCountryCode} onChange={e => setF({ ...f, defaultCountryCode: e.target.value })} /></div></div>
        {f.provider === 'interakt' && <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.confirm} onChange={e => setF({ ...f, confirm: e.target.checked })} /> I confirm this key is correct (Interakt keys cannot be verified without sending a message)</label>}
        <div><button type="button" className="btn primary" disabled={pending} onClick={() => run(() => saveWhatsAppAction({ provider: f.provider, accessToken: f.accessToken, phoneNumberId: f.phoneNumberId, apiKey: f.apiKey, templateName: f.templateName, templateLanguage: f.templateLanguage, defaultCountryCode: f.defaultCountryCode, confirmUnverified: f.confirm }), () => setF({ ...f, accessToken: '', apiKey: '' }))}>{f.provider === 'meta_cloud' ? 'Save and verify' : 'Save'}</button>
          {c && c.status !== 'not_connected' && <> <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Disconnect WhatsApp? Credentials are deleted; queued messages wait until it is connected again.')) run(() => disconnectAction(c.id)); }}>Disconnect</button></>}</div></>}
      <p className="muted">Automations with “Request an external message” (WhatsApp) are sent only while this is Connected, only with your approved template, and the message text becomes the template’s first variable ({'{{1}}'}). Without a connection, requests stay queued and nothing is sent. Not yet verified against a live account.</p><Msg />
    </div></Card>;
}

export function ConnectionsHub({ data, siteUrl, metaMissing, whatsappMissing }: { data: HubData; siteUrl: string; metaMissing: string[]; whatsappMissing: string[] }) {
  return <div className="stack">
    <WebsiteForms data={data} siteUrl={siteUrl} />
    <MetaCard data={data} missing={metaMissing} />
    <WhatsAppCard data={data} missing={whatsappMissing} />
    <Contract id="google_ads" extra="Planned adapter: Google Ads lead form extensions via offline OAuth." />
    <Contract id="telephony" extra="Planned adapter: call events (answered, missed, recording link) from a telephony provider." />
    <Contract id="payments" extra="Planned adapter: payment captured / failed events from a payment gateway." />
    {data.errors.length > 0 && <Card title="Recent errors" description="Across all connections."><ul>{data.errors.map(e => <li key={e.id}><LocalTime iso={e.createdAt} /> · {e.source} · {e.code}: {e.message}</li>)}</ul></Card>}
  </div>;
}
