'use client';
// "Try it" panel. Runs the PURE preview in lib/automation/preview.ts on sample data the person can edit. No server action, fetch or database call is made from here.
import { useEffect, useMemo, useState } from 'react';
import { preview, sampleFor, type Preview, type Sample } from '../../lib/automation/preview';
import type { AutomationDefinition } from '../../lib/automation/types';

const OUTCOME: Record<string, { label: string; cls: string }> = { happens: { label: 'Would happen', cls: 'ok' }, waits: { label: 'Would wait', cls: 'wait' }, skipped: { label: 'Skipped', cls: 'skip' }, stops: { label: 'Stops here', cls: 'stop' } };
const usedPaths = (d: AutomationDefinition): Set<string> => {
  const s = new Set<string>(); for (const c of d.match?.conditions ?? []) s.add(c.field);
  for (const m of JSON.stringify(d.actions).matchAll(/\{\{([a-z0-9_.-]{1,60})\}\}/g)) s.add(m[1]!);
  for (const a of d.actions) { if (a.type === 'wait' && a.until_field) s.add(a.until_field); if (a.type === 'assign_round_robin') s.add('lead.assigned_to'); }
  return s;
};

export function PreviewPanel({ def, fields, who, label, onClose }: { def: AutomationDefinition | null; fields: readonly (readonly [string, string])[]; who: (id: string) => string; label: (p: string) => string; onClose: () => void }) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const fieldKey = fields.map(f => f[0]).join('|');
  const [sample, setSample] = useState<Sample>(() => sampleFor(fields, today));
  useEffect(() => { setSample(sampleFor(fields, today)); /* trigger changed: fresh sample */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey]);
  const [ran, setRan] = useState<{ key: string; result: Preview } | null>(null);
  const key = JSON.stringify([def, sample]);
  const [sampleOpen, setSampleOpen] = useState(true);
  const run = () => { if (def) { setRan({ key, result: preview(def, sample, { today, who, label }) }); setSampleOpen(false); /* the result is what matters now */ } };
  const used = def ? usedPaths(def) : new Set<string>();
  const shown = fields.filter(([k]) => used.has(k)), others = fields.filter(([k]) => !used.has(k));
  const input = ([k, l]: readonly [string, string]) => <div className="field" key={k}><label htmlFor={`pv-${k}`}>{l}</label><input id={`pv-${k}`} className="input" value={sample[k] ?? ''} onChange={e => setSample(s => ({ ...s, [k]: e.target.value }))} /></div>;
  const stale = ran && ran.key !== key;

  return <>
    <div className="wfs-panel-head"><h2>Try it (preview)</h2><button type="button" className="btn" onClick={onClose}>Close</button></div>
    <p className="wfs-safe" role="note"><strong>Nothing is saved, changed or sent.</strong> This only shows what the automation would do if an event like the one below happened. The real automation runs in the background after you publish it.</p>
    {!def && <p className="err" role="alert">Fix the problems listed above the canvas first. A preview needs a complete automation.</p>}
    {def && <>
      <details open={sampleOpen} onToggle={e => setSampleOpen((e.currentTarget as HTMLDetailsElement).open)} className="wfs-sample"><summary>Sample event (edit to try other cases)</summary>
        <div className="stack" style={{ gap: 10, marginTop: 10 }}>{shown.length ? shown.map(input) : <p className="muted">This automation does not use any details of the event, so there is nothing to set.</p>}</div>
        {others.length > 0 && <details style={{ marginTop: 10 }}><summary>More event details</summary><div className="stack" style={{ gap: 10, marginTop: 10 }}>{others.map(input)}</div></details>}</details>
      <button type="button" className="btn primary" onClick={run}>{ran ? 'Run preview again' : 'Run preview'}</button>
      {ran && <section aria-label="Preview result" aria-live="polite" className="stack" style={{ gap: 10 }}>
        {stale && <p className="notice" role="note">The automation or sample changed since this result. Run the preview again.</p>}
        <p className={`wfs-headline ${ran.result.matched ? 'ok' : 'stop'}`}><strong>{ran.result.headline}</strong></p>
        <ol className="wfs-steps">{ran.result.steps.map((s, i) => <li key={i} className={`wfs-step ${OUTCOME[s.outcome]!.cls}`}><span className="wfs-pill">{OUTCOME[s.outcome]!.label}</span><strong>{s.title}</strong><span className="wfs-detail">{s.detail}</span></li>)}</ol>
      </section>}
    </>}
  </>;
}
