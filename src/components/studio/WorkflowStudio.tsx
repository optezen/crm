'use client';
// Visual workflow editor. Edits a graph that compiles to the SAME AutomationDefinition the list editor and the AI produce; it is saved with
// saveVisualAction (validated again server- and database-side) and published through automation_publish like any other automation.
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ACTION_LABEL, TRIGGERS, scopeOf, type Action, type AutomationDefinition } from '../../lib/automation/types';
import { describeAutomation } from '../../lib/automation/validate';
import { NODE_H, NODE_W, GAP_X, actionsFor, addNode, blankAction, chainOf, connect, definitionToGraph, graphToDefinition, moveInChain, nextId, nodeIssues, removeEdge, removeNode, updateNode, canConnect, type Graph, type GraphNode, type Layout, type WaitAction } from '../../lib/builder/workflowGraph';
import { commit, history, redo, seal, undo, type History } from '../../lib/builder/history';
import { WorkflowCanvas, type Selection } from './WorkflowCanvas';
import { ActionFields, ConditionsEditor, fieldOptionsFor, type MemberOption, type ModuleOption } from '../automation/fields';
import { discardAutomationDraftAction, setEnabledAction } from '../../app/(app)/automations/actions';
import { deleteWipAction, publishVisualAction, saveVisualAction, saveWipAction, type VisualResult } from '../../app/(app)/automations/visual-actions';

type E = { graph: Graph; pos: Layout['pos'] };
const START: AutomationDefinition = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };

