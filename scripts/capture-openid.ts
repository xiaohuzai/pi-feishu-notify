// 捕获你的 open_id：给机器人发一条消息，本脚本从长连接事件里抓取发送者 open_id。
// 用法：npx tsx scripts/capture-openid.ts
// 需要先配置 ~/.pi/agent/settings.json 的 feishu-notify 节（appId/appSecret）。
// 然后到飞书里给机器人发任意一条消息（例如"你好"），脚本会打印你的 open_id。
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

  const channel = lark.createLarkChannel({
    appId,
    appSecret,
    transport: 'websocket',
    loggerLevel: lark.LoggerLevel.error,
    policy: { requireMention: false },
  });

  console.log('🔌 长连接已启动，请在飞书里给机器人发送任意消息（例如"你好"）...');
  console.log('（5 分钟内未收到消息会自动退出）');

  const timeout = setTimeout(() => {
    console.log('⏰ 超时未收到消息，退出。');
    process.exit(1);
  }, 5 * 60 * 1000);

  channel.on('message', (msg) => {
    console.log('收到消息:', JSON.stringify({
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      senderName: msg.senderName,
      content: msg.content,
      replyToMessageId: msg.replyToMessageId,
    }, null, 2));
    console.log('\n✅ 你的 open_id（userId 配置项）：');
    console.log('   ' + msg.senderId);
    console.log('\n✅ 如果你用的是群聊，chat_id（chatId 配置项）：');
    console.log('   ' + msg.chatId);
    clearTimeout(timeout);
    setTimeout(() => process.exit(0), 500);
  });

  channel.on('error', (err) => {
    console.log('连接错误:', err.message);
  });

  channel.connect().catch((err) => {
    console.log('连接失败:', err.message ?? String(err));
    process.exit(1);
  });
}

main().catch((err) => {
  console.log('ERROR:', err.message ?? String(err));
  process.exit(1);
});
