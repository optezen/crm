import raw from '../../config/industries.json';
export type IndustryKey = keyof typeof raw;
export type IndustryConfig = (typeof raw)[IndustryKey];
export const industries = raw;
export const industryKeys = Object.keys(raw) as IndustryKey[];
export const getIndustry = (key: IndustryKey): IndustryConfig => industries[key];
export function validateTemplate(config: IndustryConfig): string[] {
  const errors: string[] = [];
  if (!config.name) errors.push('Missing industry name');
  if (new Set(config.modules).size !== config.modules.length) errors.push('Duplicate modules');
  if (new Set(config.pipeline).size !== config.pipeline.length) errors.push('Duplicate pipeline stages');
  if (config.pipeline.length < 2) errors.push('Pipeline must have at least 2 stages');
  if (config.records.some(r => !r.label || !r.fields.length)) errors.push('Invalid record definitions');
  return errors;
}
