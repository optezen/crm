'use client';
import { useMemo, useState, useTransition } from 'react';
import { presets, suggestPresets } from '../../lib/workspace/presets';
import { configFromChoice, validateOnboarding } from '../../lib/workspace/schema';
import { FIELD_KIND_LABEL, type SetupChoice, type WorkspaceConfig } from '../../lib/workspace/types';
import { Field } from '../../components/ui/Field';
import { Card } from '../../components/ui/Card';
import { Notice } from '../../components/ui/Notice';
import { aiDraftAction, createWithProposalAction, createWorkspaceAction, onboardingChatAction } from './actions';
import type { OnboardingMessage, StarterProposal } from '../../lib/ai/onboarding';

const STEPS = ['Business', 'About', 'Starting point', 'Preview'];

export function Wizard({ blocked, aiAvailable }: { blocked?: string; aiAvailable: boolean }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pick, setPick] = useState('blank'); // 'blank' | 'preset:<key>' | 'ai'
  const [aiDraft, setAiDraft] = useState<WorkspaceConfig | null>(null);
  const [proposal, setProposal] = useState<StarterProposal | null>(null); const [incW, setIncW] = useState<number[]>([]); const [incD, setIncD] = useState<number[]>([]);
  const [chat, setChat] = useState<OnboardingMessage[]>([]); const [chatText, setChatText] = useState('');
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const v = validateOnboarding({ name, description });
  const suggested = useMemo(() => suggestPresets(description), [description]);
  const others = presets.filter(p => !suggested.some(s => s.key === p.key));
  const choice: SetupChoice | null = pick === 'blank' ? { kind: 'blank' } : pick === 'conv' ? (proposal ? { kind: 'draft', definition: proposal.config } : null) : pick === 'ai' ? (aiDraft ? { kind: 'draft', definition: aiDraft } : null) : { kind: 'preset', key: pick.slice(7) };
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
  const submit = () => choice && start(async () => { const r = pick === 'conv' && proposal ? await createWithProposalAction(name, description, proposal, { workflows: incW, dashboards: incD }) : await createWorkspaceAction(name, description, choice); if (r?.error) setError(r.error); });
  const say = () => { const t = chatText.trim(); if (!t || pending) return; const next = [...chat, { role: 'user' as const, text: t }]; setChat(next); setChatText(''); setError(undefined);
    start(async () => { const r = await onboardingChatAction(name, description, next); if (r.type === 'error') { setError(r.message); return; } setChat(c => [...c, { role: 'assistant', text: r.text }]); if (r.type === 'proposal') { setProposal(r.proposal); setIncW(r.proposal.workflows.map((_, i) => i)); setIncD(r.proposal.dashboards.map((_, i) => i)); setPick('conv'); } }); };
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
        {proposal && radio('conv', 'AI setup from our conversation', 'Modules, pipeline, starter workflows and dashboards. Review on the next step.')}
      </fieldset>
      {others.length > 0 && <details><summary>Other starting points</summary>
        <fieldset className="choices"><legend className="sr-only">Other starting points</legend>{others.map(p => radio(`preset:${p.key}`, p.name, p.summary))}</fieldset></details>}
      {aiAvailable && <section className="card" aria-label="Set up by conversation" style={{ padding: 16 }}>
        <h3 style={{ marginTop: 0 }}>Or tell Optizen AI about your business</h3>
        <p className="muted" style={{ marginTop: 0 }}>Optional. It may ask a few short questions, then proposes modules, fields, a pipeline, starter workflows and dashboards from what Optizen supports. Nothing is created until you approve on the next step.</p>
        <div className="stack" style={{ gap: 8 }} aria-live="polite">{chat.map((m, i) => <p key={i} style={{ margin: 0, fontWeight: m.role === 'user' ? 600 : 400 }}>{m.role === 'user' ? 'You: ' : 'Optizen: '}{m.text}</p>)}
          {proposal && <p className="ok" role="status">A proposal is ready. Continue to review it, or keep talking to change it.</p>}</div>
        <div className="row" style={{ marginTop: 8 }}><label className="sr-only" htmlFor="conv">Your message</label><textarea id="conv" className="input" rows={2} value={chatText} maxLength={1500} placeholder="e.g. We sell used cars, take enquiries by phone and WhatsApp, and book test drives." onChange={e => setChatText(e.target.value)} />
          <button type="button" className="btn" onClick={say} disabled={pending || !chatText.trim() || !name.trim()}>{pending ? 'Thinking…' : 'Send'}</button></div></section>}
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
      {pick === 'conv' && proposal && <Card title="Starter items" description="Workflows are saved as drafts and are NOT turned on. Dashboards are created for you. Untick anything you do not want.">
        <div className="stack" style={{ gap: 10 }}>{proposal.workflows.map((w, i) => <label key={`w${i}`} className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={incW.includes(i)} onChange={e => setIncW(e.target.checked ? [...incW, i] : incW.filter(x => x !== i))} /><span><strong>Workflow: {w.name}</strong><br /><span className="muted">{w.preview.join(' → ')}</span></span></label>)}
          {proposal.dashboards.map((d, i) => <label key={`d${i}`} className="row" style={{ gap: 8, alignItems: 'flex-start' }}><input type="checkbox" checked={incD.includes(i)} onChange={e => setIncD(e.target.checked ? [...incD, i] : incD.filter(x => x !== i))} /><span><strong>Dashboard: {d.name}</strong><br /><span className="muted">{d.preview.join('; ')}</span></span></label>)}
          {proposal.warnings.map(w => <p key={w} className="muted">{w}</p>)}{proposal.workflows.length + proposal.dashboards.length === 0 && <p className="muted">No starter workflows or dashboards were proposed.</p>}</div></Card>}
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
