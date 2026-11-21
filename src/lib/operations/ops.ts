import type { OperationsConfig, OpsModuleKey, Role, WorkspaceConfig } from '../workspace/types.ts';

export const OPS_MODULES: { key: OpsModuleKey; label: string; href: string; blurb: string }[] = [
  { key: 'appointments', label: 'Appointments', href: '/work/appointments', blurb: 'Appointment types, staff hours, a booking calendar and conflict-free scheduling.' },
  { key: 'inventory', label: 'Inventory', href: '/work/inventory', blurb: 'Products, locations, stock receipts, adjustments, transfers and consumption with an immutable ledger.' },
  { key: 'billing', label: 'Billing', href: '/work/billing', blurb: 'Invoices with taxes and discounts, manual payments, credit notes and refunds.' },
];
export const OPS_DEFAULTS: Required<{ [K in OpsModuleKey]: NonNullable<OperationsConfig[K]> }> = {
  appointments: { enabled: true, timezone: 'UTC', enforce_working_hours: true },
  inventory: { enabled: true, allow_negative_stock: false, track_batches: false, track_expiry: false, block_expired: true },
  billing: { enabled: true, currency: 'INR', invoice_prefix: 'INV', credit_note_prefix: 'CN', default_due_days: 14, taxes: [] },
};
export const opsEnabled = (c: Pick<WorkspaceConfig, 'operations'>, m: OpsModuleKey) => c.operations?.[m]?.enabled === true;
/** Who may open each module's screens (the database enforces the same rules on every write and read). */
export const opsAccess = (role: Role, m: OpsModuleKey) => (m === 'billing' ? role !== 'employee' : true);
export const opsManage = (role: Role) => role === 'owner' || role === 'admin' || role === 'manager';
