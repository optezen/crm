// Pure workspace-configuration logic shared by onboarding, the Builder (client + server) and tests. No framework imports.
// validateConfig mirrors public.validate_workspace_definition (migration 0005); the database re-validates every write.
import type { OperationsConfig, TaxConfig } from './types.ts';
import { CORE_MODULES, FIELD_DESC_MAX, FIELD_SECTION_MAX, FIELD_KINDS, STAGE_COLORS, type FieldConfig, type PipelineConfig, type StageColor, type StageMove, type StageSettings, type FieldKind, type ModuleConfig, type ObjectConfig, type Preset, type Result, type SetupChoice, type WorkspaceConfig } from './types.ts';
import { getPreset } from './presets.ts';

const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/, FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

export const slug = (s: string) => s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '');
export const fieldSlug = (s: string) => { const k = slug(s).replace(/-/g, '_'); return /^[a-z]/.test(k) ? k : k ? `f_${k}`.slice(0, 40) : 'field'; };
/** First free key derived from a label (`base`, `base-2`, ...). Keys are stable identifiers; renaming a label never changes them. */
export function uniqueKey(base: string, taken: readonly string[], sep = '-') { let k = base || 'item', i = 2; while (taken.includes(k)) k = `${base || 'item'}${sep}${i++}`; return k; }

export function validateOnboarding(input: { name?: unknown; description?: unknown }) {
  const errors: { name?: string; description?: string } = {};
  const name = text(input.name);
  if (name.length < 2 || name.length > 80) errors.name = 'Enter a business name between 2 and 80 characters.';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length > 1000) errors.description = 'Keep the description under 1000 characters.';
  return { ok: !errors.name && !errors.description, errors, value: { name, description } };
}

