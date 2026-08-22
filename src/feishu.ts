/**
 * pi-feishu-notify — 飞书 SDK 客户端
 *
 * 用官方 @larksuiteoapi/node-sdk 直接连接，**不依赖 lark-cli**：
 *  - 下行：client.im.message.create 发送通知，直接拿到 message_id
 *  - 上行：createLarkChannel({ transport: 'websocket' }) 长连接，订阅消息事件
 *
 * 进程级单例（globalThis Symbol key）：多个 session 共享唯一 WebSocket
 * consumer，事件到达后广播给所有订阅者。consumer 生命周期 = 进程生命周期，
 * 不随 session 切换关闭。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  FeishuMessage,
  FeishuNotifyConfig,
  SendResult,
} from './types.js';
import { resolveLocale, messages } from './i18n.js';

const CLIENT_KEY = Symbol.for('pi-feishu-notify.client');

/** 校验错误：appId/appSecret 缺失 */
export class FeishuConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeishuConfigError';
  }
}

/** 发送目标（userId 优先，其次 chatId）。 */
export interface FeishuTarget {
  userId?: string;
  chatId?: string;
}

export interface FeishuClient {
  /** 发送文本消息，成功返回 message_id。 */
  sendText(text: string, cfg: FeishuTarget): Promise<SendResult>;
  /** 发送 markdown 消息（飞书 post 富文本渲染），成功返回 message_id。 */
  sendMarkdown(markdown: string, cfg: FeishuTarget): Promise<SendResult>;
  /**
   * 原地编辑一条已发送的 text/post 消息内容（im.v1.message.update），
   * 用于把「处理中」进度刷新在同一消息上，避免刷屏。返回是否成功。
   */
  updateText(messageId: string, text: string): Promise<boolean>;
  /** 订阅消息事件，返回 unsubscribe。单 handler 替换：新订阅会替换旧订阅。 */
  subscribe(handler: (msg: FeishuMessage) => void): () => void;
  /** 显式关闭连接（仅进程退出/测试清理使用）。 */
  close(): void;
  /** 当前是否已连接。 */
  isConnected(): boolean;
}

function resolveDomain(value: unknown): lark.Domain | string | undefined {
  if (!value) return undefined;
  if (value === 'feishu') return lark.Domain.Feishu;
  if (value === 'lark') return lark.Domain.Lark;
  return String(value);
}

function resolveLoggerLevel(value: unknown): lark.LoggerLevel {
  if (value === 'debug') return lark.LoggerLevel.debug;
  if (value === 'info') return lark.LoggerLevel.info;
  if (value === 'warn') return lark.LoggerLevel.warn;
  if (value === 'trace') return lark.LoggerLevel.trace;
  return lark.LoggerLevel.error;
}

function normalizeTextContent(content: string): string {
  // 只对「看起来是 JSON」的 content 做解析（text 消息 content 是 {"text":"..."}）；
  // SDK 对 post 消息已转成纯文本，纯文本即使是合法 JSON（如 "123"）也不该被误拆。
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(content) as { text?: unknown };
      return typeof parsed.text === 'string' ? parsed.text : '';
    } catch {
      // fallthrough → 原样返回
    }
  }
  return content;
}

/** 解析发送目标为 SDK 的 to 字符串（userId 优先，其次 chatId）。 */
function resolveTarget(cfg: FeishuTarget): string {
  return cfg.userId ?? cfg.chatId ?? '';
}

/** 轮询等待条件成立（带超时），默认 5ms 间隔。 */
async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 5): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return cond();
}

/** SDK 长连接通道 → 简化 FeishuMessage。 */
function toFeishuMessage(msg: lark.NormalizedMessage): FeishuMessage {
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatType: msg.chatType,
    senderId: msg.senderId,
    senderName: msg.senderName,
    content: normalizeTextContent(msg.content),
    rawContentType: msg.rawContentType,
    mentionedBot: msg.mentionedBot,
    mentionAll: msg.mentionAll,
    rootId: msg.rootId,
    threadId: msg.threadId,
    replyToMessageId: msg.replyToMessageId,
    createTime: msg.createTime,
  };
}

