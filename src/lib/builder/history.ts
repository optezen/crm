// Undo/redo for draft edits (pure). `key` coalesces a burst of edits (typing, dragging) into one undo step.
export type History<T> = { past: T[]; present: T; future: T[]; key: string | null };
export const MAX_HISTORY = 100;
export const history = <T,>(present: T): History<T> => ({ past: [], present, future: [], key: null });
export function commit<T>(h: History<T>, next: T, key: string | null = null): History<T> {
  if (Object.is(next, h.present)) return h;
  if (key !== null && key === h.key) return { ...h, present: next, future: [] };
  return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [], key };
}
export const undo = <T,>(h: History<T>): History<T> => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future], key: null } : h);
export const redo = <T,>(h: History<T>): History<T> => (h.future.length ? { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1), key: null } : h);
/** Ends a coalescing burst (e.g. on pointer-up / blur) so the next edit starts a new undo step. */
export const seal = <T,>(h: History<T>): History<T> => (h.key === null ? h : { ...h, key: null });
