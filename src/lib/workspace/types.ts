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
export type FieldConfig = { key: string; label: string; kind: FieldKind; required?: boolean; archived?: boolean; options?: string[]; currency?: string; /** Help text shown under the input (max 200). */ description?: string; /** Heading the field is grouped under in forms (max 40); sections appear in order of first use. */ section?: string };
export const FIELD_DESC_MAX = 200, FIELD_SECTION_MAX = 40;
export const STAGE_COLORS = ['gray', 'green', 'blue', 'amber', 'red', 'purple'] as const;
export type StageColor = (typeof STAGE_COLORS)[number];
/** Display and transition rules for a stage, keyed by stage name. Requirements are enforced by the database when a lead MOVES into the stage. */
export type StageSettings = { color?: StageColor; requires_assignee?: boolean; requires_summary?: boolean };
/** A migration plan applied atomically at publish: leads in `from` (a stage the new pipeline no longer has) move to `to`. Covers renaming and merging; never silent. */
export type StageMove = { from: string; to: string };
export type PipelineConfig = { stages: string[]; stageSettings?: Record<string, StageSettings>; stageMoves?: StageMove[] };
export type ObjectConfig = { key: string; label: string; fields: FieldConfig[] };

/** Optional business-operations modules. Enablement and rules are part of the versioned configuration (drafts, publish, rollback); the data lives in ordinary tables. */
export type OpsModuleKey = 'appointments' | 'inventory' | 'billing';
export type TaxConfig = { key: string; name: string; rate: string };
export type OperationsConfig = {
  appointments?: { enabled: boolean; timezone?: string; enforce_working_hours?: boolean; fields?: FieldConfig[] };
  inventory?: { enabled: boolean; allow_negative_stock?: boolean; track_batches?: boolean; track_expiry?: boolean; block_expired?: boolean; fields?: FieldConfig[] };
  billing?: { enabled: boolean; currency?: string; invoice_prefix?: string; credit_note_prefix?: string; default_due_days?: number; taxes?: TaxConfig[] };
};

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
  pipeline: PipelineConfig;
  /** Optional operations modules (appointments, inventory, billing). Absent = all disabled. */
  operations?: OperationsConfig;
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
