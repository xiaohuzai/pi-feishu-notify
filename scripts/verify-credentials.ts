// Verify Feishu app credentials: reads config from settings.json, fetches a tenant_access_token to confirm the credentials are valid.
// Usage: npx tsx scripts/verify-credentials.ts
// Requires the feishu-notify section (appId/appSecret) in ~/.pi/agent/settings.json first.
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../src/config.js';
import { resolveEnvVars } from '../src/config.js';

async function main() {
  const cfg = loadConfig(process.cwd());
  const appId = resolveEnvVars(cfg.appId ?? '') as string;
  const appSecret = resolveEnvVars(cfg.appSecret ?? '') as string;
  if (!appId || !appSecret) {
    console.error('Credentials not found: configure feishu-notify.appId / appSecret in settings.json first');
    process.exit(1);
  }
  const client = new lark.Client({ appId, appSecret });
  const resp = await client.auth.tenantAccessToken.internal({
    data: { app_id: appId, app_secret: appSecret },
  });
  if (resp.code === 0 && resp.tenant_access_token) {
    console.log(`OK credentials valid (expire=${resp.expire}s)`);
  } else {
    console.log(`FAIL code=${resp.code} msg=${resp.msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.log('ERROR:', err.message ?? String(err));
  process.exit(1);
});
