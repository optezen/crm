'use client';
import { useMemo, useState, useTransition } from 'react';
import { presets, suggestPresets } from '../../lib/workspace/presets';
import { configFromChoice, validateOnboarding } from '../../lib/workspace/schema';
import { FIELD_KIND_LABEL, type SetupChoice, type WorkspaceConfig } from '../../lib/workspace/types';
import { Field } from '../../components/ui/Field';
import { Card } from '../../components/ui/Card';
import { Notice } from '../../components/ui/Notice';
import { aiDraftAction, createWorkspaceAction } from './actions';

const STEPS = ['Business', 'About', 'Starting point', 'Preview'];

export function Wizard({ blocked, aiAvailable }: { blocked?: string; aiAvailable: boolean }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pick, setPick] = useState('blank'); // 'blank' | 'preset:<key>' | 'ai'
  const [aiDraft, setAiDraft] = useState<WorkspaceConfig | null>(null);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const v = validateOnboarding({ name, description });
  const suggested = useMemo(() => suggestPresets(description), [description]);
  const others = presets.filter(p => !suggested.some(s => s.key === p.key));
  const choice: SetupChoice | null = pick === 'blank' ? { kind: 'blank' } : pick === 'ai' ? (aiDraft ? { kind: 'draft', definition: aiDraft } : null) : { kind: 'preset', key: pick.slice(7) };
  const built = choice && v.ok ? configFromChoice({ name, description }, choice) : null;
  const config = built?.ok ? built.value : null;

  const next = () => {
    if (step === 0 && v.errors.name) return setError(v.errors.name);
    if (step === 1 && v.errors.description) return setError(v.errors.description);
    if (step === 2 && !config) return setError(built && !built.ok ? built.error : 'Choose how to start.');
    setError(undefined); setStep(step + 1);
  };
  const draftWithAi = () => start(async () => {
    setError(undefined);
    const r = await aiDraftAction(name, description);
    if (!r.ok) return setError(r.error);
    setAiDraft(r.value); setPick('ai');
  });
  const submit = () => choice && start(async () => { const r = await createWorkspaceAction(name, description, choice); if (r?.error) setError(r.error); });
  const radio = (value: string, title: string, sub: string) => <label className="choice" key={value}><input type="radio" name="start" value={value} checked={pick === value} onChange={() => setPick(value)} /><strong>{title}</strong><span>{sub}</span></label>;

  return <div className="stack">
    <div><h1>Set up your Optizen workspace</h1><p className="muted">Four short steps. Everything is editable later in Builder; no choice here limits what you can build.</p></div>
    <ol className="steps" aria-label="Progress" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{STEPS.map((t, i) => <li key={t} aria-current={i === step ? 'step' : undefined}>{i + 1}. {t}</li>)}</ol>

    {step === 0 && <Field id="name" label="Business name" value={name} onChange={e => setName(e.target.value)} autoFocus autoComplete="organization" error={step === 0 ? error : undefined} />}
    {step === 1 && <div className="field"><label htmlFor="desc">What does your business do? <span className="muted">(optional)</span></label>
      <textarea id="desc" className="input" value={description} onChange={e => setDescription(e.target.value)} maxLength={1000} placeholder="e.g. We run a bakery with three shops and take wholesale orders from cafés." />
      <span className="hint">Used to suggest a starting point{aiAvailable ? ' and, if you choose, to draft one with AI' : ''}. It is stored with your workspace profile.</span>
      {error && <span className="err" role="alert">{error}</span>}</div>}

    {step === 2 && <div className="stack">
      <fieldset className="choices"><legend className="sr-only">Starting point</legend>
        {radio('blank', 'Blank workspace', 'Leads, tasks and a simple pipeline. Add anything else in Builder.')}
        {suggested.map(p => radio(`preset:${p.key}`, p.name, `Suggested from your description. ${p.summary}`))}
        {aiDraft && radio('ai', 'AI draft', 'Drafted from your description. Review it on the next step.')}
      </fieldset>
      {others.length > 0 && <details><summary>Other starting points</summary>
        <fieldset className="choices"><legend className="sr-only">Other starting points</legend>{others.map(p => radio(`preset:${p.key}`, p.name, p.summary))}</fieldset></details>}
      {aiAvailable
        ? <div className="row"><button type="button" className="btn" onClick={draftWithAi} disabled={pending || !v.ok}>{pending ? 'Drafting…' : aiDraft ? 'Draft again with AI' : 'Draft with AI'}</button><span className="muted">Sends your business name and description to the configured AI model. Nothing is created until you confirm.</span></div>
        : <p className="muted">AI drafting is not configured on this deployment, so it is not offered. Starting points above are matched by keyword only.</p>}
      {error && <p className="err" role="alert">{error}</p>}
    </div>}

    {step === 3 && config && <>
      <Card title={config.businessName} description={pick === 'ai' ? 'Drafted by AI. Review before creating; nothing is saved yet.' : pick === 'blank' ? 'Blank workspace.' : `Starting from the “${presets.find(p => `preset:${p.key}` === pick)?.name}” starting point.`}>
        <div className="stack" style={{ gap: 16 }}>
          {config.description && <p className="muted">{config.description}</p>}
          <div><h3>Modules</h3><p className="chips" style={{ marginTop: 8 }}>{config.modules.map(m => <span className="chip" key={m.key}>{m.label}{m.status === 'planned' ? ' (planned)' : ''}</span>)}</p></div>
          <div><h3>Record types</h3>{config.objects.length === 0 ? <p className="muted">None yet. Define them in Builder.</p>
            : <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>{config.objects.map(o => <li key={o.key}><strong>{o.label}</strong>: {o.fields.map(f => `${f.label} (${FIELD_KIND_LABEL[f.kind].toLowerCase()})`).join(', ')}</li>)}</ul>}</div>
          <div><h3>Lead pipeline</h3><p className="muted">{config.pipeline.stages.join(' → ')}</p></div>
        </div></Card>
      <p className="muted">Modules marked “planned” have no screens yet. Leads, tasks, notes and team management work from day one.</p>
      {blocked && <Notice title="Cannot save yet">{blocked}</Notice>}
      {error && <p className="err" role="alert">{error}</p>}
    </>}

    <div className="row">
      {step > 0 && <button className="btn" onClick={() => { setError(undefined); setStep(step - 1); }}>Back</button>}
      {step < 3 ? <button className="btn primary" onClick={next}>Continue</button>
        : <button className="btn primary" onClick={submit} disabled={!!blocked || pending || !config}>{pending ? 'Creating…' : 'Create workspace'}</button>}
    </div>
  </div>;
}
