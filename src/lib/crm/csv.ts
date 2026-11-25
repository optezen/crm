// Pure CSV reading for the lead import. Excel: File > Save As > "CSV UTF-8".
import { LEAD_SOURCES } from './types.ts';

/** RFC 4180-style parser: quoted cells, doubled quotes, commas/newlines inside quotes, BOM, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

const ALIAS: Record<string, string> = { name: 'fullName', fullname: 'fullName', 'full name': 'fullName', 'lead name': 'fullName', phone: 'phone', mobile: 'phone', 'phone number': 'phone', email: 'email', 'e-mail': 'email', 'email address': 'email', source: 'source', stage: 'stage', notes: 'summary', note: 'summary', summary: 'summary' };
export const MAX_IMPORT_ROWS = 500;

/** Header row + data rows -> lead inputs (still validated per row by createLead). Unknown columns are ignored; an unknown source becomes "other". */
export function leadsFromCsv(text: string): { ok: true; rows: { line: number; data: Record<string, string> }[] } | { ok: false; error: string } {
  const all = parseCsv(text);
  if (all.length < 2) return { ok: false, error: 'The file needs a header row and at least one lead.' };
  const cols = all[0].map(h => ALIAS[h.trim().toLowerCase()] ?? '');
  if (!cols.includes('fullName')) return { ok: false, error: 'Add a "Name" column (other columns: Phone, Email, Source, Stage, Notes).' };
  if (all.length - 1 > MAX_IMPORT_ROWS) return { ok: false, error: `Import up to ${MAX_IMPORT_ROWS} leads at a time; this file has ${all.length - 1}. Split it and import the parts.` };
  const rows = all.slice(1).map((r, i) => {
    const data: Record<string, string> = {};
    cols.forEach((k, j) => { if (k && (r[j] ?? '').trim() !== '') data[k] = r[j].trim(); });
    if (data.source) { const v = data.source.toLowerCase().replace(/[\s-]+/g, '_'); data.source = (LEAD_SOURCES as readonly string[]).includes(v) ? v : 'other'; }
    return { line: i + 2, data };
  });
  return { ok: true, rows };
}
