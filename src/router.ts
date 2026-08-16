/**
 * pi-feishu-notify — 通知路由 + 去重
 *
 * NotificationRouter：维护 message_id → session 的映射（持久化到
 * ~/.pi/agent/feishu-notify-router.json）。下行发通知时记录归属，上行收到
 * 回复时按 replyToMessageId 反查目标 session。
 *
 * ClaimDedup：跨进程认领去重，避免同一消息被多个 pi 进程重复处理。
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir, mutateJson, readJson, withDirLock } from './state.js';
import type { ClaimEntry, NotificationRecord } from './types.js';

export type NotificationMap = Record<string, NotificationRecord>;
export type ClaimMap = Record<string, ClaimEntry>;

const DEFAULT_NOTIFICATIONS: NotificationMap = {};
const DEFAULT_CLAIMS: ClaimMap = {};

function routerFile(): string {
  return join(stateDir(), 'feishu-notify-router.json');
}
function dedupFile(): string {
  return join(stateDir(), 'feishu-notify-dedup.json');
}
function routerLockDir(): string {
  return join(stateDir(), 'feishu-notify-router.lock');
}
function dedupLockDir(): string {
  return join(stateDir(), 'feishu-notify-dedup.lock');
}

/** 清理超过 maxAgeMs 的记录（默认 7 天）。 */
function pruneByAge<T extends { ts: number }>(
  map: Record<string, T>,
  maxAgeMs: number,
): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const k of Object.keys(map)) {
    if (map[k] && map[k].ts < cutoff) delete map[k];
  }
}

export class NotificationRouter {
  /** 记录一条通知的归属：message_id → session */
  record(messageId: string, sid: string): void {
    if (!messageId || !sid) return;
    mutateJson<NotificationMap>(
      routerFile(),
      routerLockDir(),
      () => ({ ...DEFAULT_NOTIFICATIONS }),
      (map) => {
        map[messageId] = { sid, ts: Date.now() };
      },
      (map) => pruneByAge(map, 7 * 24 * 60 * 60 * 1000),
    );
  }

  /** 反查 message_id 归属的 session。 */
  lookup(messageId: string): string | undefined {
    if (!messageId) return undefined;
    const map = readJson<NotificationMap>(routerFile(), () => ({ ...DEFAULT_NOTIFICATIONS }));
    return map[messageId]?.sid;
  }

  /** 删除一条记录（收到并处理后清理）。 */
  remove(messageId: string): void {
    if (!messageId) return;
    mutateJson<NotificationMap>(
      routerFile(),
      routerLockDir(),
      () => ({ ...DEFAULT_NOTIFICATIONS }),
      (map) => {
        delete map[messageId];
      },
    );
  }

  /** 当前记录条数（测试用）。 */
  size(): number {
    return Object.keys(
      readJson<NotificationMap>(routerFile(), () => ({ ...DEFAULT_NOTIFICATIONS })),
    ).length;
  }
}

export class ClaimDedup {
  constructor(private readonly maxAgeMs = 24 * 60 * 60 * 1000) {}

  /** 认领一条消息。返回 true 表示本进程获得处理权。 */
  claim(messageId: string, sid: string): boolean {
    if (!messageId) return false;
    let won = false;
    withDirLock(dedupLockDir(), () => {
      // 单锁内读改写，避免嵌套加锁
      const map = readJson<ClaimMap>(dedupFile(), () => ({ ...DEFAULT_CLAIMS }));
      if (map[messageId]) return;
      const tmp = join(stateDir(), `feishu-notify-dedup.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
      try {
        map[messageId] = { sid, ts: Date.now() };
        pruneByAge(map, this.maxAgeMs);
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(tmp, JSON.stringify(map, null, 2));
        renameSync(tmp, dedupFile());
        won = true;
      } catch {
        // 落盘失败不阻断：本次仍算认领，靠路由表兜底
        won = true;
      }
    });
    return won;
  }
}
