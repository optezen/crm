'use client';
import { useActionState } from 'react';
import { completeTaskAction } from '../../app/(app)/work/leads/actions';
import type { FormState } from '../ui/ActionForm';

/** Finish a follow-up in one tap. The outcome is required by the database, so it defaults to "Completed" and can be edited. Works without touch gestures or drag and drop. */
export function TaskDone({ taskId, title }: { taskId: string; title: string }) {
  const [state, run, pending] = useActionState<FormState, FormData>(completeTaskAction, null);
  if (state?.ok) return <span className="ok" role="status">Done ✓</span>;
  return <form action={run} className="task-done"><input type="hidden" name="taskId" value={taskId} />
    <label className="sr-only" htmlFor={`o-${taskId}`}>Outcome for {title}</label><input id={`o-${taskId}`} name="outcome" className="input" defaultValue="Completed" maxLength={200} />
    <button className="btn" disabled={pending} aria-label={`Mark “${title}” done`}>{pending ? '…' : 'Done'}</button>
    {state?.error && <span className="err" role="alert">{state.error}</span>}</form>;
}
