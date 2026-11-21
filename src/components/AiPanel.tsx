'use client';
import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { applyProposalAction, deleteConversationAction, listConversationsAction, loadConversationAction, type ConversationRow, type ProposalView, type StoredMessage } from '../app/(app)/assistant/actions';
import { PlanCard } from './PlanCard';
import { useVoice, voiceSupported } from './useVoice';
import { emptyTurn, readTurn, type UiTurn } from '../lib/ai/clientStream';
import type { PlanView } from '../lib/ai/cards';

type Msg = { id: string; role: 'user' | 'assistant'; text: string; proposals: ProposalView[]; plans?: PlanView[] };
type Err = { code: string; message: string } | null;
const STATUS: Record<string, string> = { pending: 'Waiting for your approval', draft_saved: 'Saved as draft (not live)', published: 'Published', published_disabled: 'Published, disabled', rejected: 'Dismissed' };

function Proposal({ p, onChange }: { p: ProposalView; onChange: (p: ProposalView) => void }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const pay = p.payload as { summary?: string; diff?: string[]; preview?: string[]; warnings?: string[]; built_on?: string };
  const act = (step: Parameters<typeof applyProposalAction>[1], confirmText?: string) => { if (confirmText && !confirm(confirmText)) return; start(async () => { const r = await applyProposalAction(p.id, step); setNote({ ok: r.ok, text: (r.ok ? r.message : r.error) ?? '' }); if (r.ok && r.status) { onChange({ ...p, status: r.status }); router.refresh(); } }); };
  const lines = p.kind === 'operation' ? pay.preview ?? [] : p.kind === 'module_config' ? pay.diff ?? [] : p.kind === 'dashboard' ? ((pay.preview as unknown as { title: string; type: string; definition: string }[] | undefined) ?? []).map(w => `${w.title} (${w.type}): ${w.definition}`) : (pay.preview as string[] | undefined) ?? [];
  return <div className="ai-proposal" role="group" aria-label={`Proposal: ${p.title}`}>
    <div className="row"><strong>{p.kind === 'module_config' ? 'Workspace change' : p.kind === 'dashboard' ? 'Dashboard' : p.kind === 'operation' ? 'Change to confirm' : 'Automation'}: {p.title}</strong><span className={`badge ${p.status === 'rejected' ? 'done' : p.status === 'pending' ? 'late' : ''}`}>{STATUS[p.status] ?? p.status}</span></div>
    {pay.summary && <p className="muted">{pay.summary}</p>}
    <ul>{lines.map(l => <li key={l}>{l}</li>)}</ul>
    {(pay.warnings ?? []).map(w => <p key={w} className="ai-warn">{w}</p>)}
    {p.status === 'pending' && <div className="row">
      <button type="button" className="btn primary" disabled={pending} onClick={() => act(p.kind === 'dashboard' ? 'save_dashboard' : p.kind === 'operation' ? 'confirm' : 'save_draft', p.kind === 'operation' ? 'Apply this change now? It runs with your own permissions.' : undefined)}>{p.kind === 'dashboard' ? 'Approve: create dashboard' : p.kind === 'operation' ? 'Confirm' : 'Approve: save as draft'}</button>
      <button type="button" className="btn" disabled={pending} onClick={() => act('reject')}>Dismiss</button></div>}
    {p.status === 'draft_saved' && (p.kind === 'module_config'
      ? <div className="row"><button type="button" className="btn primary" disabled={pending} onClick={() => act('publish', 'Publish this configuration now? It becomes live for everyone. You can roll back from the Builder history.')}>Publish now</button><a className="btn" href="/builder">Review in Builder</a><button type="button" className="btn" disabled={pending} onClick={() => act('reject')}>Dismiss</button></div>
      : <div className="row"><button type="button" className="btn primary" disabled={pending} onClick={() => act('publish_enable', 'Publish and ENABLE this automation? It will run for new events as soon as the worker processes them.')}>Publish and enable</button><button type="button" className="btn" disabled={pending} onClick={() => act('publish_disabled')}>Publish, keep disabled</button><a className="btn" href="/automations">Open Automations</a></div>)}
    {p.kind !== 'operation' && ((p.kind === 'workflow' && ['pending', 'draft_saved'].includes(p.status)) || (p.kind === 'dashboard' && p.status === 'pending') || (p.kind === 'module_config' && p.status === 'draft_saved')) &&
      <div className="row"><Link className="btn" href={p.kind === 'workflow' ? `/automations/new?proposal=${p.id}` : p.kind === 'dashboard' ? `/dashboards/new?proposal=${p.id}` : '/builder/forms'}>{p.kind === 'workflow' ? 'Review and edit on the canvas' : p.kind === 'dashboard' ? 'Review and edit in the dashboard editor' : 'Open in the form builder'}</Link></div>}
    {note && <p role={note.ok ? 'status' : 'alert'} className={note.ok ? 'ok' : 'err'}>{note.text}</p>}
  </div>;
}

