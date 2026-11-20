// Pure record validation/normalization. Mirrors public.record_validate (migration 0006), which is the real gate.
import type { FieldConfig, ModuleConfig, ObjectConfig, Result, WorkspaceConfig } from '../workspace/types.ts';
import type { RecordData, RecordListParams, RecordValue } from './types.ts';

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });
const empty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
export const activeFields = (o: ObjectConfig) => o.fields.filter(f => !f.archived);

/** The record type behind an active custom module, or null. Core modules (overview, leads) are never record types. */
export function findModule(config: WorkspaceConfig, key: string): { module: ModuleConfig; object: ObjectConfig } | null {
  if (key === 'overview' || key === 'leads') return null;
  const module = config.modules.find(m => m.key === key && m.status === 'active');
  const object = config.objects.find(o => o.key === key);
  return module && object ? { module, object } : null;
}

function normalizeOne(f: FieldConfig, v: unknown, existing: unknown): Result<RecordValue> {
  const bad = (msg: string) => fail(`"${f.label}" ${msg}`);
  switch (f.kind) {
    case 'text': { if (typeof v !== 'string') return bad('must be text.'); const s = v.trim(); return s.length > 2000 ? bad('must be at most 2000 characters.') : { ok: true, value: s }; }
    case 'number': case 'currency': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('must be a number.');
      if (Math.abs(v) >= 1e15) return bad('is too large.');
      if (f.kind === 'currency' && Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) return bad('can have at most 2 decimal places.');
      return { ok: true, value: v };
    }
    case 'date': {
      if (typeof v !== 'string') return bad('must be a date.');
      const s = v.trim(), d = new Date(`${s}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s || d.getUTCFullYear() < 1900 || d.getUTCFullYear() > 2200) return bad('must be a valid date (YYYY-MM-DD).');
      return { ok: true, value: s };
    }
    case 'choice': { if (typeof v !== 'string') return bad('must be one of the listed options.'); const s = v.trim(); return (f.options ?? []).includes(s) || existing === s ? { ok: true, value: s } : bad('must be one of the listed options.'); }
    case 'yes_no': return typeof v === 'boolean' ? { ok: true, value: v } : bad('must be yes or no.');
    case 'phone': { if (typeof v !== 'string') return bad('must be a phone number.'); const s = v.replace(/[\s().-]/g, ''); return /^\+?[0-9]{7,15}$/.test(s) ? { ok: true, value: s } : bad('must be a valid phone number (7 to 15 digits, optional leading +).'); }
    case 'email': { if (typeof v !== 'string') return bad('must be an email address.'); const s = v.trim().toLowerCase(); return s.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? { ok: true, value: s } : bad('must be a valid email address.'); }
  }
}

/**
 * Validates `input` (typed values keyed by field key; null/empty clears) against the record type and returns the merged data to store.
 * Unknown and hidden fields are rejected; required fields are checked on the merged result.
 */
export function validateRecord(object: ObjectConfig, input: Record<string, unknown>, existing: RecordData = {}): Result<RecordData> {
  const out: RecordData = { ...existing };
  for (const [key, raw] of Object.entries(input)) {
    const f = object.fields.find(x => x.key === key);
    if (!f) return fail(`Unknown field "${key}".`);
    if (f.archived) return fail(`The field "${f.label}" is hidden and cannot be edited.`);
    if (empty(raw)) { delete out[key]; continue; }
    const r = normalizeOne(f, raw, existing[key]);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  for (const f of activeFields(object)) if (f.required && !(f.key in out)) return fail(`"${f.label}" is required.`);
  return JSON.stringify(out).length > 20000 ? fail('This record is too large.') : { ok: true, value: out };
}

/** Turns submitted form values (`f_<key>`) into typed input for every visible field. Checkboxes: present = true, absent = false. */
export function parseRecordForm(object: ObjectConfig, get: (name: string) => unknown): Result<Record<string, unknown>> {
  const input: Record<string, unknown> = {};
  for (const f of activeFields(object)) {
    const v = get(`f_${f.key}`);
    if (f.kind === 'yes_no') { input[f.key] = v === 'on' || v === 'true'; continue; }
    if (f.kind === 'number' || f.kind === 'currency') {
      if (empty(v)) { input[f.key] = null; continue; }
      const n = typeof v === 'string' ? Number(v.trim().replace(/,/g, '')) : NaN;
      if (!Number.isFinite(n)) return fail(`"${f.label}" must be a number.`);
      input[f.key] = n; continue;
    }
    input[f.key] = typeof v === 'string' ? v : null;
  }
  return { ok: true, value: input };
}

/** Never throws: junk in the query string falls back to defaults. Only dropdown and checkbox fields are filterable. */
export function parseRecordListParams(sp: Record<string, string | string[] | undefined>, object: ObjectConfig): RecordListParams {
  const one = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ''; };
  const page = Number.parseInt(one('page'), 10);
  const filters: Record<string, string> = {};
  for (const f of activeFields(object)) {
    const v = one(`f_${f.key}`);
    if (f.kind === 'choice' && (f.options ?? []).includes(v)) filters[f.key] = v;
    if (f.kind === 'yes_no' && (v === 'yes' || v === 'no')) filters[f.key] = v;
  }
  return { page: Number.isInteger(page) && page >= 1 && page <= 10000 ? page : 1, q: one('q').replace(/[%_,()"\\*]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80), filters };
}

export function formatValue(f: FieldConfig, v: RecordValue | undefined): string {
  if (v === undefined) return '';
  if (f.kind === 'yes_no') return v ? 'Yes' : 'No';
  if (f.kind === 'currency' && typeof v === 'number') { try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: f.currency ?? 'INR' }).format(v); } catch { return String(v); } }
  if (f.kind === 'date' && typeof v === 'string') return new Date(`${v}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return String(v);
}
