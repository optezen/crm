import type { Result } from '../workspace/types.ts';
export type { Result };

/**
 * Triggers. Every trigger listed here has a real event emitted by the database. `module` (operations triggers only) is the operations module that must be
 * enabled in the published workspace configuration before an automation on the trigger can be PUBLISHED.
 */
export const TRIGGERS = [
  { event: 'record.created', label: 'A record is created in a module', scope: 'record', available: true },
  { event: 'record.updated', label: 'A record is updated in a module', scope: 'record', available: true },
  { event: 'lead.created', label: 'A lead is created', scope: 'lead', available: true },
  { event: 'lead.assigned', label: 'A lead is assigned', scope: 'lead', available: true },
  { event: 'task.created', label: 'A follow-up task is created', scope: 'task', available: true },
  { event: 'task.completed', label: 'A follow-up task is completed', scope: 'task', available: true },
  { event: 'appointment.created', label: 'An appointment is booked', scope: 'appointment', available: true, module: 'appointments' },
  { event: 'appointment.rescheduled', label: 'An appointment is rescheduled', scope: 'appointment', available: true, module: 'appointments' },
  { event: 'appointment.cancelled', label: 'An appointment is cancelled', scope: 'appointment', available: true, module: 'appointments' },
  { event: 'appointment.completed', label: 'An appointment is completed', scope: 'appointment', available: true, module: 'appointments' },
  { event: 'inventory.low_stock', label: 'A product falls to its low-stock level', scope: 'inventory', available: true, module: 'inventory' },
  { event: 'inventory.stock_received', label: 'Stock is received', scope: 'inventory', available: true, module: 'inventory' },
  { event: 'inventory.stock_adjusted', label: 'Stock is adjusted', scope: 'inventory', available: true, module: 'inventory' },
  { event: 'inventory.stock_consumed', label: 'Stock is consumed', scope: 'inventory', available: true, module: 'inventory' },
  { event: 'inventory.stock_transferred', label: 'Stock is transferred between locations', scope: 'inventory', available: true, module: 'inventory' },
  { event: 'invoice.created', label: 'An invoice draft is created', scope: 'invoice', available: true, module: 'billing' },
  { event: 'invoice.issued', label: 'An invoice is issued', scope: 'invoice', available: true, module: 'billing' },
  { event: 'invoice.paid', label: 'An invoice is fully paid', scope: 'invoice', available: true, module: 'billing' },
  { event: 'payment.received', label: 'A payment is recorded', scope: 'payment', available: true, module: 'billing' },
  { event: 'payment.refunded', label: 'A refund is recorded', scope: 'payment', available: true, module: 'billing' },
  { event: 'credit_note.issued', label: 'A credit note is issued', scope: 'invoice', available: true, module: 'billing' },
] as const;
export type TriggerEvent = (typeof TRIGGERS)[number]['event'];
export type Scope = 'lead' | 'task' | 'record' | 'appointment' | 'inventory' | 'invoice' | 'payment' | 'none';
export const scopeOf = (event: string): Scope => (event.startsWith('lead.') ? 'lead' : event.startsWith('task.') ? 'task' : event.startsWith('record.') ? 'record' : event.startsWith('appointment.') ? 'appointment'
  : event.startsWith('inventory.') ? 'inventory' : event.startsWith('invoice.') || event.startsWith('credit_note.') ? 'invoice' : event.startsWith('payment.') ? 'payment' : 'none');
/** The operations module an event belongs to (null for CRM / custom-module events). */
export const opsModuleOf = (event: string): 'appointments' | 'inventory' | 'billing' | null => { const t = TRIGGERS.find(x => x.event === event); return t && 'module' in t ? t.module : null; };

