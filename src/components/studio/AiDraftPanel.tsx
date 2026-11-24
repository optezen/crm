'use client';
// Describe an automation to Optizen AI. The model only ever PROPOSES: the proposal opens on this canvas, unsaved, for visual editing and a normal save/publish (see docs/BUILDER_STUDIO.md).
import { useRef, useState } from 'react';
import Link from 'next/link';
import { readTurn } from '../../lib/ai/clientStream';
import type { ProposalView } from '../../app/(app)/assistant/actions';

const EXAMPLES = ['When a website lead arrives, assign it in rotation and create a call task for tomorrow', 'When a task is completed, notify the lead’s assignee', 'If a lead has no assignee after the first day, remind the team'];

export function AiDraftPanel({ available, dirty, onClose }: { available: boolean; dirty: boolean; onClose: () => void }) {
  const [text, setText] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [out, setOut] = useState<{ text: string; proposals: ProposalView[] } | null>(null); const abort = useRef<AbortController | null>(null);
  async function send() {
    const message = text.trim(); if (!message || busy) return; setBusy(true); setErr(null); setOut(null);
    const ac = new AbortController(); abort.current = ac;
    try {
      const res = await fetch('/api/ai/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: null, message: `Create an automation: ${message}`, requestId: crypto.randomUUID() }), signal: ac.signal });
      if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) { const b = await res.json().catch(() => null) as { error?: { message: string } } | null; setErr(b?.error?.message ?? 'Optizen AI is not available right now.'); return; }
      const t = await readTurn(res, () => {});
      if (t.error) setErr(t.error.message); else setOut({ text: t.text, proposals: (t.cards.proposals as ProposalView[]).filter(p => p.kind === 'workflow') });
    } catch (e) { setErr((e as Error).name === 'AbortError' ? 'Cancelled. Nothing was changed.' : 'Could not reach Optizen AI. Check your connection and try again.'); }
    finally { setBusy(false); abort.current = null; }
  }
  return <>
    <div className="wfs-panel-head"><h2>Ask Optizen AI</h2><button type="button" className="btn" onClick={onClose}>Close</button></div>
    {!available ? <p className="notice" role="note"><strong>Optizen AI is not set up on this deployment.</strong> You can still build the automation yourself with the steps on the left.</p> : <>
      <p className="muted">Describe what should happen in your own words. Optizen AI drafts it; you review and edit it on the canvas. It is never saved or published until you do that.</p>
      <div className="field"><label htmlFor="ai-text">What should this automation do?</label><textarea id="ai-text" className="input" rows={4} maxLength={1500} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. When a website lead arrives, give it to the next salesperson and remind them to call tomorrow." /></div>
      <div className="row"><button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Drafting…' : 'Draft with Optizen AI'}</button>{busy && <button type="button" className="btn" onClick={() => abort.current?.abort()}>Cancel</button>}</div>
      {!out && !busy && <div className="stack" style={{ gap: 6 }}><span className="eyebrow">Try an example</span>{EXAMPLES.map(x => <button key={x} type="button" className="btn wfs-example" onClick={() => setText(x)}>{x}</button>)}</div>}
      <div aria-live="polite" className="stack" style={{ gap: 10 }}>
        {err && <p className="err" role="alert">{err}</p>}
        {out && <>
          {out.text && <p>{out.text}</p>}
          {out.proposals.length === 0 && <p className="muted">Optizen AI did not produce an automation this time. Try describing the trigger and what should happen.</p>}
          {out.proposals.map(p => { const pay = p.payload as { summary?: string; preview?: unknown }; const lines = Array.isArray(pay.preview) ? (pay.preview as unknown[]).filter((x): x is string => typeof x === 'string') : [];
            return <div key={p.id} className="wfs-proposal" role="group" aria-label={`Proposed automation: ${p.title}`}><strong>{p.title}</strong>{pay.summary && <p className="muted">{pay.summary}</p>}{lines.length > 0 && <ul>{lines.map(l => <li key={l}>{l}</li>)}</ul>}
              {dirty && <p className="notice" role="note">Opening this replaces what is on the canvas now. Save your draft first if you want to keep it.</p>}
              <Link className="btn primary" href={`/automations/new?proposal=${p.id}`}>Open on the canvas to edit</Link></div>; })}
        </>}
      </div></>}
  </>;
}
