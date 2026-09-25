import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NotificationRouter, ClaimDedup, retentionMs } from '../src/router.js';
import { isolateStateDir } from './isolate-state.js';
import { stateDir } from '../src/state.js';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 每个测试文件用独立的 state 目录，避免并行时与其他测试文件共用 ~/.pi/agent 造成竞争
isolateStateDir('router');

function cleanup() {
  try {
    rmSync(join(stateDir(), 'feishu-notify-router.json'), { force: true });
    rmSync(join(stateDir(), 'feishu-notify-dedup.json'), { force: true });
    rmSync(join(stateDir(), 'feishu-notify-router.lock'), { recursive: true, force: true });
    rmSync(join(stateDir(), 'feishu-notify-dedup.lock'), { recursive: true, force: true });
  } catch {
    // noop
  }
}

describe('NotificationRouter', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('记录并反查 message_id → session', () => {
    const router = new NotificationRouter();
    router.record('msg-1', 'session-A');
    expect(router.lookup('msg-1')).toBe('session-A');
    expect(router.lookup('msg-unknown')).toBeUndefined();
  });

  it('record 后持久化到磁盘（重新实例化仍可反查）', () => {
    const router1 = new NotificationRouter();
    router1.record('msg-2', 'session-B');
    const router2 = new NotificationRouter();
    expect(router2.lookup('msg-2')).toBe('session-B');
  });

  it('remove 后无法反查', () => {
    const router = new NotificationRouter();
    router.record('msg-3', 'session-C');
    router.remove('msg-3');
    expect(router.lookup('msg-3')).toBeUndefined();
  });

  it('空 messageId 不写入', () => {
    const router = new NotificationRouter();
    router.record('', 'session-A');
    router.record('msg-x', '');
    expect(router.size()).toBe(0);
  });

  it('record 按 retentionDays（staleDays）清理过期记录', () => {
    // 预置一条 8 天前的旧记录
    writeFileSync(
      join(stateDir(), 'feishu-notify-router.json'),
      JSON.stringify({ 'msg-old': { sid: 'session-old', ts: Date.now() - 8 * 24 * 60 * 60 * 1000 } }),
    );
    const router = new NotificationRouter();
    router.record('msg-new', 'session-new', 7); // 保留 7 天 → 8 天前的应被清理
    expect(router.lookup('msg-old')).toBeUndefined();
    expect(router.lookup('msg-new')).toBe('session-new');
  });

  it('retentionDays 更大时保留旧记录', () => {
    writeFileSync(
      join(stateDir(), 'feishu-notify-router.json'),
      JSON.stringify({ 'msg-old': { sid: 'session-old', ts: Date.now() - 8 * 24 * 60 * 60 * 1000 } }),
    );
    const router = new NotificationRouter();
    router.record('msg-new', 'session-new', 30);
    expect(router.lookup('msg-old')).toBe('session-old');
    expect(router.lookup('msg-new')).toBe('session-new');
  });

  it('retentionMs：非法/未配置回退默认 7 天', () => {
    expect(retentionMs(undefined)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(retentionMs(0)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(retentionMs(-3)).toBe(7 * 24 * 60 * 60 * 1000);
    expect(retentionMs(30)).toBe(30 * 24 * 60 * 60 * 1000);
  });
});

describe('ClaimDedup', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('同一消息只被认领一次', () => {
    const dedup = new ClaimDedup();
    expect(dedup.claim('msg-1', 'session-A')).toBe(true);
    expect(dedup.claim('msg-1', 'session-B')).toBe(false);
  });

  it('不同消息可各自认领', () => {
    const dedup = new ClaimDedup();
    expect(dedup.claim('msg-A', 's1')).toBe(true);
    expect(dedup.claim('msg-B', 's2')).toBe(true);
  });

  it('认领持久化（重新实例化仍拒绝重复认领）', () => {
    const d1 = new ClaimDedup();
    expect(d1.claim('msg-persist', 's1')).toBe(true);
    const d2 = new ClaimDedup();
    expect(d2.claim('msg-persist', 's1')).toBe(false);
  });
});
