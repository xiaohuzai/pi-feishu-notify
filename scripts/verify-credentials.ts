// 验证飞书应用凭证：从 settings.json 读取配置，获取 tenant_access_token 确认凭证有效。
// 用法：npx tsx scripts/verify-credentials.ts
// 需要先配置 ~/.pi/agent/settings.json 的 feishu-notify 节（appId/appSecret）。
import * as lark from '@larksuiteoapi/node-sdk';
import { loadConfig } from '../src/config.js';
import { resolveEnvVars } from '../src/config.js';

async function main() {
  const cfg = loadConfig(process.cwd());
  const appId = resolveEnvVars(cfg.appId ?? '') as string;
  const appSecret = resolveEnvVars(cfg.appSecret ?? '') as string;
  if (!appId || !appSecret) {
    console.error('未找到凭证：请先在 settings.json 配置 feishu-notify.appId / appSecret');
    process.exit(1);
  }
  const client = new lark.Client({ appId, appSecret });
  const resp = await client.auth.tenantAccessToken.internal({
    data: { app_id: appId, app_secret: appSecret },
  });
  if (resp.code === 0 && resp.tenant_access_token) {
    console.log(`OK 凭证有效（expire=${resp.expire}s）`);
  } else {
    console.log(`FAIL code=${resp.code} msg=${resp.msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.log('ERROR:', err.message ?? String(err));
  process.exit(1);
});
