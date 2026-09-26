/**
 * pi-feishu-notify — pi 扩展入口
 *
 * pi 主对话 ⇄ 飞书双向桥，**不依赖 lark-cli**（基于官方 SDK 长连接）：
 *
 *  - 下行：agent_settled（任务结束）→ SDK 发送飞书 markdown 通知，记录 message_id
 *  - 上行：飞书里回复通知 → SDK 长连接收到消息 → 按 replyToMessageId 反查
 *    目标 session → pi.sendUserMessage 回注指令，继续执行
 *  - 进度：回注后先发「已收到」回执，长任务期间在该消息上原地刷新「已用时 Xs」
 *    （im.v1.message.update），避免飞书侧干等；任务结束后发最终 markdown 结果。
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
import { Inbox, decideDelivery } from '../src/inbox.js';
import { pidAlive } from '../src/state.js';
import { passesDurationFilter, shouldHandle, shouldLog, type LogVerbosity } from '../src/filter.js';
import { persistDiscovered } from '../src/settings.js';
import { loadDiscovered, recordDiscovered } from '../src/discovery.js';
import { extractAssistantText, extractReplyText, buildNotification, type NotificationMeta } from '../src/notify.js';
import { resolveLocale, messages, format, type Locale } from '../src/i18n.js';
import type { FeishuMessage, FeishuNotifyConfig, InboxEntry } from '../src/types.js';

/** 记录收到消息的去重集合（进程内，避免 SDK 自身 dedup 外的重复触发）。 */
const seenMessages = new Set<string>();
/** 去重集合上限（FIFO 淘汰，避免长驻进程无界增长）。 */
const SEEN_MESSAGES_MAX = 5000;

/** 转发后等待目标进程取走的时限（毫秒），超时把回执刷成提示。 */
const FORWARD_STALL_MS = 30_000;

/** 标记消息已处理；返回 false 表示此前已见过。 */
function markSeen(messageId: string): boolean {
  if (seenMessages.has(messageId)) return false;
  seenMessages.add(messageId);
  if (seenMessages.size > SEEN_MESSAGES_MAX) {
    const oldest = seenMessages.values().next().value;
    if (oldest !== undefined) seenMessages.delete(oldest);
  }
  return true;
}

// ── 跨进程收件箱轮询（进程级单例） ─────────────────────────────────
//
// 飞书长连接是集群投递：同应用多 client 时一条事件只随机到一个，回注指令可能
// 由别的进程认领后写进收件箱。这里轮询取回**本进程**的条目（pid 命中或 session
// 在本进程），再走本地回注。reload 后旧扩展实例的闭包会失效，因此 timer 常驻、
// handler 可替换（与 FeishuClient 的 currentHandler 同思路）。

const INBOX_POLL_KEY = Symbol.for('pi-feishu-notify.inbox-poll');
type InboxPollState = { timer?: ReturnType<typeof setInterval>; drain?: () => void };

