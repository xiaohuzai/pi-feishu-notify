import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { isolateStateDir } from './isolate-state.js';
import { stateDir } from '../src/state.js';
import { loadDiscovered, recordDiscovered } from '../src/discovery.js';

// 每个测试文件用独立的 state 目录，避免并行时与其他测试文件（如 integration）共用 ~/.pi/agent 造成竞争
isolateStateDir('discovery');

function cleanup() {
  try {
    rmSync(join(stateDir(), 'feishu-notify-discovered.json'), { force: true });
    rmSync(join(stateDir(), 'feishu-notify-discovered.lock'), { recursive: true, force: true });
  } catch {
    // noop
  }
}

describe('discovery 持久化', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('未记录时返回空', () => {
    const st = loadDiscovered();
    expect(st.userId).toBeUndefined();
    expect(st.chatIds).toEqual([]);
  });

  it('记录 userId 后可读回', () => {
    recordDiscovered('ou_abc', 'oc_chat');
    const st = loadDiscovered();
    expect(st.userId).toBe('ou_abc');
    expect(st.chatIds).toContain('oc_chat');
  });

  it('chatId 去重追加', () => {
    recordDiscovered('ou_abc', 'oc_chat');
    recordDiscovered('ou_abc', 'oc_chat');
    recordDiscovered(undefined, 'oc_chat2');
    const st = loadDiscovered();
    expect(st.chatIds).toEqual(['oc_chat', 'oc_chat2']);
    expect(st.userId).toBe('ou_abc');
  });

  it('新 userId 覆盖旧的', () => {
    recordDiscovered('ou_old', 'oc_chat');
    recordDiscovered('ou_new', 'oc_chat');
    expect(loadDiscovered().userId).toBe('ou_new');
  });
});
