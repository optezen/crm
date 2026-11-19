'use client';
import { useState, useTransition } from 'react';
import { industries } from '../../lib/config';
import { buildInitialConfig, validateOnboarding } from '../../lib/workspace/build';
import { Field } from '../../components/ui/Field';
import { Card } from '../../components/ui/Card';
import { Notice } from '../../components/ui/Notice';
import { createWorkspaceAction } from './actions';

const STEPS = ['Business', 'Industry', 'Review'];

export function Wizard({ blocked }: { blocked?: string }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const v = validateOnboarding({ name, industry }, industries);
  const config = v.ok ? buildInitialConfig(industries[industry as keyof typeof industries], industry, v.value.name) : null;

  const next = () => { if (step === 0 && v.errors.name) return setError(v.errors.name); if (step === 1 && v.errors.industry) return setError(v.errors.industry); setError(undefined); setStep(step + 1); };
  const submit = () => start(async () => { const r = await createWorkspaceAction(name, industry); if (r?.error) setError(r.error); });

  return <div className="stack">
    <div><h1>Set up your Optizen workspace</h1><p className="muted">Three short steps. You can change the configuration later in Builder.</p></div>
    <ol className="steps" aria-label="Progress" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{STEPS.map((t, i) => <li key={t} aria-current={i === step ? 'step' : undefined}>{i + 1}. {t}</li>)}</ol>
    {step === 0 && <Field id="name" label="Business name" value={name} onChange={e => setName(e.target.value)} autoFocus autoComplete="organization" error={error} />}
    {step === 1 && <fieldset className="choices" aria-describedby={error ? 'ind-err' : undefined}><legend className="sr-only">Industry</legend>
      {Object.entries(industries).map(([k, t]) => <label className="choice" key={k}><input type="radio" name="industry" value={k} checked={industry === k} onChange={() => setIndustry(k)} /><strong>{t.name}</strong><span>{t.subtitle}</span></label>)}</fieldset>}
    {step === 1 && error && <p id="ind-err" className="err" role="alert" style={{ color: '#b42318' }}>{error}</p>}
    {step === 2 && config && <>
      <Card title={config.businessName} description={`Starting from the ${industries[industry as keyof typeof industries].name} template.`}>
        <div className="stack" style={{ gap: 16 }}>
          <div><h3>Modules</h3><p className="chips" style={{ marginTop: 8 }}>{config.modules.map(m => <span className="chip" key={m.key}>{m.label}{m.status === 'planned' ? ' (planned)' : ''}</span>)}</p></div>
          <div><h3>Record types</h3><p className="chips" style={{ marginTop: 8 }}>{config.objects.map(o => <span className="chip" key={o.key}>{o.label}</span>)}</p></div>
          <div><h3>Pipeline</h3><p className="muted">{config.pipeline.stages.join(' → ')}</p></div>
        </div></Card>
      {blocked && <Notice title="Cannot save yet">{blocked}</Notice>}
      {error && <p role="alert" style={{ color: '#b42318' }}>{error}</p>}
    </>}
    <div className="row">
      {step > 0 && <button className="btn" onClick={() => { setError(undefined); setStep(step - 1); }}>Back</button>}
      {step < 2 ? <button className="btn primary" onClick={next}>Continue</button>
        : <button className="btn primary" onClick={submit} disabled={!!blocked || pending}>{pending ? 'Creating…' : 'Create workspace'}</button>}
    </div>
  </div>;
}
