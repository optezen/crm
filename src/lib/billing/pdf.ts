// Minimal, dependency-free PDF writer for ISSUED invoices. It renders ONLY the frozen snapshot stored when the invoice was issued: it never recomputes a
// total, never reads current tax rates or contact data, and never adds a timestamp, so the same snapshot always produces the same bytes.
// Text uses the built-in Helvetica font (WinAnsi): characters outside Latin-1 are replaced with "?" (a known limitation for non-Latin names).
type Line = { description: string; quantity: string | number; unit_price: string | number; discount: string | number; net: string | number; tax: string | number; line_total: string | number };
export type Snapshot = {
  number: string; business?: string; currency: string; issue_date: string; due_date: string; notes?: string | null; bill_to?: { name?: string | null; email?: string | null; phone?: string | null };
  lines: Line[]; tax_summary?: { name: string; rate: string; amount: string | number }[]; subtotal: string | number; discount_total: string | number; tax_total: string | number; total: string | number;
};

const esc = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const money = (v: string | number, cur: string) => `${cur} ${Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…'.replace('…', '.') : s);

export function invoicePdf(s: Snapshot): Buffer {
  const W = 595, H = 842, M = 48; const pages: string[][] = [[]]; let y = H - M;
  const cur = () => pages[pages.length - 1]!;
  const text = (x: number, yy: number, str: string, size = 10, bold = false) => cur().push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${yy} Td (${esc(str)}) Tj ET`);
  const right = (xr: number, yy: number, str: string, size = 10, bold = false) => text(xr - str.length * size * (bold ? 0.56 : 0.5), yy, str, size, bold);
  const rule = (yy: number) => cur().push(`0.7 w ${M} ${yy} m ${W - M} ${yy} l S`);
  const need = (h: number) => { if (y - h < M + 40) { pages.push([]); y = H - M; header(); } };
  const header = () => { text(M, y, `Invoice ${s.number}`, 9); y -= 18; };

  text(M, y, 'INVOICE', 22, true); right(W - M, y, s.number, 16, true); y -= 26;
  if (s.business) { text(M, y, clip(s.business, 60), 12, true); y -= 16; }
  text(M, y, `Issue date: ${s.issue_date}`, 10); text(M + 200, y, `Due date: ${s.due_date}`, 10); y -= 14; text(M, y, `Currency: ${s.currency}`, 10); y -= 22;
  text(M, y, 'Bill to', 9, true); y -= 13;
  for (const l of [s.bill_to?.name, s.bill_to?.email, s.bill_to?.phone]) if (l) { text(M, y, clip(String(l), 70), 10); y -= 13; }
  if (!s.bill_to?.name && !s.bill_to?.email && !s.bill_to?.phone) { text(M, y, 'No customer recorded', 10); y -= 13; }
  y -= 10; rule(y + 6); y -= 8;
  const X = { d: M, q: 300, p: 345, disc: 400, tax: 455, t: W - M };
  text(X.d, y, 'Description', 9, true); right(X.q + 28, y, 'Qty', 9, true); right(X.p + 40, y, 'Unit price', 9, true); right(X.disc + 40, y, 'Discount', 9, true); right(X.tax + 36, y, 'Tax', 9, true); right(X.t, y, 'Total', 9, true); y -= 8; rule(y + 3); y -= 12;
  for (const l of s.lines) {
    need(16);
    text(X.d, y, clip(l.description, 48), 10); right(X.q + 28, y, String(Number(l.quantity)), 10); right(X.p + 40, y, Number(l.unit_price).toFixed(2), 10);
    right(X.disc + 40, y, Number(l.discount).toFixed(2), 10); right(X.tax + 36, y, Number(l.tax).toFixed(2), 10); right(X.t, y, Number(l.line_total).toFixed(2), 10); y -= 15;
  }
  need(110); rule(y + 6); y -= 8;
  const row = (label: string, v: string, bold = false) => { text(340, y, label, 10, bold); right(W - M, y, v, 10, bold); y -= 15; };
  row('Subtotal', money(s.subtotal, s.currency)); if (Number(s.discount_total) !== 0) row('Discounts', `-${money(s.discount_total, s.currency)}`);
  for (const t of s.tax_summary ?? []) row(`${clip(t.name, 24)} (${t.rate}%)`, money(t.amount, s.currency));
  if (!s.tax_summary?.length && Number(s.tax_total) !== 0) row('Tax', money(s.tax_total, s.currency));
  y -= 2; rule(y + 10); row('Total', money(s.total, s.currency), true);
  if (s.notes) { y -= 10; need(40); text(M, y, 'Notes', 9, true); y -= 13; for (const ln of String(s.notes).split(/\r?\n/).slice(0, 12)) { need(14); text(M, y, clip(ln, 95), 10); y -= 13; } }
  y -= 14; need(14); text(M, y, 'Generated from the invoice as issued. Payments and credit notes are tracked separately and are not shown here.', 8);

  // assemble objects: 1 catalog, 2 pages, 3 font, 4 bold font, then (page, content) pairs
  const objs: string[] = []; const kids: number[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'; objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'; objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((p, i) => { const pi = 5 + i * 2, ci = pi + 1; const content = p.join('\n'); kids.push(pi);
    objs[pi] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${ci} 0 R >>`;
    objs[ci] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`; });
  objs[2] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = Buffer.byteLength(out, 'latin1'); out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