/** 基于 SDK 的 FeishuClient 实现。 */
class SdkFeishuClient implements FeishuClient {
  private channel: lark.LarkChannel | null = null;
  private readonly subscribers = new Set<(msg: FeishuMessage) => void>();
  /** 单 handler 替换：记录最近一次注册的 handler，新注册时先移除旧的。
   *  这样 reload 后新扩展实例的 subscribe 会替换掉旧实例捕获 stale pi 的 handler。 */
  private currentHandler: ((msg: FeishuMessage) => void) | null = null;
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private restartDelay = 3000;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly log: (event: string, data?: Record<string, unknown>, level?: string) => void;

  constructor(
    private readonly cfg: FeishuNotifyConfig,
    log: (event: string, data?: Record<string, unknown>, level?: string) => void = () => undefined,
  ) {
    this.log = log;
  }

  async sendText(
    text: string,
    cfg: { userId?: string; chatId?: string },
  ): Promise<SendResult> {
    const client = this.getClient();
    const receiveId = cfg.userId ?? cfg.chatId;
    const receiveIdType = cfg.userId ? 'open_id' : 'chat_id';
    const err = messages(resolveLocale(this.cfg.locale)).error;
    if (!receiveId) {
      return { ok: false, error: err.missingTarget };
    }
    try {
      const response = await client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      if (response.code !== 0) {
        return { ok: false, error: `${err.sendFailed}${response.msg ?? response.code}` };
      }
      const messageId = response.data?.message_id;
      if (!messageId) {
        return { ok: false, error: err.noMessageId };
      }
      return { ok: true, messageId };
    } catch (e) {
      return { ok: false, error: `${err.sendError}${e instanceof Error ? e.message : String(e)}` };
    }
  }

  subscribe(handler: (msg: FeishuMessage) => void): () => void {
    // 单 handler 替换：移除旧的（reload 后旧实例的 handler 捕获 stale pi，必须换掉）
    if (this.currentHandler && this.currentHandler !== handler) {
      this.subscribers.delete(this.currentHandler);
    }
    this.subscribers.add(handler);
    this.currentHandler = handler;
    void this.ensureChannel();
    // 常驻单例：unsubscribe 只移除 handler，不关闭 consumer。
    return () => {
      this.subscribers.delete(handler);
      if (this.currentHandler === handler) this.currentHandler = null;
    };
  }

