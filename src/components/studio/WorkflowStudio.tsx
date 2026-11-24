'use client';
// Visual workflow editor. Edits a graph that compiles to the SAME AutomationDefinition the list editor and the AI produce; it is saved with
// saveVisualAction (validated again server- and database-side) and published through automation_publish like any other automation.
// This file is layout and interaction only: grammar, validation, permissions, save/publish lifecycle and the execution engine are unchanged.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ACTION_LABEL, TRIGGERS, scopeOf, type Action, type ActionType, type AutomationDefinition } from '../../lib/automation/types';
import { NODE_H, actionsFor, addNode, blankAction, chainOf, connect, definitionToGraph, graphToDefinition, isLegacyRow, moveInChain, nextId, relayout, removeEdge, removeNode, updateNode, canConnect, type Graph, type GraphNode, type Layout, type WaitAction } from '../../lib/builder/workflowGraph';
import { describeStep, issueMap, problemsOf, summarize } from '../../lib/builder/workflowText';
import { commit, history, redo, seal, undo, type History } from '../../lib/builder/history';
import { WorkflowCanvas, type Selection } from './WorkflowCanvas';
import { PreviewPanel } from './PreviewPanel';
import { AiDraftPanel } from './AiDraftPanel';
import { Dialog } from '../ui/Dialog';
import { ActionFields, ConditionsEditor, fieldOptionsFor, type MemberOption, type ModuleOption } from '../automation/fields';
import { discardAutomationDraftAction, setEnabledAction } from '../../app/(app)/automations/actions';
import { deleteWipAction, publishVisualAction, saveVisualAction, saveWipAction, type VisualResult } from '../../app/(app)/automations/visual-actions';

type E = { graph: Graph; pos: Layout['pos'] };
type Panel = 'props' | 'preview' | 'ai' | null;
const START: AutomationDefinition = { trigger: { event: 'lead.created' }, actions: [{ type: 'assign_round_robin' }, { type: 'create_task', title: 'Call {{lead.full_name}}', due_in_days: 1, owner: 'lead_assignee' }] };
const HELP: Record<string, string> = {
  condition: 'Only continue if something about the event is true. If not, nothing else happens.', delay: 'Pause for a while, then carry on with the next step.',
  assign_round_robin: 'Give the lead to the next person in turn, so work is shared fairly.', assign_lead: 'Always give the lead to one chosen person.', create_task: 'Add a to-do for someone, with a due date.',
  update_task_status: 'Mark the task done or reopen it.', update_record: 'Change a field on the record that started this.', notify: 'Send a message inside Optizen to a team member.', request_integration: 'Ask for a WhatsApp, SMS, email or webhook message (recorded only until a provider is connected).',
};

