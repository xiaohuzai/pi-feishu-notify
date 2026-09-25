import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionRegistry } from '../src/sessions.js';
import { isolateStateDir } from './isolate-state.js';
import { stateDir } from '../src/state.js';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

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

  it('保留已退出进程的历史记录（stale 回注依赖，不能按 pid 死活即删）', () => {
    // 预置一条死进程（pid 必不存在）的会话记录
    writeFileSync(
      join(stateDir(), 'feishu-notify-sessions.json'),
      JSON.stringify({
        'session-old': { pid: 2147483647, cwd: '/proj/old', startedAt: new Date().toISOString() },
      }),
    );
    const reg = new SessionRegistry();
    reg.register('session-new', '/proj/new');
    // 历史记录保留 → 重启后回复旧通知仍可按 cwd 比对回退注入
    expect(reg.get('session-old')?.cwd).toBe('/proj/old');
    expect(reg.get('session-new')?.cwd).toBe('/proj/new');
    // 但不计入存活列表
    expect(reg.alive().map((e) => e.sid)).toEqual(['session-new']);
  });

  it('register 按保留天数清理过期历史记录', () => {
    writeFileSync(
      join(stateDir(), 'feishu-notify-sessions.json'),
      JSON.stringify({
        'session-ancient': {
          pid: 2147483647,
          cwd: '/proj/old',
          startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    );
    const reg = new SessionRegistry();
    reg.register('session-new', '/proj/new', 7); // 10 天前的记录超出 7 天保留期
    expect(reg.get('session-ancient')).toBeUndefined();
    expect(reg.get('session-new')).toBeDefined();
  });

  it('保留天数更大时历史记录不被清理', () => {
    writeFileSync(
      join(stateDir(), 'feishu-notify-sessions.json'),
      JSON.stringify({
        'session-ancient': {
          pid: 2147483647,
          cwd: '/proj/old',
          startedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        },
      }),
    );
    const reg = new SessionRegistry();
    reg.register('session-new', '/proj/new', 30);
    expect(reg.get('session-ancient')?.cwd).toBe('/proj/old');
  });
});
