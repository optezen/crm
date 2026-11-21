import { ActionForm, type FormState } from '../ui/ActionForm';
import { Card } from '../ui/Card';
import { LocalTime } from '../ui/LocalTime';
import type { ConsentView } from '../../lib/crm/consent';

const SOURCE: Record<string, string> = { staff: 'Recorded by staff', website_form: 'Website form', customer_reply: 'Customer reply', import: 'Imported' };

/** WhatsApp consent for one customer. Messages from automations and reminders are sent only while this says "Opted in"; an opt-out is final until a person records a new opt-in. */
export function ConsentCard({ view, contactId, hasPhone, action }: { view: ConsentView; contactId: string; hasPhone: boolean; action: (prev: FormState, data: FormData) => Promise<FormState> }) {
  const cur = view.current;
  return <Card title="WhatsApp consent" description="Automatic WhatsApp messages and reminders go only to customers who agreed to receive them.">
    <div className="stack" style={{ gap: 12 }}>
      <p>{cur ? <span className={`badge ${cur.status === 'opted_in' ? '' : 'late'}`}>{cur.status === 'opted_in' ? 'Opted in' : 'Opted out'}</span> : <span className="badge done">No consent recorded</span>}{' '}
        <span className="muted">{cur ? <>{SOURCE[cur.source] ?? cur.source} · <LocalTime iso={cur.updatedAt} />{cur.note ? ` · ${cur.note}` : ''}</> : 'No WhatsApp message will be sent to this customer.'}</span></p>
      {!hasPhone && <p className="muted">There is no phone number on this lead, so nothing can be sent yet.</p>}
      {!view.whatsappReady && <p className="muted">WhatsApp is not connected for this workspace, so no message is sent today. You can still record consent now.</p>}
      <ActionForm action={action} submit="Save consent">
        <input type="hidden" name="contactId" value={contactId} />
        <div className="field"><label htmlFor="consent-status">Customer choice</label>
          <select id="consent-status" name="status" className="input" defaultValue={cur?.status === 'opted_out' ? 'opted_in' : 'opted_out'}>
            <option value="opted_in">Agreed to receive WhatsApp messages</option><option value="opted_out">Asked us to stop</option></select></div>
        <div className="field"><label htmlFor="consent-note">How did they say so? <span className="hint">(required when they agreed)</span></label><input id="consent-note" name="note" className="input" maxLength={300} placeholder="Asked on the phone on 22 Nov" /></div>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" name="confirm" /> <span>I confirm the customer told us this themselves.</span></label>
      </ActionForm>
      {view.history.length > 1 && <details><summary>History</summary><ul style={{ margin: 0, paddingLeft: 18 }}>{view.history.map((h, i) => <li key={i}><LocalTime iso={h.createdAt} /> · {h.status === 'opted_in' ? 'Opted in' : 'Opted out'} · {SOURCE[h.source] ?? h.source}{h.note ? ` · ${h.note}` : ''}</li>)}</ul></details>}
    </div>
  </Card>;
}
