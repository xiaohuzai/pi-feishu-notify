/**
 * pi-feishu-notify — 会话注册表
 *
 * 记录 pi session（pid + cwd + 启动时间），用于：
 *  - stale 回注：pi 重启后 session id 会变，回复旧通知时按记录里的 cwd
 *    与当前项目比对，同项目则回退注入到当前会话。因此**历史记录（含已退出
 *    进程的）必须保留**，只按 staleDays 做过期清理，不能按 pid 死活即删。
 *  - 诊断：/feishu-notify status 展示当前存活的 session（alive 自动剔除死进程）
 *
 * 注意：SDK 长连接在 pi 进程内，进程退出 WebSocket 自然断开，无需像
 * lark-cli 子进程那样回收孤儿 consumer；这里主要做状态记账与清理。
 */
import { join } from 'node:path';
import { stateDir, mutateJson, readJson, pidAlive } from './state.js';
import { retentionMs } from './router.js';
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
  /**
   * 注册一个 session。历史记录按保留天数清理（默认 7 天）；
   * 同 sid 重复注册覆盖为最新（pid/cwd/startedAt）。
   */
  register(sid: string, cwd: string, retentionDays?: number): void {
    if (!sid) return;
    const maxAgeMs = retentionMs(retentionDays);
    mutateJson<SessionMap>(
      sessionsFile(),
      sessionsLockDir(),
      () => ({ ...DEFAULT_SESSIONS }),
      (map) => {
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (!e) {
            delete map[k];
            continue;
          }
          const started = Date.parse(e.startedAt);
          if (Number.isFinite(started) && Date.now() - started > maxAgeMs) delete map[k];
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

  /** 直接读取某个 session 的注册条目（含已退出的历史记录，供 stale 回注判断用）。 */
  get(sid: string): { pid: number; cwd: string } | undefined {
    if (!sid) return undefined;
    const map = readJson<SessionMap>(sessionsFile(), () => ({ ...DEFAULT_SESSIONS }));
    const e = map[sid];
    return e ? { pid: e.pid, cwd: e.cwd } : undefined;
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
