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
import { basename } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { loadConfig, canSend } from '../src/config.js';
import { getFeishuClient, type FeishuClient } from '../src/feishu.js';
import { NotificationRouter, ClaimDedup } from '../src/router.js';
import { SessionRegistry } from '../src/sessions.js';
import { passesDurationFilter, shouldLog, type LogVerbosity } from '../src/filter.js';
import { persistDiscovered } from '../src/settings.js';
import { loadDiscovered, recordDiscovered } from '../src/discovery.js';
import type { FeishuMessage, FeishuNotifyConfig } from '../src/types.js';

/** 记录收到消息的去重集合（进程内，避免 SDK 自身 dedup 外的重复触发）。 */
const seenMessages = new Set<string>();

/**
 * 统一的日志输出（全部走 stderr，避免污染 stdout 协议）。
 * 根据配置的 logLevel（日志详细度）过滤：
 *  - quiet   → 只输出 ERROR
 *  - normal  → 输出 WARN/ERROR（默认）
 *  - verbose → 输出全部（含 notification-sent 等 INFO 细节）
 *
 * 默认 normal：日常任务完成的 notification-sent 等 INFO 日志不再刷屏，
 * 减少对对话的干扰。
 */
function makeLog(cfg: FeishuNotifyConfig): (event: string, data?: Record<string, unknown>, severity?: string) => void {
  const verbosity: LogVerbosity = cfg.logLevel ?? 'normal';
  return (event, data, severity = 'INFO') => {
    if (!shouldLog(severity, verbosity)) return;
    const line = `[feishu-notify] ${event}${data ? ` ${JSON.stringify(data)}` : ''}`;
    // 一律写 stderr，避免污染 stdout 协议（TUI 下 stdout 被接管重定向）
    process.stderr.write(line + '\n');
  };
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
  const sessionCwds = new Map<string, string>();
  // 本次任务开始时间（agent_start 记录，agent_settled 判断时长用）
  const taskStarts = new Map<string, number>();
  // 用户手动静音的 session（/feishu-notify off）
  const muted = new Set<string>();
  // 自动识别的发送目标：用户在飞书给机器人发过消息后，这里会记录
  //  - discoveredUserId：最近一条 p2p 私聊的 senderId（open_id）
  //  - discoveredChatIds：收到过消息的 chatId → senderId 映射
  // 同时持久化到 ~/.pi/agent/feishu-notify-discovered.json，重启后仍能提示绑定
  let discoveredUserId: string | undefined;
  const discoveredChatIds = new Map<string, string>();
  let warnedAutoTarget = false;
  // 进程内一次性启动提示标记（/feishu-notify bind 提示只提示一次）
  let startupHintShown = false;
  {
    const st = loadDiscovered();
    discoveredUserId = st.userId;
    for (const cid of st.chatIds) discoveredChatIds.set(cid, cid);
  }
  const router = new NotificationRouter();
  const dedup = new ClaimDedup();
  const registry = new SessionRegistry();
  let client: FeishuClient | undefined;
  // 每个 session 的日志器（按各自配置的 logLevel 过滤）
  const logs = new Map<string, (event: string, data?: Record<string, unknown>, severity?: string) => void>();
  // 全局日志器（无 session 上下文时用，如 SDK 连接日志）
  const log = makeLog({});
  // 最近一次 agent 回复文本（agent_end 时更新，agent_settled 时发送）
  let lastAssistantText = '';

  /** 获取当前 session 的 sid + 是否允许发送。 */
  function sessionInfo(ctx: ExtensionContext): { sid: string; cfg: FeishuNotifyConfig } {
    const sid = ctx.sessionManager.getSessionId();
    const cfg = configs.get(sid) ?? {};
    return { sid, cfg };
  }

  /** 当前 session 的日志器（未登记时回退到全局）。 */
  function sessionLog(sid: string): (event: string, data?: Record<string, unknown>, severity?: string) => void {
    return logs.get(sid) ?? log;
  }

  /** 订阅飞书长连接（进程级单例，首次调用建立）。 */
  function ensureSubscribed(cfg: FeishuNotifyConfig): void {
    if (!cfg.appId || !cfg.appSecret) return;
    if (client) return;
    client = getFeishuClient(cfg, makeLog(cfg));
    client.subscribe((msg) => {
      void handleIncoming(msg);
    });
  }

  /** 处理一条上行飞书消息（回复通知 → 回注 session）。 */
  async function handleIncoming(msg: FeishuMessage): Promise<void> {
    if (seenMessages.has(msg.messageId)) return;
    seenMessages.add(msg.messageId);

    // 自动识别发送目标：只要收到消息就记录，供未配置 userId/chatId 时回填
    if (msg.chatType === 'p2p' && msg.senderId) {
      discoveredUserId = msg.senderId;
    }
    if (msg.chatId && msg.senderId) {
      discoveredChatIds.set(msg.chatId, msg.senderId);
    }
    // 持久化识别结果（供下次启动提示 /feishu-notify bind）
    recordDiscovered(msg.chatType === 'p2p' ? msg.senderId : undefined, msg.chatId);

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

    sessionLog(targetSid)('reply-injected', { to: targetSid, from: msg.senderName ?? msg.senderId, text });
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
    // 目标 session 已结束（configs 中已移除）→ 无法回注，友好提示
    if (!configs.has(sid)) {
      sessionLog(sid)('reply-session-gone', { to: sid }, 'WARN');
      sendReceipt(sid, '该 pi 会话已结束，无法回注指令。请在新会话中重新发起任务。');
      return;
    }
    try {
      const prompt =
        `[feishu-notify] 飞书用户${msg.senderName ? `「${msg.senderName}」` : ''}回复了通知，` +
        `请求：${text}`;
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      sendReceipt(sid, `已收到你的回复：「${text}」，正在处理…`);
    } catch (err) {
      // print 模式（-p）收尾时 session 可能已关闭导致 ctx stale，
      // 此时回注失败不影响通知/路由，仅记日志即可。
      sessionLog(sid)('inject-failed', { error: err instanceof Error ? err.message : String(err) }, 'WARN');
    }
  }

  /** 发送回执（可选）。 */
  function sendReceipt(sid: string, text: string): void {
    const cfg = configs.get(sid);
    if (!cfg || cfg.receipt === false) return;
    const project = basename(sessionCwds.get(sid) ?? '') || '?';
    const target = resolveSendTarget(cfg, sessionLog(sid));
    void client?.sendText(`${text}\n\n项目: ${project}`, target).then((r) => {
      if (!r.ok) sessionLog(sid)('receipt-failed', { error: r.error }, 'ERROR');
    });
  }

  /**
   * 解析发送目标：优先用配置里的 userId/chatId；未配置 userId 时回退到自动识别值
   * （用户在飞书给机器人发过私聊消息后自动捕获的 open_id）。
   * 回退仅用于 userId（私聊方向明确）；chatId 不做自动回退（群聊可能多个，容易发错）。
   * 首次回退时输出一条可见日志，提示可用 /feishu-notify bind 持久化。
   */
  function resolveSendTarget(
    cfg: FeishuNotifyConfig,
    logc: (event: string, data?: Record<string, unknown>, severity?: string) => void,
  ): { userId?: string; chatId?: string } {
    const userId = cfg.userId ?? discoveredUserId;
    if (!cfg.userId && discoveredUserId && !warnedAutoTarget) {
      warnedAutoTarget = true;
      logc(
        'auto-target',
        { userId: discoveredUserId, hint: 'settings.json 未配置 userId，已回退到自动识别值；可用 /feishu-notify bind 持久化' },
        'WARN',
      );
    }
    return { userId, chatId: cfg.chatId };
  }

  /** 该 session 本次任务是否应发通知（静音/时长过滤）。 */
  function shouldNotify(sid: string, cfg: FeishuNotifyConfig): boolean {
    // 用户手动静音
    if (muted.has(sid)) {
      sessionLog(sid)('notification-skipped', { sid, reason: 'muted' }, 'INFO');
      return false;
    }
    // 最短时长过滤
    const taskStart = taskStarts.get(sid);
    if (!passesDurationFilter(taskStart, Date.now(), cfg.minDurationMs)) {
      sessionLog(sid)(
        'notification-skipped',
        { sid, elapsedMs: taskStart ? Date.now() - taskStart : 0, minDurationMs: Number(cfg.minDurationMs) || 0, reason: 'too-short' },
        'INFO',
      );
      return false;
    }
    return true;
  }

  // ── pi 事件钩子 ──────────────────────────────────────────────

  pi.on('session_start', (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const cfg = loadConfig(ctx.cwd);
    configs.set(sid, cfg);
    sessionCwds.set(sid, ctx.cwd);
    logs.set(sid, makeLog(cfg));
    registry.register(sid, ctx.cwd);
    sessionLog(sid)('session-start', { sid });

    // 启动一次性提示：settings 未配 userId，但已自动识别过 → 提醒一键持久化
    if (
      !startupHintShown &&
      ctx.hasUI &&
      !cfg.userId &&
      discoveredUserId
    ) {
      startupHintShown = true;
      ctx.ui.notify(
        `feishu-notify: 已自动识别你的 open_id（${discoveredUserId.slice(0, 12)}…），但 settings.json 尚未配置 userId。` +
          `可执行 /feishu-notify bind 一键写入，或 /feishu-notify whoami 查看。`,
        'info',
      );
    }

    if (!cfg.enabled || !cfg.appId || !cfg.appSecret) {
      sessionLog(sid)('session-disabled', { sid, reason: !cfg.enabled ? 'enabled=false' : 'missing appId/appSecret' }, 'WARN');
      return;
    }
    ensureSubscribed(cfg);
  });

  // 任务开始：记录时间戳，供 agent_settled 判断任务时长
  pi.on('agent_start', (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    taskStarts.set(sid, Date.now());
    // 新任务开始时，重置上一条摘要（避免误用旧回复）
    lastAssistantText = '';
  });

  pi.on('agent_end', async (_event, ctx) => {
    // 记录最近一次 assistant 文本，供 agent_settled 发通知用
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === 'message' && entry.message.role === 'assistant') {
        const text = extractAssistantText(entry.message.content);
        if (text) {
          lastAssistantText = text;
          break;
        }
      }
    }
  });

  pi.on('agent_settled', (_event, ctx) => {
    const { sid, cfg } = sessionInfo(ctx);
    if (!cfg.enabled || !canSend(cfg)) return;

    // 只在空闲时通知（避免 stream 中打扰）
    if (!ctx.isIdle()) return;

    // 静音 / 时长过滤
    if (!shouldNotify(sid, cfg)) {
      taskStarts.delete(sid);
      return;
    }
    taskStarts.delete(sid);

    // 通知文本：带上项目名 + 会话 ID（前 8 位）+ 时间，多任务可区分
    const project = basename(ctx.cwd) || ctx.cwd;
    const time = new Date().toLocaleString('zh-CN', { hour12: false });
    const lines = [
      '✅ pi 主对话已完成',
      `项目: ${project}`,
      `会话: ${sid.slice(0, 8)}`,
      `时间: ${time}`,
    ];
    if (lastAssistantText) lines.push('', lastAssistantText);
    lines.push('', '回复本消息可继续指挥该会话。');
    const text = lines.join('\n');

    void client?.sendText(text, resolveSendTarget(cfg, sessionLog(sid))).then((r) => {
      if (r.ok && r.messageId) {
        router.record(r.messageId, sid);
        // 成功通知仅 verbose 时输出，避免刷屏
        sessionLog(sid)('notification-sent', { sid, messageId: r.messageId });
      } else {
        sessionLog(sid)('notification-failed', { sid, error: r.error }, 'ERROR');
      }
    });
  });

  pi.on('session_shutdown', (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    configs.delete(sid);
    sessionCwds.delete(sid);
    logs.delete(sid);
    taskStarts.delete(sid);
    muted.delete(sid);
    registry.unregister(sid);
    sessionLog(sid)('session-shutdown', { sid });
  });

  // ── 命令：手动发送通知 / 查看状态 ─────────────────────────────

  pi.registerCommand('feishu-notify', {
    description: '向飞书发送一条通知，或查看扩展状态；off/on 静音，whoami 查看识别到的 ID，bind 持久化',
    handler: async (args, ctx) => {
      const { sid, cfg } = sessionInfo(ctx);
      const logc = sessionLog(sid);
      const arg = args.trim();

      // 静音 / 取消静音：当前 session 不再（或重新）自动发通知
      if (arg === 'off' || arg === 'mute') {
        muted.add(sid);
        ctx.ui.notify('feishu-notify: 当前会话已静音，任务完成后不再自动发送通知。使用 /feishu-notify on 恢复。', 'info');
        logc('muted', { sid }, 'INFO');
        return;
      }
      if (arg === 'on' || arg === 'unmute') {
        muted.delete(sid);
        ctx.ui.notify('feishu-notify: 当前会话已恢复自动通知。', 'info');
        logc('unmuted', { sid }, 'INFO');
        return;
      }

      // 查看自动识别的 open_id / chat_id：用户在飞书给机器人发过消息后即可看到
      if (arg === 'whoami' || arg === 'detect') {
        const lines = [
          `userId（open_id）: ${cfg.userId ?? discoveredUserId ?? '（未识别，先在飞书给机器人发条消息）'}`,
          `chatId: ${cfg.chatId ?? '（未配置）'}`,
        ];
        if (discoveredChatIds.size > 0) {
          lines.push('已识别的群聊 chat_id:');
          for (const [cid] of discoveredChatIds) lines.push(`  - ${cid}`);
        }
        lines.push('把上面的值填到 settings.json 的 feishu-notify 节即可固定，或 /feishu-notify bind 自动写入。');
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      // 持久化自动识别的 userId/chatId 到项目 .pi/settings.json
      if (arg === 'bind') {
        if (!discoveredUserId && discoveredChatIds.size === 0) {
          ctx.ui.notify('feishu-notify: 尚未识别到任何 ID，先在飞书给机器人发一条消息（私聊或群里 @ 机器人）再执行 bind。', 'warning');
          return;
        }
        const result = persistDiscovered(ctx.cwd, cfg, discoveredUserId, [...discoveredChatIds.keys()]);
        if (result.ok) {
          const written = result.written?.join(', ') ?? '';
          ctx.ui.notify(`feishu-notify: 已写入项目 .pi/settings.json（${written}）。重启会话或 /reload 生效。`, 'info');
          logc('bound', { ...result.written }, 'INFO');
        } else {
          ctx.ui.notify(`feishu-notify: 写入失败: ${result.error}`, 'error');
        }
        return;
      }

      if (!args.trim()) {
        const minMs = Number(cfg.minDurationMs) || 0;
        const extra = [
          `muted=${muted.has(sid)}`,
          `minDurationMs=${minMs > 0 ? `${minMs}ms` : 'off'}`,
          `autoUserId=${discoveredUserId ? '✓' : '✗'}`,
        ];
        ctx.ui.notify(
          `feishu-notify: enabled=${!!cfg.enabled}, appId=${cfg.appId ? '✓' : '✗'}, ` +
            `connected=${client?.isConnected() ?? false}, ${extra.join(', ')}`,
          'info',
        );
        return;
      }
      if (!cfg.enabled || !canSend(cfg)) {
        ctx.ui.notify('feishu-notify: 未配置或已禁用（需要 appId/appSecret/userId）', 'warning');
        return;
      }
      const r = await client?.sendText(args.trim(), resolveSendTarget(cfg, logc));
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