export function WorkflowStudio({ id, name: initName, enabled, publishedVersion, draft, published, initial, layout, token: initToken, modules, members, proposalId, banner, wip = null }: {
  id: string | null; name: string; enabled: boolean; publishedVersion: number | null; draft: AutomationDefinition | null; published: AutomationDefinition | null; initial: AutomationDefinition | null; layout: Layout | null; token: string | null;
  modules: ModuleOption[]; members: MemberOption[]; proposalId: string | null; banner: string | null; wip?: { id: string; name: string; graph: Graph; pos: Layout['pos'] } | null;
}) {
  const router = useRouter();
  const [first] = useState(() => (wip ? { graph: wip.graph, pos: wip.pos, view: undefined } : definitionToGraph(draft ?? published ?? initial ?? START, layout)));
  const [wipId, setWipId] = useState<string | null>(wip?.id ?? null);
  const [h, setH] = useState<History<E>>(() => history({ graph: first.graph, pos: first.pos }));
  const [sel, setSel] = useState<Selection>(null);
  const [name, setName] = useState(wip?.name || initName || 'New lead follow-up');
  const [wfId, setWfId] = useState(id), [token, setToken] = useState(initToken);
  const [hasDraft, setHasDraft] = useState(!!draft);
  const view = useRef(first.view ?? null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; conflict?: boolean }>();
  const [pending, startT] = useTransition();
  const { graph, pos } = h.present;

  const compiled = useMemo(() => graphToDefinition(graph), [graph]);
  const issues = useMemo(() => nodeIssues(graph), [graph]);
  const who = (uid: string) => members.find(m => m.id === uid)?.email ?? uid.slice(0, 8);
  const trig = graph.nodes.find((n): n is Extract<GraphNode, { kind: 'trigger' }> => n.kind === 'trigger');
  const scope = trig ? scopeOf(trig.event) : 'none';
  const fieldOptions = fieldOptionsFor(scope, trig?.object, modules);
  const snap = (n: string, g: Graph, p: Layout['pos']) => JSON.stringify([n, g, p]);
  const [saved, setSaved] = useState(() => snap(initName || 'New lead follow-up', first.graph, first.pos));
  const dirty = snap(name, graph, pos) !== saved || (!wfId);
  const selNode = sel?.kind === 'node' ? graph.nodes.find(n => n.id === sel.id) ?? null : null;

  const edit = (next: E, key: string | null = null) => setH(c => commit(c, next, key));
  const setGraph = (g: Graph, key: string | null = null) => edit({ graph: g, pos }, key);
  const chain = useMemo(() => chainOf(graph).chain, [graph]);
  const titles = useMemo(() => Object.fromEntries(graph.nodes.map(n => [n.id, describeNode(n, who)])), [graph.nodes, members]); // eslint-disable-line react-hooks/exhaustive-deps

  const insert = (n: GraphNode, at?: { x: number; y: number }) => {
    const after = n.kind === 'condition' ? trig?.id : selNode ? selNode.id : chain[chain.length - 1]?.id;
    const g = addNode(graph, n, after); if (g === graph) { setMsg({ ok: false, text: n.kind === 'condition' ? 'A condition goes directly after the trigger, and there can be only one.' : 'That step cannot be added there.' }); return; }
    const prev = after ? pos[after] : null;
    const p = at ?? (prev ? { x: prev.x + (g.edges.some(e => e.from === n.id) ? 30 : NODE_W + GAP_X), y: prev.y + (g.edges.some(e => e.from === n.id) ? NODE_H + 30 : 0) } : { x: 40, y: 120 });
    edit({ graph: g, pos: { ...pos, [n.id]: { x: Math.round(p.x), y: Math.round(p.y) } } }); setSel({ kind: 'node', id: n.id }); setMsg(undefined);
  };
  const fromPayload = (payload: string): GraphNode | null => {
    try { const p = JSON.parse(payload) as { kind: string; type?: string }; const id2 = nextId(graph);
      if (p.kind === 'condition' && !graph.nodes.some(n => n.kind === 'condition')) return { id: id2, kind: 'condition', op: 'and', conditions: fieldOptions[0] ? [{ field: fieldOptions[0][0], op: 'eq', value: '' }] : [] };
      if (p.kind === 'delay') return { id: id2, kind: 'delay', action: blankAction('wait') as WaitAction };
      if (p.kind === 'action' && p.type && actionsFor(trig?.event ?? '').includes(p.type as never)) return { id: id2, kind: 'action', action: blankAction(p.type as never) as never };
    } catch { /* ignore malformed drag data */ } return null;
  };
  const tidy = () => edit({ graph, pos: Object.fromEntries([...chain, ...chainOf(graph).rest].map((n, i) => [n.id, { x: 40 + i * (NODE_W + GAP_X), y: 120 }])) });
  const del = () => { if (sel?.kind === 'node') { const g = removeNode(graph, sel.id); if (g !== graph) { setGraph(g); setSel(null); } } else if (sel?.kind === 'edge') { setGraph(removeEdge(graph, sel)); setSel(null); } };
  const nudge = (dx: number, dy: number) => { if (sel?.kind === 'node') { const p = pos[sel.id] ?? { x: 0, y: 0 }; edit({ graph, pos: { ...pos, [sel.id]: { x: p.x + dx, y: p.y + dy } } }, `nudge:${sel.id}`); } };
  const setNode = (n: GraphNode) => setGraph(updateNode(graph, n), `edit:${n.id}`);
  const undoRedo = { undo: () => setH(c => undo(seal(c))), redo: () => setH(c => redo(c)) };

  const layoutOut = (order: string[]): Layout => ({ v: 1, order, pos: Object.fromEntries(order.map(i => [i, pos[i] ?? { x: 0, y: 0 }])), ...(view.current ? { view: view.current } : {}) });
  const run = (fn: () => Promise<VisualResult>, after?: (r: Extract<VisualResult, { ok: true }>) => void) => startT(async () => { const r = await fn(); setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error, conflict: r.conflict }); if (r.ok) after?.(r); });
  const save = () => { if (!compiled.ok) return; run(() => saveVisualAction({ id: wfId, name, definition: compiled.definition, layout: layoutOut(compiled.order), token, basePublished: publishedVersion, proposalId }), r => {
    setSaved(snap(name, graph, pos)); setHasDraft(true); if (r.token) setToken(r.token); if (wipId) { void deleteWipAction(wipId); setWipId(null); }
    if (!wfId && r.id) { setWfId(r.id); router.replace(`/automations/${r.id}${proposalId ? `?proposal=${proposalId}` : ''}`); } }); };
  const saveWip = () => startT(async () => { const r = await saveWipAction({ id: wipId, workflowId: wfId, name, graph: { nodes: graph.nodes, edges: graph.edges, pos } }); if (r.ok) { setWipId(r.id); setMsg({ ok: true, text: r.message }); } else setMsg({ ok: false, text: r.error }); });
  const publish = (enable: boolean) => { if (wfId) run(() => publishVisualAction(wfId, enable, proposalId), () => { setToken('none'); setHasDraft(false); router.refresh(); }); };
  const addable = actionsFor(trig?.event ?? '').filter(a => a !== 'wait');
  const hasCond = graph.nodes.some(n => n.kind === 'condition');
  const canPub = !!wfId && !dirty && hasDraft && compiled.ok && !pending;

  return <div className="stack" style={{ gap: 12 }}>
    {banner && <p className="notice" role="note">{banner}</p>}
    <div className="studio-bar">
      <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="wf-name" className="sr-only">Automation name</label><input id="wf-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label="Automation name" /></div>
      <button type="button" className="btn" disabled={!h.past.length} onClick={undoRedo.undo} aria-keyshortcuts="Control+Z">Undo</button>
      <button type="button" className="btn" disabled={!h.future.length} onClick={undoRedo.redo} aria-keyshortcuts="Control+Shift+Z">Redo</button>
      <button type="button" className="btn" onClick={tidy}>Tidy layout</button>
      <button type="button" className="btn primary" disabled={pending || !compiled.ok || !dirty} onClick={save}>Save draft</button>
      <button type="button" className="btn" disabled={pending || graph.nodes.length === 0} onClick={saveWip} title="Keeps an incomplete canvas. It cannot run or be published.">{wipId ? 'Update unfinished work' : 'Save unfinished work'}</button>
      <span className={`save-state ${dirty ? 'dirty' : 'clean'}`} role="status">{dirty ? 'Unsaved changes' : hasDraft ? 'Draft saved (not live)' : publishedVersion ? 'No changes' : 'Saved'}{!compiled.ok ? ' · has problems (not publishable)' : ''}{wipId ? ' · unfinished copy saved' : ''}</span>
    </div>

    <div className="studio">
      <aside className="studio-pane" aria-label="Step palette">
        <h2>Add a step</h2>
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>Drag onto the canvas, or press Add. New steps go after the selected step.</p>
        {[{ kind: 'condition', label: 'Condition (only if…)', off: hasCond || !trig }, { kind: 'delay', label: 'Wait / delay', off: !trig }, ...addable.map(a => ({ kind: 'action', type: a, label: ACTION_LABEL[a], off: false }))].map(p => <div key={`${p.kind}${(p as { type?: string }).type ?? ''}`} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
          <div className="palette-item" draggable={!p.off} aria-disabled={p.off} style={p.off ? { opacity: .5, cursor: 'not-allowed' } : undefined}
            onDragStart={e => { e.dataTransfer.setData('application/x-optizen-node', JSON.stringify({ kind: p.kind, type: (p as { type?: string }).type })); e.dataTransfer.effectAllowed = 'copy'; }}>{p.label}</div>
          <button type="button" className="btn" disabled={p.off} aria-label={`Add ${p.label}`} onClick={() => { const n = fromPayload(JSON.stringify({ kind: p.kind, type: (p as { type?: string }).type })); if (n) insert(n); }}>Add</button></div>)}
      </aside>

      <section aria-label="Canvas" className="stack" style={{ gap: 8 }}>
        <WorkflowCanvas graph={graph} pos={pos} view={first.view ?? null} issues={issues} selected={sel} titles={titles} onSelect={setSel}
          onMove={(i, p) => edit({ graph, pos: { ...pos, [i]: p } }, `drag:${i}`)} onMoveEnd={() => setH(c => seal(c))}
          onConnect={(a, b) => setGraph(connect(graph, a, b))} onView={v => { view.current = v; }}
          onDropNew={(payload, at) => { const n = fromPayload(payload); if (n) insert(n, { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 }); }} onDelete={del} onNudge={nudge} onUndo={undoRedo.undo} onRedo={undoRedo.redo} />
        <div aria-live="polite">
          {!compiled.ok && <div role="alert" className="err"><strong>Fix before saving:</strong><ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{compiled.issues.map((i, k) => <li key={k}>{i.nodeId ? <button type="button" className="btn" style={{ padding: '0 8px', marginRight: 6 }} onClick={() => setSel({ kind: 'node', id: i.nodeId! })}>Show</button> : null}{i.message}</li>)}</ul></div>}
          {compiled.ok && <div><strong>What this will do</strong><ol style={{ margin: '4px 0 0', paddingLeft: 20 }}>{describeAutomation(compiled.definition, who).map(l => <li key={l}>{l.replace(/^\d+\. /, '')}</li>)}</ol></div>}
        </div>
      </section>

      <aside className="studio-pane" aria-label="Properties">
        <h2>{sel?.kind === 'edge' ? 'Connection' : selNode ? 'Step properties' : 'Automation'}</h2>
        {sel?.kind === 'edge' && <><p className="muted">This connection decides the order the steps run in.</p><button type="button" className="btn" onClick={del}>Remove connection</button></>}
        {!sel && <p className="muted">Select a step to edit it. Steps run in the order they are connected, top to bottom of the chain. The engine runs one sequence: no branches or loops, so the canvas does not offer them.</p>}
        {selNode && <>
          {issues[selNode.id] && <p className="err" role="alert">{issues[selNode.id]}</p>}
          {selNode.kind === 'trigger' && <>
            <div className="field"><label htmlFor="p-trig">When</label><select id="p-trig" className="input" value={selNode.event} onChange={e => { const ev = e.target.value, sc = scopeOf(ev); setNode({ ...selNode, event: ev, object: sc === 'record' ? (modules[0]?.key ?? undefined) : undefined }); }}>{TRIGGERS.map(t => <option key={t.event} value={t.event}>{t.label}</option>)}</select></div>
            {scope === 'record' && <div className="field"><label htmlFor="p-mod">In module</label><select id="p-mod" className="input" value={selNode.object ?? ''} onChange={e => setNode({ ...selNode, object: e.target.value || undefined })}><option value="">Any module</option>{modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select></div>}
            {(() => { const t = TRIGGERS.find(x => x.event === selNode.event); return t && 'module' in t ? <p className="muted">Needs the {t.module} module enabled in the Builder before publishing.</p> : null; })()}
            <p className="muted">Changing the trigger can make later steps invalid; they are flagged on the canvas.</p></>}
          {selNode.kind === 'condition' && <ConditionsEditor op={selNode.op} conditions={selNode.conditions} fieldOptions={fieldOptions} onChange={(op, conditions) => setNode({ ...selNode, op, conditions })} />}
          {(selNode.kind === 'action' || selNode.kind === 'delay') && <>
            {selNode.kind === 'action' && <div className="field"><label htmlFor="p-type">Action</label><select id="p-type" className="input" value={selNode.action.type} onChange={e => setNode({ ...selNode, action: blankAction(e.target.value as never) as never })}>{addable.concat(!addable.includes(selNode.action.type as never) ? [selNode.action.type as never] : []).map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}</select></div>}
            <ActionFields a={selNode.action as Action} onChange={a => setNode({ ...selNode, action: a } as GraphNode)} scope={scope} object={trig?.object} modules={modules} members={members} fieldOptions={fieldOptions} /></>}
          {selNode.kind !== 'trigger' && <div className="stack" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 6 }}>
              {selNode.kind !== 'condition' && <><button type="button" className="btn" disabled={moveInChain(graph, selNode.id, -1) === graph} onClick={() => setGraph(moveInChain(graph, selNode.id, -1))}>Move earlier</button>
                <button type="button" className="btn" disabled={moveInChain(graph, selNode.id, 1) === graph} onClick={() => setGraph(moveInChain(graph, selNode.id, 1))}>Move later</button></>}
              <button type="button" className="btn" onClick={del}>Delete step</button></div>
          </div>}
          <div className="field"><label htmlFor="p-next">Next step</label>
            <select id="p-next" className="input" value={graph.edges.find(e => e.from === selNode.id)?.to ?? ''} onChange={e => { const cur = graph.edges.find(x => x.from === selNode.id); let g = cur ? removeEdge(graph, cur) : graph; if (e.target.value) { const ok = canConnect(g, selNode.id, e.target.value); if (!ok.ok) { setMsg({ ok: false, text: ok.reason }); return; } g = connect(g, selNode.id, e.target.value); } setGraph(g); }}>
              <option value="">(none, last step)</option>{graph.nodes.filter(n => n.id !== selNode.id).map(n => { const cur = graph.edges.find(x => x.from === selNode.id)?.to === n.id; return <option key={n.id} value={n.id} disabled={!cur && !canConnect(graph, selNode.id, n.id).ok}>{titles[n.id]?.kind}: {titles[n.id]?.title}</option>; })}</select>
            <span className="hint">The keyboard way to connect steps. Options that would branch, loop or put a condition after an action are disabled.</span></div>
        </>}
      </aside>
    </div>

    <div className="studio-pane" aria-label="Publish">
      <h2>Publish</h2>
      <p className="muted" style={{ margin: 0 }}>{publishedVersion ? `Version ${publishedVersion} is ${enabled ? 'live and enabled' : 'published but disabled'}. Publishing makes the saved draft a new immutable version; runs in progress keep their version.` : 'Save a draft, review it, then publish. Only events after you enable it are processed.'}</p>
      <div className="row">
        <button type="button" className="btn primary" disabled={!canPub} onClick={() => { if (confirm('Publish and ENABLE this automation? It will run for new events.')) publish(true); }}>Publish and enable</button>
        <button type="button" className="btn" disabled={!canPub} onClick={() => publish(false)}>Publish (keep disabled)</button>
        {wfId && publishedVersion && <button type="button" className="btn" disabled={pending} onClick={() => run(() => setEnabledAction(wfId, !enabled) as Promise<VisualResult>, () => router.refresh())}>{enabled ? 'Disable' : 'Enable'}</button>}
        {wfId && hasDraft && <button type="button" className="btn" disabled={pending} onClick={() => { if (confirm('Discard the saved draft?')) run(() => discardAutomationDraftAction(wfId) as Promise<VisualResult>); }}>Discard draft</button>}
      </div>
      {dirty && <p className="muted">Save the draft to enable publishing.</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.conflict && <button type="button" className="btn" onClick={() => location.reload()}>Reload latest</button>}</p>}
    </div>
  </div>;
}

