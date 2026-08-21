import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
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
