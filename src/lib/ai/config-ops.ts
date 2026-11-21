// Turns the assistant's structured module requests into a WorkspaceConfig draft using the SAME helpers as the Builder (slug/uniqueKey/validateConfig/diffConfig).
// The model never writes keys or whole configurations: it names labels and kinds; keys, validation and the diff come from here.
import { FIELD_KINDS, type FieldConfig, type FieldKind, type ObjectConfig, type Result, type WorkspaceConfig } from '../workspace/types.ts';
import { diffConfig, fieldSlug, slug, uniqueKey, validateConfig } from '../workspace/schema.ts';
import { OPS_DEFAULTS } from '../operations/ops.ts';
import type { OpsModuleKey } from '../workspace/types.ts';
import type { ObjectSchema } from './schema.ts';

export type FieldSpec = { label: string; kind: string; required?: boolean; options?: string[]; currency?: string };
export type LayoutSpec = { order?: string[]; sections?: { title: string; fields: string[] }[]; help?: { field: string; text: string }[]; required?: { field: string; value: boolean }[] };
export type PipelineSpec = { stages: string[]; settings?: { stage: string; color?: string; requires_assignee?: boolean; requires_summary?: boolean }[]; moves?: { from: string; to: string }[] };
export type Op = { op: 'add_module' | 'add_fields' | 'rename_module' | 'rename_field' | 'hide_field' | 'enable_module' | 'disable_module' | 'set_layout' | 'set_pipeline'; operations_module?: OpsModuleKey; module_label?: string; module_key?: string; fields?: FieldSpec[]; new_label?: string; field_key?: string; layout?: LayoutSpec; pipeline?: PipelineSpec };

/** Finds a field by its permanent key or (case-insensitively) by its label. Ambiguous or missing references are errors, never guesses. */
export function resolveField(obj: ObjectConfig, ref: string): Result<FieldConfig> {
  const r = ref.trim(); const byKey = obj.fields.find(f => f.key === r); if (byKey) return { ok: true, value: byKey };
  const hits = obj.fields.filter(f => f.label.toLowerCase() === r.toLowerCase() || fieldSlug(r) === f.key);
  if (hits.length === 1) return { ok: true, value: hits[0]! };
  return { ok: false, error: hits.length ? `"${ref}" matches more than one field in "${obj.label}".` : `"${obj.label}" has no field "${ref}" (fields: ${obj.fields.filter(f => !f.archived).map(f => f.label).join(', ') || 'none'}).` };
}

const FIELD: ObjectSchema = { type: 'object', properties: {
  label: { type: 'string', minLength: 1, maxLength: 60, description: 'Field name shown to users, e.g. "Registration Number".' },
  kind: { type: 'string', enum: FIELD_KINDS, description: 'text, number, date, choice (dropdown), yes_no (checkbox), phone, email, currency.' },
  required: { type: 'boolean' }, options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 60 }, maxItems: 30, description: 'Required for choice (dropdown) fields.' },
  currency: { type: 'string', pattern: '^[A-Za-z]{3}$', description: 'Optional 3-letter currency code for currency fields.' } }, required: ['label', 'kind'] };
