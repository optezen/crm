'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { LocalTime } from '../../../components/ui/LocalTime';
import type { RunRow } from '../../../lib/automation/types';
import { requeueRunAction } from './actions';

const BADGE: Record<string, string> = { succeeded: '', dead: 'late', cancelled: 'done', skipped: 'done' };
const LABEL: Record<string, string> = { queued: 'Queued', waiting: 'Waiting (delayed)', retrying: 'Retrying', succeeded: 'Succeeded', dead: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped' };
export function RunLog({ runs, showWorkflow }: { runs: (RunRow & { workflowName: string })[]; showWorkflow?: boolean }) {
  const router = useRouter(); const [err, setErr] = useState<string>(); const [pending, start] = useTransition();
  if (!runs.length) return <p className="muted">No runs yet. Runs appear here after the worker processes a matching event.</p>;
  return <div className="stack" style={{ gap: 10 }}>
    {err && <p className="err" role="alert">{err}</p>}
    {runs.map(r => <details key={r.id}><summary><span className={`badge ${BADGE[r.status] ?? ''}`}>{LABEL[r.status] ?? r.status}</span> {showWorkflow && <strong>{r.workflowName} · </strong>}<LocalTime iso={r.createdAt} /> · v{r.version}{r.status === 'waiting' && <> · resumes <LocalTime iso={r.nextAttemptAt} /></>}{r.status === 'retrying' && <> · attempt {r.attempts} failed, retry <LocalTime iso={r.nextAttemptAt} /></>}</summary>
      <div className="stack" style={{ gap: 6, marginTop: 8 }}>
        {r.lastError && <p className={r.status === 'skipped' ? 'muted' : 'err'}>{r.lastError}</p>}
        {r.steps.map(s => <div key={s.stepIndex} className="row"><span className={`badge ${s.status === 'failed' ? 'late' : ''}`}>{s.status}</span> <span>Step {s.stepIndex + 1}: {s.actionType.replace(/_/g, ' ')}</span>{s.error && <span className="err">{s.error}</span>}{s.result && <code className="muted">{JSON.stringify(s.result)}</code>}</div>)}
        {r.status === 'dead' && <div><button type="button" className="btn" disabled={pending} onClick={() => start(async () => { const x = await requeueRunAction(r.id); if (x.ok) router.refresh(); else setErr(x.error); })}>Try again</button></div>}
      </div></details>)}
  </div>;
}
