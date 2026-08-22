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
import { getFeishuClient, type FeishuClient, type MarkdownStream } from '../src/feishu.js';
import { NotificationRouter, ClaimDedup } from '../src/router.js';
import { SessionRegistry } from '../src/sessions.js';
import { passesDurationFilter, shouldHandle, shouldLog, type LogVerbosity } from '../src/filter.js';
import { persistDiscovered } from '../src/settings.js';
import { loadDiscovered, recordDiscovered } from '../src/discovery.js';
import { extractAssistantText, extractReplyText, buildNotification, type NotificationMeta } from '../src/notify.js';
import { resolveLocale, messages, format, type Locale } from '../src/i18n.js';
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

/** 是否应该处理这条上行消息（回复通知回注场景）。已抽取为纯函数 src/filter.ts#shouldHandle。 */
// (逻辑已迁移到 filter.ts，见下方 handleIncoming 调用点)

export default function feishuNotifyExtension(pi: ExtensionAPI): void {
  // 每个 session 关联的配置（session_start 时刷新）
  const configs = new Map<string, FeishuNotifyConfig>();
  const sessionCwds = new Map<string, string>();
  // 当前激活的 session id（单进程内只有一个；用于 stale 回注时回退到当前会话）
  let currentSid: string | undefined;
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

  // ── 流式回复状态（on-followup）──
  // 用户从飞书回复通知回注指令后，把 pi 的回复以打字机效果流式推回飞书。
  // 每个 follow-up 任务一个 streamingTask：
  //  - buffer：assistant 文本增量累积（stream 就绪前也能缓存，避免丢字）
  //  - stream：已就绪的流式句柄（异步建立，建立后先把 buffer 里已累积的 flush 进去）
  //  - target/replyTo：发送目标 + 要回复的用户消息 id
  type StreamingTask = {
    buffer: string[];
    stream: MarkdownStream | null;
    target: { userId?: string; chatId?: string };
    replyTo: string;
    finished: boolean;
  };
  const streamingTasks = new Map<string, StreamingTask>();

  /** 记录一段文本增量到流式任务（未就绪则先入 buffer）。 */
  function pushStreamChunk(sid: string, chunk: string): void {
    if (!chunk) return;
    const task = streamingTasks.get(sid);
    if (!task || task.finished) return;
    if (task.stream) {
      task.stream.append(chunk);
    } else {
      task.buffer.push(chunk);
    }
  }

  /** 把流式任务置为完成：结束句柄并返回其 messageId（用于路由）。 */
  function finishStreamTask(sid: string): MarkdownStream | null {
    const task = streamingTasks.get(sid);
    if (!task || task.finished) return null;
    task.finished = true;
    streamingTasks.delete(sid);
    if (task.stream) {
      void task.stream.done().catch(() => undefined);
      return task.stream;
    }
    return null;
  }

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

  /** 某 session 的界面语言（默认 auto 探测）。 */
  function sessionLocale(sid: string): Locale {
    return resolveLocale(configs.get(sid)?.locale);
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
    // 群聊放行「已知群」：配置的 allowedChatIds ∪ 通知目标 chatId ∪ 自动识别过的群
    if (!shouldHandle(msg, cfg, discoveredChatIds)) return;

    // 必须是"回复了通知"的消息才回注
    const targetSid = router.lookup(msg.replyToMessageId ?? '');
    if (!targetSid) return;

    // 跨进程去重认领
    if (!dedup.claim(msg.messageId, targetSid)) return;

    const text = extractReplyText(msg.content, msg.rawContentType);
    if (!text) return;

    sessionLog(targetSid)('reply-injected', { to: targetSid, from: msg.senderName ?? msg.senderId, text });
    await injectReply(targetSid, text, msg);
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

  /**
   * 回注指令到目标 session。
   *
   * 目标 session 不在当前进程（configs 中不存在）时，不再直接放弃：
   *  - 若目标 session 与当前会话属于同一项目（cwd 相同），回退注入到当前会话
   *    （用户回复通知的本意就是"继续这个项目"，而单进程内 pi.sendUserMessage
   *     只能作用于当前激活会话）；
   *  - 否则（项目也对不上）才发"会话已结束"回执。
   *
   * 注入本身 await pi.sendUserMessage：同步抛错（如 print 模式收尾 ctx stale）
   * 会捕获并回执"转达失败"，不再静默吞掉。
   */
  async function injectReply(sid: string, text: string, msg: FeishuMessage): Promise<void> {
    // 目标 session 不在当前进程 → 判断是否同项目可回退到当前会话
    if (!configs.has(sid)) {
      const entry = registry.get(sid);
      const curCwd = currentSid ? sessionCwds.get(currentSid) : undefined;
      const sameProject = Boolean(entry && curCwd && entry.cwd === curCwd);
      if (!sameProject) {
        sessionLog(sid)('reply-session-gone', { to: sid, sameProject: false }, 'WARN');
        sendReceipt(sid, messages(sessionLocale(sid)).receipt.sessionGone);
        return;
      }
      sessionLog(sid)('reply-stale-session', { to: sid, fallbackTo: currentSid, sameProject: true }, 'WARN');
      sid = currentSid as string;
    }
    const t = messages(sessionLocale(sid));
    const prompt =
      `[feishu-notify] ${format(t.inject.prompt, {
        name: msg.senderName ? ` 「${msg.senderName}」` : '',
      })}${text}`;
    try {
      await pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
      sendReceipt(sid, `${t.receipt.received}（${text}）`);
      // 标记「本次 follow-up 需要流式回推」：下一个 assistant 消息开始流式
      const cfg = configs.get(sid);
      if (cfg && cfg.enabled !== false && cfg.streamReplies !== false) {
        const target = resolveSendTarget(cfg, sessionLog(sid));
        if (target.userId || target.chatId) {
          // 预建任务（含 buffer），首个 assistant 消息到达时启动流式
          if (!streamingTasks.has(sid)) {
            streamingTasks.set(sid, {
              buffer: [],
              stream: null,
              target,
              replyTo: msg.messageId,
              finished: false,
            });
          }
          sessionLog(sid)('stream-marked', { to: sid, replyTo: msg.messageId }, 'INFO');
        }
      }
    } catch (err) {
      // print 模式（-p）收尾时 session 可能已关闭导致 ctx stale，
      // 此时回注失败不影响通知/路由，仅记日志 + 回执告知用户即可。
      const msg_ = err instanceof Error ? err.message : String(err);
      sessionLog(sid)('inject-failed', { error: msg_ }, 'WARN');
      sendReceipt(sid, `${t.receipt.relayFailed}${msg_}`);
    }
  }

  /** 发送回执（可选）。 */
  function sendReceipt(sid: string, text: string): void {
    const cfg = configs.get(sid);
    if (!cfg || cfg.receipt === false) return;
    const project = basename(sessionCwds.get(sid) ?? '') || '?';
    const target = resolveSendTarget(cfg, sessionLog(sid));
    void client?.sendText(`${text}\n\n${messages(sessionLocale(sid)).notification.project}: ${project}`, target).then((r) => {
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
        { userId: discoveredUserId, hint: messages(resolveLocale(cfg.locale)).hint.autoTarget },
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
    currentSid = sid;
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
        format(messages(sessionLocale(sid)).hint.startupBind, {
          openid: discoveredUserId.slice(0, 12),
        }),
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

  // ── 流式回复：follow-up 回注后，pi 的 assistant 回复以打字机效果推回飞书 ──
  pi.on('message_start', (_event, ctx) => {
    const { sid } = sessionInfo(ctx);
    const task = streamingTasks.get(sid);
    if (!task || task.finished || task.stream) return;
    const msg = (_event as { message?: { role?: string } }).message;
    if (msg?.role !== 'assistant') return;

    // 首个 assistant 消息到达：异步建立流式句柄；期间 delta 先进 buffer
    void (async () => {
      const stream = await client?.streamMarkdown(task.target, {
        replyTo: task.replyTo,
      });
      const cur = streamingTasks.get(sid);
      if (!stream || !cur || cur.finished) {
        // 启动失败或任务已结束：回退为普通通知（agent_settled 会发 markdown 通知）
        if (cur && !cur.finished) cur.stream = null;
        sessionLog(sid)('stream-start-failed', { sid }, 'WARN');
        return;
      }
      cur.stream = stream;
      // 把建立期间累积的 buffer 一次性刷入，避免丢字
      for (const chunk of cur.buffer) stream.append(chunk);
      cur.buffer = [];
      sessionLog(sid)('stream-started', { sid, messageId: stream.messageId }, 'INFO');
    })();
  });

  pi.on('message_update', (_event, ctx) => {
    const { sid } = sessionInfo(ctx);
    const msg = (_event as { message?: { role?: string } }).message;
    if (msg?.role !== 'assistant') return;
    const evt = (_event as { assistantMessageEvent?: { type?: string; delta?: string } }).assistantMessageEvent;
    // 只累计可见文本增量（text_delta），跳过 thinking / toolCall args
    if (evt?.type === 'text_delta' && typeof evt.delta === 'string') {
      pushStreamChunk(sid, evt.delta);
    }
  });

  pi.on('message_end', async (_event, ctx) => {
    // 不立即收尾：agent 可能有多轮（工具调用后继续），留到 agent_settled 统一合并
    const { sid } = sessionInfo(ctx);
    const msg = (_event as { message?: { role?: string; content?: unknown } }).message;
    if (msg?.role !== 'assistant') return;
    const task = streamingTasks.get(sid);
    if (!task || task.finished) return;
    // 万一没有 text_delta（如纯工具调用轮），用最终权威文本兜底
    const final = extractAssistantText(msg.content);
    if (final) {
      if (task.stream) {
        task.stream.setContent(final);
      } else {
        task.buffer = [final];
      }
    }
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

    // 合并流式回复：本次任务已有流式消息（follow-up 回注）→ 收尾即可，不再发第二条通知
    const stream = finishStreamTask(sid);
    if (stream) {
      void stream.done().then(() => {
        if (stream.messageId) {
          router.record(stream.messageId, sid);
          sessionLog(sid)('stream-settled', { sid, messageId: stream.messageId });
        }
      });
      return;
    }

    // 未流式：发一条 markdown（或 text）通知
    const project = basename(ctx.cwd) || ctx.cwd;
    const time = new Date().toLocaleString(
      sessionLocale(sid) === 'zh' ? 'zh-CN' : 'en-US',
      { hour12: false },
    );
    const meta: NotificationMeta = { project, sid, time };
    const { format, content } = buildNotification(cfg, meta, lastAssistantText || undefined);
    const target = resolveSendTarget(cfg, sessionLog(sid));
    const send = format === 'text'
      ? client?.sendText(content, target)
      : client?.sendMarkdown(content, target);
    void send?.then((r) => {
      if (r.ok && r.messageId) {
        router.record(r.messageId, sid);
        // 成功通知仅 verbose 时输出，避免刷屏
        sessionLog(sid)('notification-sent', { sid, messageId: r.messageId });
      } else {
        sessionLog(sid)('notification-failed', { sid, error: r?.error }, 'ERROR');
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
    // 清理流式状态：收尾进行中的流式消息
    const stream = finishStreamTask(sid);
    if (stream) void stream.done().catch(() => undefined);
    if (currentSid === sid) currentSid = undefined;
    sessionLog(sid)('session-shutdown', { sid });
  });

  // ── 命令：手动发送通知 / 查看状态 ─────────────────────────────

  pi.registerCommand('feishu-notify', {
    description: messages(resolveLocale(undefined)).command.description,
    handler: async (args, ctx) => {
      const { sid, cfg } = sessionInfo(ctx);
      const logc = sessionLog(sid);
      const t = messages(sessionLocale(sid)).command;
      const arg = args.trim();

      // 静音 / 取消静音：当前 session 不再（或重新）自动发通知
      if (arg === 'off' || arg === 'mute') {
        muted.add(sid);
        ctx.ui.notify(t.muted, 'info');
        logc('muted', { sid }, 'INFO');
        return;
      }
      if (arg === 'on' || arg === 'unmute') {
        muted.delete(sid);
        ctx.ui.notify(t.unmuted, 'info');
        logc('unmuted', { sid }, 'INFO');
        return;
      }

      // 查看自动识别的 open_id / chat_id：用户在飞书给机器人发过消息后即可看到
      if (arg === 'whoami' || arg === 'detect') {
        const lines = [
          `${t.whoamiUser}: ${cfg.userId ?? discoveredUserId ?? t.whoamiUnknown}`,
          `${t.whoamiChat}: ${cfg.chatId ?? t.whoamiNotConfigured}`,
        ];
        if (discoveredChatIds.size > 0) {
          lines.push(t.whoamiKnownChats);
          for (const [cid] of discoveredChatIds) lines.push(`  - ${cid}`);
        }
        lines.push(t.whoamiHint);
        ctx.ui.notify(lines.join('\n'), 'info');
        return;
      }

      // 持久化自动识别的 userId/chatId 到项目 .pi/settings.json
      if (arg === 'bind') {
        if (!discoveredUserId && discoveredChatIds.size === 0) {
          ctx.ui.notify(t.bindNoIds, 'warning');
          return;
        }
        const result = persistDiscovered(ctx.cwd, cfg, discoveredUserId, [...discoveredChatIds.keys()]);
        if (result.ok) {
          const written = result.written?.join(', ') ?? '';
          ctx.ui.notify(format(t.bindWritten, { fields: written }), 'info');
          logc('bound', { ...result.written }, 'INFO');
        } else {
          ctx.ui.notify(`${t.bindFailed}${result.error}`, 'error');
        }
        return;
      }

      if (!args.trim()) {
        const minMs = Number(cfg.minDurationMs) || 0;
        const extra = [
          `muted=${muted.has(sid)}`,
          `minDurationMs=${minMs > 0 ? `${minMs}ms` : 'off'}`,
          `format=${cfg.messageFormat ?? 'markdown'}`,
          `streamReplies=${cfg.streamReplies !== false}`,
          `autoUserId=${discoveredUserId ? '✓' : '✗'}`,
        ];
        ctx.ui.notify(
          format(t.status, {
            enabled: !!cfg.enabled,
            appId: cfg.appId ? '✓' : '✗',
            connected: client?.isConnected() ?? false,
            extra: extra.join(', '),
          }),
          'info',
        );
        return;
      }
      if (!cfg.enabled || !canSend(cfg)) {
        ctx.ui.notify(t.notConfigured, 'warning');
        return;
      }
      const target = resolveSendTarget(cfg, logc);
      const send = cfg.messageFormat === 'text'
        ? client?.sendText(args.trim(), target)
        : client?.sendMarkdown(args.trim(), target);
      const r = await send;
      if (r?.ok) {
        if (r.messageId) router.record(r.messageId, sid);
        ctx.ui.notify(t.sent, 'info');
      } else {
        ctx.ui.notify(`${t.sendFailed}${r?.error}`, 'error');
      }
    },
  });

  // 退出清理
  process.on('beforeExit', () => {
    for (const [sid] of configs) registry.unregister(sid);
  });
}
