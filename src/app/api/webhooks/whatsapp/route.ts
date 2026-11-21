import { handleProviderWebhook } from '../../../../lib/integrations/webhooks';
import { anonClient, supabaseReady } from '../../../../lib/integrations/anon';

export const dynamic = 'force-dynamic';
const handle = (req: Request) => {
  if (!supabaseReady()) return new Response('Not configured', { status: 503 });
  const db = anonClient();
  return handleProviderWebhook(req, 'whatsapp', { META_APP_SECRET: process.env.META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN: process.env.META_WEBHOOK_VERIFY_TOKEN, INTEGRATION_GATEWAY_SECRET: process.env.INTEGRATION_GATEWAY_SECRET }, args => db.rpc('integration_receive_webhook', args));
};
export const GET = handle, POST = handle;
