import type { Column, QueryResult } from './types.ts';

/** RFC 4180 CSV. Cells that a spreadsheet could execute as a formula (= + - @ tab CR) are prefixed with an apostrophe so exported data can never run as code. */
const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(result: Pick<QueryResult, 'columns' | 'rows' | 'definition'>): string {
  const cols: Column[] = result.columns;
  const head = cols.map(c => cell(c.label));
  const lines = result.rows.map(r => cols.map(c => cell(c.user ? r[`${c.key}_label`] ?? r[c.key] : r[c.key])).join(','));
  return ['# ' + result.definition.replace(/[\r\n]+/g, ' '), head.join(','), ...lines].join('\r\n') + '\r\n';
}