/** Validates and normalizes a proposed configuration. Returns every problem found so the Builder can show them all. */
const TZ_OK = (z: string) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };
/** Mirror of public.ops_validate (migration 0010). Custom fields are validated with the SAME code as custom-module fields. */
export function validateOperations(raw: unknown): { ok: true; value: OperationsConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [], out: OperationsConfig = {};
  if (!isObj(raw) || Object.keys(raw).some(k => !['appointments', 'inventory', 'billing'].includes(k))) return { ok: false, errors: ['The operations settings are invalid.'] };
  const bool = (o: Record<string, unknown>, k: string) => o[k] === undefined || typeof o[k] === 'boolean';
  const fieldsOf = (v: unknown, label: string): FieldConfig[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 15) { errors.push(`${label}: custom fields must be a list of at most 15.`); return undefined; }
    const r = validateConfig({ schemaVersion: 1, businessName: 'x', modules: coreModules(), objects: [{ key: 'ops', label: 'Ops', fields: v }], pipeline: { stages: ['a', 'b'] } });
    if (!r.ok) { errors.push(...r.errors.map(e => `${label}: ${e}`)); return undefined; }
    return r.value.objects[0]!.fields;
  };
  const a = raw.appointments;
  if (a !== undefined) {
    if (!isObj(a) || Object.keys(a).some(k => !['enabled', 'timezone', 'enforce_working_hours', 'fields'].includes(k)) || typeof a.enabled !== 'boolean' || !bool(a, 'enforce_working_hours')) errors.push('The appointments settings are invalid.');
    else if (a.timezone !== undefined && (typeof a.timezone !== 'string' || !TZ_OK(a.timezone))) errors.push('The appointments time zone is not a valid IANA name (for example Asia/Kolkata).');
    else { const f = fieldsOf(a.fields, 'Appointments'); out.appointments = { enabled: a.enabled, ...(a.timezone ? { timezone: a.timezone as string } : {}), ...(typeof a.enforce_working_hours === 'boolean' ? { enforce_working_hours: a.enforce_working_hours } : {}), ...(f ? { fields: f } : {}) }; }
  }
  const i = raw.inventory;
  if (i !== undefined) {
    if (!isObj(i) || Object.keys(i).some(k => !['enabled', 'allow_negative_stock', 'track_batches', 'track_expiry', 'block_expired', 'fields'].includes(k)) || typeof i.enabled !== 'boolean'
      || !['allow_negative_stock', 'track_batches', 'track_expiry', 'block_expired'].every(k => bool(i, k))) errors.push('The inventory settings are invalid.');
    else if (i.track_expiry === true && i.track_batches !== true) errors.push('Expiry tracking needs batch tracking.');
    else { const f = fieldsOf(i.fields, 'Inventory'); const o: NonNullable<OperationsConfig['inventory']> = { enabled: i.enabled };
      for (const k of ['allow_negative_stock', 'track_batches', 'track_expiry', 'block_expired'] as const) { const v = i[k]; if (typeof v === 'boolean') o[k] = v; } if (f) o.fields = f; out.inventory = o; }
  }
  const b = raw.billing;
  if (b !== undefined) {
    const bad = !isObj(b) || Object.keys(b).some(k => !['enabled', 'currency', 'invoice_prefix', 'credit_note_prefix', 'default_due_days', 'taxes'].includes(k)) || typeof b.enabled !== 'boolean'
      || (b.currency !== undefined && !/^[A-Z]{3}$/.test(String(b.currency))) || (b.invoice_prefix !== undefined && !/^[A-Z0-9]{1,8}$/.test(String(b.invoice_prefix))) || (b.credit_note_prefix !== undefined && !/^[A-Z0-9]{1,8}$/.test(String(b.credit_note_prefix)))
      || (b.default_due_days !== undefined && (!Number.isInteger(b.default_due_days) || (b.default_due_days as number) < 0 || (b.default_due_days as number) > 365));
    if (bad || !isObj(b)) errors.push('The billing settings are invalid.');
    else {
      const taxes: TaxConfig[] = [];
      if (b.taxes !== undefined) {
        if (!Array.isArray(b.taxes) || b.taxes.length > 10) errors.push('Taxes must be a list of at most 10.');
        else for (const t of b.taxes) {
          if (!isObj(t) || Object.keys(t).some(k => !['key', 'name', 'rate'].includes(k)) || !/^[a-z][a-z0-9_]{0,19}$/.test(String(t.key)) || text(t.name).length < 1 || text(t.name).length > 40
            || typeof t.rate !== 'string' || !/^(100(\.0{1,3})?|[0-9]{1,2}(\.[0-9]{1,3})?)$/.test(t.rate)) { errors.push('Every tax needs a key, a name and a rate between 0 and 100 given as text (for example "18" or "5.5").'); continue; }
          if (taxes.some(x => x.key === t.key)) { errors.push(`Duplicate tax "${String(t.key)}".`); continue; }
          taxes.push({ key: t.key as string, name: text(t.name), rate: t.rate });
        }
      }
      const o: NonNullable<OperationsConfig["billing"]> = { enabled: b.enabled === true };
      if (b.currency) o.currency = b.currency as string; if (b.invoice_prefix) o.invoice_prefix = b.invoice_prefix as string; if (b.credit_note_prefix) o.credit_note_prefix = b.credit_note_prefix as string;
      if (typeof b.default_due_days === 'number') o.default_due_days = b.default_due_days; if (b.taxes !== undefined) o.taxes = taxes; out.billing = o;
    }
  }
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, value: out };
}

