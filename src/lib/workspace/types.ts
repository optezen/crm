export type Role = 'owner' | 'admin' | 'manager' | 'employee';
export const BUILDER_ROLES: readonly Role[] = ['owner', 'admin'];

/** active: usable; planned: placeholder, no screens; archived: hidden everywhere, records kept. */
export type ModuleStatus = 'active' | 'planned' | 'archived';
export type ModuleConfig = { key: string; label: string; status: ModuleStatus };
/** `choice` is the dropdown and `yes_no` the checkbox; the ids are kept so existing configurations stay valid. */
export const FIELD_KINDS = ['text', 'number', 'date', 'choice', 'yes_no', 'phone', 'email', 'currency'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export const FIELD_KIND_LABEL: Record<FieldKind, string> = { text: 'Text', number: 'Number', date: 'Date', choice: 'Dropdown', yes_no: 'Checkbox', phone: 'Phone', email: 'Email', currency: 'Currency' };
export const DEFAULT_CURRENCY = 'INR';
/** `key` is the stable identifier records are stored under; renaming changes only `label`. `archived` hides the field without touching stored data. */
export type FieldConfig = { key: string; label: string; kind: FieldKind; required?: boolean; archived?: boolean; options?: string[]; currency?: string };
export type ObjectConfig = { key: string; label: string; fields: FieldConfig[] };

/** Modules the CRM engine runs on. Every workspace has them; they cannot be removed in Builder. */
export const CORE_MODULES = [{ key: 'overview', label: 'Overview' }, { key: 'leads', label: 'Leads' }] as const;

/**
 * Canonical, versioned workspace definition (jsonb in workspace_configuration_versions). One model for every business:
 * nothing here depends on an industry. `industryTemplate` exists only on definitions created before 0005 and is never read.
 */
export type WorkspaceConfig = {
  schemaVersion: 1;
  businessName: string;
  description?: string;
  /** Provenance only: which optional starting point (if any) the workspace was created from. */
  preset?: string;
  /** @deprecated legacy field on pre-0005 definitions; ignored. */
  industryTemplate?: string;
  modules: ModuleConfig[];
  objects: ObjectConfig[];
  pipeline: { stages: string[] };
};

export type Membership = { organizationId: string; role: Role };

/** An optional starting point from config/presets.json. Presets never restrict what a workspace can become. */
export type Preset = { key: string; name: string; summary: string; keywords: string[]; modules: string[]; records: { label: string; fields: string[] }[]; pipeline: string[] };

/** What the user picked in onboarding. `draft` is a full proposed config (e.g. from the AI drafter) and is always re-validated server-side. */
export type SetupChoice = { kind: 'blank' } | { kind: 'preset'; key: string } | { kind: 'draft'; definition: unknown };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type WorkspaceState =
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'no-organization'; userId: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; userId: string; organizationId: string; role: Role; config: WorkspaceConfig };
