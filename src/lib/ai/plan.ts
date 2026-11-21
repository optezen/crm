// Multi-step configuration plans. The assistant describes SEVERAL dependent changes in one structured request; this module validates them as one unit against the
// configuration they would produce (so step 4 may use the module step 1 creates), resolves module/field references by key or label without guessing, infers and checks
// dependencies, and returns normalized steps that the executor (planRun.ts) can apply in order. It reuses the Builder's helpers and validators; it adds no capabilities.
import { diffConfig } from '../workspace/schema.ts';
import type { WorkspaceConfig, ObjectConfig } from '../workspace/types.ts';
import { validateAutomation, describeAutomation } from '../automation/validate.ts';
import { TRIGGERS, opsModuleOf, scopeOf, type AutomationDefinition } from '../automation/types.ts';
import { permDefault, PERM_MODULES, PERM_ACTIONS, SCOPE_MODULES, SCOPES } from '../permissions/defaults.ts';
import { applyOps, resolveField, type FieldSpec, type LayoutSpec, type Op, type PipelineSpec } from './config-ops.ts';
import type { Query, WidgetType } from '../analytics/types.ts';

export const STEP_KINDS = ['module', 'fields', 'layout', 'pipeline', 'ops_module', 'workflow', 'dashboard', 'role'] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const CONFIG_KINDS: readonly StepKind[] = ['module', 'fields', 'layout', 'pipeline', 'ops_module'];
export type StepInput = { key: string; kind: StepKind; title: string; depends_on?: string[]; args: Record<string, unknown> };
export type NormStep = { key: string; kind: StepKind; title: string; depends_on: string[]; args: Record<string, unknown>; preview: string[]; warnings: string[] };
export type PlanCheck = { ok: true; steps: NormStep[]; config: WorkspaceConfig; diff: string[]; warnings: string[] } | { ok: false; errors: string[] };
export type QueryCheck = { ok: true; definition: string; grouped: number } | { ok: false; error: string };
export type PlanEnv = { base: WorkspaceConfig; live: WorkspaceConfig; validateQuery?: (q: Query) => Promise<QueryCheck> };

