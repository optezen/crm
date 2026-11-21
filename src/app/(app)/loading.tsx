/** Shown while a screen loads: the same placeholder everywhere (no spinner-only states, no layout jump). */
export default function Loading() {
  return <div className="stack" role="status" aria-live="polite" aria-busy="true"><span className="sr-only">Loading…</span>
    <div className="skeleton" style={{ height: 28, width: 220 }} /><div className="skeleton" style={{ height: 16, width: 360, maxWidth: '100%' }} /><div className="grid"><div className="skeleton" style={{ height: 160 }} /><div className="skeleton" style={{ height: 160 }} /></div></div>;
}