export function validateConfig(input: unknown): { ok: true; value: WorkspaceConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(input) || input.schemaVersion !== 1) return { ok: false, errors: ['Not a valid workspace configuration.'] };
  const modules: ModuleConfig[] = [], objects: ObjectConfig[] = [];

  if (!Array.isArray(input.modules) || input.modules.length > 40) errors.push('Modules must be a list of at most 40.');
  else for (const m of input.modules) {
    const key = isObj(m) && typeof m.key === 'string' ? m.key : '', label = isObj(m) ? text(m.label) : '', status = isObj(m) ? m.status : undefined;
    if (!KEY.test(key) || key.length > 40) { errors.push('Every module needs a valid key.'); continue; }
    if (modules.some(x => x.key === key)) { errors.push(`Duplicate module "${label || key}".`); continue; }
    if (label.length < 1 || label.length > 60) errors.push(`Module "${key}" needs a name of up to 60 characters.`);
    if (status !== 'active' && status !== 'planned' && status !== 'archived') { errors.push(`Module "${label || key}" has an invalid status.`); continue; }
    modules.push({ key, label, status });
  }
  for (const c of CORE_MODULES) if (!modules.some(m => m.key === c.key && m.status === 'active')) errors.push('The Overview and Leads modules are required and must be active.');

  const rawStages = isObj(input.pipeline) && Array.isArray(input.pipeline.stages) ? input.pipeline.stages : null;
  const stages = rawStages ? rawStages.map(text) : [];
  if (!rawStages || stages.length < 2 || stages.length > 20) errors.push('The pipeline needs between 2 and 20 stages.');
  else if (stages.some(s => s.length < 1 || s.length > 80)) errors.push('Each pipeline stage needs a name of up to 80 characters.');
  else if (new Set(stages).size !== stages.length) errors.push('Pipeline stage names must be unique.');
  const pipeline: PipelineConfig = { stages };
  if (isObj(input.pipeline) && input.pipeline.stageSettings !== undefined) {
    const ss = input.pipeline.stageSettings, out: Record<string, StageSettings> = {};
    if (!isObj(ss) || Object.keys(ss).length > 20) errors.push('Stage settings are invalid.');
    else for (const [name, v] of Object.entries(ss)) {
      if (!stages.includes(name) || !isObj(v) || Object.keys(v).some(k => !['color', 'requires_assignee', 'requires_summary'].includes(k))
        || (v.color !== undefined && !(STAGE_COLORS as readonly unknown[]).includes(v.color)) || (v.requires_assignee !== undefined && typeof v.requires_assignee !== 'boolean') || (v.requires_summary !== undefined && typeof v.requires_summary !== 'boolean')) { errors.push(`The settings for stage "${name}" are invalid.`); continue; }
      const o: StageSettings = {}; if (v.color !== undefined && v.color !== 'gray') o.color = v.color as StageColor; if (v.requires_assignee === true) o.requires_assignee = true; if (v.requires_summary === true) o.requires_summary = true;
      if (Object.keys(o).length) out[name] = o;
    }
    if (Object.keys(out).length) pipeline.stageSettings = out;
  }
  if (isObj(input.pipeline) && input.pipeline.stageMoves !== undefined) {
    const mv = input.pipeline.stageMoves, out: StageMove[] = [];
    if (!Array.isArray(mv) || mv.length > 20) errors.push('Stage moves are invalid.');
    else for (const m of mv) {
      if (!isObj(m) || Object.keys(m).some(k => k !== 'from' && k !== 'to') || typeof m.from !== 'string' || typeof m.to !== 'string' || stages.includes(m.from) || !stages.includes(m.to) || out.some(x => x.from === m.from)) { errors.push('A stage move is invalid: it must move leads out of a stage the pipeline no longer has, into one it does.'); continue; }
      out.push({ from: m.from, to: m.to });
    }
    if (out.length) pipeline.stageMoves = out;
  }

  if (!Array.isArray(input.objects) || input.objects.length > 20) errors.push('Record types must be a list of at most 20.');
  else for (const o of input.objects) {
    const key = isObj(o) && typeof o.key === 'string' ? o.key : '', label = isObj(o) ? text(o.label) : '';
    if (!KEY.test(key) || key.length > 40) { errors.push('Every record type needs a valid key.'); continue; }
    if (objects.some(x => x.key === key)) { errors.push(`Duplicate record type "${label || key}".`); continue; }
    if (label.length < 1 || label.length > 60) errors.push(`Record type "${key}" needs a name of up to 60 characters.`);
    const rawFields = isObj(o) && Array.isArray(o.fields) ? o.fields : null;
    if (!rawFields || rawFields.length > 30) { errors.push(`"${label || key}" can have at most 30 fields.`); continue; }
    const fields: FieldConfig[] = [];
    for (const f of rawFields) {
      const fk = isObj(f) && typeof f.key === 'string' ? f.key : '', fl = isObj(f) ? text(f.label) : '', kind = isObj(f) ? f.kind : undefined;
      if (!FIELD_KEY.test(fk) || fk.length > 40) { errors.push(`A field in "${label || key}" has an invalid key.`); continue; }
      if (fields.some(x => x.key === fk)) { errors.push(`Duplicate field "${fl || fk}" in "${label || key}".`); continue; }
      if (fl.length < 1 || fl.length > 60) errors.push(`Field "${fk}" needs a name of up to 60 characters.`);
      if (!(FIELD_KINDS as readonly unknown[]).includes(kind)) { errors.push(`Field "${fl || fk}" has an invalid type.`); continue; }
      const field: FieldConfig = { key: fk, label: fl, kind: kind as FieldKind };
      const attr = (name: string) => (isObj(f) ? f[name] : undefined);
      if (attr('required') !== undefined && typeof attr('required') !== 'boolean') errors.push(`Field "${fl || fk}" has an invalid required setting.`);
      if (attr('archived') !== undefined && typeof attr('archived') !== 'boolean') errors.push(`Field "${fl || fk}" has an invalid hidden setting.`);
      if (attr('description') !== undefined) { const dsc = attr('description'); if (typeof dsc === 'string' && dsc.trim().length <= FIELD_DESC_MAX) { if (dsc.trim()) field.description = dsc.trim(); } else errors.push(`Field "${fl || fk}" has an invalid description (up to ${FIELD_DESC_MAX} characters).`); }
      if (attr('section') !== undefined) { const sec = attr('section'); if (typeof sec === 'string' && sec.trim().length <= FIELD_SECTION_MAX) { if (sec.trim()) field.section = sec.trim().replace(/\s+/g, ' '); } else errors.push(`Field "${fl || fk}" has an invalid section (up to ${FIELD_SECTION_MAX} characters).`); }
      if (attr('required') === true) field.required = true;
      if (attr('archived') === true) field.archived = true;
      if (attr('currency') !== undefined) { if (typeof attr('currency') === 'string' && /^[A-Z]{3}$/.test(attr('currency') as string)) field.currency = attr('currency') as string; else errors.push(`Field "${fl || fk}" needs a 3-letter currency code such as INR.`); }
      if (kind === 'choice') {
        const opts = isObj(f) && Array.isArray(f.options) ? f.options.map(text) : [];
        if (opts.length < 1 || opts.length > 30 || opts.some(x => x.length < 1 || x.length > 60)) errors.push(`Dropdown field "${fl || fk}" needs between 1 and 30 options.`);
        field.options = opts;
      }
      fields.push(field);
    }
    objects.push({ key, label, fields });
  }
  let opsValue: OperationsConfig | undefined;
  if (input.operations !== undefined) { const r = validateOperations(input.operations); if (r.ok) opsValue = r.value; else errors.push(...r.errors); }
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const cfg: WorkspaceConfig = { schemaVersion: 1, businessName: text(input.businessName), modules, objects, pipeline };
  if (opsValue && Object.keys(opsValue).length) cfg.operations = opsValue;
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description) cfg.description = description.slice(0, 1000);
  if (typeof input.preset === 'string' && /^[a-z0-9_-]{1,40}$/.test(input.preset)) cfg.preset = input.preset;
  return { ok: true, value: cfg };
}