export function AiPanel({ available, role, voice = false }: { available: boolean; role: string; voice?: boolean }) {
  const [open, setOpen] = useState(false);
  const [convId, setConvId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [history, setHistory] = useState<ConversationRow[]>([]);
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<Err>(null); const [last, setLast] = useState('');
  const end = useRef<HTMLDivElement>(null); const box = useRef<HTMLTextAreaElement>(null);
  const [live, setLive] = useState<UiTurn | null>(null); const abortRef = useRef<AbortController | null>(null); const reqRef = useRef<string>('');
  const mic = useVoice(t => { setText(cur => (cur.trim() ? `${cur.trim()} ${t}` : t)); setTimeout(() => box.current?.focus(), 0); });
  const canVoice = voice && typeof window !== 'undefined' && voiceSupported();
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy]);
  useEffect(() => { if (open) { box.current?.focus(); listConversationsAction().then(setHistory); } }, [open]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === '/') { e.preventDefault(); setOpen(o => !o); } if (e.key === 'Escape') setOpen(false); }; addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);

  async function send(message: string, retry = false) {
    if (!message.trim() || busy) return;
    setErr(null); setBusy(true); setLast(message); setText(''); setLive(emptyTurn());
    if (!retry) { reqRef.current = crypto.randomUUID(); setMsgs(m => [...m, { id: `u${Date.now()}`, role: 'user', text: message, proposals: [] }]); }
    const ac = new AbortController(); abortRef.current = ac;
    try {
      const res = await fetch('/api/ai/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: convId, message, requestId: reqRef.current }), signal: ac.signal });
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) { const body = await res.json().catch(() => null) as { error?: { code: string; message: string } } | null; setErr(body?.error ?? { code: 'unavailable', message: 'The assistant is unavailable.' }); return; }
      const t = await readTurn(res, setLive);
      if (t.conversationId) setConvId(t.conversationId);
      if (t.done) { setMsgs(m => [...m, { id: `a${Date.now()}`, role: 'assistant', text: t.text, proposals: t.cards.proposals as ProposalView[], plans: t.cards.plans as PlanView[] }]); listConversationsAction().then(setHistory); }
      else if (t.error) setErr(t.error);
    } catch (e) { setErr((e as Error).name === 'AbortError' ? { code: 'cancelled', message: 'Cancelled. Nothing was changed.' } : { code: 'network', message: 'Could not reach the server. Check your connection and try again.' }); }
    finally { setBusy(false); setLive(null); abortRef.current = null; }
  }
  const newChat = () => { setConvId(null); setMsgs([]); setErr(null); setText(''); };
  const openConv = async (id: string) => { setConvId(id); setErr(null); setMsgs((await loadConversationAction(id)) as Msg[]); };
  const patch = (mi: number, p: ProposalView) => setMsgs(m => m.map((x, i) => (i === mi ? { ...x, proposals: x.proposals.map(y => (y.id === p.id ? p : y)) } : x)));
  const admin = role === 'owner' || role === 'admin';
  const examples = admin ? ['Which leads are unassigned?', 'What tasks are overdue?', 'Create a Vehicles module with Registration Number and Status', 'When a website lead arrives, assign it round-robin and create a call task for tomorrow'] : ['Which leads are assigned to me?', 'What are my pending tasks?', 'List my team'];

  return <>
    <button type="button" className="btn ai-launch" onClick={() => setOpen(true)} aria-keyshortcuts="Control+/ Meta+/" aria-expanded={open}>Ask Optizen <kbd className="muted">⌘/</kbd></button>
    {open && <aside className="ai-panel" role="dialog" aria-label="Optizen AI assistant">
      <header className="ai-head"><div><strong>Optizen AI</strong><span className="muted" style={{ display: 'block', fontSize: 12 }}>Answers come from your workspace data. Changes need your approval.</span></div>
        <div className="row"><select className="input" aria-label="Conversation history" value={convId ?? ''} onChange={e => (e.target.value ? openConv(e.target.value) : newChat())}><option value="">New conversation</option>{history.map(h => <option key={h.id} value={h.id}>{(h.title ?? 'Conversation').slice(0, 40)}</option>)}</select>
          {convId && <button type="button" className="btn" aria-label="Delete this conversation" onClick={async () => { if (confirm('Delete this conversation?')) { await deleteConversationAction(convId); newChat(); setHistory(await listConversationsAction()); } }}>Delete</button>}
          <button type="button" className="btn" aria-label="Close assistant" onClick={() => setOpen(false)}>✕</button></div></header>
      <div className="ai-body" aria-live="polite">
        {!available && <div className="notice"><strong>AI is not configured</strong>No model API key is set on this deployment (ANTHROPIC_API_KEY), so the assistant is switched off. The rest of Optizen works normally.</div>}
        {available && msgs.length === 0 && !busy && <div className="stack"><p className="muted">Ask about your leads, tasks, team, modules, records, connections and automations. Try:</p>
          {examples.map(x => <button key={x} type="button" className="btn ai-example" onClick={() => send(x)}>{x}</button>)}
          <p className="muted" style={{ fontSize: 12 }}>I only see what your role allows, and I never publish anything without your explicit approval.</p></div>}
        {msgs.map((m, i) => <div key={m.id} className={`ai-msg ${m.role}`}><div className="ai-bubble">{m.text}</div>{(m.plans ?? []).map(pl => <PlanCard key={pl.plan.id} initial={pl} />)}{m.proposals.map(p => <Proposal key={p.id} p={p} onChange={np => patch(i, np)} />)}</div>)}
        {busy && <div className="ai-msg assistant" role="status" aria-live="polite"><div className="ai-bubble">{live?.text || <span className="muted">{live?.tools.length ? '' : 'Thinking…'}</span>}
          {live?.tools.map((t, i) => <div key={i} className="muted" style={{ fontSize: 12 }}>{t.state === 'running' ? '⏳' : t.state === 'done' ? '✓' : '⚠'} {t.label}{t.state === 'running' ? '…' : ''}</div>)}</div></div>}
        {err && <div className="notice" role="alert"><strong>{err.code === 'cancelled' ? 'Cancelled' : err.code === 'interrupted' ? 'Connection interrupted' : err.code === 'budget' ? 'Usage limit reached' : err.code === 'not_configured' ? 'AI is not configured' : 'The assistant could not answer'}</strong>{err.message}
          {last && !['budget', 'not_configured', 'invalid_message', 'not_found', 'cancelled'].includes(err.code) && <div style={{ marginTop: 8 }}><button type="button" className="btn" disabled={busy} onClick={() => send(last, true)}>Try again</button></div>}</div>}
        <div ref={end} />
      </div>
      <form className="ai-compose" onSubmit={e => { e.preventDefault(); send(text); }}>
        <label className="sr-only" htmlFor="ai-input">Message</label>
        {mic.state === 'recording' && <div className="row" role="status" style={{ gap: 8 }}><span aria-hidden style={{ color: '#b42318' }}>●</span> Recording… {mic.seconds}s of {mic.maxSeconds}s
          <button type="button" className="btn primary" onClick={mic.stop}>Stop and transcribe</button><button type="button" className="btn" onClick={mic.cancel}>Cancel</button></div>}
        {(mic.state === 'requesting' || mic.state === 'transcribing') && <div className="row" role="status" style={{ gap: 8 }}>{mic.state === 'requesting' ? 'Waiting for microphone permission…' : 'Transcribing…'}<button type="button" className="btn" onClick={mic.cancel}>Cancel</button></div>}
        {mic.error && <p className="err" role="alert">{mic.error} <button type="button" className="btn" onClick={mic.clearError}>Dismiss</button></p>}
        <textarea id="ai-input" ref={box} className="input" rows={2} maxLength={4000} placeholder={available ? 'Type or speak what you want. Review the text before sending.' : 'AI is not configured'} disabled={!available || busy} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
        <div className="row" style={{ gap: 8 }}>
          {canVoice && <button type="button" className="btn" aria-label="Speak your request" disabled={!available || busy || mic.state !== 'idle'} onClick={mic.start}>🎤 Speak</button>}
          {busy ? <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>Cancel</button> : <button className="btn primary" disabled={!available || !text.trim() || mic.state !== 'idle'}>Send</button>}</div>
        {canVoice && <p className="muted" style={{ fontSize: 11, margin: 0 }}>Voice: your recording is sent to the transcription provider and is not saved by Optizen. You can edit the text before sending.</p>}
      </form>
    </aside>}
  </>;
}
