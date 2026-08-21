import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/sessions.js';
import { isolateStateDir } from './isolate-state.js';
import { stateDir } from '../src/state.js';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// 每个测试文件用独立的 state 目录，避免并行时与其他测试文件共用 ~/.pi/agent 造成竞争
isolateStateDir('sessions');

function cleanup() {
  for (const f of ['feishu-notify-sessions.json']) {
    try {
      rmSync(join(stateDir(), f), { force: true });
    } catch {
      // noop
    }
  }
  for (const d of ['feishu-notify-sessions.lock']) {
    try {
      rmSync(join(stateDir(), d), { recursive: true, force: true });
    } catch {
      // noop
    }
  }
}

describe('SessionRegistry', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it('register 后可 get 出 pid+cwd（含历史记录）', () => {
    const reg = new SessionRegistry();
    reg.register('session-A', '/proj/a');
    const got = reg.get('session-A');
    expect(got).toBeDefined();
    expect(got?.cwd).toBe('/proj/a');
    expect(typeof got?.pid).toBe('number');
  });

  it('未注册的 sid → undefined', () => {
    const reg = new SessionRegistry();
    expect(reg.get('session-nope')).toBeUndefined();
  });

  it('unregister 后 get 不到', () => {
    const reg = new SessionRegistry();
    reg.register('session-A', '/proj/a');
    reg.unregister('session-A');
    expect(reg.get('session-A')).toBeUndefined();
  });

  it('空 sid 不入库', () => {
    const reg = new SessionRegistry();
    reg.register('', '/proj/a');
    expect(reg.size()).toBe(0);
  });
});