const coreModules = (): ModuleConfig[] => CORE_MODULES.map(c => ({ key: c.key, label: c.label, status: 'active' as const }));
/** Adds any missing core module (used when opening an older configuration in the Builder). */
export function ensureCore(config: WorkspaceConfig): WorkspaceConfig {
  const have = new Set(config.modules.map(m => m.key));
  const missing = coreModules().filter(m => !have.has(m.key));
  const fixed = config.modules.map(m => (CORE_MODULES.some(c => c.key === m.key) ? { ...m, status: 'active' as const } : m));
  return missing.length || fixed.some((m, i) => m.status !== config.modules[i].status) ? { ...config, modules: [...missing, ...fixed] } : config;
}

export const BLANK_STAGES = ['New', 'Contacted', 'Qualified', 'Won', 'Lost'];

export function blankConfig(businessName: string, description = ''): WorkspaceConfig {
  return { schemaVersion: 1, businessName, ...(description ? { description } : {}), modules: coreModules(), objects: [], pipeline: { stages: [...BLANK_STAGES] } };
}

/** Optional starting point. Anything beyond the core modules is "planned": there are no screens for it yet, and the Builder says so. */
export function presetConfig(preset: Preset, businessName: string, description = ''): WorkspaceConfig {
  const modules = coreModules(), taken = modules.map(m => m.key);
  for (const label of preset.modules) {
    if (CORE_MODULES.some(c => c.key === slug(label))) continue; // Overview and Leads are always present
    const key = uniqueKey(slug(label), taken); taken.push(key); modules.push({ key, label, status: 'planned' });
  }
  const objKeys: string[] = [];
  const objects: ObjectConfig[] = preset.records.map(r => {
    const key = uniqueKey(slug(r.label), objKeys); objKeys.push(key);
    const fk: string[] = [];
    return { key, label: r.label, fields: r.fields.map(f => { const k = uniqueKey(fieldSlug(f), fk, '_'); fk.push(k); return { key: k, label: f.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), kind: 'text' as const }; }) };
  });
  return { schemaVersion: 1, businessName, ...(description ? { description } : {}), preset: preset.key, modules, objects, pipeline: { stages: [...preset.pipeline] } };
}

