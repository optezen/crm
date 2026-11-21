// Pure form-layout logic shared by the Form Builder and Work Mode. A form is the module's field list: order = display order, `section` = heading.
// Consecutive fields with the same section share one heading, so what the builder shows is exactly what Work Mode renders.
import { FIELD_KINDS, type FieldConfig, type FieldKind, FIELD_KIND_LABEL, DEFAULT_CURRENCY } from '../workspace/types.ts';
import { fieldSlug, uniqueKey } from '../workspace/schema.ts';

export type Run = { section: string; fields: FieldConfig[] };
export function sectionRuns(fields: FieldConfig[]): Run[] {
  const out: Run[] = [];
  for (const f of fields) { const s = f.section ?? ''; const last = out[out.length - 1]; if (last && last.section === s) last.fields.push(f); else out.push({ section: s, fields: [f] }); }
  return out;
}
export const FIELD_PALETTE: { kind: FieldKind; label: string }[] = FIELD_KINDS.map(k => ({ kind: k, label: FIELD_KIND_LABEL[k] }));
const clean = (f: FieldConfig): FieldConfig => { const { options, currency, ...rest } = f; return { ...rest, ...(f.kind === 'choice' ? { options: options?.length ? options : ['Option 1'] } : {}), ...(f.kind === 'currency' ? { currency: currency ?? DEFAULT_CURRENCY } : {}) }; };
/** A new field gets a fresh, never-reused key (unique among all fields, including hidden ones) so it can never collide with stored record data. */
export function newField(fields: FieldConfig[], kind: FieldKind, label: string, section?: string): FieldConfig {
  const text = label.trim().replace(/\s+/g, ' ') || FIELD_KIND_LABEL[kind];
  return clean({ key: uniqueKey(fieldSlug(text), fields.map(f => f.key), '_'), label: text, kind, ...(section ? { section } : {}) });
}
/** Insert at an index (default: end). Max 30 fields per record type. */
export function insertField(fields: FieldConfig[], f: FieldConfig, at?: number): FieldConfig[] {
  if (fields.length >= 30) return fields; const i = at === undefined ? fields.length : Math.min(Math.max(at, 0), fields.length); const n = [...fields]; n.splice(i, 0, f); return n;
}
/** Moves a field to a new index. When `adopt` is true the field takes the section of the field it lands next to (drag across sections). */
export function moveField(fields: FieldConfig[], from: number, to: number, adopt = true): FieldConfig[] {
  if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) return fields;
  const n = [...fields]; const [x] = n.splice(from, 1); let moved = x!;
  if (adopt) { const sec = (n[to - 1] ?? n[to])?.section; const { section: _s, ...rest } = moved; moved = sec ? { ...rest, section: sec } : rest; }
  n.splice(to, 0, moved); return n;
}
export function updateField(fields: FieldConfig[], key: string, patch: Partial<FieldConfig>): FieldConfig[] {
  return fields.map(f => { if (f.key !== key) return f; const next = { ...f, ...patch } as FieldConfig;
    for (const k of ['description', 'section', 'required', 'archived'] as const) if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
    return patch.kind ? clean(next) : next; });
}
export function renameSection(fields: FieldConfig[], from: string, to: string): FieldConfig[] {
  const t = to.trim().replace(/\s+/g, ' ');
  return fields.map(f => ((f.section ?? '') === from ? (() => { const { section: _s, ...rest } = f; return t ? { ...rest, section: t } : rest; })() : f));
}
export const removeField = (fields: FieldConfig[], key: string): FieldConfig[] => fields.filter(f => f.key !== key);
/** Fields a published record type already has: their key and type are locked (records may use them) and they cannot be removed, only hidden. */
export const lockedKeys = (published: FieldConfig[] | undefined): Set<string> => new Set((published ?? []).map(f => f.key));
