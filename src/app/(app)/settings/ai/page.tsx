import { getWorkspaceState } from '../../../../lib/workspace/service';
import { StudioNav } from '../../../../components/studio/StudioNav';
import { supabaseServer } from '../../../../lib/supabase/server';
import { DEFAULT_MODEL, providerFor } from '../../../../lib/ai/anthropic';
import { speechProviderFor } from '../../../../lib/ai/speech';
import { estimateCost, fmtCost, pct, type Prices } from '../../../../lib/ai/usage';
import { Card } from '../../../../components/ui/Card';
import { Notice } from '../../../../components/ui/Notice';
import { LocalTime } from '../../../../components/ui/LocalTime';
import { SettingsForm } from './SettingsForm';

type Summary = { prices: Prices; by_day: { day: string; requests: number; input_tokens: number; output_tokens: number; blocked: number; errors: number; audio_seconds: number }[]; by_user: { user_id: string; email: string | null; requests: number; tokens: number; input_tokens: number; output_tokens: number }[]; by_kind: Record<string, number>; recent: { at: string; user_id: string; kind: string; status: string; model: string; input_tokens: number; output_tokens: number; tool_calls: number; error: string | null }[] };
type Budget = { tokens_today: number; daily_limit: number; tokens_month: number; monthly_limit: number | null; your_tokens_today: number; per_user_daily_limit: number | null; hourly_limit: number; enabled: boolean };

