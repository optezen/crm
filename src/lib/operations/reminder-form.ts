// Reminder settings form -> the arguments of reminder_settings_save. Validation here gives friendly messages; the database function re-checks everything and is the real gate.
export const OFFSET_CHOICES: [number, string][] = [[10080, '1 week before'], [2880, '2 days before'], [1440, '1 day before'], [240, '4 hours before'], [120, '2 hours before'], [60, '1 hour before'], [30, '30 minutes before']];
export type ReminderArgs = { p_enabled: boolean; p_offsets: number[]; p_staff: boolean; p_customer: boolean; p_template: string | null; p_language: string | null; p_quiet_from: string | null; p_quiet_to: string | null };
type Get = { getAll(k: string): unknown[]; get(k: string): unknown };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export function parseReminderForm(f: Get): { ok: true; value: ReminderArgs } | { ok: false; error: string } {
  const offsets = new Set<number>(); for (const v of f.getAll('offset')) { const n = Number(v); if (OFFSET_CHOICES.some(([m]) => m === n)) offsets.add(n); }
  const custom = String(f.get('customOffset') ?? '').trim(); if (custom) { const n = Number(custom); if (!Number.isInteger(n) || n < 5 || n > 10080) return { ok: false, error: 'A custom reminder time must be a whole number of minutes from 5 to 10080.' }; offsets.add(n); }
  const enabled = f.get('enabled') === 'on', staff = f.get('staff') === 'on', customer = f.get('customer') === 'on';
  if (enabled && offsets.size === 0) return { ok: false, error: 'Choose at least one reminder time.' }; if (offsets.size > 4) return { ok: false, error: 'Choose at most 4 reminder times.' };
  const template = String(f.get('template') ?? '').trim() || null, language = String(f.get('language') ?? '').trim() || null;
  if (language && !/^[a-z]{2}(_[A-Z]{2})?$/.test(language)) return { ok: false, error: 'Use a language code such as en or en_GB.' };
  if (customer && (!template || !language)) return { ok: false, error: 'Customer reminders need the name and language of a WhatsApp template that Meta has approved.' };
  const qf = String(f.get('quietFrom') ?? '').trim() || null, qt = String(f.get('quietTo') ?? '').trim() || null;
  if ((qf === null) !== (qt === null)) return { ok: false, error: 'Set both quiet-hours times, or neither.' }; if ((qf && !TIME.test(qf)) || (qt && !TIME.test(qt))) return { ok: false, error: 'Quiet hours must be times like 21:00.' };
  const list = [...offsets].sort((a, b) => b - a); if (list.length === 0) list.push(1440, 60); // nothing chosen while turned off: keep the defaults so the form re-opens sensibly
  return { ok: true, value: { p_enabled: enabled, p_offsets: list, p_staff: staff, p_customer: customer, p_template: template, p_language: language, p_quiet_from: qf, p_quiet_to: qt } };
}
