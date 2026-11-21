// A small JSON-Schema subset used for BOTH the schema the model sees and the validation of what it sends back. Unknown keys are rejected at every
// level, strings/arrays/numbers are bounded, nothing is coerced. Tool arguments from the model are untrusted input.
export type Prop =
  | { type: 'string'; description?: string; minLength?: number; maxLength?: number; enum?: readonly string[]; pattern?: string }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: Prop; minItems?: number; maxItems?: number }
  | ObjectSchema
  | { type: 'free_object'; description?: string; maxBytes?: number }; // validated separately by its owner (e.g. the automation grammar)
export type ObjectSchema = { type: 'object'; description?: string; properties: Record<string, Prop>; required?: readonly string[] };

export type Checked = { ok: true; value: unknown } | { ok: false; error: string };
const fail = (path: string, msg: string): Checked => ({ ok: false, error: `${path || 'arguments'}: ${msg}` });

export function check(p: Prop, v: unknown, path = ''): Checked {
  switch (p.type) {
    case 'string': {
      if (typeof v !== 'string') return fail(path, 'must be a string');
      if (p.minLength !== undefined && v.trim().length < p.minLength) return fail(path, `must be at least ${p.minLength} characters`);
      if (p.maxLength !== undefined && v.length > p.maxLength) return fail(path, `must be at most ${p.maxLength} characters`);
      if (p.enum && !p.enum.includes(v)) return fail(path, `must be one of ${p.enum.join(', ')}`);
      if (p.pattern && !new RegExp(p.pattern).test(v)) return fail(path, 'has an invalid format');
      return { ok: true, value: v };
    }
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) return fail(path, 'must be an integer');
      if (p.minimum !== undefined && v < p.minimum) return fail(path, `must be at least ${p.minimum}`);
      if (p.maximum !== undefined && v > p.maximum) return fail(path, `must be at most ${p.maximum}`);
      return { ok: true, value: v };
    case 'boolean': return typeof v === 'boolean' ? { ok: true, value: v } : fail(path, 'must be true or false');
    case 'array': {
      if (!Array.isArray(v)) return fail(path, 'must be an array');
      if (p.minItems !== undefined && v.length < p.minItems) return fail(path, `needs at least ${p.minItems} item(s)`);
      if (p.maxItems !== undefined && v.length > p.maxItems) return fail(path, `allows at most ${p.maxItems} item(s)`);
      const out: unknown[] = [];
      for (const [i, x] of v.entries()) { const r = check(p.items, x, `${path}[${i}]`); if (!r.ok) return r; out.push(r.value); }
      return { ok: true, value: out };
    }
    case 'free_object':
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(path, 'must be an object');
      return JSON.stringify(v).length > (p.maxBytes ?? 30000) ? fail(path, 'is too large') : { ok: true, value: v };
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(path, 'must be an object');
      const o = v as Record<string, unknown>, out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) if (!(k in p.properties)) return fail(path ? `${path}.${k}` : k, 'is not an accepted argument');
      for (const k of p.required ?? []) if (o[k] === undefined) return fail(path ? `${path}.${k}` : k, 'is required');
      for (const [k, sub] of Object.entries(p.properties)) { if (o[k] === undefined) continue; const r = check(sub, o[k], path ? `${path}.${k}` : k); if (!r.ok) return r; out[k] = r.value; }
      return { ok: true, value: out };
    }
  }
}
/** The JSON Schema sent to the model (additionalProperties:false everywhere; our own `free_object` is rendered as a plain object). */
export function toJsonSchema(p: Prop): Record<string, unknown> {
  if (p.type === 'object') return { type: 'object', ...(p.description ? { description: p.description } : {}), properties: Object.fromEntries(Object.entries(p.properties).map(([k, v]) => [k, toJsonSchema(v)])), ...(p.required?.length ? { required: [...p.required] } : {}), additionalProperties: false };
  if (p.type === 'array') return { type: 'array', ...(p.description ? { description: p.description } : {}), items: toJsonSchema(p.items), ...(p.minItems !== undefined ? { minItems: p.minItems } : {}), ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}) };
  if (p.type === 'free_object') return { type: 'object', ...(p.description ? { description: p.description } : {}) };
  const { ...rest } = p; return { ...rest } as Record<string, unknown>;
}