const BUILTIN_RECORD_FIELDS = ['created_at', 'created_by'];
const isCore = (k: string) => k === 'overview' || k === 'leads';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export async function checkPlan(env: PlanEnv, input: StepInput[]): Promise<PlanCheck> {
  const errors: string[] = []; let cfg = clone(env.base); const out: NormStep[] = [];
  const keys = new Set<string>(); const moduleOrigin = new Map<string, string>(); const opsOrigin = new Map<string, string>();
  if (!input.length || input.length > 12) return { ok: false, errors: ['A plan has between 1 and 12 steps.'] };
  for (const [i, st] of input.entries()) {
    const at = `Step ${i + 1} (${st.key})`; const deps = new Set<string>(st.depends_on ?? []); const warnings: string[] = []; const preview: string[] = [];
    const fail = (m: string) => { errors.push(`${at}: ${m}`); };
    if (!/^[a-z][a-z0-9_]{0,29}$/.test(st.key) || keys.has(st.key)) { fail('the key must be unique, lowercase letters, digits and underscores.'); continue; }
    for (const d of deps) if (!keys.has(d)) fail(`depends on "${d}", which is not an earlier step.`);
    keys.add(st.key);
    /** Resolves a module reference (a step key, a module key or a label) in the PROJECTED configuration; records the dependency when it points at a module this plan creates. */
    const mod = (ref: unknown, allowCore = false): { key: string; obj: ObjectConfig } | null => {
      const r = String(ref ?? '').trim(); if (!r) { fail('a module is required.'); return null; }
      const fromStep = [...moduleOrigin].find(([, sk]) => sk === r)?.[0];
      const m = cfg.modules.find(x => x.key === (fromStep ?? r)) ?? cfg.modules.find(x => x.label.toLowerCase() === r.toLowerCase());
      if (!m || (!allowCore && isCore(m.key)) || m.status === 'archived') { fail(`the module "${r}" does not exist${m && isCore(m.key) ? ' as a custom module' : ''} (known modules: ${cfg.modules.filter(x => !isCore(x.key) && x.status !== 'archived').map(x => x.label).join(', ') || 'none'}).`); return null; }
      const obj = cfg.objects.find(o => o.key === m.key); if (!obj) { fail(`"${m.label}" has no record type.`); return null; }
      const origin = moduleOrigin.get(m.key); if (origin && origin !== st.key) deps.add(origin);
      return { key: m.key, obj };
    };
    const a = st.args ?? {}; let norm: Record<string, unknown> = a;
    try {
      if ((CONFIG_KINDS as readonly string[]).includes(st.kind)) {
        let op: Op | null = null;
        if (st.kind === 'module') { op = { op: 'add_module', module_label: String(a.module_label ?? ''), fields: a.fields as FieldSpec[] | undefined }; }
        else if (st.kind === 'fields') { const m = mod(a.module); if (m) op = { op: 'add_fields', module_key: m.key, fields: a.fields as FieldSpec[] }; if (m) norm = { module_key: m.key, fields: a.fields }; }
        else if (st.kind === 'layout') { const m = mod(a.module); if (m) { op = { op: 'set_layout', module_key: m.key, layout: a.layout as LayoutSpec }; norm = { module_key: m.key, layout: a.layout }; } }
        else if (st.kind === 'pipeline') { op = { op: 'set_pipeline', pipeline: a.pipeline as PipelineSpec }; }
        else { const k = String(a.module ?? ''); if (!['appointments', 'inventory', 'billing'].includes(k)) fail('module must be appointments, inventory or billing.'); else { op = { op: a.enabled === false ? 'disable_module' : 'enable_module', operations_module: k as 'appointments' }; norm = { module: k, enabled: a.enabled !== false }; if (a.enabled !== false) opsOrigin.set(k, st.key); } }
        if (op) {
          const before = new Set(cfg.modules.map(m => m.key));
          const r = applyOps(cfg, env.live, [op]); if (!r.ok) fail(r.error);
          else {
            cfg = r.value.config;
            if (st.kind === 'module') { const created = cfg.modules.find(m => !before.has(m.key)); if (created) { moduleOrigin.set(created.key, st.key); norm = { module_label: a.module_label, fields: a.fields, module_key: created.key }; preview.push(`Create module “${created.label}” (key ${created.key}) with fields: ${cfg.objects.find(o => o.key === created.key)?.fields.map(f => f.label).join(', ')}`); } }
            else if (st.kind === 'fields') preview.push(`Add fields to ${(norm as { module_key: string }).module_key}: ${((a.fields as FieldSpec[]) ?? []).map(f => f.label).join(', ')}`);
            else if (st.kind === 'layout') preview.push(`Arrange the form of ${(norm as { module_key: string }).module_key}: ${JSON.stringify(a.layout)}`.slice(0, 300));
            else if (st.kind === 'pipeline') { preview.push(`Pipeline stages: ${cfg.pipeline.stages.join(' → ')}`); const removed = env.live.pipeline.stages.filter(s => !cfg.pipeline.stages.includes(s) && !(cfg.pipeline.stageMoves ?? []).some(m => m.from === s)); if (removed.length) warnings.push(`Removing the stage(s) ${removed.join(', ')} is refused at publish if any lead is still in them. Plan a move for them or leave them out.`); }
            else preview.push(`${a.enabled === false ? 'Turn off' : 'Turn on'} the ${a.module} module`);
          }
        }
      } else if (st.kind === 'workflow') {
        const def = clone(a.definition) as AutomationDefinition & { trigger: { event: string; object?: string }; actions: Record<string, unknown>[]; match?: { conditions: { field: string }[] } };
        let obj: ObjectConfig | null = null;
        if (def?.trigger?.object !== undefined) { const m = mod(def.trigger.object); if (m) { def.trigger.object = m.key; obj = m.obj; } }
        else if (def?.trigger && scopeOf(def.trigger.event) === 'record') fail('a record trigger needs "object" (a module).');
        if (obj) {
          for (const c of def.match?.conditions ?? []) if (c.field.startsWith('record.')) { const r = resolveField(obj, c.field.slice(7)); if (!r.ok) fail(r.error); else c.field = `record.${r.value.key}`; }
          for (const x of def.actions ?? []) { if (x.type === 'update_record') { const r = resolveField(obj, String(x.field)); if (!r.ok) fail(r.error); else x.field = r.value.key; } if (x.type === 'wait' && typeof x.until_field === 'string' && x.until_field.startsWith('record.')) { const r = resolveField(obj, x.until_field.slice(7)); if (r.ok) x.until_field = `record.${r.value.key}`; } }
        }
        const v = validateAutomation(def); if (!v.ok) { fail(v.error); }
        else {
          const trig = TRIGGERS.find(t => t.event === v.value.trigger.event); if (!trig?.available) fail(`the trigger "${v.value.trigger.event}" is not available.`);
          const om = opsModuleOf(v.value.trigger.event); if (om) { if (!cfg.operations?.[om]?.enabled) fail(`this trigger needs the ${om} module to be enabled. Add an "ops_module" step for it before this step.`); else { const o = opsOrigin.get(om); if (o) deps.add(o); } }
          for (const x of v.value.actions) if (x.type === 'assign_lead' || (x.type === 'create_task' && UUID.test(x.owner)) || (x.type === 'notify' && UUID.test(x.recipient))) fail('a step may not name a specific person. Use round-robin, "lead_assignee" or "event_actor".');
          norm = { name: String(a.name ?? st.title).slice(0, 80), summary: a.summary, definition: v.value }; preview.push(...describeAutomation(v.value));
          if (v.value.actions.some(x => x.type === 'request_integration')) warnings.push('A message action only records a request unless a provider is connected; nothing is sent automatically by this plan.');
        }
      } else if (st.kind === 'dashboard') {
        const widgets = (a.widgets as { type: WidgetType; title: string; query: Query; w?: number; h?: number }[]) ?? []; const outW: unknown[] = [];
        if (!widgets.length || widgets.length > 12) fail('a dashboard has 1 to 12 widgets.');
        for (const [wi, w] of widgets.entries()) {
          const q = clone(w.query) as Query; let pending = false; const wat = `widget ${wi + 1} (${w.title})`;
          if (typeof q?.source === 'string' && q.source.startsWith('records:')) {
            const m = mod(q.source.slice(8)); if (!m) continue; q.source = `records:${m.key}`; const origin = moduleOrigin.get(m.key); if (origin) pending = true;
            const mapF = (f: string) => { if (BUILTIN_RECORD_FIELDS.includes(f)) return f; const r = resolveField(m.obj, f.replace(/^f_/, '')); if (!r.ok) { fail(`${wat}: ${r.error}`); return f; } if (r.value.kind === 'phone' || r.value.kind === 'email') { fail(`${wat}: "${r.value.label}" is personal data and is not available to dashboards.`); return f; } return `f_${r.value.key}`; };
            if (q.metric?.field) q.metric.field = mapF(q.metric.field); for (const g of q.group_by ?? []) g.field = mapF(g.field); for (const f of q.filters ?? []) f.field = mapF(f.field); if (q.date?.field) q.date.field = mapF(q.date.field);
          } else if (['appointments', 'stock_movements', 'inventory', 'batches', 'invoices', 'payments'].includes(q?.source)) {
            const om = { appointments: 'appointments', stock_movements: 'inventory', inventory: 'inventory', batches: 'inventory', invoices: 'billing', payments: 'billing' }[q.source] as string;
            if (!cfg.operations?.[om as 'billing']?.enabled) fail(`${wat}: the ${om} module is not enabled. Add an "ops_module" step before this step.`); else if (!env.live.operations?.[om as 'billing']?.enabled) { pending = true; const o = opsOrigin.get(om); if (o) deps.add(o); }
          }
          const g = q?.group_by?.length ?? 0, t = w.type;
          if ((t === 'kpi' && g !== 0) || (['bar', 'pie', 'funnel'].includes(t) && g !== 1) || (t === 'line' && (g !== 1 || !q.group_by?.[0]?.bucket)) || (t === 'table' && g > 2)) fail(`${wat}: a ${t} widget has the wrong grouping (kpi 0, line one dated grouping with a bucket, bar/pie/funnel one, table up to two).`);
          let definition = 'checked when the dashboard is created, after the steps it depends on are published';
          if (!pending && env.validateQuery) { const c = await env.validateQuery(q); if (!c.ok) fail(`${wat}: ${c.error}`); else definition = c.definition; } else if (!pending) definition = 'not validated here';
          preview.push(`${w.title} (${t}): ${definition}`); outW.push({ type: t, title: w.title, query: q, w: w.w ?? (t === 'kpi' ? 3 : 6), h: w.h ?? (t === 'kpi' ? 2 : 4) });
        }
        norm = { name: a.name, description: a.description ?? null, visibility: a.visibility === 'organization' ? 'organization' : 'personal', widgets: outW };
      } else if (st.kind === 'role') {
        const base = String(a.base ?? ''); if (!['admin', 'manager', 'employee'].includes(base)) fail('base must be admin, manager or employee.');
        const name = String(a.name ?? '').trim(); if (!name || name.length > 40) fail('the role needs a name of up to 40 characters.');
        const perms: Record<string, Record<string, boolean>> = {}, scopes: Record<string, string> = {};
        for (const d of (a.deny as { module: string; actions: string[] }[]) ?? []) {
          let m = String(d.module); if (!(PERM_MODULES as readonly string[]).includes(m)) { const r = mod(m); if (!r) continue; m = `custom:${r.key}`; }
          for (const act of d.actions ?? []) { if (!(PERM_ACTIONS as readonly string[]).includes(act) || (m === 'contacts' && act !== 'view')) { fail(`"${act}" is not a permission of "${m}".`); continue; } if (permDefault(base, m, act)) (perms[m] ??= {})[act] = false; else warnings.push(`A ${base} role does not have "${act}" on ${m} anyway.`); }
        }
        for (const sc of (a.scopes as { module: string; scope: string }[]) ?? []) {
          let m = String(sc.module); if (!SCOPE_MODULES.includes(m)) { const r = SCOPE_MODULES.includes(m) ? null : mod(m); if (!r) { if (!errors.some(e => e.startsWith(at))) fail(`"${m}" has no visibility setting.`); continue; } m = `custom:${r.key}`; }
          if (!SCOPES.some(([k]) => k === sc.scope)) { fail(`"${sc.scope}" is not a visibility (all, team, assigned, own).`); continue; } scopes[m] = sc.scope;
        }
        norm = { name, base, permissions: perms, scopes }; preview.push(`Create the role “${name}” based on ${base}: ${Object.entries(perms).flatMap(([m, x]) => Object.keys(x).map(k => `no ${k} on ${m}`)).join(', ') || 'no restrictions'}${Object.keys(scopes).length ? `; visibility ${JSON.stringify(scopes)}` : ''}. It is NOT assigned to anyone.`);
      }
    } catch (e) { fail((e as Error).message); }
    out.push({ key: st.key, kind: st.kind, title: st.title, depends_on: [...deps], args: norm, preview, warnings });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, steps: out, config: cfg, diff: diffConfig(env.live, cfg), warnings: out.flatMap(s => s.warnings) };
}