export function WorkflowStudio({ id, name: initName, enabled, publishedVersion, draft, published, initial, layout, token: initToken, modules, members, proposalId, banner, aiAvailable = false, wip = null }: {
  id: string | null; name: string; enabled: boolean; publishedVersion: number | null; draft: AutomationDefinition | null; published: AutomationDefinition | null; initial: AutomationDefinition | null; layout: Layout | null; token: string | null;
  modules: ModuleOption[]; members: MemberOption[]; proposalId: string | null; banner: string | null; aiAvailable?: boolean; wip?: { id: string; name: string; graph: Graph; pos: Layout['pos'] } | null;
}) {
  const router = useRouter();
  const [first] = useState(() => {
    const f = wip ? { graph: wip.graph, pos: wip.pos, view: undefined } : definitionToGraph(draft ?? published ?? initial ?? START, layout);
    const ids = chainOf(f.graph).chain.map(n => n.id);
    return isLegacyRow(ids, f.pos) ? { ...f, pos: relayout(f.graph, f.pos) } : f; // the old default was one wide row that could not be read at any zoom
  });
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

  // ----- workspace chrome: collapsible docks, full screen -----
  const root = useRef<HTMLDivElement>(null);
  const [libOpen, setLibOpen] = useState(false); const [panel, setPanel] = useState<Panel>(null); const [expanded, setExpanded] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false); const [publishOpen, setPublishOpen] = useState(false); const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [insertAfter, setInsertAfter] = useState<string | null>(null);
  useEffect(() => { /* the summary shows up to three lines; Show all expands it */ }, []);
  useEffect(() => { document.body.style.overflow = expanded ? 'hidden' : ''; return () => { document.body.style.overflow = ''; }; }, [expanded]);
  useEffect(() => { // Esc leaves full screen (the browser handles Esc itself when native full screen is active)
    if (!expanded) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input,select,textarea,dialog')) { setExpanded(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); } };
    addEventListener('keydown', k); return () => removeEventListener('keydown', k);
  }, [expanded]);
  useEffect(() => { const f = () => { if (!document.fullscreenElement) setExpanded(false); }; document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);
  const toggleExpanded = async () => {
    const next = !expanded; setExpanded(next);
    try { if (next && root.current?.requestFullscreen) await root.current.requestFullscreen(); else if (!next && document.fullscreenElement) await document.exitFullscreen(); } catch { /* the in-page full screen still works where the browser refuses */ }
  };

  // ----- derived model -----
  const compiled = useMemo(() => graphToDefinition(graph), [graph]);
  const who = (uid: string) => members.find(m => m.id === uid)?.email ?? uid.slice(0, 8);
  const trig = graph.nodes.find((n): n is Extract<GraphNode, { kind: 'trigger' }> => n.kind === 'trigger');
  const scope = trig ? scopeOf(trig.event) : 'none';
  const fieldOptions = useMemo(() => fieldOptionsFor(scope, trig?.object, modules), [scope, trig?.object, modules]);
  const label = useMemo(() => (path: string) => fieldOptions.find(([k]) => k === path)?.[1] ?? path.replace(/^[a-z]+\./, '').replace(/_/g, ' '), [fieldOptions]);
  const problems = useMemo(() => problemsOf(graph, label), [graph, label]);
  const issues = useMemo(() => issueMap(problems), [problems]);
  const canSave = compiled.ok && problems.length === 0;
  const snap = (n: string, g: Graph, p: Layout['pos']) => JSON.stringify([n, g, p]);
  const [saved, setSaved] = useState(() => snap(initName || 'New lead follow-up', first.graph, first.pos));
  const dirty = snap(name, graph, pos) !== saved || (!wfId);
  const selNode = sel?.kind === 'node' ? graph.nodes.find(n => n.id === sel.id) ?? null : null;
  const chain = useMemo(() => chainOf(graph).chain, [graph]);
  const order = useMemo(() => chain.map(n => n.id), [chain]);
  const titles = useMemo(() => Object.fromEntries(graph.nodes.map(n => [n.id, describeStep(n, who, label)])), [graph.nodes, members, label]); // eslint-disable-line react-hooks/exhaustive-deps
  const summary = useMemo(() => summarize(graph, who, label), [graph, members, label]); // eslint-disable-line react-hooks/exhaustive-deps
  const sumP = useRef<HTMLParagraphElement>(null); const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => { // "Show all" is offered only when the text is actually cut off
    const el = sumP.current; if (!el) return; const measure = () => { if (!summaryOpen) setClipped(el.scrollHeight > el.clientHeight + 1); };
    measure(); addEventListener('resize', measure); return () => removeEventListener('resize', measure);
  }, [summary?.text, summaryOpen, expanded]);

  // ----- edits -----
  const edit = (next: E, key: string | null = null) => setH(c => commit(c, next, key));
  const restack = (g: Graph, key: string | null = null) => edit({ graph: g, pos: relayout(g, pos) }, key); // structure changed: steps re-stack in run order
  const stepIdx = (nid: string) => order.indexOf(nid) + 1;
  const selectNode = (nid: string) => { setSel({ kind: 'node', id: nid }); setPanel('props'); };
  const insert = (n: GraphNode, afterOverride?: string | null) => {
    let after = n.kind === 'condition' ? trig?.id : (afterOverride ?? insertAfter) ?? (selNode ? selNode.id : chain[chain.length - 1]?.id);
    const cond = graph.nodes.find(x => x.kind === 'condition'); if (n.kind !== 'condition' && after === trig?.id && cond) after = cond.id; // nothing may sit between the trigger and its condition: the first action goes after it
    const g = addNode(graph, n, after); if (g === graph) { setMsg({ ok: false, text: n.kind === 'condition' ? 'A condition goes directly after the trigger, and there can be only one.' : 'That step cannot be added there.' }); return; }
    edit({ graph: g, pos: relayout(g, pos) }); setInsertAfter(null); selectNode(n.id); setMsg(undefined);
  };
  const fromPayload = (payload: string): GraphNode | null => {
    try { const p = JSON.parse(payload) as { kind: string; type?: string }; const id2 = nextId(graph);
      if (p.kind === 'condition' && !graph.nodes.some(n => n.kind === 'condition')) return { id: id2, kind: 'condition', op: 'and', conditions: fieldOptions[0] ? [{ field: fieldOptions[0][0], op: 'eq', value: '' }] : [] };
      if (p.kind === 'delay') return { id: id2, kind: 'delay', action: blankAction('wait') as WaitAction };
      if (p.kind === 'action' && p.type && actionsFor(trig?.event ?? '').includes(p.type as never)) return { id: id2, kind: 'action', action: blankAction(p.type as never) as never };
    } catch { /* ignore malformed drag data */ } return null;
  };
  const addFromLibrary = (kind: string, type?: string) => { const n = fromPayload(JSON.stringify({ kind, type })); if (n) insert(n); };
  const tidy = () => edit({ graph, pos: relayout(graph, {}) });
  const del = () => { if (sel?.kind === 'node') { const g = removeNode(graph, sel.id); if (g !== graph) { restack(g); setSel(null); setPanel(p => (p === 'props' ? null : p)); } } else if (sel?.kind === 'edge') { restack(removeEdge(graph, sel)); setSel(null); } };
  const nudge = (dx: number, dy: number) => { if (sel?.kind === 'node') { const p = pos[sel.id] ?? { x: 0, y: 0 }; edit({ graph, pos: { ...pos, [sel.id]: { x: p.x + dx, y: p.y + dy } } }, `nudge:${sel.id}`); } };
  const setNode = (n: GraphNode) => edit({ graph: updateNode(graph, n), pos }, `edit:${n.id}`);
  const undoRedo = { undo: () => setH(c => undo(seal(c))), redo: () => setH(c => redo(c)) };
  const dropAfter = (y: number) => { const above = chain.filter(n => (pos[n.id]?.y ?? 0) + NODE_H / 2 < y); return above[above.length - 1]?.id ?? trig?.id ?? null; };

  const layoutOut = (ord: string[]): Layout => ({ v: 1, order: ord, pos: Object.fromEntries(ord.map(i => [i, pos[i] ?? { x: 0, y: 0 }])), ...(view.current ? { view: view.current } : {}) });
  const run = (fn: () => Promise<VisualResult>, after?: (r: Extract<VisualResult, { ok: true }>) => void) => startT(async () => { const r = await fn(); setMsg(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error, conflict: r.conflict }); if (r.ok) after?.(r); });
  const save = () => { if (!compiled.ok || !canSave) return; run(() => saveVisualAction({ id: wfId, name, definition: compiled.definition, layout: layoutOut(compiled.order), token, basePublished: publishedVersion, proposalId }), r => {
    setSaved(snap(name, graph, pos)); setHasDraft(true); if (r.token) setToken(r.token); if (wipId) { void deleteWipAction(wipId); setWipId(null); }
    if (!wfId && r.id) { setWfId(r.id); router.replace(`/automations/${r.id}${proposalId ? `?proposal=${proposalId}` : ''}`); } }); };
  const saveWip = () => startT(async () => { const r = await saveWipAction({ id: wipId, workflowId: wfId, name, graph: { nodes: graph.nodes, edges: graph.edges, pos } }); if (r.ok) { setWipId(r.id); setMsg({ ok: true, text: r.message }); } else setMsg({ ok: false, text: r.error }); });
  const publish = (enable: boolean) => { if (wfId) run(() => publishVisualAction(wfId, enable, proposalId), () => { setToken('none'); setHasDraft(false); setPublishOpen(false); router.refresh(); }); };
  const addable = actionsFor(trig?.event ?? '').filter(a => a !== 'wait');
  const hasCond = graph.nodes.some(n => n.kind === 'condition');
  const canPub = !!wfId && !dirty && hasDraft && canSave && !pending;
  const insertTarget = insertAfter ? titles[insertAfter] : null;
  const status = dirty ? 'Unsaved changes' : hasDraft ? 'Draft saved (not live)' : publishedVersion ? (enabled ? `Live · version ${publishedVersion}` : `Version ${publishedVersion} (disabled)`) : 'Saved';
  const toggleBtn = (text: string, on: boolean, click: () => void, ctl: string) => <button type="button" className="btn" aria-pressed={on} aria-controls={ctl} onClick={click}>{text}</button>;
  const libItems: { key: string; kind: string; type?: ActionType; title: string; help: string; off?: string }[] = [
    { key: 'cond', kind: 'condition', title: 'Only continue if…', help: HELP.condition!, off: !trig ? 'Choose a trigger first' : hasCond ? 'Already added (one per automation)' : undefined },
    ...addable.map(a => ({ key: a, kind: 'action', type: a, title: ACTION_LABEL[a], help: HELP[a] ?? '' })),
    { key: 'delay', kind: 'delay', title: 'Wait / delay', help: HELP.delay!, off: !trig ? 'Choose a trigger first' : undefined },
  ];

  return <div ref={root} className={`wfs-root${expanded ? ' expanded' : ''}`} data-expanded={expanded}>
    {banner && <p className="notice" role="note" style={{ margin: 0 }}>{banner}</p>}
    <div className="wfs-bar" role="toolbar" aria-label="Automation toolbar">
      <div className="wfs-name"><label htmlFor="wf-name" className="sr-only">Automation name</label><input id="wf-name" className="input" value={name} maxLength={80} onChange={e => setName(e.target.value)} aria-label="Automation name" /></div>
      <span className={`save-state ${dirty ? 'dirty' : 'clean'}`} role="status">{status}</span>
      <div className="wfs-group wfs-end">
        <button type="button" className="btn ph-hide" aria-pressed={panel === 'ai'} aria-controls="wfs-right" onClick={() => setPanel(p => (p === 'ai' ? null : 'ai'))}>Ask Optizen AI</button>
        <button type="button" className="btn ph-hide" aria-pressed={panel === 'preview'} aria-controls="wfs-right" onClick={() => setPanel(p => (p === 'preview' ? null : 'preview'))}>Preview</button>
        <button type="button" className="btn primary" disabled={pending || !canSave || !dirty} onClick={save}>Save draft</button>
        <button type="button" className="btn ph-hide" onClick={() => setPublishOpen(true)} disabled={!wfId && !hasDraft && !publishedVersion}>Publish</button>
        <details className="wfs-more"><summary className="btn" aria-label="More actions">More</summary><div className="wfs-menu">
          <button type="button" className="btn ph-only" aria-pressed={panel === 'preview'} onClick={() => setPanel(p => (p === 'preview' ? null : 'preview'))}>Preview</button>
          <button type="button" className="btn ph-only" aria-pressed={panel === 'ai'} onClick={() => setPanel(p => (p === 'ai' ? null : 'ai'))}>Ask Optizen AI</button>
          <button type="button" className="btn ph-only" onClick={() => setPublishOpen(true)} disabled={!wfId && !hasDraft && !publishedVersion}>Publish</button>
          <button type="button" className="btn ph-only" disabled={!h.past.length} onClick={undoRedo.undo}>Undo</button>
          <button type="button" className="btn ph-only" disabled={!h.future.length} onClick={undoRedo.redo}>Redo</button>
          <button type="button" className="btn" onClick={tidy}>Re-stack steps</button>
          <button type="button" className="btn" disabled={pending || graph.nodes.length === 0} onClick={saveWip} title="Keeps an incomplete canvas. It cannot run or be published.">{wipId ? 'Update unfinished work' : 'Save unfinished work'}</button></div></details>
        <button type="button" className="btn ph-hide" aria-pressed={expanded} onClick={toggleExpanded}>{expanded ? 'Exit full screen' : 'Full screen'}</button>
      </div>
    </div>

    {problems.length > 0 && <section className="wfs-problems" aria-label="Problems to fix" aria-live="polite"><strong>{problems.length === 1 ? '1 thing to fix before you can save' : `${problems.length} things to fix before you can save`}</strong>
      <ul>{problems.slice(0, 3).map((p, k) => <li key={k}><span>{p.message}{p.fix ? <span className="wfs-fix"> {p.fix}</span> : null}</span>{p.nodeId && <button type="button" className="btn" onClick={() => selectNode(p.nodeId!)}>Go to step {stepIdx(p.nodeId) || ''}</button>}</li>)}</ul>
      {problems.length > 3 && <span className="wfs-fix">…and {problems.length - 3} more.</span>}</section>}
    <section className="wfs-summary" aria-label="In plain English"><span className="eyebrow">In plain English</span>
      <p ref={sumP} className={summaryOpen ? '' : 'clamp'}>{summary ? summary.text : 'Add a trigger to begin.'}</p>
      {summary && (clipped || summaryOpen) && <button type="button" className="wfs-link" aria-expanded={summaryOpen} onClick={() => setSummaryOpen(o => !o)}>{summaryOpen ? 'Show less' : 'Show all'}</button>}</section>

    <div className={`wfs-main${libOpen ? ' lib' : ''}${panel ? ' right' : ''}`}>
      <aside id="wfs-lib" className="wfs-panel wfs-lib" aria-label="Step library" hidden={!libOpen}>
        <div className="wfs-panel-head"><h2>Add a step</h2><button type="button" className="btn" onClick={() => setLibOpen(false)}>Close</button></div>
        <p className="muted wfs-lib-help">{insertTarget ? <>New steps go after <strong>{insertTarget.title}</strong>. <button type="button" className="btn" onClick={() => setInsertAfter(null)}>Cancel</button></> : 'Pick a step to add it after the selected one. You can also drag a step onto the canvas.'}</p>
        {libItems.map(p => <button key={p.key} type="button" className="wfs-item" disabled={!!p.off} draggable={!p.off} onClick={() => addFromLibrary(p.kind, p.type)}
          onDragStart={e => { e.dataTransfer.setData('application/x-optizen-node', JSON.stringify({ kind: p.kind, type: p.type })); e.dataTransfer.effectAllowed = 'copy'; }}><strong>{p.title}</strong><span>{p.off ?? p.help}</span></button>)}
      </aside>

      <section aria-label="Canvas" className="wfs-canvas">
        <WorkflowCanvas tools={<>
          {toggleBtn('Steps', libOpen, () => setLibOpen(o => !o), 'wfs-lib')}
          {selNode && <button type="button" className="btn ph-hide" aria-pressed={panel === 'props'} aria-controls="wfs-right" onClick={() => setPanel(p => (p === 'props' ? null : 'props'))}>Step details</button>}
          <button type="button" className="btn ph-hide" disabled={!h.past.length} onClick={undoRedo.undo} aria-keyshortcuts="Control+Z">Undo</button>
          <button type="button" className="btn ph-hide" disabled={!h.future.length} onClick={undoRedo.redo} aria-keyshortcuts="Control+Shift+Z">Redo</button>
          <button type="button" className="btn ph-only" aria-pressed={expanded} onClick={toggleExpanded}>{expanded ? 'Exit full screen' : 'Full screen'}</button></>} graph={graph} pos={pos} issues={issues} selected={sel} titles={titles} order={order} onSelect={s => { setSel(s); if (s?.kind === 'node') setPanel('props'); else if (s?.kind === 'edge') setPanel('props'); else setPanel(p => (p === 'props' ? null : p)); }}
          onFocusNode={nid => setSel({ kind: 'node', id: nid })}
          onMove={(i, p) => edit({ graph, pos: { ...pos, [i]: p } }, `drag:${i}`)} onMoveEnd={() => setH(c => seal(c))}
          onConnect={(a, b) => restack(connect(graph, a, b))} onView={v => { view.current = v; }}
          onDropNew={(payload, at) => { const n = fromPayload(payload); if (n) insert(n, dropAfter(at.y)); }} onDelete={del} onNudge={nudge} onUndo={undoRedo.undo} onRedo={undoRedo.redo}
          onInsertAfter={nid => { setInsertAfter(nid); setLibOpen(true); setPanel(p => (p === 'props' ? null : p)); }} />
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`wfs-msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text} {msg.conflict && <button type="button" className="btn" onClick={() => location.reload()}>Reload latest</button>} <button type="button" className="btn" aria-label="Dismiss message" onClick={() => setMsg(undefined)}>×</button></p>}
      </section>

      <aside id="wfs-right" className="wfs-panel wfs-right" aria-label={panel === 'preview' ? 'Preview' : panel === 'ai' ? 'Optizen AI' : 'Step details'} hidden={!panel}>
        {panel === 'preview' && <PreviewPanel def={compiled.ok ? compiled.definition : null} fields={fieldOptions} who={who} label={label} onClose={() => setPanel(null)} />}
        {panel === 'ai' && <AiDraftPanel available={aiAvailable} dirty={dirty} onClose={() => setPanel(null)} />}
        {panel === 'props' && <>
          <div className="wfs-panel-head"><h2>{sel?.kind === 'edge' ? 'Connection' : selNode ? `Step ${stepIdx(selNode.id) || ''} details` : 'Step details'}</h2><button type="button" className="btn" onClick={() => setPanel(null)}>Close</button></div>
          {sel?.kind === 'edge' && <><p className="muted">This line decides the order the steps run in.</p><button type="button" className="btn" onClick={del}>Remove connection</button></>}
          {!sel && <p className="muted">Select a step on the canvas to edit it. Steps run top to bottom, one after another. There are no branches or loops.</p>}
          {selNode && <>
            {issues[selNode.id] && selNode.kind !== 'condition' && <p className="err" role="alert">{issues[selNode.id]}</p>}
            {selNode.kind === 'trigger' && <>
              <div className="field"><label htmlFor="p-trig">When this happens</label><select id="p-trig" className="input" value={selNode.event} onChange={e => { const ev = e.target.value, sc = scopeOf(ev); setNode({ ...selNode, event: ev, object: sc === 'record' ? (modules[0]?.key ?? undefined) : undefined }); }}>{TRIGGERS.map(t => <option key={t.event} value={t.event}>{t.label}</option>)}</select></div>
              {scope === 'record' && <div className="field"><label htmlFor="p-mod">In module</label><select id="p-mod" className="input" value={selNode.object ?? ''} onChange={e => setNode({ ...selNode, object: e.target.value || undefined })}><option value="">Any module</option>{modules.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}</select></div>}
              {(() => { const t = TRIGGERS.find(x => x.event === selNode.event); return t && 'module' in t ? <p className="muted">Needs the {t.module} module enabled in the Builder before publishing.</p> : null; })()}
              <p className="muted">Changing the trigger can make later steps invalid; they are flagged on the canvas.</p></>}
            {selNode.kind === 'condition' && <>
              <p className="muted">Only continue if this is true. If it is not, the automation stops and nothing else happens.</p>
              <ConditionsEditor op={selNode.op} conditions={selNode.conditions} fieldOptions={fieldOptions} onChange={(op, conditions) => setNode({ ...selNode, op, conditions })}
                errors={Object.fromEntries(selNode.conditions.map((c, i) => [i, c.op !== 'empty' && c.op !== 'not_empty' && String(c.value ?? '').trim() === '' ? 'Enter a value to compare with, or choose “is empty”.' : ''] as const).filter(([, m]) => m))} />
              {selNode.conditions.length === 0 && issues[selNode.id] && <p className="err" role="alert">{issues[selNode.id]}</p>}</>}
            {(selNode.kind === 'action' || selNode.kind === 'delay') && <>
              {selNode.kind === 'action' && <div className="field"><label htmlFor="p-type">What should happen</label><select id="p-type" className="input" value={selNode.action.type} onChange={e => setNode({ ...selNode, action: blankAction(e.target.value as never) as never })}>{addable.concat(!addable.includes(selNode.action.type as never) ? [selNode.action.type as never] : []).map(a => <option key={a} value={a}>{ACTION_LABEL[a]}</option>)}</select></div>}
              <ActionFields a={selNode.action as Action} onChange={a => setNode({ ...selNode, action: a } as GraphNode)} scope={scope} object={trig?.object} modules={modules} members={members} fieldOptions={fieldOptions} /></>}
            {selNode.kind !== 'trigger' && <div className="row">
              {selNode.kind !== 'condition' && <><button type="button" className="btn" disabled={moveInChain(graph, selNode.id, -1) === graph} onClick={() => restack(moveInChain(graph, selNode.id, -1))}>Move earlier</button>
                <button type="button" className="btn" disabled={moveInChain(graph, selNode.id, 1) === graph} onClick={() => restack(moveInChain(graph, selNode.id, 1))}>Move later</button></>}
              <button type="button" className="btn" onClick={del}>Delete step</button></div>}
            <details className="wfs-adv"><summary>Advanced: change the connection</summary>
              <div className="field"><label htmlFor="p-next">Next step</label>
                <select id="p-next" className="input" value={graph.edges.find(e => e.from === selNode.id)?.to ?? ''} onChange={e => { const cur = graph.edges.find(x => x.from === selNode.id); let g = cur ? removeEdge(graph, cur) : graph; if (e.target.value) { const ok = canConnect(g, selNode.id, e.target.value); if (!ok.ok) { setMsg({ ok: false, text: ok.reason }); return; } g = connect(g, selNode.id, e.target.value); } restack(g); }}>
                  <option value="">(none, last step)</option>{graph.nodes.filter(n => n.id !== selNode.id).map(n => { const cur = graph.edges.find(x => x.from === selNode.id)?.to === n.id; return <option key={n.id} value={n.id} disabled={!cur && !canConnect(graph, selNode.id, n.id).ok}>{titles[n.id]?.kind}: {titles[n.id]?.title}</option>; })}</select>
                <span className="hint">Options that would branch, loop or put a condition after an action are disabled.</span></div></details>
          </>}
        </>}
      </aside>
    </div>

    <Dialog open={publishOpen} onClose={() => { setPublishOpen(false); setConfirmDiscard(false); }} label="Publish this automation">
      <h2>Publish</h2>
      <p className="muted" style={{ margin: 0 }}>{publishedVersion ? `Version ${publishedVersion} is ${enabled ? 'live and enabled' : 'published but disabled'}. Publishing makes the saved draft a new immutable version; runs in progress keep their version.` : 'Save a draft, review it, then publish. Only events after you enable it are processed.'}</p>
      {dirty && <p className="notice" role="note">Save the draft first. Only a saved draft can be published.</p>}
      {!canSave && <p className="err" role="alert">Fix the problems on the canvas first.</p>}
      <div className="row">
        <button type="button" className="btn primary" disabled={!canPub} onClick={() => publish(true)}>Publish and enable</button>
        <button type="button" className="btn" disabled={!canPub} onClick={() => publish(false)}>Publish (keep disabled)</button>
        {wfId && publishedVersion && <button type="button" className="btn" disabled={pending} onClick={() => run(() => setEnabledAction(wfId, !enabled) as Promise<VisualResult>, () => { setPublishOpen(false); router.refresh(); })}>{enabled ? 'Disable' : 'Enable'}</button>}
      </div>
      <p className="muted" style={{ margin: 0 }}>“Publish and enable” makes the automation run for every new matching event.</p>
      {wfId && hasDraft && (confirmDiscard
        ? <div className="row"><span>Discard the saved draft?</span><button type="button" className="btn" disabled={pending} onClick={() => run(() => discardAutomationDraftAction(wfId) as Promise<VisualResult>, () => { setConfirmDiscard(false); setPublishOpen(false); })}>Yes, discard</button><button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>Keep it</button></div>
        : <div><button type="button" className="btn" disabled={pending} onClick={() => setConfirmDiscard(true)}>Discard draft…</button></div>)}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</p>}
      <div className="row"><button type="button" className="btn" onClick={() => { setPublishOpen(false); setConfirmDiscard(false); }}>Close</button></div>
    </Dialog>
  </div>;
}
