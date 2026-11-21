import type { SupabaseClient } from '@supabase/supabase-js';
import type { Role } from '../workspace/types.ts';

export const LEAD_SOURCES = ['walk_in', 'phone', 'website', 'whatsapp', 'referral', 'meta_ads', 'other'] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
export const SOURCE_LABEL: Record<LeadSource, string> = { walk_in: 'Walk-in', phone: 'Phone', website: 'Website', whatsapp: 'WhatsApp', referral: 'Referral', meta_ads: 'Meta ads', other: 'Other' };
export const PAGE_SIZE = 25;
export const MANAGER_ROLES: readonly Role[] = ['owner', 'admin', 'manager'];
export const ASSIGNABLE_ROLES = ['admin', 'manager', 'employee'] as const;

/** Domain events written to the `domain_events` outbox by the database functions (same transaction as the change). */
export const DOMAIN_EVENTS = ['lead.created', 'lead.updated', 'lead.stage_changed', 'lead.assigned', 'lead.note_added', 'task.created', 'task.completed', 'member.added', 'member.role_changed'] as const;
export type DomainEventName = (typeof DOMAIN_EVENTS)[number];

/**
 * Everything a CRM service call needs. The organization id is NOT input: the UI derives it from the user's membership
 * (getCrmContext); an integration adapter must build it the same way, from a membership row of an authenticated actor.
 * The database re-checks membership and role on every call regardless.
 */
export type CrmContext = { db: SupabaseClient; organizationId: string; userId: string; role: Role; stages: readonly string[] };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type LeadInput = { fullName: string; phone: string | null; email: string | null; source: LeadSource; summary: string | null };
export type NewLeadInput = LeadInput & { stage: string | null; assignedTo: string | null };
export type TaskInput = { leadId: string; title: string; ownerId: string | null; dueDate: string };

export type LeadListParams = { page: number; q: string; stage: string | null; source: LeadSource | null; assignee: 'me' | 'unassigned' | string | null };
export type LeadRow = { id: string; stage: string; source: LeadSource; summary: string | null; assignedTo: string | null; createdAt: string; updatedAt: string; contactId: string; fullName: string; contactHidden: boolean; phone: string | null; email: string | null; openTasks: number };
export type ActivityRow = { id: string; kind: string; body: string | null; meta: Record<string, unknown>; actorId: string | null; createdAt: string };
export type TaskRow = { id: string; leadId: string; title: string; ownerId: string; dueDate: string; status: 'open' | 'done'; outcome: string | null; completedAt: string | null };
export type MemberRow = { userId: string; role: Role; email: string };
