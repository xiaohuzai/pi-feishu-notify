import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isolateStateDir } from './isolate-state.js';
import { stateDir } from '../src/state.js';
import { recordDiscovered } from '../src/discovery.js';

// 每个测试文件用独立的 state 目录，避免并行时与其他测试文件共用 ~/.pi/agent 造成竞争
isolateStateDir('integration');

function cleanupState() {
  for (const f of ['feishu-notify-router.json', 'feishu-notify-dedup.json', 'feishu-notify-sessions.json', 'feishu-notify-discovered.json']) {
    try {
      rmSync(join(stateDir(), f), { force: true });
    } catch {
      // noop
    }
  }
  for (const d of ['feishu-notify-router.lock', 'feishu-notify-dedup.lock', 'feishu-notify-sessions.lock', 'feishu-notify-discovered.lock']) {
    try {
      rmSync(join(stateDir(), d), { recursive: true, force: true });
    } catch {
      // noop
    }
  }
}

// 载入扩展（延迟 require，因为扩展读取真实配置）
let factory: (pi: ExtensionAPI) => void;
beforeEach(async () => {
  cleanupState();
  factory = (await import('../extensions/feishu-notify.js')).default;
});
afterEach(cleanupState);

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    ui: { notify: vi.fn() } as unknown as ExtensionContext['ui'],
    mode: 'print',
    hasUI: false,
    cwd: '/tmp/pi-fn-it/proj',
    sessionManager: {
      getSessionId: () => 'session-test-1',
      getBranch: () => [],
      getCwd: () => '/tmp/pi-fn-it/proj',
    } as unknown as ExtensionContext['sessionManager'],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => '',
    ...overrides,
  } as ExtensionContext;
}