export const CONDITION_OPS = ['eq', 'neq', 'contains', 'empty', 'not_empty', 'gt', 'lt', 'before', 'after'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const OP_LABEL: Record<ConditionOp, string> = { eq: 'equals', neq: 'does not equal', contains: 'contains', empty: 'is empty', not_empty: 'is not empty', gt: 'is greater than', lt: 'is less than', before: 'is before', after: 'is after' };
export type Condition = { field: string; op: ConditionOp; value?: string | number | boolean };
export type Match = { op: 'and' | 'or'; conditions: Condition[] };

export const ACTION_TYPES = ['assign_round_robin', 'assign_lead', 'create_task', 'update_task_status', 'update_record', 'notify', 'wait', 'request_integration'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export const ACTION_LABEL: Record<ActionType, string> = {
  assign_round_robin: 'Assign the lead (round-robin)', assign_lead: 'Assign the lead to a specific person', create_task: 'Create a follow-up task',
  update_task_status: 'Update the task status', update_record: 'Update a field of the record', notify: 'Notify a team member in Optizen', wait: 'Wait / delay', request_integration: 'Request an external message',
};
export const RR_ROLES = ['employee', 'manager', 'admin'] as const;
export const CHANNELS = ['whatsapp', 'sms', 'email', 'webhook'] as const;
export type Action =
  | { type: 'assign_round_robin'; roles?: string[]; only_if_unassigned?: boolean }
  | { type: 'assign_lead'; user_id: string }
  | { type: 'create_task'; title: string; due_in_days: number; owner: string }
  | { type: 'update_task_status'; status: 'done' | 'open'; outcome?: string }
  | { type: 'update_record'; field: string; value: string | number | boolean }
  | { type: 'notify'; recipient: string; title: string; body?: string }
  | { type: 'wait'; minutes?: number; until_field?: string }
  | { type: 'request_integration'; channel: string; message: string; to?: 'lead_contact' };
export type AutomationDefinition = { trigger: { event: string; object?: string }; match?: Match; actions: Action[] };

/** Fields each trigger scope exposes to conditions and templates (record fields come from the module definition). */
export const LEAD_FIELDS = [['lead.stage', 'Lead stage'], ['lead.source', 'Lead source'], ['lead.summary', 'Lead summary'], ['lead.assigned_to', 'Lead assignee'], ['lead.full_name', 'Contact name'], ['lead.phone', 'Contact phone'], ['lead.email', 'Contact email'], ['lead.created_at', 'Lead created date']] as const;
export const APPOINTMENT_FIELDS = [['appointment.status', 'Appointment status'], ['appointment.type', 'Appointment type'], ['appointment.starts_at', 'Starts at'], ['appointment.ends_at', 'Ends at'], ['appointment.staff_id', 'Staff member'], ['appointment.reschedule_count', 'Times rescheduled']] as const;
export const INVENTORY_FIELDS = [['inventory.sku', 'SKU'], ['inventory.name', 'Product name'], ['inventory.on_hand', 'Quantity on hand'], ['inventory.threshold', 'Low-stock threshold'], ['inventory.quantity', 'Quantity moved']] as const;
export const INVOICE_FIELDS = [['invoice.number', 'Invoice number'], ['invoice.status', 'Invoice status'], ['invoice.currency', 'Currency'], ['invoice.total', 'Invoice total'], ['invoice.balance_due', 'Balance due'], ['invoice.due_date', 'Due date']] as const;
export const PAYMENT_FIELDS = [['payment.amount', 'Payment amount'], ['payment.method', 'Payment method'], ['payment.currency', 'Currency'], ['payment.balance_due', 'Balance after payment'], ['payment.source', 'Source (manual or provider)']] as const;
export const TASK_FIELDS = [['task.title', 'Task title'], ['task.status', 'Task status'], ['task.owner_id', 'Task owner'], ['task.due_date', 'Task due date'], ['task.outcome', 'Task outcome']] as const;

export type WorkflowRow = { id: string; name: string; enabled: boolean; publishedVersion: number | null; updatedAt: string };
export type RunStep = { stepIndex: number; actionType: string; status: 'succeeded' | 'failed'; result: Record<string, unknown> | null; error: string | null };
export type RunRow = { id: string; status: string; attempts: number; stepIndex: number; nextAttemptAt: string; lastError: string | null; createdAt: string; finishedAt: string | null; version: number; steps: RunStep[] };
