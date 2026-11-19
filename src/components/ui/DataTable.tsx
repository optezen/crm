import type { ReactNode } from 'react';
export type Column<T> = { header: string; cell: (row: T) => ReactNode };
export function DataTable<T>({ caption, columns, rows, empty }: { caption: string; columns: Column<T>[]; rows: T[]; empty: string }) {
  return <div className="table-wrap" role="region" aria-label={caption} tabIndex={0}><table><caption className="sr-only">{caption}</caption>
    <thead><tr>{columns.map(c => <th key={c.header} scope="col">{c.header}</th>)}</tr></thead>
    <tbody>{rows.map((r, i) => <tr key={i}>{columns.map(c => <td key={c.header}>{c.cell(r)}</td>)}</tr>)}</tbody></table>
    {rows.length === 0 && <p className="empty">{empty}</p>}</div>;
}