function pollIntervalMs(): number {
  const n = Number(process.env.PI_FEISHU_NOTIFY_INBOX_POLL_MS);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** 注册（或替换）收件箱处理函数，并确保进程级轮询已启动。 */
function ensureInboxPoller(drain: () => void): void {
  const g = globalThis as Record<symbol, unknown>;
  let st = g[INBOX_POLL_KEY] as InboxPollState | undefined;
  if (!st) {
    st = {};
    g[INBOX_POLL_KEY] = st;
  }
  st.drain = drain;
  if (!st.timer) {
    st.timer = setInterval(() => {
      try {
        st?.drain?.();
      } catch {
        // 轮询异常不阻断主流程
      }
    }, pollIntervalMs());
    st.timer.unref?.();
  }
}

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
  //  - discoveredChatIds：收到过消息的群 chatId → senderId 映射
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
  const inbox = new Inbox();
  let client: FeishuClient | undefined;
  // 每个 session 的日志器（按各自配置的 logLevel 过滤）
  const logs = new Map<string, (event: string, data?: Record<string, unknown>, severity?: string) => void>();
  // 全局日志器（无 session 上下文时用，如 SDK 连接日志）
  const log = makeLog({});
  // 最近一次 agent 回复文本，按 sid 记录（agent_end 时更新，agent_settled 时发送）
  const lastAssistantTexts = new Map<string, string>();

  // ── 进度心跳状态（follow-up 回注后）──
  // 回注后发一条「已收到」回执，长任务期间用 updateText 在原地刷新已用时，
  // 避免飞书侧傻等不知道 bot 是否还活着。keyed by sid，agent_settled 时停掉。
  const progress = new Map<string, {
    msgId: string;
    timer: ReturnType<typeof setInterval>;
    start: number;
  }>();

  /** 进度刷新间隔（毫秒）。 */
  const PROGRESS_INTERVAL_MS = 15000;

  /** 启动某 session 的进度心跳：定时在原回执消息上刷新已用时 + 项目/会话信息。 */
  function startProgress(sid: string, msgId: string): void {
    stopProgress(sid); // 同一 session 再次回注时先停掉旧心跳，避免定时器泄漏
    const start = Date.now();
    // 项目名：取 session cwd 的 basename（与通知里的「项目」一致）
    const project = basename(sessionCwds.get(sid) ?? '') || '?';
    const timer = setInterval(() => {
      const seconds = Math.max(1, Math.round((Date.now() - start) / 1000));
      void client?.updateText(msgId, format(messages(sessionLocale(sid)).receipt.progress, {
        seconds,
        project,
        sid: sid.slice(0, 8),
      })).catch(() => undefined);
    }, PROGRESS_INTERVAL_MS);
    timer.unref?.();
    progress.set(sid, { msgId, timer, start });
  }

  /**
   * 停止心跳。传 finalText 时把回执消息原地更新为该文案；
   * 返回是否找到（并停掉）进行中的心跳。
   */
  function stopProgress(sid: string, finalText?: string): boolean {
    const p = progress.get(sid);
    if (!p) return false;
    clearInterval(p.timer);
    progress.delete(sid);
    if (finalText) {
      void client?.updateText(p.msgId, finalText).catch(() => undefined);
    }
    return true;
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
      void handleIncoming(msg).catch((err) => {
        log('reply-handle-failed', { error: err instanceof Error ? err.message : String(err) }, 'ERROR');
      });
    });
  }

  /** 处理一条上行飞书消息（回复通知 → 回注 session）。 */
  async function handleIncoming(msg: FeishuMessage): Promise<void> {
    if (!markSeen(msg.messageId)) return;

    // 自动识别发送目标：只要收到消息就记录，供未配置 userId/chatId 时回填。
    // 只把群聊 chatId 记入「已识别群聊」——p2p 的 chatId 混进去会污染 whoami/bind
    // （bind 可能把单聊 chat_id 当成群 chatId 写进配置）。
    const isP2p = msg.chatType === 'p2p';
    if (isP2p && msg.senderId) {
      discoveredUserId = msg.senderId;
    }
    if (!isP2p && msg.chatId && msg.senderId) {
      discoveredChatIds.set(msg.chatId, msg.senderId);
    }
    // 持久化识别结果（供下次启动提示 /feishu-notify bind）
    recordDiscovered(isP2p ? msg.senderId : undefined, isP2p ? undefined : msg.chatId);

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

    await deliverReply(targetSid, text, msg);
    router.remove(msg.replyToMessageId ?? '');
  }

  /**
   * 投递一条回注指令：按会话归属决定本地回注 / 跨进程转发 / 会话已结束。
   *
   * 飞书长连接是集群投递（一条事件只随机到一个 client），认领到回复的进程
   * 未必是目标 session 所在的进程。目标 session 在别的存活进程时把指令写进
   * 收件箱（Inbox），由目标进程轮询取回后用 pi.sendUserMessage 本地回注——
   * 后者只能注入本进程的会话。
   */
  async function deliverReply(targetSid: string, text: string, msg: FeishuMessage): Promise<void> {
    const decision = decideDelivery({
      targetSid,
      localSids: new Set(configs.keys()),
      registryEntry: registry.get(targetSid),
      isPidAlive: pidAlive,
      myPid: process.pid,
      currentSid,
      currentCwd: currentSid ? sessionCwds.get(currentSid) : undefined,
      aliveSessions: registry.alive(),
    });

    if (decision.kind === 'local') {
      sessionLog(targetSid)(decision.stale ? 'reply-stale-session' : 'reply-injected', {
        to: targetSid,
        ...(decision.stale ? { fallbackTo: decision.sid } : {}),
        from: msg.senderName ?? msg.senderId,
        text,
      });
      await injectReply(decision.sid, text, msg.senderName);
      return;
    }

    if (decision.kind === 'forward') {
      // 目标 session 在另一个存活进程：写收件箱由对方取回，回执告知「正在转达」
      const cfg = configForMessage(msg) ?? {};
      const locale = resolveLocale(cfg.locale);
      const receiptMsgId = await sendReceiptTo(
        cfg,
        locale,
        registry.get(targetSid)?.cwd,
        `${messages(locale).receipt.forwarded}（${text}）`,
        msg,
      );
      inbox.enqueue({
        id: msg.messageId,
        sid: decision.sid,
        pid: decision.pid,
        text,
        senderName: msg.senderName,
        cwd: registry.get(targetSid)?.cwd,
        receiptMsgId,
        receipt: cfg.receipt !== false,
        locale: resolveLocale(cfg.locale),
        hops: 1,
        replyChatId: msg.chatId,
        replySenderId: msg.senderId,
        replyChatType: msg.chatType,
        ts: Date.now(),
      });
      sessionLog(targetSid)('reply-forwarded', {
        to: decision.sid,
        pid: decision.pid,
        reason: decision.stale ? 'same-project' : 'exact',
        text,
      });
      // 看护：目标进程一直没取走（挂起/版本不支持轮询）→ 把回执刷成提示，避免误导性沉默
      if (receiptMsgId) {
        const watch = setTimeout(() => {
          if (inbox.get(msg.messageId)) {
            void client
              ?.updateText(receiptMsgId, messages(locale).receipt.forwardStalled)
              .catch(() => undefined);
            sessionLog(targetSid)('reply-forward-stalled', { to: decision.sid, pid: decision.pid }, 'WARN');
          }
        }, FORWARD_STALL_MS);
        watch.unref?.();
      }
      return;
    }

    // 目标会话（含同项目会话）均已结束
    sessionLog(targetSid)('reply-session-gone', { to: targetSid, sameProject: false }, 'WARN');
    const cfg = configForMessage(msg) ?? {};
    await sendReceiptTo(
      cfg,
      resolveLocale(cfg.locale),
      registry.get(targetSid)?.cwd,
      messages(resolveLocale(cfg.locale)).receipt.sessionGone,
      msg,
    );
  }

  /**
   * 取回收件箱中属于本进程的指令并本地回注（轮询器定期调用）。
   *
   * 判定「属于本进程」：目标 session 在本进程 configs 中，或注册表记录的 pid
   * 就是本进程（session 可能已切走/结束，交回 delivery 决策处理回退）。
   * 取走即从收件箱删除（Inbox.take 原子操作），避免多进程重复投递。
   */
  function drainInbox(): void {
    const taken = inbox.take((e) => configs.has(e.sid) || e.pid === process.pid);
    for (const e of taken) {
      void deliverInboxEntry(e).catch((err: unknown) => {
        sessionLog(e.sid)(
          'inbox-deliver-failed',
          { to: e.sid, error: err instanceof Error ? err.message : String(err) },
          'ERROR',
        );
      });
    }
  }

  /** 投递一条收件箱条目：本地注入 / 同项目再转发（有限跳数）/ 会话已结束。 */
  async function deliverInboxEntry(e: InboxEntry): Promise<void> {
    const decision = decideDelivery({
      targetSid: e.sid,
      localSids: new Set(configs.keys()),
      registryEntry: registry.get(e.sid),
      isPidAlive: pidAlive,
      myPid: process.pid,
      currentSid,
      currentCwd: currentSid ? sessionCwds.get(currentSid) : undefined,
      aliveSessions: registry.alive(),
    });

    if (decision.kind === 'local') {
      sessionLog(decision.sid)(decision.stale ? 'inbox-stale-fallback' : 'inbox-delivered', {
        to: e.sid,
        ...(decision.stale ? { fallbackTo: decision.sid } : {}),
        text: e.text,
      });
      await injectReply(decision.sid, e.text, e.senderName, e.receiptMsgId);
      return;
    }

    if (decision.kind === 'forward') {
      // 目标会话已漂移到第三个进程（本进程只剩注册表残留）：有限跳数再转发，防环
      const hops = e.hops ?? 0;
      if (hops < 3) {
        inbox.enqueue({ ...e, sid: decision.sid, pid: decision.pid, hops: hops + 1, ts: Date.now() });
        sessionLog(e.sid)('inbox-reforward', { to: decision.sid, pid: decision.pid, hops: hops + 1 }, 'WARN');
        return;
      }
    }

    // 无处投递：优先把转发方的「正在转达」回执原地刷成「会话已结束」，避免误导
    sessionLog(e.sid)('inbox-session-gone', { to: e.sid, hops: e.hops ?? 0 }, 'WARN');
    const t = messages(e.locale ?? resolveLocale(undefined));
    if (e.receiptMsgId) {
      void client?.updateText(e.receiptMsgId, t.receipt.sessionGone).catch(() => undefined);
    }
  }

  /**
   * 反查一条消息属于哪个配置（多会话/多配置并存时按 chatId/senderId 精确匹配，
   * 匹配不到再回退到第一个配置）。不要求 canSend：allowedSenderIds 等过滤规则
   * 在未配发送目标的纯自动模式下也必须生效。
   */
  function configForMessage(msg: FeishuMessage): FeishuNotifyConfig | undefined {
    let fallback: FeishuNotifyConfig | undefined;
    for (const cfg of configs.values()) {
      if (cfg.chatId && cfg.chatId === msg.chatId) return cfg;
      if (cfg.userId && cfg.userId === msg.senderId) return cfg;
      fallback ??= cfg;
    }
    return fallback;
  }

  /**
   * 本地回注指令到目标 session（调用前须确认目标 session 在本进程）。
   *
   * 流程：先发「已收到」回执并启动进度心跳（在 sendUserMessage 之前，保证用户
   * 立即得到飞书反馈）；agent_end 记录最终文本、agent_settled 停掉心跳并发送
   * 最终 markdown 结果。注意 pi.sendUserMessage 是 fire-and-forget（包装层不返回
   * Promise），这里的 try/catch 只能捕获同步抛出的错误（如 session 已失效）。
   *
   * receiptMsgId：跨进程转发时由转发方发出的回执 message_id，本进程直接接管
   * 进度心跳（原地刷新那条消息），不再另发一条「已收到」。
   */
  async function injectReply(
    sid: string,
    text: string,
    senderName: string | undefined,
    receiptMsgId?: string,
  ): Promise<void> {
    const t = messages(sessionLocale(sid));
    const prompt =
      `[feishu-notify] ${format(t.inject.prompt, {
        name: senderName ? ` 「${senderName}」` : '',
      })}${text}`;
    // 先发回执 + 启动进度心跳（必须在 sendUserMessage 之前）
    let msgId = receiptMsgId;
    if (msgId) {
      // 接管转发方的「正在转达」回执：原地刷成「已收到」，用户视角无缝衔接
      void client?.updateText(msgId, `${t.receipt.received}（${text}）`).catch(() => undefined);
    } else {
      msgId = await sendReceipt(sid, `${t.receipt.received}（${text}）`);
    }
    if (msgId) startProgress(sid, msgId);
    try {
      await pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
    } catch (err) {
      // print 模式（-p）收尾时 session 可能已关闭导致 ctx stale，
      // 此时回注失败不影响通知/路由，仅记日志 + 回执告知用户即可。
      const msg_ = err instanceof Error ? err.message : String(err);
      sessionLog(sid)('inject-failed', { error: msg_ }, 'WARN');
      const failed = `${t.receipt.relayFailed}${msg_}`;
      // 优先把失败信息原地刷在回执上；没有回执（未生成/未启用）才另发一条
      if (!stopProgress(sid, failed)) {
        void sendReceipt(sid, failed);
      }
    }
  }

  /**
   * 发送回执（可选），返回已发送消息的 message_id（用于进度心跳原地刷新）。
   * 返回 undefined 表示未启用回执或发送失败。
   */
  async function sendReceipt(sid: string, text: string): Promise<string | undefined> {
    const cfg = configs.get(sid);
    if (!cfg || cfg.receipt === false) return undefined;
    return sendReceiptTo(
      cfg,
      sessionLocale(sid),
      sessionCwds.get(sid),
      text,
      undefined,
      sessionLog(sid),
    );
  }

  /**
   * 向「回复来源」所在配置的发送目标发一条回执文本。
   *
   * 与 sendReceipt 的区别：不依赖目标 session 在本进程（configs 里查不到 sid），
   * 用于跨进程转发 / 会话已结束等路径——此时按回复消息匹配到的配置决定
   * 回执开关、语言与发送目标，并把项目目录显式传入。
   */
  async function sendReceiptTo(
    cfg: FeishuNotifyConfig,
    locale: Locale,
    cwd: string | undefined,
    text: string,
    msg?: FeishuMessage,
    logc?: (event: string, data?: Record<string, unknown>, severity?: string) => void,
  ): Promise<string | undefined> {
    if (cfg.receipt === false) return undefined;
    const project = basename(cwd ?? '') || '?';
    const target = resolveSendTarget(cfg, logc ?? log);
    const r = await client?.sendText(
      `${text}\n\n${messages(locale).notification.project}: ${project}`,
      target,
    );
    if (!r?.ok) {
      if (r) (logc ?? log)('receipt-failed', { error: r.error, replyFrom: msg?.senderId }, 'ERROR');
      return undefined;
    }
    return r.messageId;
  }

  /**
   * 解析发送目标：
   *  - 配置了 userId/chatId 任一 → 用配置值（已锁定目标，不再被自动识别值劫持：
   *    否则只配了群 chatId 的用户会把通知发进某个曾私聊过 bot 的单聊）
   *  - 两者都未配置 → 回退到自动识别的 open_id（私聊方向明确；chatId 不做自动
   *    回退，群聊可能多个，容易发错）
   * 首次回退时输出一条可见日志，提示可用 /feishu-notify bind 持久化。
   */
  function resolveSendTarget(
    cfg: FeishuNotifyConfig,
    logc: (event: string, data?: Record<string, unknown>, severity?: string) => void,
  ): { userId?: string; chatId?: string } {
    if (cfg.userId || cfg.chatId) {
      return { userId: cfg.userId, chatId: cfg.chatId };
    }
    const userId = discoveredUserId;
    if (userId && !warnedAutoTarget) {
      warnedAutoTarget = true;
      logc(
        'auto-target',
        { userId, hint: messages(resolveLocale(cfg.locale)).hint.autoTarget },
        'WARN',
      );
    }
    return { userId };
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
    registry.register(sid, ctx.cwd, cfg.staleDays);
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
    lastAssistantTexts.delete(sid);
  });

  pi.on('agent_end', async (_event, ctx) => {
    // 记录最近一次 assistant 文本，供 agent_settled 发通知用
    const sid = ctx.sessionManager.getSessionId();
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry?.type === 'message' && entry.message.role === 'assistant') {
        const text = extractAssistantText(entry.message.content);
        if (text) {
          lastAssistantTexts.set(sid, text);
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
    const willNotify = shouldNotify(sid, cfg);
    taskStarts.delete(sid);

    // 停掉 follow-up 的进度心跳（若有）；只在后面真有一条结果消息时才提示
    // 「结果见下一条」，否则（静音/时长过滤）只回「处理完成」
    const t = messages(sessionLocale(sid));
    stopProgress(sid, willNotify ? t.receipt.done : t.receipt.doneOnly);
    if (!willNotify) return;

    // 发一条 markdown（或 text）通知：只含过滤后的最终结果文字
    const project = basename(ctx.cwd) || ctx.cwd;
    const time = new Date().toLocaleString(
      sessionLocale(sid) === 'zh' ? 'zh-CN' : 'en-US',
      { hour12: false },
    );
    const meta: NotificationMeta = { project, sid, time };
    const { format: msgFormat, content } = buildNotification(
      cfg,
      meta,
      lastAssistantTexts.get(sid) || undefined,
    );
    lastAssistantTexts.delete(sid);
    ensureSubscribed(cfg);
    const target = resolveSendTarget(cfg, sessionLog(sid));
    const send = msgFormat === 'text'
      ? client?.sendText(content, target)
      : client?.sendMarkdown(content, target);
    void send?.then((r) => {
      if (r.ok && r.messageId) {
        router.record(r.messageId, sid, cfg.staleDays);
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
    lastAssistantTexts.delete(sid);
    muted.delete(sid);
    // 不 registry.unregister：保留 sid → cwd 历史记录，重启后回复旧通知时
    // 依赖它做「同项目回退注入」；过期记录由 register 按 staleDays 清理
    // 清理进度心跳，避免残留定时器
    stopProgress(sid);
    if (currentSid === sid) currentSid = undefined;
    sessionLog(sid)('session-shutdown', { sid });
  });

  // 跨进程收件箱轮询：别的进程认领到回复后写入的指令，这里取回本地回注
  ensureInboxPoller(drainInbox);

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
          logc('bound', { fields: result.written }, 'INFO');
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
      ensureSubscribed(cfg);
      const target = resolveSendTarget(cfg, logc);
      const send = cfg.messageFormat === 'text'
        ? client?.sendText(args.trim(), target)
        : client?.sendMarkdown(args.trim(), target);
      const r = await send;
      if (r?.ok) {
        if (r.messageId) router.record(r.messageId, sid, cfg.staleDays);
        ctx.ui.notify(t.sent, 'info');
      } else {
        ctx.ui.notify(`${t.sendFailed}${r?.error}`, 'error');
      }
    },
  });
}
