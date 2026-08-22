// Capture your open_id: send the bot a message, this script grabs the sender's open_id from the long-connection events.
// Usage: npx tsx scripts/capture-openid.ts
// Requires the feishu-notify section (appId/appSecret) in ~/.pi/agent/settings.json first.
// Then send the bot any message in Feishu (e.g. "hello"); the script prints your open_id.
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

  const channel = lark.createLarkChannel({
    appId,
    appSecret,
    transport: 'websocket',
    loggerLevel: lark.LoggerLevel.error,
    policy: { requireMention: false },
  });

  console.log('🔌 Long connection started. Send the bot any message in Feishu (e.g. "hello")...');
  console.log('(Exits automatically if no message arrives within 5 minutes)');

  const timeout = setTimeout(() => {
    console.log('⏰ Timed out waiting for a message, exiting.');
    process.exit(1);
  }, 5 * 60 * 1000);

  channel.on('message', (msg) => {
    console.log('Message received:', JSON.stringify({
      messageId: msg.messageId,
      chatId: msg.chatId,
      chatType: msg.chatType,
      senderId: msg.senderId,
      senderName: msg.senderName,
      content: msg.content,
      replyToMessageId: msg.replyToMessageId,
    }, null, 2));
    console.log('\n✅ Your open_id (the userId setting):');
    console.log('   ' + msg.senderId);
    console.log('\n✅ If you use a group chat, the chat_id (the chatId setting):');
    console.log('   ' + msg.chatId);
    clearTimeout(timeout);
    setTimeout(() => process.exit(0), 500);
  });

  channel.on('error', (err) => {
    console.log('Connection error:', err.message);
  });

  channel.connect().catch((err) => {
    console.log('Connection failed:', err.message ?? String(err));
    process.exit(1);
  });
}

main().catch((err) => {
  console.log('ERROR:', err.message ?? String(err));
  process.exit(1);
});