  async sendMarkdown(
    markdown: string,
    cfg: FeishuTarget,
  ): Promise<SendResult> {
    const to = resolveTarget(cfg);
    const err = messages(resolveLocale(this.cfg.locale)).error;
    if (!to) {
      return { ok: false, error: err.missingTarget };
    }
    try {
      const channel = await this.ensureConnectedChannel();
      const result = await channel.send(to, { markdown });
      return { ok: true, messageId: result.messageId };
    } catch (e) {
      return { ok: false, error: `${err.sendError}${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async updateText(messageId: string, text: string): Promise<boolean> {
    if (!messageId) return false;
    try {
      const channel = await this.ensureConnectedChannel();
      await channel.editMessage(messageId, text);
      return true;
    } catch (e) {
      this.log('feishu-update-failed', { messageId, error: e instanceof Error ? e.message : String(e) }, 'WARN');
      return false;
    }
  }

  private async ensureConnectedChannel(): Promise<lark.LarkChannel> {
    if (this.channel) {
      const ready = await waitFor(() => this.connected, 8000);
      if (ready && this.channel) return this.channel;
    }
    // 尚未建连：主动建一个（与 subscribe 共用 ensureChannel 逻辑）
    this.ensureChannel();
    const ok = await waitFor(() => this.channel !== null && this.connected, 8000);
    if (!ok || !this.channel) {
      throw new Error(messages(resolveLocale(this.cfg.locale)).error.channelNotReady);
    }
    return this.channel;
  }

  private getClient(): lark.Client {
    if (!this.cfg.appId || !this.cfg.appSecret) {
      throw new FeishuConfigError(messages(resolveLocale(this.cfg.locale)).error.missingCredentials);
    }
    return new lark.Client({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      source: 'pi-feishu-notify',
      ...(resolveDomain(this.cfg.domain) !== undefined
        ? { domain: resolveDomain(this.cfg.domain) }
        : {}),
    });
  }

  private ensureChannel(): void {
    if (this.channel) return;
    if (this.connectPromise) return;
    if (this.shuttingDown) return;
    if (!this.cfg.appId || !this.cfg.appSecret) {
      this.log('feishu-config-missing', undefined, 'WARN');
      return;
    }

    const channel = lark.createLarkChannel({
      appId: this.cfg.appId,
      appSecret: this.cfg.appSecret,
      transport: 'websocket',
      loggerLevel: resolveLoggerLevel(this.cfg.domain),
      source: 'pi-feishu-notify',
      // 回复通知回注场景：不要求 @ 机器人，自己按 sender/chat 白名单过滤
      policy: {
        requireMention: false,
        respondToMentionAll: false,
        ...(Array.isArray(this.cfg.allowedChatIds) && this.cfg.allowedChatIds.length > 0
          ? { groupAllowlist: this.cfg.allowedChatIds }
          : {}),
      },
    });
    this.channel = channel;

    channel.on('message', (msg) => {
      const feishuMsg = toFeishuMessage(msg);
      for (const fn of [...this.subscribers]) {
        try {
          fn(feishuMsg);
        } catch (err) {
          this.log('feishu-handler-error', { error: String(err) }, 'ERROR');
        }
      }
    });
    channel.on('error', (err) => {
      this.log('feishu-channel-error', { error: err.message, code: err.code }, 'ERROR');
      this.connected = false;
    });
    channel.on('reconnecting', () => {
      this.log('feishu-reconnecting', undefined, 'WARN');
    });
    channel.on('reconnected', () => {
      this.connected = true;
      this.log('feishu-reconnected', undefined, 'INFO');
    });

    this.connectPromise = channel
      .connect()
      .then(() => {
        this.connected = true;
        this.connectPromise = null;
        this.log('feishu-connected', undefined, 'INFO');
      })
      .catch((err: unknown) => {
        this.connected = false;
        this.connectPromise = null;
        this.channel = null;
        this.log(
          'feishu-connect-failed',
          { error: err instanceof Error ? err.message : String(err) },
          'ERROR',
        );
        this.scheduleRestart();
      });
  }

  private scheduleRestart(): void {
    if (this.shuttingDown || this.restartTimer || this.connectPromise) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      this.restartDelay = Math.min(this.restartDelay * 2, 60000);
      this.ensureChannel();
    }, this.restartDelay);
    this.restartTimer.unref?.();
  }

  close(): void {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const c = this.channel;
    this.channel = null;
    if (c) {
      void c.disconnect().catch(() => undefined);
    }
    this.connected = false;
    setTimeout(() => {
      this.shuttingDown = false;
    }, 500).unref?.();
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/** 获取进程级单例 FeishuClient。 */
export function getFeishuClient(
  cfg: FeishuNotifyConfig,
  log?: (event: string, data?: Record<string, unknown>, level?: string) => void,
): FeishuClient {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[CLIENT_KEY]) {
    g[CLIENT_KEY] = new SdkFeishuClient(cfg, log);
  }
  return g[CLIENT_KEY] as FeishuClient;
}

/** 进程退出/测试时释放单例（可选）。 */
export function resetFeishuClient(): void {
  const g = globalThis as Record<symbol, unknown>;
  const client = g[CLIENT_KEY] as FeishuClient | undefined;
  if (client) {
    client.close();
    delete g[CLIENT_KEY];
  }
}
