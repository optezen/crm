'use client';
// Dependency-free node canvas: drag nodes, draw connections, pan, zoom, fit. It only draws and reports gestures; every rule about what may
// connect or exist lives in lib/builder/workflowGraph.ts (the same rules the engine needs), so the canvas cannot create a graph that will not run.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { NODE_H, NODE_W, canConnect, type Graph, type GraphNode, type Layout } from '../../lib/builder/workflowGraph';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | null;
type View = NonNullable<Layout['view']>;
const MIN_Z = 0.25, MAX_Z = 2;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export function WorkflowCanvas({ graph, pos, view, issues, selected, titles, onSelect, onMove, onMoveEnd, onConnect, onView, onDropNew, onDelete, onNudge, onUndo, onRedo }: {
  graph: Graph; pos: Layout['pos']; view: View | null; issues: Record<string, string>; selected: Selection; titles: Record<string, { kind: string; title: string; sub: string }>;
  onSelect: (s: Selection) => void; onMove: (id: string, p: { x: number; y: number }) => void; onMoveEnd: () => void; onConnect: (from: string, to: string) => void; onView: (v: View) => void;
  onDropNew: (payload: string, at: { x: number; y: number }) => void; onDelete: () => void; onNudge: (dx: number, dy: number) => void; onUndo: () => void; onRedo: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<View>(view ?? { x: 24, y: 24, z: 1 });
  const vRef = useRef(v); vRef.current = v;
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const setView = useCallback((n: View) => { vRef.current = n; setV(n); }, []);
  const posOf = (id: string) => pos[id] ?? { x: 0, y: 0 };

  const fit = useCallback(() => {
    const el = root.current; if (!el || !graph.nodes.length) return;
    const xs = graph.nodes.map(n => pos[n.id]?.x ?? 0), ys = graph.nodes.map(n => pos[n.id]?.y ?? 0);
    const minX = Math.min(...xs), minY = Math.min(...ys), w = Math.max(...xs) + NODE_W - minX, h = Math.max(...ys) + NODE_H - minY, pad = 40;
    const z = clamp(Math.min((el.clientWidth - pad * 2) / w, (el.clientHeight - pad * 2) / h), MIN_Z, 1.25);
    setView({ z, x: (el.clientWidth - w * z) / 2 - minX * z, y: (el.clientHeight - h * z) / 2 - minY * z });
  }, [graph.nodes, pos, setView]);
  useEffect(() => { if (!view) fit(); /* first paint only */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { onView(v); /* reported after gestures settle via parent debounce */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.x, v.y, v.z]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    const c = vRef.current, z = clamp(c.z * factor, MIN_Z, MAX_Z), k = z / c.z; setView({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
  }, [setView]);
  useEffect(() => { // wheel must be non-passive so the page does not scroll while zooming the canvas
    const el = root.current; if (!el) return;
    const h = (e: WheelEvent) => { e.preventDefault(); const r = el.getBoundingClientRect(); if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); else setView({ ...vRef.current, x: vRef.current.x - e.deltaX, y: vRef.current.y - e.deltaY }); };
    el.addEventListener('wheel', h, { passive: false }); return () => el.removeEventListener('wheel', h);
  }, [zoomAt, setView]);

  const toCanvas = (cx: number, cy: number) => { const r = root.current!.getBoundingClientRect(), c = vRef.current; return { x: (cx - r.left - c.x) / c.z, y: (cy - r.top - c.y) / c.z }; };

  // background: pan
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const bgDown = (e: RPointerEvent) => { if ((e.target as HTMLElement).closest('[data-node],[data-edge],[data-ctl]')) return; root.current?.focus(); pan.current = { sx: e.clientX, sy: e.clientY, vx: vRef.current.x, vy: vRef.current.y, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const bgMove = (e: RPointerEvent) => { const p = pan.current; if (!p) return; const dx = e.clientX - p.sx, dy = e.clientY - p.sy; if (Math.abs(dx) + Math.abs(dy) > 3) p.moved = true; setView({ ...vRef.current, x: p.vx + dx, y: p.vy + dy }); };
  const bgUp = () => { const p = pan.current; pan.current = null; if (p && !p.moved) onSelect(null); };

  // nodes: drag
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const nodeDown = (e: RPointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('[data-port-out]')) return; e.stopPropagation(); onSelect({ kind: 'node', id });
    const p = posOf(id); drag.current = { id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const nodeMove = (e: RPointerEvent) => { const d = drag.current; if (!d) return; const z = vRef.current.z, dx = (e.clientX - d.sx) / z, dy = (e.clientY - d.sy) / z; if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true; if (d.moved) onMove(d.id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) }); };
  const nodeUp = () => { if (drag.current?.moved) onMoveEnd(); drag.current = null; };

  // output port: draw a connection, released over a node
  const wireDown = (e: RPointerEvent, from: string) => { e.stopPropagation(); e.preventDefault(); setHint(null); const p = toCanvas(e.clientX, e.clientY); setWire({ from, ...p }); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const wireMove = (e: RPointerEvent) => { if (wire) setWire({ ...wire, ...toCanvas(e.clientX, e.clientY) }); };
  const wireUp = (e: RPointerEvent) => {
    if (!wire) return; const from = wire.from; setWire(null);
    const to = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-node]')?.getAttribute('data-node');
    if (!to || to === from) return; const ok = canConnect(graph, from, to);
    if (!ok.ok) { setHint(ok.reason); return; } setHint(null); onConnect(from, to);
  };

  const key = (e: RKeyboardEvent) => {
    const t = e.target as HTMLElement; if (t.closest('input,select,textarea') ) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? onRedo() : onUndo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); onRedo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDelete(); return; }
    if (e.key === '0') { fit(); return; }
    const r = root.current!.getBoundingClientRect();
    if (e.key === '+' || e.key === '=') { zoomAt(1.2, r.width / 2, r.height / 2); return; } if (e.key === '-') { zoomAt(1 / 1.2, r.width / 2, r.height / 2); return; }
    const step = e.shiftKey ? 40 : 10;
    const dd = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key]; if (dd) { e.preventDefault(); if (selected?.kind === 'node') onNudge(dd[0], dd[1]); else setView({ ...vRef.current, x: vRef.current.x - dd[0] * 4, y: vRef.current.y - dd[1] * 4 }); }
  };

  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }) => { const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2, dx = Math.max(40, Math.abs(x2 - x1) / 2); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; };
  const nodeById = useMemo(() => new Map(graph.nodes.map(n => [n.id, n] as [string, GraphNode])), [graph.nodes]);

  return <div ref={root} className="wf-canvas" tabIndex={0} role="application" aria-label="Workflow canvas. Arrow keys move the selected step, plus and minus zoom, 0 fits the view, Delete removes the selection."
    onKeyDown={key} onPointerDown={bgDown} onPointerMove={bgMove} onPointerUp={bgUp}
    onDragOver={e => { if (e.dataTransfer.types.includes('application/x-optizen-node')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={e => { const p = e.dataTransfer.getData('application/x-optizen-node'); if (p) { e.preventDefault(); onDropNew(p, toCanvas(e.clientX, e.clientY)); } }}>
    <div className="wf-world" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})` }}>
      <svg className="wf-edges" width="1" height="1" aria-hidden="true">
        <defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker></defs>
        {graph.edges.map(e => { const a = nodeById.get(e.from), b = nodeById.get(e.to); if (!a || !b) return null; const sel = selected?.kind === 'edge' && selected.from === e.from && selected.to === e.to; const d = edgePath(posOf(e.from), posOf(e.to));
          return <g key={`${e.from}>${e.to}`} data-edge className={sel ? 'wf-edge sel' : 'wf-edge'}><path d={d} className="wf-hit" onPointerDown={ev => { ev.stopPropagation(); root.current?.focus(); onSelect({ kind: 'edge', from: e.from, to: e.to }); }} /><path d={d} className="wf-line" markerEnd="url(#wf-arrow)" /></g>; })}
        {wire && <path d={edgePath(posOf(wire.from), { x: wire.x - 0, y: wire.y - NODE_H / 2 })} className="wf-line wf-wire" />}
      </svg>
      {graph.nodes.map(n => { const p = posOf(n.id), t = titles[n.id], sel = selected?.kind === 'node' && selected.id === n.id, bad = issues[n.id];
        return <div key={n.id} data-node={n.id} role="button" tabIndex={0} aria-pressed={sel} aria-label={`${t?.kind}: ${t?.title}. ${bad ? 'Problem: ' + bad : 'No problems.'}`}
          className={`wf-node wf-${n.kind}${sel ? ' sel' : ''}${bad ? ' bad' : ''}`} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
          onPointerDown={e => nodeDown(e, n.id)} onPointerMove={nodeMove} onPointerUp={nodeUp} onFocus={() => onSelect({ kind: 'node', id: n.id })}>
          {n.kind !== 'trigger' && <span className="wf-in" aria-hidden="true" />}
          <span className="wf-kind">{t?.kind}</span><span className="wf-title">{t?.title}</span><span className="wf-sub">{bad ? `⚠ ${bad}` : t?.sub}</span>
          <span className="wf-out" data-port-out={n.id} title="Drag to the next step" aria-hidden="true" onPointerDown={e => wireDown(e, n.id)} onPointerMove={wireMove} onPointerUp={wireUp} />
        </div>; })}
    </div>
    <div className="wf-controls" data-ctl role="group" aria-label="Canvas view">
      <button type="button" className="btn" aria-label="Zoom out" onClick={() => { const r = root.current!.getBoundingClientRect(); zoomAt(1 / 1.2, r.width / 2, r.height / 2); }}>−</button>
      <span aria-live="polite" className="muted" style={{ minWidth: 44, textAlign: 'center' }}>{Math.round(v.z * 100)}%</span>
      <button type="button" className="btn" aria-label="Zoom in" onClick={() => { const r = root.current!.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); }}>+</button>
      <button type="button" className="btn" onClick={fit}>Fit to view</button>
    </div>
    {hint && <p className="wf-hint err" role="alert" data-ctl>{hint}</p>}
    {graph.nodes.length === 0 && <p className="empty" style={{ position: 'absolute', inset: 0 }}>Add a trigger from the palette to start.</p>}
  </div>;
}
