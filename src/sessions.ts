/**
 * pi-feishu-notify — 会话注册表
 *
 * 记录当前活跃的 pi session（pid + cwd + 启动时间），用于：
 *  - 崩溃自愈：清理已死进程残留的孤儿记录
 *  - 诊断：/feishu-notify status 展示当前注册的 session
 *
 * 注意：SDK 长连接在 pi 进程内，进程退出 WebSocket 自然断开，无需像
 * lark-cli 子进程那样回收孤儿 consumer；这里主要做状态记账与清理。
 */
import { join } from 'node:path';
import { stateDir, mutateJson, readJson, pidAlive } from './state.js';
import type { SessionEntry } from './types.js';

export type SessionMap = Record<string, SessionEntry>;

const DEFAULT_SESSIONS: SessionMap = {};

function sessionsFile(): string {
  return join(stateDir(), 'feishu-notify-sessions.json');
}
function sessionsLockDir(): string {
  return join(stateDir(), 'feishu-notify-sessions.lock');
}

export class SessionRegistry {
  /** 注册一个 session（崩溃清理：顺带移除死进程的孤儿记录）。 */
  register(sid: string, cwd: string): void {
    if (!sid) return;
    mutateJson<SessionMap>(
      sessionsFile(),
      sessionsLockDir(),
      () => ({ ...DEFAULT_SESSIONS }),
      (map) => {
        for (const k of Object.keys(map)) {
          if (!map[k]) continue;
          if (map[k]!.pid === process.pid && k !== sid) {
            // 同进程旧记录
          }
          if (!pidAlive(map[k]!.pid)) delete map[k];
        }
        map[sid] = { pid: process.pid, cwd, startedAt: new Date().toISOString() };
      },
    );
  }

  /** 反注册一个 session。 */
  unregister(sid: string): void {
    if (!sid) return;
    mutateJson<SessionMap>(
      sessionsFile(),
      sessionsLockDir(),
      () => ({ ...DEFAULT_SESSIONS }),
      (map) => {
        delete map[sid];
      },
    );
  }

  /** 当前存活 session 列表（自动剔除死进程）。 */
  alive(): Array<{ sid: string; pid: number; cwd: string }> {
    const map = readJson<SessionMap>(sessionsFile(), () => ({ ...DEFAULT_SESSIONS }));
    return Object.entries(map)
      .filter(([, e]) => e && pidAlive(e.pid))
      .map(([sid, e]) => ({ sid, pid: e.pid, cwd: e.cwd }));
  }

  /** 清理所有死进程残留记录。 */
  sweep(): void {
    mutateJson<SessionMap>(
      sessionsFile(),
      sessionsLockDir(),
      () => ({ ...DEFAULT_SESSIONS }),
      (map) => {
        for (const k of Object.keys(map)) {
          if (map[k] && !pidAlive(map[k]!.pid)) delete map[k];
        }
      },
    );
  }

  size(): number {
    return this.alive().length;
  }
}
