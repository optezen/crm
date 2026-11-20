import type { SupabaseClient } from '@supabase/supabase-js';
import type { FieldConfig, Role, WorkspaceConfig } from '../workspace/types.ts';

export type RecordValue = string | number | boolean;
export type RecordData = Record<string, RecordValue>;
export type RecordRow = { id: string; objectKey: string; data: RecordData; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string };

/** Like CrmContext: organization and role come from the signed-in user's membership, never from the request. `config` is the live published definition. */
export type RecordsContext = { db: SupabaseClient; organizationId: string; userId: string; role: Role; config: WorkspaceConfig };
export type RecordListParams = { page: number; q: string; filters: Record<string, string> };
export const RECORD_PAGE_SIZE = 25;
export type { FieldConfig };