export const OPS_SCHEMA: ObjectSchema = { type: 'object', properties: {
  summary: { type: 'string', minLength: 3, maxLength: 160, description: 'One-line description of the change for the user.' },
  operations: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: {
    op: { type: 'string', enum: ['add_module', 'add_fields', 'rename_module', 'rename_field', 'hide_field', 'enable_module', 'disable_module'] },
    operations_module: { type: 'string', enum: ['appointments', 'inventory', 'billing'], description: 'enable_module / disable_module: which optional business-operations module.' },
    module_label: { type: 'string', maxLength: 60, description: 'add_module: the new module name.' }, module_key: { type: 'string', maxLength: 40, description: 'Existing module key from list_modules (add_fields, rename_*, hide_field).' },
    fields: { type: 'array', items: FIELD, maxItems: 30 }, new_label: { type: 'string', maxLength: 60 }, field_key: { type: 'string', maxLength: 40 } }, required: ['op'] } } }, required: ['summary', 'operations'] };

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const cleanField = (f: FieldSpec, taken: string[]): Result<FieldConfig> => {
  if (!(FIELD_KINDS as readonly string[]).includes(f.kind)) return { ok: false, error: `"${f.label}": "${f.kind}" is not a supported field type (use ${FIELD_KINDS.join(', ')}).` };
  const kind = f.kind as FieldKind;
  if (kind === 'choice' && !(f.options?.length)) return { ok: false, error: `"${f.label}" is a dropdown and needs at least one option.` };
  if (kind !== 'choice' && f.options?.length) return { ok: false, error: `"${f.label}": only dropdown fields take options.` };
  if (kind !== 'currency' && f.currency) return { ok: false, error: `"${f.label}": only currency fields take a currency code.` };
  const label = f.label.trim().replace(/\s+/g, ' '); const key = uniqueKey(fieldSlug(label), taken, '_'); taken.push(key);
  return { ok: true, value: { key, label, kind, ...(f.required ? { required: true } : {}), ...(kind === 'choice' ? { options: [...new Set(f.options!.map(o => o.trim()).filter(Boolean))] } : {}), ...(kind === 'currency' && f.currency ? { currency: f.currency.toUpperCase() } : {}) } };
};

