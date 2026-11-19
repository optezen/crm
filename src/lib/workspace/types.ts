export type Role = 'owner' | 'admin' | 'manager' | 'employee';
export const BUILDER_ROLES: readonly Role[] = ['owner', 'admin'];

export type ModuleStatus = 'active' | 'planned';
export type ModuleConfig = { key: string; label: string; status: ModuleStatus };
export type FieldConfig = { key: string; label: string; kind: 'text' };
export type ObjectConfig = { key: string; label: string; fields: FieldConfig[] };

/** Canonical, versioned workspace definition. Stored as jsonb in workspace_configuration_versions. */
export type WorkspaceConfig = {
  schemaVersion: 1;
  businessName: string;
  industryTemplate: string;
  modules: ModuleConfig[];
  objects: ObjectConfig[];
  pipeline: { stages: string[] };
};

export type Membership = { organizationId: string; role: Role };

/** Shape of an industries.json entry (the onboarding template). */
export type IndustryTemplate = {
  name: string;
  subtitle: string;
  modules: string[];
  records: { label: string; fields: string[] }[];
  pipeline: string[];
};

export type WorkspaceState =
  | { status: 'unconfigured' }
  | { status: 'unauthenticated' }
  | { status: 'no-organization'; userId: string }
  | { status: 'error'; message: string }
  | { status: 'ready'; userId: string; organizationId: string; role: Role; config: WorkspaceConfig };
