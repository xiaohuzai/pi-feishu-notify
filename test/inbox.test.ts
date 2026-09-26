import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { isolateStateDir } from './isolate-state.js';
import { stateDir } from '../src/state.js';
import { Inbox, decideDelivery, type DeliveryContext } from '../src/inbox.js';
import type { InboxEntry } from '../src/types.js';

// 每个测试文件用独立的 state 目录，避免并行时与其他测试文件共用状态文件
isolateStateDir('inbox');

function cleanup() {
  for (const f of ['feishu-notify-inbox.json']) {
    try {
      rmSync(join(stateDir(), f), { force: true });
    } catch {
      // noop
    }
  }
  for (const d of ['feishu-notify-inbox.lock']) {
    try {
      rmSync(join(stateDir(), d), { recursive: true, force: true });
    } catch {
      // noop
    }
  }
}

function entry(partial: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'om_1',
    sid: 'sid-1',
    pid: 100,
    text: '继续',
    ts: Date.now(),
    ...partial,
  };
}

describe('Inbox', () => {
  const inbox = new Inbox();
  beforeEach(cleanup);
  afterEach(cleanup);

  it('enqueue 后可读回 / take 取走即删除', () => {
    inbox.enqueue(entry());
    expect(inbox.get('om_1')?.sid).toBe('sid-1');
    expect(inbox.size()).toBe(1);

    const taken = inbox.take((e) => e.sid === 'sid-1');
    expect(taken).toHaveLength(1);
    expect(taken[0]?.text).toBe('继续');
    expect(inbox.get('om_1')).toBeUndefined();
    expect(inbox.size()).toBe(0);
  });

  it('take 只取走匹配条目', () => {
    inbox.enqueue(entry({ id: 'om_1', pid: 1 }));
    inbox.enqueue(entry({ id: 'om_2', pid: 2 }));
    const taken = inbox.take((e) => e.pid === 2);
    expect(taken.map((e) => e.id)).toEqual(['om_2']);
    expect(inbox.get('om_1')).toBeDefined();
  });

  it('同 id 幂等覆盖', () => {
    inbox.enqueue(entry({ text: '第一版' }));
    inbox.enqueue(entry({ text: '第二版' }));
    expect(inbox.size()).toBe(1);
    expect(inbox.get('om_1')?.text).toBe('第二版');
  });

  it('remove 删除单条', () => {
    inbox.enqueue(entry());
    inbox.remove('om_1');
    expect(inbox.size()).toBe(0);
  });

  it('超龄条目随写入清理', () => {
    const shortLived = new Inbox(50); // 50ms TTL
    shortLived.enqueue(entry({ ts: Date.now() - 1000 }));
    shortLived.enqueue(entry({ id: 'om_2' })); // 触发 prune
    expect(shortLived.size()).toBe(1);
    expect(shortLived.get('om_1')).toBeUndefined();
  });
});

describe('decideDelivery', () => {
  const MY_PID = 111;
  const alive = (pids: number[]) => (pid: number) => pids.includes(pid);

  function ctx(partial: Partial<DeliveryContext> = {}): DeliveryContext {
    return {
      targetSid: 'sid-1',
      localSids: new Set<string>(),
      isPidAlive: alive([]),
      myPid: MY_PID,
      aliveSessions: [],
      ...partial,
    };
  }

  it('目标 session 在本进程 → 本地回注', () => {
    const d = decideDelivery(ctx({ localSids: new Set(['sid-1']) }));
    expect(d).toEqual({ kind: 'local', sid: 'sid-1', stale: false });
  });

  it('目标 session 在另一存活进程 → 转发（issue #14 主诉求）', () => {
    const d = decideDelivery(
      ctx({
        registryEntry: { pid: 222, cwd: '/proj/a' },
        isPidAlive: alive([222]),
      }),
    );
    expect(d).toEqual({ kind: 'forward', sid: 'sid-1', pid: 222, stale: false });
  });

  it('目标 session 精确命中优先于同项目回退（不劫持到本进程当前会话）', () => {
    const d = decideDelivery(
      ctx({
        registryEntry: { pid: 222, cwd: '/proj/a' },
        isPidAlive: alive([222]),
        localSids: new Set(['sid-cur']),
        currentSid: 'sid-cur',
        currentCwd: '/proj/a', // 同项目，但目标会话在别的进程还活着
      }),
    );
    expect(d).toEqual({ kind: 'forward', sid: 'sid-1', pid: 222, stale: false });
  });

  it('目标进程已退出 + 同项目当前会话在本进程 → 回退本地（重启场景）', () => {
    const d = decideDelivery(
      ctx({
        registryEntry: { pid: 222, cwd: '/proj/a' },
        isPidAlive: alive([]), // 222 已死
        localSids: new Set(['sid-cur']),
        currentSid: 'sid-cur',
        currentCwd: '/proj/a',
      }),
    );
    expect(d).toEqual({ kind: 'local', sid: 'sid-cur', stale: true });
  });

  it('目标进程已退出 + 同项目存活会话在其它进程 → 转发给它', () => {
    const d = decideDelivery(
      ctx({
        registryEntry: { pid: 222, cwd: '/proj/a' },
        isPidAlive: alive([333]),
        aliveSessions: [{ sid: 'sid-2', pid: 333, cwd: '/proj/a' }],
      }),
    );
    expect(d).toEqual({ kind: 'forward', sid: 'sid-2', pid: 333, stale: true });
  });

  it('同项目回退不选本进程未激活的残留注册项', () => {
    const d = decideDelivery(
      ctx({
        registryEntry: { pid: 222, cwd: '/proj/a' },
        isPidAlive: alive([]),
        // 本进程注册表里有同项目历史条目，但 configs 中已无该 session
        aliveSessions: [{ sid: 'sid-old', pid: MY_PID, cwd: '/proj/a' }],
      }),
    );
    expect(d).toEqual({ kind: 'gone' });
  });

  it('无注册记录 → 会话已结束', () => {
    expect(decideDelivery(ctx())).toEqual({ kind: 'gone' });
  });

  it('注册记录指向本进程但 session 已不在 → 会话已结束', () => {
    const d = decideDelivery(
      ctx({ registryEntry: { pid: MY_PID, cwd: '/proj/a' }, currentCwd: '/proj/other' }),
    );
    expect(d).toEqual({ kind: 'gone' });
  });
});
