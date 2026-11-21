import { Frame } from '../fixture';
import { ReminderSettings } from '../../../components/ReminderSettings';
import { parseReminderForm } from '../../../lib/operations/reminder-form';
import type { FormState } from '../../../components/ui/ActionForm';

// Sample data only. The action runs the REAL form validation (parseReminderForm) and reports what would be sent to reminder_settings_save.
async function save(_: FormState, f: FormData): Promise<FormState> {
  'use server';
  const p = parseReminderForm(f); if (!p.ok) return { error: p.error };
  return { ok: `Saved (sample): ${p.value.p_enabled ? 'on' : 'off'}; offsets ${p.value.p_offsets.join(', ')}; customer ${p.value.p_customer ? 'yes' : 'no'}.` };
}
export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  const { state } = await searchParams;
  return <Frame><h1>Reminders fixture</h1><ReminderSettings settings={null} timezone="Asia/Kolkata" whatsappConnected={state === 'connected'} canEdit={state !== 'readonly'} action={save} /></Frame>;
}
