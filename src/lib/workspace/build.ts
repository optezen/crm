import type { IndustryTemplate, ModuleConfig, WorkspaceConfig } from './types.ts';

export const slug = (s: string) => s.toLowerCase().replace(/&/g, ' ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

// Modules whose backend does not exist yet. Shown as planned, never as working features.
const PLANNED = [/inventory/i, /billing/i, /automation/i];
const FUTURE_LABEL: [RegExp, string][] = [[/inventory/i, 'Inventory'], [/billing/i, 'Billing'], [/automation/i, 'Workflows']];

export function validateOnboarding(input: { name?: unknown; industry?: unknown }, templates: Record<string, unknown>) {
  const errors: { name?: string; industry?: string } = {};
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2 || name.length > 80) errors.name = 'Enter a business name between 2 and 80 characters.';
  const industry = typeof input.industry === 'string' ? input.industry : '';
  if (!Object.hasOwn(templates, industry)) errors.industry = 'Choose one of the available industries.';
  return { ok: !errors.name && !errors.industry, errors, value: { name, industry } };
}

export function buildInitialConfig(template: IndustryTemplate, industry: string, businessName: string): WorkspaceConfig {
  const modules: ModuleConfig[] = template.modules.map(label => {
    const planned = PLANNED.some(re => re.test(label));
    const future = FUTURE_LABEL.find(([re]) => re.test(label));
    return { key: slug(label), label: future ? future[1] : label, status: planned ? 'planned' : 'active' };
  });
  return {
    schemaVersion: 1,
    businessName,
    industryTemplate: industry,
    modules,
    objects: template.records.map(r => ({
      key: slug(r.label), label: r.label,
      fields: r.fields.map(f => ({ key: f, label: humanize(f), kind: 'text' as const })),
    })),
    pipeline: { stages: [...template.pipeline] },
  };
}
