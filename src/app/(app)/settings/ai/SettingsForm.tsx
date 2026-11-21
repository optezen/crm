'use client';
import { useActionState } from 'react';
import { saveAiSettingsAction, type SettingsResult } from './actions';

export type Current = { enabled: boolean; daily: number; hourly: number; monthly: number | null; perUser: number | null; priceIn: number | null; priceOut: number | null; currency: string };
export function SettingsForm({ cur }: { cur: Current }) {
  const [state, action, pending] = useActionState<SettingsResult | null, FormData>(saveAiSettingsAction, null);
  const n = (v: number | null) => (v === null ? '' : String(v));
  return <form action={action} className="stack" style={{ gap: 14 }}>
    <label className="row" style={{ gap: 8 }}><input type="checkbox" name="enabled" defaultChecked={cur.enabled} /> AI is turned on for this organization</label>
    <div className="form-grid">
      <div className="field"><label htmlFor="daily">Organization daily tokens (required)</label><input id="daily" name="daily" className="input" type="number" min={1000} max={5000000} required defaultValue={cur.daily} /><span className="hint">Resets at midnight UTC.</span></div>
      <div className="field"><label htmlFor="monthly">Organization monthly tokens</label><input id="monthly" name="monthly" className="input" type="number" min={1000} max={100000000} defaultValue={n(cur.monthly)} /><span className="hint">Leave empty for no monthly limit.</span></div>
      <div className="field"><label htmlFor="perUser">Per-user daily tokens</label><input id="perUser" name="perUser" className="input" type="number" min={1000} max={5000000} defaultValue={n(cur.perUser)} /><span className="hint">Leave empty for no per-user limit. Cannot exceed the daily total.</span></div>
      <div className="field"><label htmlFor="hourly">Messages per user per hour (required)</label><input id="hourly" name="hourly" className="input" type="number" min={1} max={500} required defaultValue={cur.hourly} /></div>
      <div className="field"><label htmlFor="priceIn">Input price per million tokens</label><input id="priceIn" name="priceIn" className="input" type="number" min={0} step="0.0001" defaultValue={n(cur.priceIn)} /></div>
      <div className="field"><label htmlFor="priceOut">Output price per million tokens</label><input id="priceOut" name="priceOut" className="input" type="number" min={0} step="0.0001" defaultValue={n(cur.priceOut)} /></div>
      <div className="field"><label htmlFor="currency">Price currency</label><input id="currency" name="currency" className="input" maxLength={3} defaultValue={cur.currency} style={{ width: 90 }} /></div>
    </div>
    <p className="muted" style={{ margin: 0 }}>Prices are optional and only used for the cost ESTIMATES below (your recorded tokens × these prices). They are not your provider&apos;s invoice.</p>
    <div className="row"><button className="btn primary" disabled={pending}>{pending ? 'Saving…' : 'Save settings'}</button>{state && <span role={state.ok ? 'status' : 'alert'} className={state.ok ? 'ok' : 'err'}>{state.ok ? state.message : state.error}</span>}</div>
  </form>;
}
