// Pure workspace-configuration logic shared by onboarding, the Builder (client + server) and tests. No framework imports.
// validateConfig mirrors public.validate_workspace_definition (migration 0005); the database re-validates every write.
import { CORE_MODULES, FIELD_KINDS, type FieldConfig, type FieldKind, type ModuleConfig, type ObjectConfig, type Preset, type Result, type SetupChoice, type WorkspaceConfig } from './types.ts';
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
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  const cfg: WorkspaceConfig = { schemaVersion: 1, businessName: text(input.businessName), modules, objects, pipeline: { stages } };
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
  for (const s of ts) if (!fs.includes(s)) out.push(`Add pipeline stage "${s}"`);
  for (const s of fs) if (!ts.includes(s)) out.push(`Remove pipeline stage "${s}" (no lead may be left in it)`);
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
      } }
    for (const f of p.fields) if (!nf.has(f.key)) out.push(`"${o.label}": remove field "${f.label}"`);
  }
  for (const o of from.objects) if (!to_.has(o.key)) out.push(`Remove record type "${o.label}"`);
  return out;
}
