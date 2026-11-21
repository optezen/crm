// Maintenance worker (the scheduled process): overdue-follow-up notifications, due appointment reminders, uncertain-message detection, housekeeping.
// One run at a time across all copies (advisory lock inside maintenance_tick). Idempotent: running it twice, or after a crash, never duplicates a notification or a reminder.
import { start } from './runtime.mjs';
await start({ name: 'maintenance', pollMs: Number(process.env.MAINTENANCE_POLL_MS) || 60000, tick: async db => {
  const { data, error } = await db.rpc('maintenance_tick'); if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const n = (data.overdue_notifications ?? 0) + (data.reminders?.staff_sent ?? 0) + (data.reminders?.customer_queued ?? 0) + (data.uncertain_messages ?? 0);
  return { busy: false, stats: { overdue_notifications: data.overdue_notifications ?? 0, reminders_staff: data.reminders?.staff_sent ?? 0, reminders_customer_queued: data.reminders?.customer_queued ?? 0, reminders_skipped: data.reminders?.skipped ?? 0, uncertain_messages: data.uncertain_messages ?? 0, work_items: n } };
} });