/** Applies operations to a copy of `base`. Returns the resulting (validated) configuration and a plain-language diff against `live`. */
export function applyOps(base: WorkspaceConfig, live: WorkspaceConfig, ops: Op[]): Result<{ config: WorkspaceConfig; diff: string[] }> {
  const cfg = clone(base); const isCore = (k: string) => k === 'overview' || k === 'leads';
  const findModule = (o: Op) => cfg.modules.find(m => (o.module_key ? m.key === o.module_key : o.module_label ? m.label.toLowerCase() === o.module_label.trim().toLowerCase() : false));
  for (const [i, o] of ops.entries()) {
    const at = `Step ${i + 1}`;
    if (o.op === 'enable_module' || o.op === 'disable_module') {
      const k = o.operations_module; if (!k) return { ok: false, error: `${at}: ${o.op} needs operations_module (appointments, inventory or billing).` };
      cfg.operations = { ...(cfg.operations ?? {}), [k]: { ...(cfg.operations?.[k] ?? OPS_DEFAULTS[k]), enabled: o.op === 'enable_module' } } as typeof cfg.operations; // other settings are kept; disabling never deletes data
      continue;
    }
    if (o.op === 'set_pipeline') {
      const sp = o.pipeline; if (!sp?.stages?.length) return { ok: false, error: `${at}: set_pipeline needs stages.` };
      const stages = sp.stages.map(x => x.trim().replace(/\s+/g, ' '));
      const settings: Record<string, { color?: string; requires_assignee?: boolean; requires_summary?: boolean }> = {};
      for (const st of sp.settings ?? []) { const name = stages.find(x => x.toLowerCase() === st.stage.trim().toLowerCase()); if (!name) return { ok: false, error: `${at}: settings refer to the stage "${st.stage}", which is not in the pipeline.` }; settings[name] = { ...(st.color ? { color: st.color } : {}), ...(st.requires_assignee ? { requires_assignee: true } : {}), ...(st.requires_summary ? { requires_summary: true } : {}) }; }
      const moves = (sp.moves ?? []).map(m => ({ from: m.from.trim(), to: stages.find(x => x.toLowerCase() === m.to.trim().toLowerCase()) ?? m.to.trim() }));
      cfg.pipeline = { stages, ...(Object.keys(settings).length ? { stageSettings: settings as never } : {}), ...(moves.length ? { stageMoves: moves } : {}) };
      continue;
    }
    if (o.op === 'add_module') {
      const label = (o.module_label ?? '').trim().replace(/\s+/g, ' ');
      if (!label) return { ok: false, error: `${at}: add_module needs module_label.` };
      if (cfg.modules.some(m => m.label.toLowerCase() === label.toLowerCase() || m.key === slug(label))) return { ok: false, error: `${at}: a module called "${label}" already exists. Use add_fields to extend it.` };
      const key = uniqueKey(slug(label), [...cfg.modules.map(m => m.key), ...cfg.objects.map(x => x.key)]); if (!slug(label)) return { ok: false, error: `${at}: the module name needs letters or digits.` };
      const taken: string[] = []; const fields: FieldConfig[] = [];
      for (const f of o.fields?.length ? o.fields : [{ label: 'Name', kind: 'text', required: true }]) { const r = cleanField(f, taken); if (!r.ok) return { ok: false, error: `${at}: ${r.error}` }; fields.push(r.value); }
      cfg.modules.push({ key, label, status: 'active' }); cfg.objects.push({ key, label, fields } as ObjectConfig);
    } else {
      const m = findModule(o);
      if (!m || isCore(m.key)) return { ok: false, error: `${at}: ${m ? `"${m.label}" is a core module and cannot be changed this way` : 'that module does not exist (use list_modules for the exact key)'}.` };
      const obj = cfg.objects.find(x => x.key === m.key); if (!obj) return { ok: false, error: `${at}: "${m.label}" has no record type to change.` };
      if (o.op === 'add_fields') {
        if (!o.fields?.length) return { ok: false, error: `${at}: add_fields needs at least one field.` };
        const taken = obj.fields.map(f => f.key);
        for (const f of o.fields) { const r = cleanField(f, taken); if (!r.ok) return { ok: false, error: `${at}: ${r.error}` }; obj.fields.push(r.value); }
      } else if (o.op === 'set_layout') {
        const L = o.layout; if (!L) return { ok: false, error: `${at}: set_layout needs layout.` };
        const res = (ref: string) => { const r = resolveField(obj, ref); if (!r.ok) throw new Error(`${at}: ${r.error}`); return r.value; };
        try {
          for (const h of L.help ?? []) { const f = res(h.field); const t = h.text.trim(); if (t) f.description = t; else delete f.description; }
          for (const q of L.required ?? []) { const f = res(q.field); if (q.value) f.required = true; else delete f.required; }
          let order: FieldConfig[] | null = null;
          if (L.sections?.length) {
            const seen = new Set<string>(); const front: FieldConfig[] = [];
            for (const sec of L.sections) for (const ref of sec.fields) { const f = res(ref); if (seen.has(f.key)) throw new Error(`${at}: "${f.label}" is placed in more than one section.`); seen.add(f.key); f.section = sec.title.trim().replace(/\s+/g, ' '); front.push(f); }
            order = [...front, ...obj.fields.filter(f => !seen.has(f.key))];
          } else if (L.order?.length) { const seen = new Set<string>(); const front = L.order.map(res).filter(f => !seen.has(f.key) && seen.add(f.key)); order = [...front, ...obj.fields.filter(f => !seen.has(f.key))]; }
          if (order) obj.fields = order;
        } catch (e) { return { ok: false, error: (e as Error).message }; }
      } else if (o.op === 'rename_module') {
        const nl = (o.new_label ?? '').trim().replace(/\s+/g, ' '); if (!nl) return { ok: false, error: `${at}: rename_module needs new_label.` };
        m.label = nl; obj.label = nl; // keys never change, so stored records and URLs are unaffected
      } else {
        const f = obj.fields.find(x => x.key === o.field_key); if (!f) return { ok: false, error: `${at}: field "${o.field_key ?? ''}" does not exist in "${m.label}".` };
        if (o.op === 'rename_field') { const nl = (o.new_label ?? '').trim(); if (!nl) return { ok: false, error: `${at}: rename_field needs new_label.` }; f.label = nl; }
        else f.archived = true; // hide_field keeps all stored values
      }
    }
  }
  const v = validateConfig(cfg);
  if (!v.ok) return { ok: false, error: `The result is not a valid configuration: ${v.errors[0]}` };
  return { ok: true, value: { config: v.value, diff: diffConfig(live, v.value) } };
}
