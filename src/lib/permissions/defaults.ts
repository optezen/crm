// TypeScript mirror of public.perm_default (migration 0014). Used only to show which boxes can be ticked: the database enforces the rules, and a parity test keeps them identical.
export const PERM_MODULES = ['leads', 'contacts', 'billing_contacts', 'tasks', 'appointments', 'inventory', 'billing', 'dashboards', 'reports', 'integrations', 'automations', 'team'] as const;
export const PERM_ACTIONS = ['view', 'create', 'edit', 'archive', 'export', 'assign', 'approve'] as const;
export type PermModule = string; export type PermAction = (typeof PERM_ACTIONS)[number];
export const MODULE_LABEL: Record<string, string> = { leads: 'Leads', contacts: 'Contact details (phone, email)', billing_contacts: 'Customer contact details on invoices', tasks: 'Follow-up tasks', appointments: 'Appointments', inventory: 'Inventory', billing: 'Billing', dashboards: 'Dashboards', reports: 'Reports', integrations: 'Connections', automations: 'Automations', team: 'Team' };
export const SCOPE_MODULES = ['leads', 'tasks', 'appointments', 'billing'];
export const SCOPES = [['all', 'All records'], ['team', 'My branch team'], ['assigned', 'Assigned to me'], ['own', 'Created by me']] as const;
export function permDefault(role: string, module: string, action: string): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role === 'manager') return ['integrations', 'automations', 'team'].includes(module) ? action === 'view' : true;
  switch (module) {
    case 'leads': return ['view', 'create', 'edit', 'assign'].includes(action);
    case 'tasks': case 'appointments': return ['view', 'create', 'edit'].includes(action);
    case 'inventory': case 'dashboards': return ['view', 'create'].includes(action);
    case 'billing': case 'integrations': case 'automations': case 'team': return false;
    case 'reports': return action === 'view';
    default: return ['view', 'create', 'edit'].includes(action); // custom modules
  }
}
