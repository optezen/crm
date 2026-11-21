// Pure layout rules for the dashboard grid editor (12 columns; a widget's position is its order, its size is w x h). Kept apart from React so they can be tested.
import type { Widget } from '../analytics/types.ts';
export const GRID_GAP = 12, ROW_H = 84, MAX_COLS = 12, MAX_ROWS = 12;
export type GridDraft = { name: string; description: string; visibility: 'personal' | 'organization'; widgets: Widget[] };
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
/** Moves a widget to a new index; out-of-range or no-op moves return the same array (so history records nothing). */
export function moveWidget<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const n = [...list]; const [x] = n.splice(from, 1); n.splice(to, 0, x!); return n;
}
/** New size after dragging the resize corner by (dx, dy) pixels, snapped to whole columns/rows and clamped to the grid. */
export function resizeFromDrag(start: { w: number; h: number }, dx: number, dy: number, colW: number): { w: number; h: number } {
  return { w: clamp(start.w + Math.round(dx / (colW + GRID_GAP)), 1, MAX_COLS), h: clamp(start.h + Math.round(dy / (ROW_H + GRID_GAP)), 1, MAX_ROWS) };
}
/** Keyboard resize (Shift+arrows): left/right change columns, up/down change rows. */
export function applyGridEdit(w: { w: number; h: number }, key: string): { w: number; h: number } {
  const d = key === 'ArrowRight' ? { w: 1, h: 0 } : key === 'ArrowLeft' ? { w: -1, h: 0 } : key === 'ArrowDown' ? { w: 0, h: 1 } : key === 'ArrowUp' ? { w: 0, h: -1 } : { w: 0, h: 0 };
  return { w: clamp(w.w + d.w, 1, MAX_COLS), h: clamp(w.h + d.h, 1, MAX_ROWS) };
}
