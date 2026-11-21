// Invoice PDF for ISSUED invoices, rendered ONLY from the frozen snapshot stored when the invoice was issued: it never recomputes a total, never reads current
// tax rates or contact data, and adds no wall-clock timestamp, so the same snapshot always yields the same bytes.
// Renderer: PDFKit with embedded Noto Sans (SIL Open Font License, assets/fonts) subsets for Latin, Latin Extended, Vietnamese, Greek, Cyrillic and Devanagari
// (shaped by the font engine). Characters in other scripts are not covered by the bundled fonts and are replaced by "?" (see UNSUPPORTED below and docs).
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import path from 'node:path';

type Line = { description: string; quantity: string | number; unit_price: string | number; discount: string | number; net: string | number; tax: string | number; line_total: string | number };
export type Snapshot = {
  number: string; business?: string; currency: string; issue_date: string; due_date: string; notes?: string | null; bill_to?: { name?: string | null; email?: string | null; phone?: string | null };
  lines: Line[]; tax_summary?: { name: string; rate: string; amount: string | number }[]; subtotal: string | number; discount_total: string | number; tax_total: string | number; total: string | number
};

const SCRIPTS = ['latin', 'latin-ext', 'vietnamese', 'cyrillic', 'cyrillic-ext', 'greek', 'greek-ext', 'devanagari'] as const;
const fontFile = (s: string, w: 400 | 700) => `noto-sans-${s === 'devanagari' ? 'devanagari-devanagari' : s}-${w}-normal.woff`;
const FONT_DIR = () => path.join(process.cwd(), 'assets', 'fonts');
const cache = new Map<string, Buffer>();
const load = (file: string) => { let b = cache.get(file); if (!b) { b = readFileSync(path.join(FONT_DIR(), file)); cache.set(file, b); } return b; };
/** Scripts the bundled fonts do not cover (not exhaustive): such characters print as "?". */
export const UNSUPPORTED = 'Arabic, Hebrew, Thai, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Odia, CJK and emoji';

