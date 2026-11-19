import { BUILDER_ROLES, type Membership, type Role } from './types.ts';

/**
 * Picks the active organization from the user's own memberships (loaded server-side under RLS).
 * `preferredOrgId` comes from a client cookie and is only a hint: honored iff it matches a membership.
 */
export function resolveMembership(memberships: Membership[], preferredOrgId?: string | null): Membership | null {
  return memberships.find(m => m.organizationId === preferredOrgId) ?? memberships[0] ?? null;
}

export const canBuild = (role: Role) => BUILDER_ROLES.includes(role);
