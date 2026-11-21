import { ActionForm, type FormState } from './ui/ActionForm';
import { Card } from './ui/Card';
import { OFFSET_CHOICES } from '../lib/operations/reminder-form';

export type ReminderSettingsRow = { enabled: boolean; offsets: number[]; notify_staff: boolean; notify_customer: boolean; whatsapp_template: string | null; whatsapp_language: string | null; quiet_from: string | null; quiet_to: string | null };
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : '');

/** Appointment reminders: staff get an in-app notification; customers get an approved WhatsApp template, only with a connected provider and recorded consent. */
export function ReminderSettings({ settings, timezone, whatsappConnected, canEdit, action }: { settings: ReminderSettingsRow | null; timezone: string; whatsappConnected: boolean; canEdit: boolean; action: (prev: FormState, data: FormData) => Promise<FormState> }) {
  const s: ReminderSettingsRow = settings ?? { enabled: false, offsets: [1440, 60], notify_staff: true, notify_customer: false, whatsapp_template: null, whatsapp_language: 'en', quiet_from: null, quiet_to: null };
  const known = new Set(OFFSET_CHOICES.map(([m]) => m)); const custom = s.offsets.find(o => !known.has(o));
  const summary = <p className="muted">{s.enabled ? `On: ${[...s.offsets].sort((a, b) => b - a).map(o => OFFSET_CHOICES.find(([m]) => m === o)?.[1] ?? `${o} minutes before`).join(', ')}. ` : 'Off. '}Staff reminders: {s.notify_staff ? 'yes' : 'no'}. Customer reminders: {s.notify_customer ? 'yes' : 'no'}. Times follow {timezone}.</p>;
  return <Card title="Appointment reminders" description={`Reminders are scheduled for every upcoming appointment, are moved or cancelled when it changes, and are never sent twice. Times use the workspace time zone (${timezone}).`}>
    {!canEdit ? <>{summary}<p className="muted">Only owners and admins can change reminder settings.</p></> : <ActionForm action={action} submit="Save reminder settings">
      <label className="row" style={{ gap: 8 }}><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> <strong>Send appointment reminders</strong></label>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ fontWeight: 600, fontSize: 13 }}>When (choose up to 4)</legend>
        <div className="row" style={{ gap: 16 }}>{OFFSET_CHOICES.map(([m, label]) => <label key={m} className="row" style={{ gap: 6 }}><input type="checkbox" name="offset" value={m} defaultChecked={s.offsets.includes(m)} /> {label}</label>)}</div>
        <div className="field" style={{ maxWidth: 260, marginTop: 8 }}><label htmlFor="customOffset">Another time (minutes before, 5–10080)</label><input id="customOffset" name="customOffset" type="number" inputMode="numeric" step={1} className="input" defaultValue={custom ?? ''} /></div></fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ fontWeight: 600, fontSize: 13 }}>Who is reminded</legend>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" name="staff" defaultChecked={s.notify_staff} /> The staff member (in-app notification)</label>
        <label className="row" style={{ gap: 8 }}><input type="checkbox" name="customer" defaultChecked={s.notify_customer} /> The customer (WhatsApp)</label>
        {s.notify_customer && !whatsappConnected && <p role="alert" className="err">WhatsApp is not connected, so customer reminders are skipped (with the reason shown on each reminder). Connect it in Builder → Connections.</p>}
        <p className="muted">Customer reminders need a connected WhatsApp provider, a template Meta has approved, a phone number and a recorded opt-in. They contain only the appointment type and the date and time: never notes, staff names or other details.</p>
        <div className="form-grid"><div className="field"><label htmlFor="template">Approved template name</label><input id="template" name="template" className="input" maxLength={120} defaultValue={s.whatsapp_template ?? ''} placeholder="appointment_reminder" /></div>
          <div className="field"><label htmlFor="language">Template language</label><input id="language" name="language" className="input" maxLength={5} defaultValue={s.whatsapp_language ?? 'en'} placeholder="en" /></div></div></fieldset>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend style={{ fontWeight: 600, fontSize: 13 }}>Quiet hours ({timezone})</legend>
        <p className="muted">Reminders due inside this window are held until it ends, or skipped if the appointment would already have started. Leave both empty for none.</p>
        <div className="form-grid"><div className="field"><label htmlFor="quietFrom">From</label><input id="quietFrom" name="quietFrom" type="time" className="input" defaultValue={hhmm(s.quiet_from)} /></div>
          <div className="field"><label htmlFor="quietTo">Until</label><input id="quietTo" name="quietTo" type="time" className="input" defaultValue={hhmm(s.quiet_to)} /></div></div></fieldset>
    </ActionForm>}
  </Card>;
}
