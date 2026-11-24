'use client';
// Dependency-free node canvas. Steps are stacked top to bottom in run order. It only draws and reports gestures; every rule about what may connect or exist lives in
// lib/builder/workflowGraph.ts (the same rules the engine needs), so the canvas cannot create a graph that will not run. Everything can be done without dragging:
// "+" buttons insert steps, Up/Down move between steps, Enter opens a step, Alt+arrows nudge, plus/minus zoom, 0 fits.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { NODE_H, NODE_W, canConnect, type Graph, type GraphNode, type Layout } from '../../lib/builder/workflowGraph';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | null;
type View = NonNullable<Layout['view']>;
const MIN_Z = 0.3, MAX_Z = 2, READABLE_Z = 0.85, FIT_MAX_Z = 1.1, ADD_ROW = 64;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const KIND_ICON: Record<string, string> = { trigger: 'M13 2 4 14h6l-1 8 9-12h-6z', condition: 'M3 5h18l-7 8v6l-4-2v-4z', action: 'M5 12l5 5L20 7', delay: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18' };

export function WorkflowCanvas({ tools, graph, pos, issues, selected, titles, order, onSelect, onFocusNode, onMove, onMoveEnd, onConnect, onView, onDropNew, onDelete, onNudge, onUndo, onRedo, onInsertAfter }: {
  tools?: ReactNode; graph: Graph; pos: Layout['pos']; issues: Record<string, string>; selected: Selection; titles: Record<string, { kind: string; title: string; sub: string }>; order: string[];
  onSelect: (s: Selection) => void; onFocusNode: (id: string) => void; onMove: (id: string, p: { x: number; y: number }) => void; onMoveEnd: () => void; onConnect: (from: string, to: string) => void; onView: (v: View) => void;
  onDropNew: (payload: string, at: { x: number; y: number }) => void; onDelete: () => void; onNudge: (dx: number, dy: number) => void; onUndo: () => void; onRedo: () => void; onInsertAfter: (id: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [v, setV] = useState<View>({ x: 24, y: 24, z: 1 });
  const vRef = useRef(v); vRef.current = v;
  const autoFit = useRef(true); // true until the person pans or zooms; while true the view keeps itself fitted (resizes, panels opening, steps added)
  const [wire, setWire] = useState<{ from: string; x: number; y: number } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const setView = useCallback((n: View) => { vRef.current = n; setV(n); }, []);
  const posOf = (id: string) => pos[id] ?? { x: 0, y: 0 };
  const manual = () => { autoFit.current = false; };

  // Fit and centre at a readable zoom. A long chain is not squeezed below READABLE_Z: it is centred horizontally, starts at the top, and the rest is a scroll away.
  const fit = useCallback(() => {
    const el = root.current; if (!el || !graph.nodes.length) return;
    const cw = el.clientWidth, ch = el.clientHeight; if (!cw || !ch) return;
    const xs = graph.nodes.map(n => pos[n.id]?.x ?? 0), ys = graph.nodes.map(n => pos[n.id]?.y ?? 0);
    const minX = Math.min(...xs), minY = Math.min(...ys), w = Math.max(...xs) + NODE_W - minX, h = Math.max(...ys) + NODE_H + ADD_ROW - minY, padX = cw < 600 ? 14 : 56, padY = cw < 600 ? 14 : 28;
    const z = clamp(Math.min((cw - padX * 2) / w, (ch - padY * 2) / h), READABLE_Z, FIT_MAX_Z);
    const x = (cw - w * z) / 2 - minX * z, y = h * z + padY * 2 <= ch ? (ch - h * z) / 2 - minY * z : padY - minY * z;
    setView({ z, x, y }); autoFit.current = true;
  }, [graph.nodes, pos, setView]);
  useLayoutEffect(() => { fit(); /* first paint, before the person sees anything */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fitRef = useRef(fit); fitRef.current = fit;
  useEffect(() => { const el = root.current; if (!el || typeof ResizeObserver === 'undefined') return; const ro = new ResizeObserver(() => { if (autoFit.current) fitRef.current(); }); ro.observe(el); return () => ro.disconnect(); }, []);
  useEffect(() => { if (autoFit.current) fit(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph.nodes.length]);
  useEffect(() => { onView(v); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.x, v.y, v.z]);

  // keep the selected step on screen when the chain is longer than the canvas
  const selId = selected?.kind === 'node' ? selected.id : null;
  useEffect(() => {
    const el = root.current; if (!el || !selId) return; const c = vRef.current, p = pos[selId]; if (!p) return;
    const top = p.y * c.z + c.y, bottom = top + NODE_H * c.z; if (top >= 8 && bottom <= el.clientHeight - 8) return;
    manual(); setView({ ...c, y: el.clientHeight / 2 - (p.y + NODE_H / 2) * c.z });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    const c = vRef.current, z = clamp(c.z * factor, MIN_Z, MAX_Z), k = z / c.z; autoFit.current = false; setView({ z, x: cx - (cx - c.x) * k, y: cy - (cy - c.y) * k });
  }, [setView]);
  useEffect(() => { // wheel must be non-passive so the page does not scroll while zooming the canvas
    const el = root.current; if (!el) return;
    const h = (e: WheelEvent) => { e.preventDefault(); const r = el.getBoundingClientRect(); if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top); else { autoFit.current = false; setView({ ...vRef.current, x: vRef.current.x - e.deltaX, y: vRef.current.y - e.deltaY }); } };
    el.addEventListener('wheel', h, { passive: false }); return () => el.removeEventListener('wheel', h);
  }, [zoomAt, setView]);

  const toCanvas = (cx: number, cy: number) => { const r = root.current!.getBoundingClientRect(), c = vRef.current; return { x: (cx - r.left - c.x) / c.z, y: (cy - r.top - c.y) / c.z }; };

  // background: pan
  const pan = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const bgDown = (e: RPointerEvent) => { if ((e.target as HTMLElement).closest('[data-node],[data-edge],[data-ctl]')) return; root.current?.focus(); pan.current = { sx: e.clientX, sy: e.clientY, vx: vRef.current.x, vy: vRef.current.y, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const bgMove = (e: RPointerEvent) => { const p = pan.current; if (!p) return; const dx = e.clientX - p.sx, dy = e.clientY - p.sy; if (Math.abs(dx) + Math.abs(dy) > 3) { p.moved = true; manual(); } if (p.moved) setView({ ...vRef.current, x: p.vx + dx, y: p.vy + dy }); };
  const bgUp = () => { const p = pan.current; pan.current = null; if (p && !p.moved) onSelect(null); };

  // nodes: click selects, dragging moves (optional: the steps re-stack whenever the order changes)
  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const nodeDown = (e: RPointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('[data-port-out]')) return; e.stopPropagation();
    const p = posOf(id); drag.current = { id, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const nodeMove = (e: RPointerEvent) => { const d = drag.current; if (!d) return; const z = vRef.current.z, dx = (e.clientX - d.sx) / z, dy = (e.clientY - d.sy) / z; if (Math.abs(dx) + Math.abs(dy) > 4) { d.moved = true; manual(); } if (d.moved) onMove(d.id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) }); };
  const nodeUp = () => { const d = drag.current; drag.current = null; if (!d) return; if (d.moved) onMoveEnd(); else onSelect({ kind: 'node', id: d.id }); };

  // output port: draw a connection, released over a node
  const wireDown = (e: RPointerEvent, from: string) => { e.stopPropagation(); e.preventDefault(); setHint(null); const p = toCanvas(e.clientX, e.clientY); setWire({ from, ...p }); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const wireMove = (e: RPointerEvent) => { if (wire) setWire({ ...wire, ...toCanvas(e.clientX, e.clientY) }); };
  const wireUp = (e: RPointerEvent) => {
    if (!wire) return; const from = wire.from; setWire(null);
    const to = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-node]')?.getAttribute('data-node');
    if (!to || to === from) return; const ok = canConnect(graph, from, to);
    if (!ok.ok) { setHint(ok.reason); return; } setHint(null); onConnect(from, to);
  };

  const sequence = useMemo(() => [...order, ...graph.nodes.map(n => n.id).filter(i => !order.includes(i))], [order, graph.nodes]);
  const focusNode = (id: string) => (root.current?.querySelector(`[data-node="${id}"]`) as HTMLElement | null)?.focus({ preventScroll: true }); // the view pans itself; a browser scroll of the clipped canvas would double it
  const key = (e: RKeyboardEvent) => {
    const t = e.target as HTMLElement; if (t.closest('input,select,textarea,[data-ctl]')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? onRedo() : onUndo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); onRedo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onDelete(); return; }
    if (e.key === '0') { fit(); return; }
    const r = root.current!.getBoundingClientRect();
    if (e.key === '+' || e.key === '=') { zoomAt(1.2, r.width / 2, r.height / 2); return; } if (e.key === '-') { zoomAt(1 / 1.2, r.width / 2, r.height / 2); return; }
    const dir = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[e.key]; if (!dir) return; e.preventDefault();
    if (e.altKey) { if (selected?.kind === 'node') onNudge(dir[0] * 10, dir[1] * 10); return; } // Alt+arrows: nudge the selected step
    if (e.shiftKey || !sequence.length) { manual(); setView({ ...vRef.current, x: vRef.current.x - dir[0] * 80, y: vRef.current.y - dir[1] * 80 }); return; } // Shift+arrows: pan
    const i = selId ? sequence.indexOf(selId) : -1; const j = clamp(i < 0 ? 0 : i + (dir[1] || dir[0]), 0, sequence.length - 1); focusNode(sequence[j]!); // arrows: previous / next step
  };

  // the arrow tip stops 12px above the step (y2 = b.y - 12) so it does not collide with the connection point
  const edgePath = (a: { x: number; y: number }, b: { x: number; y: number }) => { const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H, x2 = b.x + NODE_W / 2, y2 = b.y - 12, dy = Math.max(16, Math.abs(y2 - y1) / 2); return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`; };
  const nodeById = useMemo(() => new Map(graph.nodes.map(n => [n.id, n] as [string, GraphNode])), [graph.nodes]);
  const last = order.length ? nodeById.get(order[order.length - 1]!) : undefined;
  const stepNo = (id: string) => { const i = order.indexOf(id); return i < 0 ? '–' : String(i + 1); };

  return <div className="wf-wrap">
    <div className="wf-strip" role="group" aria-label="Canvas tools"><div className="wf-tools">{tools}</div>
      <div className="wf-zoomctl" role="group" aria-label="Canvas view">
        <button type="button" className="btn ph-hide" aria-label="Zoom out" onClick={() => { const r = root.current!.getBoundingClientRect(); zoomAt(1 / 1.2, r.width / 2, r.height / 2); }}>−</button>
        <span aria-live="polite" className="muted wf-zoom">{Math.round(v.z * 100)}%</span>
        <button type="button" className="btn ph-hide" aria-label="Zoom in" onClick={() => { const r = root.current!.getBoundingClientRect(); zoomAt(1.2, r.width / 2, r.height / 2); }}>+</button>
        <button type="button" className="btn" onClick={fit}>Fit to view</button></div></div>
  <div ref={root} className="wf-canvas" tabIndex={0} role="application" aria-label="Workflow canvas. Up and Down arrows move between steps, Enter opens a step, plus and minus zoom, 0 fits the view, Delete removes the selected step."
    onScroll={e => { e.currentTarget.scrollTop = 0; e.currentTarget.scrollLeft = 0; /* Tab-focusing an off-screen step must not scroll the clipped canvas */ }} onKeyDown={key} onPointerDown={bgDown} onPointerMove={bgMove} onPointerUp={bgUp}
    onDragOver={e => { if (e.dataTransfer.types.includes('application/x-optizen-node')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
    onDrop={e => { const p = e.dataTransfer.getData('application/x-optizen-node'); if (p) { e.preventDefault(); onDropNew(p, toCanvas(e.clientX, e.clientY)); } }}>
    <div className="wf-world" data-zoom={v.z.toFixed(2)} style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.z})` }}>
      <svg className="wf-edges" width="1" height="1" aria-hidden="true">
        <defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" /></marker></defs>
        {graph.edges.map(e => { const a = nodeById.get(e.from), b = nodeById.get(e.to); if (!a || !b) return null; const sel = selected?.kind === 'edge' && selected.from === e.from && selected.to === e.to; const d = edgePath(posOf(e.from), posOf(e.to));
          return <g key={`${e.from}>${e.to}`} data-edge className={sel ? 'wf-edge sel' : 'wf-edge'}><path d={d} className="wf-hit" onPointerDown={ev => { ev.stopPropagation(); root.current?.focus(); onSelect({ kind: 'edge', from: e.from, to: e.to }); }} /><path d={d} className="wf-line" markerEnd="url(#wf-arrow)" /></g>; })}
        {wire && <path d={edgePath(posOf(wire.from), { x: wire.x - NODE_W / 2, y: wire.y })} className="wf-line wf-wire" />}
      </svg>
      {graph.nodes.map(n => { const p = posOf(n.id), t = titles[n.id], sel = selected?.kind === 'node' && selected.id === n.id, bad = issues[n.id];
        return <div key={n.id} data-node={n.id} role="button" tabIndex={0} aria-pressed={sel}
          className={`wf-node wf-${n.kind}${sel ? ' sel' : ''}${bad ? ' bad' : ''}`} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
          onPointerDown={e => nodeDown(e, n.id)} onPointerMove={nodeMove} onPointerUp={nodeUp} onFocus={() => onFocusNode(n.id)}
          onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect({ kind: 'node', id: n.id }); } }}>
          {n.kind !== 'trigger' && <span className="wf-in" aria-hidden="true" />}
          <span className="wf-badge" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={KIND_ICON[n.kind]} /></svg></span>
          <span className="wf-body"><span className="wf-kind">{stepNo(n.id)}. {t?.kind}</span><span className="wf-title">{t?.title}</span><span className="wf-sub">{t?.sub}</span>{bad && <span className="sr-only">Problem: {bad}</span>}</span>
          {bad && <span className="wf-warn" aria-hidden="true" title={bad}>!</span>}
          <span className="wf-out" data-port-out={n.id} title="Drag to the next step (optional)" aria-hidden="true" onPointerDown={e => wireDown(e, n.id)} onPointerMove={wireMove} onPointerUp={wireUp} />
        </div>; })}
      {order.slice(0, -1).map((id, i) => { const nx = nodeById.get(order[i + 1]!), a = nodeById.get(id); if (!a || !nx || !graph.edges.some(e => e.from === id && e.to === nx.id) || (a.kind === 'trigger' && nx.kind === 'condition')) return null;
        const pa = posOf(id), pb = posOf(nx.id); return <button key={`add-${id}`} type="button" data-ctl className="wf-add" aria-label={`Add a step after step ${i + 1}`} title="Add a step here" style={{ left: pa.x + NODE_W / 2 - 18, top: (pa.y + NODE_H + pb.y) / 2 - 18 }}
          onPointerDown={e => e.stopPropagation()} onClick={() => onInsertAfter(id)}><span aria-hidden="true">+</span></button>; })}
      {last && <button type="button" data-ctl className="wf-add wf-add-end" onPointerDown={e => e.stopPropagation()} onClick={() => onInsertAfter(last.id)} style={{ left: posOf(last.id).x + NODE_W / 2 - 62, top: posOf(last.id).y + NODE_H + 18 }}><span aria-hidden="true">+</span> Add step</button>}
    </div>
    {hint && <p className="wf-hint err" role="alert" data-ctl>{hint}</p>}
    {graph.nodes.length === 0 && <p className="empty" style={{ position: 'absolute', inset: 0 }}>Add a trigger to start.</p>}
  </div></div>;
}