function describeNode(n: GraphNode, who: (id: string) => string): { kind: string; title: string; sub: string } {
  if (n.kind === 'trigger') { const t = TRIGGERS.find(x => x.event === n.event); return { kind: 'Trigger', title: (t?.label ?? n.event), sub: n.object ? `in “${n.object}”` : 'starts the automation' }; }
  if (n.kind === 'condition') return { kind: 'Condition', title: n.conditions.length ? `${n.conditions.length} test${n.conditions.length === 1 ? '' : 's'} (${n.op === 'or' ? 'any' : 'all'} must match)` : 'No tests yet', sub: 'checked once, before the actions' };
  const a = n.action;
  if (a.type === 'wait') return { kind: 'Delay', title: a.minutes ? `Wait ${a.minutes} minute${a.minutes === 1 ? '' : 's'}` : `Wait until ${a.until_field}`, sub: 'then continue' };
  const sub = a.type === 'create_task' ? `“${a.title}”` : a.type === 'notify' ? (a.recipient.length === 36 ? who(a.recipient) : a.recipient.replace('_', ' ')) : a.type === 'assign_lead' ? (a.user_id ? who(a.user_id) : 'choose a person') : a.type === 'update_record' ? `${a.field || '…'} → ${String(a.value)}` : a.type === 'request_integration' ? a.channel : '';
  return { kind: 'Action', title: ACTION_LABEL[a.type], sub };
}
