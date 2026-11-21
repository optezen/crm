// Which platform-level settings are configured. Tenants never provide these; the operator sets them once per deployment.
export type PlatformEnv = Record<string, string | undefined>;
/** From Meta's lead-retrieval and leadgen-webhook guides: Page listing/engagement, webhook subscription (pages_manage_metadata), reading leads (leads_retrieval) and the ad permissions the guide lists. Each needs App Review (and Business Verification for Advanced Access) before non-test users can grant it. */
export const META_PERMISSIONS = ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'leads_retrieval', 'ads_management', 'pages_manage_ads'] as const;

export function missingFor(feature: 'meta' | 'whatsapp' | 'forms' | 'encryption' | 'payments', env: PlatformEnv = process.env): string[] {
  const need: Record<string, string[]> = {
    forms: [],
    encryption: ['INTEGRATION_ENCRYPTION_KEY'],
    meta: ['META_APP_ID', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN', 'INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_GATEWAY_SECRET', 'NEXT_PUBLIC_SITE_URL'],
    whatsapp: ['INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_GATEWAY_SECRET'],
    payments: ['INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_GATEWAY_SECRET', 'NEXT_PUBLIC_SITE_URL'],
  };
  return need[feature]!.filter(k => !env[k]);
}