describe('extension integration', () => {
  it('加载后注册 session 钩子（不崩溃）', async () => {
    // 默认无配置：session_start 应安全处理
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    factory(pi);

    // 取出 session_start handler 并触发
    const startHandler = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'session_start',
    )?.[1] as (e: unknown, ctx: ExtensionContext) => void | Promise<void>;

    expect(startHandler).toBeDefined();
    await startHandler?.({ type: 'session_start', reason: 'startup' }, makeCtx());
    // 不崩溃即可
  });

  it('无配置时 agent_settled 不发送（静默）', async () => {
    const sendUserMessage = vi.fn();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage,
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    factory(pi);

    const settledHandler = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'agent_settled',
    )?.[1] as (e: unknown, ctx: ExtensionContext) => void | Promise<void>;

    await settledHandler?.({ type: 'agent_settled' }, makeCtx());
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it('注册 feishu-notify 命令', () => {
    const registerCommand = vi.fn();
    const pi = {
      on: vi.fn(),
      registerCommand,
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    factory(pi);
    const call = registerCommand.mock.calls.find((c: unknown[]) => c[0] === 'feishu-notify');
    expect(call).toBeDefined();
    expect(typeof call?.[1]?.handler).toBe('function');
  });

  it('已识别但未配 userId 时，session_start 弹一次性 bind 提示', async () => {
    // 先持久化一条识别结果
    recordDiscovered('ou_hint', 'oc_hint_chat');

    const notify = vi.fn();
    const pi = {
      on: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    factory(pi);

    const startHandler = (pi.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'session_start',
    )?.[1] as (e: unknown, ctx: ExtensionContext) => void | Promise<void>;

    // TUI 上下文 + 未配置 userId → 应弹出提示
    await startHandler?.(
      { type: 'session_start', reason: 'startup' },
      makeCtx({ hasUI: true, ui: { notify } as unknown as ExtensionContext['ui'] }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0]?.[0] ?? '')).toContain('bind');

    // 第二次 session_start（同进程）→ 只提示一次
    await startHandler?.(
      { type: 'session_start', reason: 'new' },
      makeCtx({ hasUI: true, ui: { notify } as unknown as ExtensionContext['ui'] }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe('follow-up 回注：只发最终结果，不泄漏 thinking/toolUse', () => {
  const CLIENT_KEY = Symbol.for('pi-feishu-notify.client');
  const PROJ = '/tmp/pi-fn-it/proj';

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[CLIENT_KEY];
    // 写入项目级 settings，提供 appId/appSecret/userId，使 session_start 能建连
    mkdirSync(join(PROJ, '.pi'), { recursive: true });
    writeFileSync(join(PROJ, '.pi', 'settings.json'), JSON.stringify({
      'feishu-notify': {
        enabled: true,
        appId: 'cli_test',
        appSecret: 'secret_test',
        userId: 'ou_test',
        replyEnabled: true,
        receipt: true,
      },
    }));
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[CLIENT_KEY];
    rmSync(join(PROJ, '.pi'), { recursive: true, force: true });
  });

  /** 组装 handlers + mock client，返回可驱动的方法。 */
  function setup(mockClient: unknown, sendUserMessage: ReturnType<typeof vi.fn>) {
    (globalThis as Record<symbol, unknown>)[CLIENT_KEY] = mockClient;
    const pi = { on: vi.fn(), registerCommand: vi.fn(), sendUserMessage, sendMessage: vi.fn() } as unknown as ExtensionAPI;
    factory(pi);
    const handlers = Object.fromEntries(
      (pi.on as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => [c[0], c[1]]),
    ) as Record<string, (e: unknown, ctx: ExtensionContext) => void | Promise<void>>;
    return { handlers };
  }

  it('回注后：先发回执，agent_settled 只发过滤后的最终 markdown 结果', async () => {
    const sent: string[] = [];
    const mockClient = {
      sendText: vi.fn(async (text: string) => { sent.push(`TEXT:${text}`); return { ok: true, messageId: 'rcpt-1' }; }),
      sendMarkdown: vi.fn(async (md: string) => { sent.push(`MD:${md}`); return { ok: true, messageId: 'notify-1' }; }),
      updateText: vi.fn(async () => true),
      subscribe: vi.fn(() => () => {}),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    // 模拟空闲场景：sendUserMessage 阻塞到 agent 跑完（内部触发 agent_end/agent_settled）
    let agentEndHandler: ((e: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
    let agentSettledHandler: ((e: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
    const sendUserMessage = vi.fn(async () => {
      // 先 agent_end：把最终文本写进 lastAssistantText
      const branch = [
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '这是最终结果，不含思考。' }] } },
      ];
      await agentEndHandler?.({ type: 'agent_end', messages: [] }, makeCtx({ sessionManager: { getSessionId: () => 'session-test-1', getBranch: () => branch, getCwd: () => PROJ } } as unknown as Partial<ExtensionContext>));
      await agentSettledHandler?.({ type: 'agent_settled' }, makeCtx());
    });

    const { handlers } = setup(mockClient, sendUserMessage);
    agentEndHandler = handlers['agent_end'];
    agentSettledHandler = handlers['agent_settled'];
    const ctx = makeCtx();
    await handlers['session_start']?.({ type: 'session_start', reason: 'startup' }, ctx);

    const { NotificationRouter } = await import('../src/router.js');
    new NotificationRouter().record('om_notify_1', 'session-test-1');

    const sub = (mockClient.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as (msg: any) => void;
    sub({
      messageId: 'om_reply_1', chatId: 'oc_1', chatType: 'p2p', senderId: 'ou_1', senderName: '张三',
      content: '继续', rawContentType: 'text', mentionedBot: false, mentionAll: false,
      replyToMessageId: 'om_notify_1', rootId: '', threadId: '', createTime: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(sendUserMessage).toHaveBeenCalled();
    // 先发了「已收到」回执
    expect(sent.some((s) => s.startsWith('TEXT:') && s.includes('继续'))).toBe(true);
    // 最终发了一条 markdown 通知，且内容只含最终结果、不含 thinking/toolUse
    const md = sent.find((s) => s.startsWith('MD:')) ?? '';
    expect(md).toContain('这是最终结果');
    expect(md).not.toContain('thinking');
    expect(md).not.toContain('toolCall');
  });

  it('不再注册流式事件处理器（message_start/update/end）', () => {
    const mockClient = {
      sendText: vi.fn(async () => ({ ok: true, messageId: 't1' })),
      sendMarkdown: vi.fn(async () => ({ ok: true, messageId: 'm1' })),
      updateText: vi.fn(async () => true),
      subscribe: vi.fn(() => () => {}),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const { handlers } = setup(mockClient, vi.fn(async () => {}));
    expect(handlers['message_start']).toBeUndefined();
    expect(handlers['message_update']).toBeUndefined();
    expect(handlers['message_end']).toBeUndefined();
  });
});
