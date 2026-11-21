'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { callOps } from '../app/(app)/work/ops-actions';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/** Weekly working hours for one staff member (one interval per day here; leave blank for a day off). Saved as a whole; overlaps are refused by the database. */
export function HoursEditor({ userId, label, initial }: { userId: string; label: string; initial: { weekday: number; start_minute: number; end_minute: number }[] }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [rows, setRows] = useState(() => DAYS.map((_, d) => { const h = initial.find(x => x.weekday === d); return { start: h ? hhmm(h.start_minute) : '', end: h ? hhmm(h.end_minute) : '' }; }));
  const save = () => start(async () => {
    const hours = rows.flatMap((r, d) => (r.start && r.end ? [{ weekday: d, start: r.start, end: r.end }] : []));
    const r = await callOps('staff_hours_set', { p_user: userId, p_hours: hours }, 'Working hours saved.'); setMsg({ ok: r.ok, text: r.ok ? r.message : r.error }); if (r.ok) router.refresh();
  });
  return <details><summary>{label}{initial.length === 0 && <span className="tag" style={{ marginLeft: 8 }}>no hours set</span>}</summary>
    <div className="stack" style={{ gap: 8 }}>{rows.map((r, d) => <div className="inline" key={d}><span style={{ width: 96 }}>{DAYS[d]}</span>
      <input className="input" style={{ width: 120 }} type="time" aria-label={`${label} ${DAYS[d]} start`} value={r.start} onChange={e => setRows(rows.map((x, i) => (i === d ? { ...x, start: e.target.value } : x)))} /><span>to</span>
      <input className="input" style={{ width: 120 }} type="time" aria-label={`${label} ${DAYS[d]} end`} value={r.end} onChange={e => setRows(rows.map((x, i) => (i === d ? { ...x, end: e.target.value } : x)))} /></div>)}
      <div className="row"><button type="button" className="btn primary" disabled={pending} onClick={save}>Save hours</button>{msg && <span role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'ok' : 'err'}>{msg.text}</span>}</div></div></details>;
}