export default async function AiSettings() {
  const s = await getWorkspaceState(); if (s.status !== 'ready') return null;
  if (s.role !== 'owner') return <Notice title="AI settings are limited to the owner">Ask the owner of this organization to review AI usage and limits.</Notice>;
  const db = await supabaseServer();
  const [sum, bud, set] = await Promise.all([db.rpc('ai_usage_summary', { p_org: s.organizationId, p_days: 30 }), db.rpc('ai_budget', { p_org: s.organizationId }), db.from('ai_settings').select('*').eq('organization_id', s.organizationId).maybeSingle()]);
  if (sum.error || bud.error) return <Notice title="AI settings could not be loaded">Please try again.</Notice>;
  const u = sum.data as Summary, b = bud.data as Budget; const cfg = set.data as { enabled: boolean; daily_token_limit: number; hourly_messages_per_user: number; monthly_token_limit: number | null; per_user_daily_tokens: number | null; input_price_per_mtok: number | null; output_price_per_mtok: number | null; price_currency: string } | null;
  const chat = providerFor(), speech = speechProviderFor(); const cur = u.prices?.currency ?? cfg?.price_currency ?? 'USD';
  const total = u.by_day.reduce((a, d) => ({ i: a.i + Number(d.input_tokens), o: a.o + Number(d.output_tokens), r: a.r + d.requests }), { i: 0, o: 0, r: 0 });
  const bar = (used: number, limit: number | null, label: string) => { const p = pct(used, limit); return <div><div className="row" style={{ justifyContent: 'space-between' }}><span>{label}</span><span className="muted">{used.toLocaleString()} {limit ? `of ${limit.toLocaleString()}` : '(no limit)'}</span></div>{p !== null && <div role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label} style={{ height: 8, background: '#e7e5e4', borderRadius: 99 }}><div style={{ width: `${p}%`, height: 8, borderRadius: 99, background: p >= 90 ? '#b42318' : 'var(--accent)' }} /></div>}</div>; };
  return <div className="stack">
    <StudioNav current="ai" />
    <div className="top"><div><span className="eyebrow">Optizen AI</span><h1>AI settings and usage</h1><p className="muted">Only the owner sees this page. Usage is counted before each request runs, so limits hold even when many people ask at once.</p></div></div>
    <Card title="Providers" description="Configuration status only. Keys are read from the server environment and are never shown.">
      <dl className="kv">
        <dt>Assistant model</dt><dd>{chat ? <>Configured: <strong>{chat.id}</strong> · {chat.model}</> : <span className="err">Not configured (set ANTHROPIC_API_KEY). The assistant is switched off.</span>}</dd>
        <dt>Voice input</dt><dd>{speech ? <>Configured: <strong>{speech.id}</strong> · {speech.model}</> : <span className="muted">Not configured (set OPENAI_API_KEY or OPTIZEN_SPEECH_API_KEY). Typing still works.</span>}</dd>
        <dt>Default model</dt><dd>{DEFAULT_MODEL}</dd>
      </dl>
      <p className="muted" style={{ marginBottom: 0 }}>“Configured” means a key is set; Optizen does not call the provider from this page, so availability is confirmed only when someone uses the assistant.</p>
    </Card>
    <Card title="Today and this month">
      <div className="stack" style={{ gap: 12 }}>{bar(b.tokens_today, b.daily_limit, 'Organization tokens today')}{bar(b.tokens_month, b.monthly_limit, 'Organization tokens this month')}{bar(b.your_tokens_today, b.per_user_daily_limit, 'Your tokens today')}
        <p className="muted" style={{ margin: 0 }}>Last 30 days: {total.r.toLocaleString()} requests · {total.i.toLocaleString()} input + {total.o.toLocaleString()} output tokens · estimated cost {fmtCost(estimateCost(total.i, total.o, u.prices), cur)}{u.prices ? '' : ' (enter prices below to see estimates)'}</p></div>
    </Card>
    <Card title="Limits and prices"><SettingsForm cur={{ enabled: cfg?.enabled ?? true, daily: cfg?.daily_token_limit ?? 300000, hourly: cfg?.hourly_messages_per_user ?? 40, monthly: cfg?.monthly_token_limit ?? null, perUser: cfg?.per_user_daily_tokens ?? null, priceIn: cfg?.input_price_per_mtok ?? null, priceOut: cfg?.output_price_per_mtok ?? null, currency: cfg?.price_currency ?? 'USD' }} /></Card>
    <Card title="Usage by person (30 days)"><div className="table-wrap"><table><thead><tr><th scope="col">Person</th><th scope="col">Requests</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Est. cost</th></tr></thead>
      <tbody>{u.by_user.map(x => <tr key={x.user_id}><td>{x.email ?? x.user_id.slice(0, 8)}</td><td>{x.requests}</td><td>{Number(x.input_tokens).toLocaleString()}</td><td>{Number(x.output_tokens).toLocaleString()}</td><td>{fmtCost(estimateCost(Number(x.input_tokens), Number(x.output_tokens), u.prices), cur)}</td></tr>)}{u.by_user.length === 0 && <tr><td colSpan={5} className="muted">No usage yet.</td></tr>}</tbody></table></div></Card>
    <Card title="Usage by day (30 days)"><div className="table-wrap"><table><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Requests</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Blocked</th><th scope="col">Errors</th><th scope="col">Voice (s)</th><th scope="col">Est. cost</th></tr></thead>
      <tbody>{u.by_day.map(d => <tr key={d.day}><td>{d.day}</td><td>{d.requests}</td><td>{Number(d.input_tokens).toLocaleString()}</td><td>{Number(d.output_tokens).toLocaleString()}</td><td>{d.blocked}</td><td>{d.errors}</td><td>{d.audio_seconds}</td><td>{fmtCost(estimateCost(Number(d.input_tokens), Number(d.output_tokens), u.prices), cur)}</td></tr>)}</tbody></table></div></Card>
    <Card title="Recent requests" description="The 50 most recent. No messages, tool results or audio are shown or stored here.">
      <div className="table-wrap"><table><thead><tr><th scope="col">When</th><th scope="col">Kind</th><th scope="col">Status</th><th scope="col">Model</th><th scope="col">Tokens in / out</th><th scope="col">Tools</th></tr></thead>
        <tbody>{u.recent.map((r, i) => <tr key={i}><td><LocalTime iso={r.at} /></td><td>{r.kind}</td><td>{r.status}{r.error ? ` (${r.error})` : ''}</td><td>{r.model || '—'}</td><td>{r.input_tokens} / {r.output_tokens}</td><td>{r.tool_calls}</td></tr>)}</tbody></table></div></Card>
  </div>;
}
