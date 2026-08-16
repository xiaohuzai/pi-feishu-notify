import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// 隔离测试用 home：把 ~/.pi/agent 指向临时目录
const TMP_HOME = '/tmp/pi-fn-it';
const AGENT_DIR = join(TMP_HOME, '.pi', 'agent');

vi.stubGlobal('__PI_TEST_HOME', TMP_HOME);

// 需要把 stateDir 指向测试目录——通过改环境变量不生效，
// 这里直接依赖 ~/.pi/agent（真实 homedir）。测试用真实家目录但清理干净。
// 为避免污染，测试全程只使用独立的 message_id。

import { stateDir } from '../src/state.js';

function cleanupState() {
  for (const f of ['feishu-notify-router.json', 'feishu-notify-dedup.json', 'feishu-notify-sessions.json']) {
    try {
      rmSync(join(stateDir(), f), { force: true });
    } catch {
      // noop
    }
  }
  for (const d of ['feishu-notify-router.lock', 'feishu-notify-dedup.lock', 'feishu-notify-sessions.lock']) {
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
});
