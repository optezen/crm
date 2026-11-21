// Types for the analytics query grammar. The grammar is validated and executed by PostgreSQL (analytics_build / analytics_run); the same JSON is what dashboards
// store, what reports run, what exports use and what the AI may propose. Nothing here is SQL.
export type Agg = 'count' | 'count_distinct' | 'sum' | 'avg' | 'min' | 'max';
export type Op = 'eq' | 'neq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'is_null' | 'not_null';
export type Bucket = 'day' | 'week' | 'month';
export type Range = 'last_7_days' | 'last_30_days' | 'last_90_days' | 'this_month' | 'last_month' | 'this_year' | 'next_7_days' | 'next_30_days' | 'custom';
export const RANGES: { value: Range; label: string }[] = [{ value: 'last_7_days', label: 'Last 7 days' }, { value: 'last_30_days', label: 'Last 30 days' }, { value: 'last_90_days', label: 'Last 90 days' }, { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' }, { value: 'this_year', label: 'This year' }, { value: 'next_7_days', label: 'Next 7 days' }, { value: 'next_30_days', label: 'Next 30 days' }];
export type Query = {
  source: string; metric: { agg: Agg; field?: string }; group_by?: { field: string; bucket?: Bucket }[]; filters?: { field: string; op: Op; value?: string | number | boolean | (string | number)[] }[];
  date?: { field: string; range: Range; from?: string; to?: string }; tz?: string; order?: { by: 'value' | 'group'; dir?: 'asc' | 'desc' }; limit?: number;
};
export type Column = { key: string; label: string; type: string; user?: boolean };
export type QueryResult = { columns: Column[]; rows: Record<string, string | number | boolean | null>[]; definition: string; row_count: number; source: string; module: string; truncated: boolean };
export const WIDGET_TYPES = ['kpi', 'line', 'bar', 'pie', 'table', 'funnel'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type Widget = { id?: string; type: WidgetType; title: string; query: Query; w: number; h: number; options?: Record<string, unknown> };
export type Dashboard = { id: string; name: string; description: string | null; visibility: 'personal' | 'organization'; owner_id: string; version: number; widgets: Widget[] };
export type CatalogField = { field: string; label: string; type: 'text' | 'number' | 'money' | 'date' | 'timestamp' | 'bool' | 'uuid'; groupable: boolean; filterable: boolean; aggregatable: boolean; money_fixed: string | null; user: boolean };
export type CatalogSource = { source: string; label: string; module: string; product_field: string | null; fields: CatalogField[] };
export type Catalog = { sources: CatalogSource[]; aggregations: Agg[]; ranges: Range[]; notes: string[] };