/** The single path from "what the user chose" to a validated configuration. The server calls this again at creation time and never trusts a client-built config. */
export function configFromChoice(input: { name: unknown; description: unknown }, choice: SetupChoice): Result<WorkspaceConfig> {
  const v = validateOnboarding(input);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0]! };
  const { name, description } = v.value;
  let draft: unknown;
  if (choice.kind === 'blank') draft = blankConfig(name, description);
  else if (choice.kind === 'preset') {
    const p = getPreset(choice.key);
    if (!p) return { ok: false, error: 'Choose one of the available starting points, or start blank.' };
    draft = presetConfig(p, name, description);
  } else if (choice.kind === 'draft' && isObj(choice.definition)) draft = { ...choice.definition, businessName: name, description: description || undefined, preset: undefined };
  else return { ok: false, error: 'Choose how to start your workspace.' };
  const r = validateConfig(draft);
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.errors[0]! };
}

/** Human-readable summary of what changes between two configurations (the Builder's preview). */
export function diffConfig(from: WorkspaceConfig, to: WorkspaceConfig): string[] {
  const out: string[] = [];
  const byKey = <T extends { key: string }>(l: T[]) => new Map(l.map(x => [x.key, x]));
  const fm = byKey(from.modules), tm = byKey(to.modules);
  for (const m of to.modules) { const o = fm.get(m.key); if (!o) out.push(`Add module "${m.label}"`); else if (o.label !== m.label) out.push(`Rename module "${o.label}" to "${m.label}"`); else if (o.status !== m.status) out.push(`Module "${m.label}": ${o.status} → ${m.status}`); }
  for (const m of from.modules) if (!tm.has(m.key)) out.push(`Remove module "${m.label}"`);
  const fs = from.pipeline.stages, ts = to.pipeline.stages;
  const moves = to.pipeline.stageMoves ?? [];
  for (const m of moves) out.push(`Move leads from stage "${m.from}" to "${m.to}" when published${to.pipeline.stages.includes(m.from) ? '' : ` (stage "${m.from}" is removed)`}`);
  for (const s of ts) if (!fs.includes(s) && !moves.some(m => m.to === s && !fs.includes(m.to))) out.push(`Add pipeline stage "${s}"`);
  for (const s of fs) if (!ts.includes(s) && !moves.some(m => m.from === s)) out.push(`Remove pipeline stage "${s}" (no lead may be left in it)`);
  for (const s of ts) { const a2 = from.pipeline.stageSettings?.[s], b2 = to.pipeline.stageSettings?.[s]; if (JSON.stringify(a2 ?? {}) !== JSON.stringify(b2 ?? {}) && fs.includes(s)) out.push(`Change settings of stage "${s}"`); }
  const kept = ts.filter(s => fs.includes(s)); if (kept.length > 1 && kept.join('\u0000') !== fs.filter(s => ts.includes(s)).join('\u0000')) out.push('Reorder pipeline stages');
  const fo = byKey(from.objects), to_ = byKey(to.objects);
  for (const o of to.objects) {
    const p = fo.get(o.key);
    if (!p) { out.push(`Add record type "${o.label}" with ${o.fields.length} field${o.fields.length === 1 ? '' : 's'}`); continue; }
    if (p.label !== o.label) out.push(`Rename record type "${p.label}" to "${o.label}"`);
    const pf = byKey(p.fields), nf = byKey(o.fields);
    for (const f of o.fields) { const q = pf.get(f.key); if (!q) out.push(`"${o.label}": add field "${f.label}"`); else {
        if (q.label !== f.label) out.push(`"${o.label}": rename field "${q.label}" to "${f.label}"`);
        if (!!q.archived !== !!f.archived) out.push(`"${o.label}": ${f.archived ? 'hide' : 'show'} field "${f.label}"`);
        if (!!q.required !== !!f.required) out.push(`"${o.label}": field "${f.label}" is now ${f.required ? 'required' : 'optional'}`);
        if (q.kind !== f.kind) out.push(`"${o.label}": change type of "${f.label}" to ${f.kind}`);
        if ((q.options ?? []).join('|') !== (f.options ?? []).join('|')) out.push(`"${o.label}": change dropdown options of "${f.label}"`);
        if ((q.currency ?? '') !== (f.currency ?? '')) out.push(`"${o.label}": change currency of "${f.label}"`);
        if ((q.description ?? '') !== (f.description ?? '')) out.push(`"${o.label}": change help text of "${f.label}"`);
        if ((q.section ?? '') !== (f.section ?? '')) out.push(`"${o.label}": move "${f.label}" to section "${f.section ?? '(none)'}"`);
      } }
    for (const f of p.fields) if (!nf.has(f.key)) out.push(`"${o.label}": remove field "${f.label}"`);
    const kept = o.fields.filter(f => pf.has(f.key)).map(f => f.key), was = p.fields.filter(f => nf.has(f.key)).map(f => f.key); if (kept.join('|') !== was.join('|')) out.push(`"${o.label}": reorder fields`);
  }
  for (const o of from.objects) if (!to_.has(o.key)) out.push(`Remove record type "${o.label}"`);
  out.push(...diffOperations(from.operations ?? {}, to.operations ?? {}));
  return out;
}