const money = (v: string | number, cur: string) => `${cur} ${Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
const clip = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join('') + '.' : s; };

export async function invoicePdf(s: Snapshot): Promise<Buffer> {
  const W = 595.28, H = 841.89, M = 48;
  const issue = new Date(`${String(s.issue_date).slice(0, 10)}T00:00:00Z`);
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, font: undefined as never, compress: true, info: { Title: `Invoice ${s.number}`, Producer: 'Optizen', Creator: 'Optizen', CreationDate: issue, ModDate: issue } });
  const chunks: Buffer[] = []; doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  // register every subset (regular + bold); remember which characters each can draw
  const has: Record<string, (cp: number) => boolean> = {};
  for (const w of [400, 700] as const) for (const sc of SCRIPTS) { const n = `${sc}-${w}`; doc.registerFont(n, load(fontFile(sc, w))); doc.font(n); const f = (doc as unknown as { _font: { font: { hasGlyphForCodePoint(c: number): boolean } } })._font.font; has[n] = cp => f.hasGlyphForCodePoint(cp); }
  const order = (w: 400 | 700) => SCRIPTS.map(sc => `${sc}-${w}`);
  /** Splits text into runs, each drawn with ONE font that has every glyph in it (so the font's shaper can join Devanagari clusters). A run keeps its font while it can. */
  const runs = (str: string, w: 400 | 700): { font: string; text: string }[] => {
    const out: { font: string; text: string }[] = []; const fonts = order(w); let cur = fonts[0]!;
    for (const ch of Array.from(str.normalize('NFC'))) {
      const cp = ch.codePointAt(0)!; if (cp < 0x20 || cp === 0x7f) continue;
      let f = has[cur]!(cp) ? cur : fonts.find(n => has[n]!(cp));
      let c = ch; if (!f) { f = fonts[0]!; c = '?'; }
      const last = out[out.length - 1]; if (last && last.font === f) last.text += c; else out.push({ font: f, text: c }); cur = f;
    }
    return out;
  };
  let y = M; const page = () => { doc.addPage({ size: 'A4', margin: 0 }); y = M; };
  const width = (str: string, size: number, bold: boolean) => runs(str, bold ? 700 : 400).reduce((a, r) => a + doc.font(r.font).fontSize(size).widthOfString(r.text), 0);
  const text = (x: number, yy: number, str: string, size = 10, bold = false, align: 'left' | 'right' = 'left') => {
    let cx = align === 'right' ? x - width(str, size, bold) : x;
    for (const r of runs(str, bold ? 700 : 400)) { doc.font(r.font).fontSize(size).fillColor('#000').text(r.text, cx, yy, { lineBreak: false }); cx += doc.widthOfString(r.text); }
  };
  const rule = (yy: number) => { doc.lineWidth(0.7).moveTo(M, yy).lineTo(W - M, yy).strokeColor('#000').stroke(); };
  const header = () => { text(M, y, `Invoice ${s.number}`, 9); y += 18; };
  const need = (h: number) => { if (y + h > H - M - 40) { page(); header(); } };

  page();
  text(M, y, 'INVOICE', 22, true); text(W - M, y, s.number, 16, true, 'right'); y += 30;
  if (s.business) { text(M, y, clip(s.business, 60), 12, true); y += 18; }
  text(M, y, `Issue date: ${s.issue_date}`); text(M + 200, y, `Due date: ${s.due_date}`); y += 15; text(M, y, `Currency: ${s.currency}`); y += 24;
  text(M, y, 'Bill to', 9, true); y += 14;
  for (const l of [s.bill_to?.name, s.bill_to?.email, s.bill_to?.phone]) if (l) { text(M, y, clip(String(l), 70)); y += 14; }
  if (!s.bill_to?.name && !s.bill_to?.email && !s.bill_to?.phone) { text(M, y, 'No customer recorded'); y += 14; }
  y += 8; rule(y); y += 8;
  const X = { d: M, q: 300, p: 345, disc: 400, tax: 455, t: W - M };
  text(X.d, y, 'Description', 9, true); text(X.q + 28, y, 'Qty', 9, true, 'right'); text(X.p + 40, y, 'Unit price', 9, true, 'right'); text(X.disc + 40, y, 'Discount', 9, true, 'right'); text(X.tax + 36, y, 'Tax', 9, true, 'right'); text(X.t, y, 'Total', 9, true, 'right'); y += 16;
  for (const l of s.lines) {
    need(18);
    text(X.d, y, clip(l.description, 48)); text(X.q + 28, y, String(Number(l.quantity)), 10, false, 'right'); text(X.p + 40, y, Number(l.unit_price).toFixed(2), 10, false, 'right');
    text(X.disc + 40, y, Number(l.discount).toFixed(2), 10, false, 'right'); text(X.tax + 36, y, Number(l.tax).toFixed(2), 10, false, 'right'); text(X.t, y, Number(l.line_total).toFixed(2), 10, false, 'right'); y += 16;
  }
  need(120); rule(y); y += 10;
  const row = (label: string, v: string, bold = false) => { text(340, y, label, 10, bold); text(W - M, y, v, 10, bold, 'right'); y += 16; };
  row('Subtotal', money(s.subtotal, s.currency)); if (Number(s.discount_total) !== 0) row('Discounts', `-${money(s.discount_total, s.currency)}`);
  for (const t of s.tax_summary ?? []) row(`${clip(t.name, 24)} (${t.rate}%)`, money(t.amount, s.currency));
  if (!s.tax_summary?.length && Number(s.tax_total) !== 0) row('Tax', money(s.tax_total, s.currency));
  y += 2; rule(y); y += 8; row('Total', money(s.total, s.currency), true);
  if (s.notes) { y += 10; need(44); text(M, y, 'Notes', 9, true); y += 14; for (const ln of String(s.notes).split(/\r?\n/).slice(0, 12)) { need(15); text(M, y, clip(ln, 95)); y += 14; } }
  y += 14; need(16); text(M, y, 'Generated from the invoice as issued. Payments and credit notes are tracked separately and are not shown here.', 8);
  doc.end();
  return done;
}

/** Characters of `str` the bundled fonts cannot draw (they print as "?"). Used by tests and by callers that want to warn before issuing. */
export function unsupportedCharacters(str: string): string[] {
  const doc = new PDFDocument({ font: undefined as never, autoFirstPage: false }); const sets: ((cp: number) => boolean)[] = [];
  for (const sc of SCRIPTS) { doc.registerFont(`c-${sc}`, load(fontFile(sc, 400))); doc.font(`c-${sc}`); const f = (doc as unknown as { _font: { font: { hasGlyphForCodePoint(c: number): boolean } } })._font.font; sets.push(cp => f.hasGlyphForCodePoint(cp)); }
  return [...new Set(Array.from(str.normalize('NFC')).filter(ch => { const cp = ch.codePointAt(0)!; return cp >= 0x20 && cp !== 0x7f && !sets.some(h => h(cp)); }))];
}
