/**
 * pi-feishu-notify — pi 扩展入口
 *
 * pi 主对话 ⇄ 飞书双向桥，**不依赖 lark-cli**（基于官方 SDK 长连接）：
 *
 *  - 下行：agent_settled（任务结束）→ SDK 发送飞书通知，记录 message_id
 *  - 上行：飞书里回复通知 → SDK 长连接收到消息 → 按 replyToMessageId 反查
 *    目标 session → pi.sendUserMessage 回注指令，继续执行
 *
 * 进程级单例 FeishuClient（跨 session 共享 WebSocket consumer）。
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { loadConfig, canSend } from '../src/config.js';
import { getFeishuClient, type FeishuClient } from '../src/feishu.js';
import { NotificationRouter, ClaimDedup } from '../src/router.js';
import { SessionRegistry } from '../src/sessions.js';
import type { FeishuMessage, FeishuNotifyConfig } from '../src/types.js';

/** 记录收到消息的去重集合（进程内，避免 SDK 自身 dedup 外的重复触发）。 */
const seenMessages = new Set<string>();

function log(event: string, data?: Record<string, unknown>, level = 'INFO'): void {
  // 通过 console 输出到 stderr，避免污染 stdout 协议
  const line = `[feishu-notify] ${event}${data ? ` ${JSON.stringify(data)}` : ''}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
}

/** 是否应该处理这条上行消息（回复通知回注场景）。 */
function shouldHandle(
  msg: FeishuMessage,
  cfg: FeishuNotifyConfig,
): boolean {
  // 只看文本消息
  if (msg.rawContentType !== 'text') return false;
  // 忽略自己（机器人）发的消息
  if (msg.senderName && msg.senderName.startsWith('@')) return false;
  if (msg.senderName === 'pi-feishu-notify') return false;

  // 私聊：白名单（未配置则只允许 p2p 单聊）
  if (msg.chatType === 'p2p') {
    if (Array.isArray(cfg.allowedSenderIds) && cfg.allowedSenderIds.length > 0) {
      if (!cfg.allowedSenderIds.includes(msg.senderId)) return false;
    }
    return true;
  }
  // 群聊：必须在允许群列表内，且（可选）@ 机器人
  if (Array.isArray(cfg.allowedChatIds) && cfg.allowedChatIds.length > 0) {
    if (!cfg.allowedChatIds.includes(msg.chatId)) return false;
  } else {
    return false; // 群聊未配置 allowedChatIds 默认忽略
  }
  if (cfg.requireMention === true && !msg.mentionedBot) return false;
  return true;
}

/** 从回复消息里提取要回注的文本。 */
function extractReplyText(msg: FeishuMessage): string {
  return msg.content.trim();
}

/** 从 assistant 消息的 content 数组里提取纯文本（跳过 thinking / toolCall）。 */
function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

export default function feishuNotifyExtension(pi: ExtensionAPI): void {
  // 每个 session 关联的配置（session_start 时刷新）
  const configs = new Map<string, FeishuNotifyConfig>();
  const router = new NotificationRouter();
  const dedup = new ClaimDedup();
  const registry = new SessionRegistry();
  let client: FeishuClient | undefined;

  /** 获取当前 session 的 sid + 是否允许发送。 */
  function sessionInfo(ctx: ExtensionContext): { sid: string; cfg: FeishuNotifyConfig } {
    const sid = ctx.sessionManager.getSessionId();
    const cfg = configs.get(sid) ?? {};
    return { sid, cfg };
  }

  /** 订阅飞书长连接（进程级单例，首次调用建立）。 */
  function ensureSubscribed(cfg: FeishuNotifyConfig): void {
    if (!cfg.appId || !cfg.appSecret) return;
    if (client) return;
    client = getFeishuClient(cfg, (event, data, level) => log(event, data, level));
    client.subscribe((msg) => {
      void handleIncoming(msg);
    });
  }

  /** 处理一条上行飞书消息（回复通知 → 回注 session）。 */
  async function handleIncoming(msg: FeishuMessage): Promise<void> {
    if (seenMessages.has(msg.messageId)) return;
    seenMessages.add(msg.messageId);

    // 找到这条消息对应的配置（按 chatId/senderId 归属）
    const cfg = configForMessage(msg) ?? {};
    if (cfg.replyEnabled === false) return;
    if (!shouldHandle(msg, cfg)) return;

    // 必须是"回复了通知"的消息才回注
    const targetSid = router.lookup(msg.replyToMessageId ?? '');
    if (!targetSid) return;

    // 跨进程去重认领
    if (!dedup.claim(msg.messageId, targetSid)) return;

    const text = extractReplyText(msg);
    if (!text) return;

    log('reply-injected', { to: targetSid, from: msg.senderName ?? msg.senderId, text });
    // 回注到目标 session：优先用该 session 的 pi（同进程内 session 切换不适用，
    // 这里直接向当前 API 注入——因为单进程内 getSessionId 即目标）
    injectReply(targetSid, text, msg);
    router.remove(msg.replyToMessageId ?? '');
  }

  /** 反查一条消息属于哪个配置（用于会话绑定多个配置的场景）。 */
  function configForMessage(msg: FeishuMessage): FeishuNotifyConfig | undefined {
    // 简单场景：取最近注册的配置；多配置场景暂取第一个启用的
    for (const cfg of configs.values()) {
      if (canSend(cfg)) return cfg;
    }
    return undefined;
  }

  /** 回注指令到目标 session。 */
  function injectReply(sid: string, text: string, msg: FeishuMessage): void {
    try {
      const prompt =
        `[feishu-notify] 飞书用户${msg.senderName ? `「${msg.senderName}」` : ''}回复了通知，` +
        `请求：${text}`;
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      sendReceipt(sid, `已收到你的回复：「${text}」，正在处理…`);
    } catch (err) {
      log('inject-failed', { error: err instanceof Error ? err.message : String(err) }, 'ERROR');
    }
  }

  /** 发送回执（可选）。 */
  function sendReceipt(sid: string, text: string): void {
    const cfg = configs.get(sid);
    if (!cfg || cfg.receipt === false) return;
    void client?.sendText(text, { userId: cfg.userId, chatId: cfg.chatId }).then((r) => {
      if (!r.ok) log('receipt-failed', { error: r.error }, 'ERROR');
    });
  }

  // ── pi 事件钩子 ──────────────────────────────────────────────

  pi.on('session_start', (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const cfg = loadConfig(ctx.cwd);
    configs.set(sid, cfg);
    registry.register(sid, ctx.cwd);
    log('session-start', { sid });

    if (!cfg.enabled || !cfg.appId || !cfg.appSecret) {
      log('session-disabled', { sid, reason: !cfg.enabled ? 'enabled=false' : 'missing appId/appSecret' });
      return;
    }
    ensureSubscribed(cfg);
  });

  pi.on('agent_settled', (_event, ctx) => {
    const { sid, cfg } = sessionInfo(ctx);
    if (!cfg.enabled || !canSend(cfg)) return;

    // 只在空闲时通知（避免 stream 中打扰）
    if (!ctx.isIdle()) return;

    // 取最近一条 assistant 消息作为通知内容
    const branch = ctx.sessionManager.getBranch();
    let lastAssistant: string | undefined;
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === 'message' && entry.message.role === 'assistant') {
        lastAssistant = extractAssistantText(entry.message.content);
        break;
      }
    }
    const summary = lastAssistant ?? '任务已完成';
    const text = `✅ [pi] 任务完成\n${summary}\n\n回复本消息可继续指挥该会话。`;

    void client?.sendText(text, { userId: cfg.userId, chatId: cfg.chatId }).then((r) => {
      if (r.ok && r.messageId) {
        router.record(r.messageId, sid);
        log('notification-sent', { sid, messageId: r.messageId });
      } else {
        log('notification-failed', { sid, error: r.error }, 'ERROR');
      }
    });
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    configs.delete(sid);
    registry.unregister(sid);
    log('session-shutdown', { sid });
  });

  // ── 命令：手动发送通知 / 查看状态 ─────────────────────────────

  pi.registerCommand('feishu-notify', {
    description: '向飞书发送一条通知，或查看扩展状态',
    handler: async (args, ctx) => {
      const { sid, cfg } = sessionInfo(ctx);
      if (!args.trim()) {
        ctx.ui.notify(`feishu-notify: enabled=${!!cfg.enabled}, appId=${cfg.appId ? '✓' : '✗'}, connected=${client?.isConnected() ?? false}`, 'info');
        return;
      }
      if (!cfg.enabled || !canSend(cfg)) {
        ctx.ui.notify('feishu-notify: 未配置或已禁用（需要 appId/appSecret/userId）', 'warning');
        return;
      }
      const r = await client?.sendText(args.trim(), { userId: cfg.userId, chatId: cfg.chatId });
      if (r?.ok) {
        if (r.messageId) router.record(r.messageId, sid);
        ctx.ui.notify('已发送到飞书 ✓', 'info');
      } else {
        ctx.ui.notify(`发送失败: ${r?.error}`, 'error');
      }
    },
  });

  // 退出清理
  process.on('beforeExit', () => {
    for (const [sid] of configs) registry.unregister(sid);
  });
}