const OPS_LABEL = { appointments: 'Appointments', inventory: 'Inventory', billing: 'Billing' } as const;
/** Plain-language differences in the operations block (enablement, rules, taxes, custom fields). */
export function diffOperations(from: OperationsConfig, to: OperationsConfig): string[] {
  const out: string[] = [];
  for (const k of ['appointments', 'inventory', 'billing'] as const) {
    const a = from[k] as Record<string, unknown> | undefined, b = to[k] as Record<string, unknown> | undefined, L = OPS_LABEL[k];
    if (!a && !b) continue;
    if (!!a?.enabled !== !!b?.enabled) out.push(b?.enabled ? `Enable the ${L} module` : `Disable the ${L} module (existing data is kept)`);
    for (const key of Object.keys({ ...(a ?? {}), ...(b ?? {}) })) {
      if (key === 'enabled' || key === 'taxes' || key === 'fields') continue;
      if (JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])) out.push(`${L}: set ${key.replace(/_/g, ' ')} to ${JSON.stringify(b?.[key] ?? null)}`);
    }
    if (k === 'billing') {
      const ft = new Map(((a?.taxes as TaxConfig[] | undefined) ?? []).map(t => [t.key, t])), tt = new Map(((b?.taxes as TaxConfig[] | undefined) ?? []).map(t => [t.key, t]));
      for (const [key, t] of tt) { const o = ft.get(key); if (!o) out.push(`Billing: add tax "${t.name}" at ${t.rate}%`); else if (o.rate !== t.rate || o.name !== t.name) out.push(`Billing: change tax "${o.name}" to "${t.name}" at ${t.rate}% (issued invoices keep their original rate)`); }
      for (const [key, t] of ft) if (!tt.has(key)) out.push(`Billing: remove tax "${t.name}" (issued invoices keep their original rate)`);
    } else {
      const ff = new Map(((a?.fields as FieldConfig[] | undefined) ?? []).map(f => [f.key, f])), tf = new Map(((b?.fields as FieldConfig[] | undefined) ?? []).map(f => [f.key, f]));
      for (const [key, f] of tf) { const o = ff.get(key); if (!o) out.push(`${L}: add custom field "${f.label}"`); else { if (o.label !== f.label) out.push(`${L}: rename custom field "${o.label}" to "${f.label}"`); if (!!o.archived !== !!f.archived) out.push(`${L}: ${f.archived ? 'hide' : 'show'} custom field "${f.label}"`); } }
      for (const [key, f] of ff) if (!tf.has(key)) out.push(`${L}: remove custom field "${f.label}" (not allowed once published: hide it instead)`);
    }
  }
  return out;
}
