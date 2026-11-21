// Pipeline editing model. Stages are edited as rows that remember which LIVE stage they came from, so a rename is recorded as a migration plan
// (`pipeline.stageMoves`) rather than silently orphaning leads. Removing a stage that holds leads needs a target stage. The database applies the plan
// atomically at publish and refuses anything that would leave a lead in a stage the pipeline no longer has.
import type { PipelineConfig, StageColor, StageMove, StageSettings } from '../workspace/types.ts';

export type StageRow = { key: string; name: string; liveName: string | null; color?: StageColor; requires_assignee?: boolean; requires_summary?: boolean };
export type Removed = { liveName: string; targetKey: string | null };
export type PipelineModel = { rows: StageRow[]; removed: Removed[] };

export function modelFromPipeline(draft: PipelineConfig, live: PipelineConfig): PipelineModel {
  let n = 0; const rows: StageRow[] = draft.stages.map(name => { const s = draft.stageSettings?.[name] ?? {}; return { key: `s${++n}`, name, liveName: live.stages.includes(name) ? name : null, ...s }; });
  const removed: Removed[] = [];
  for (const m of draft.stageMoves ?? []) { const to = rows.find(r => r.name === m.to); if (!to) continue; if (live.stages.includes(m.to)) removed.push({ liveName: m.from, targetKey: to.key }); else to.liveName = m.from; }
  for (const l of live.stages) if (!rows.some(r => r.liveName === l) && !removed.some(r => r.liveName === l)) removed.push({ liveName: l, targetKey: null });
  return { rows, removed };
}
export function pipelineFromModel(m: PipelineModel): PipelineConfig {
  const stages = m.rows.map(r => r.name.trim().replace(/\s+/g, ' '));
  const stageSettings: Record<string, StageSettings> = {};
  m.rows.forEach((r, i) => { const o: StageSettings = {}; if (r.color && r.color !== 'gray') o.color = r.color; if (r.requires_assignee) o.requires_assignee = true; if (r.requires_summary) o.requires_summary = true; if (Object.keys(o).length) stageSettings[stages[i]!] = o; });
  const moves: StageMove[] = [];
  m.rows.forEach((r, i) => { if (r.liveName && r.liveName !== stages[i]) moves.push({ from: r.liveName, to: stages[i]! }); });
  for (const x of m.removed) { const t = m.rows.find(r => r.key === x.targetKey); if (t && !stages.includes(x.liveName) && !moves.some(v => v.from === x.liveName)) moves.push({ from: x.liveName, to: stages[m.rows.indexOf(t)]! }); }
  return { stages, ...(Object.keys(stageSettings).length ? { stageSettings } : {}), ...(moves.length ? { stageMoves: moves } : {}) };
}
/** Stages removed from the pipeline that still hold leads but have no target: publishing would be refused, so saving is blocked with this explanation. */
export function unplanned(m: PipelineModel, counts: Record<string, number>): string[] {
  return m.removed.filter(r => (counts[r.liveName] ?? 0) > 0 && !r.targetKey && !m.rows.some(x => x.name === r.liveName)).map(r => `${counts[r.liveName]} lead(s) are in "${r.liveName}". Choose a stage to move them to before removing it.`);
}
export const moveRow = (rows: StageRow[], from: number, to: number): StageRow[] => { if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows; const n = [...rows]; const [x] = n.splice(from, 1); n.splice(to, 0, x!); return n; };
export function addRow(m: PipelineModel, name: string): PipelineModel {
  if (m.rows.length >= 20) return m; const key = `s${Math.max(0, ...m.rows.map(r => Number(r.key.slice(1)))) + 1}`;
  // re-adding the name of a stage that was removed cancels that removal instead of creating a second stage with the same name
  const back = m.removed.find(r => r.liveName === name.trim());
  return { rows: [...m.rows, { key, name: name.trim(), liveName: back ? back.liveName : null }], removed: m.removed.filter(r => r !== back) };
}
/** Removes a row. A stage that existed live is recorded as removed (needs a target if it holds leads); a brand-new stage just disappears. */
export function removeRow(m: PipelineModel, key: string): PipelineModel {
  const r = m.rows.find(x => x.key === key); if (!r || m.rows.length <= 2) return m;
  const removed = m.removed.filter(x => x.targetKey !== key); // anything that pointed at it must choose again
  const fixed = m.removed.filter(x => x.targetKey === key).map(x => ({ ...x, targetKey: null }));
  return { rows: m.rows.filter(x => x.key !== key), removed: [...removed, ...fixed, ...(r.liveName ? [{ liveName: r.liveName, targetKey: null }] : [])] };
}
export const setTarget = (m: PipelineModel, liveName: string, targetKey: string | null): PipelineModel => ({ ...m, removed: m.removed.map(x => (x.liveName === liveName ? { ...x, targetKey } : x)) });
export const patchRow = (m: PipelineModel, key: string, p: Partial<StageRow>): PipelineModel => ({ ...m, rows: m.rows.map(r => (r.key === key ? { ...r, ...p } : r)) });
export const COLOR_HEX: Record<StageColor, string> = { gray: '#a8a29e', green: '#4d9a74', blue: '#4f6d9a', amber: '#c2972b', red: '#b4504a', purple: '#8a5a83' };
