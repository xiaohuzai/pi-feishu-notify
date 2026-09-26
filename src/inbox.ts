/**
 * pi-feishu-notify — 跨进程回注收件箱 + 投递决策
 *
 * 飞书长连接是**集群投递**：同一应用的多个 client 中，一条事件只会随机到达
 * 其中一个。因此「回复通知」的事件可能落在非目标 session 所在的 pi 进程上，
 * 而 pi.sendUserMessage 只能注入本进程的会话。
 *
 * 解决方案（跨进程 inbox）：
 *  - decideDelivery（纯函数）：按会话注册表判断一条指令该本地回注、转发给
 *    哪个 pid、还是目标会话确实已结束；
 *  - Inbox：收到事件的进程把 {sid, text, pid} 写进收件箱文件，目标进程轮询
 *    取回后本地回注。读写均带目录锁 + 原子替换，多进程安全；条目按 id 幂等，
 *    超时未取走的孤儿条目按 TTL 清理。
 */
import { join } from 'node:path';
import { mutateJson, pruneByAge, readJson, stateDir } from './state.js';
import type { InboxEntry } from './types.js';

export type InboxMap = Record<string, InboxEntry>;

const DEFAULT_INBOX: InboxMap = {};

/** 孤儿条目保留时长（目标进程一直没取走则过期清理）。 */
const DEFAULT_INBOX_TTL_MS = 24 * 60 * 60 * 1000;

function inboxFile(): string {
  return join(stateDir(), 'feishu-notify-inbox.json');
}
function inboxLockDir(): string {
  return join(stateDir(), 'feishu-notify-inbox.lock');
}

export class Inbox {
  constructor(private readonly maxAgeMs = DEFAULT_INBOX_TTL_MS) {}

  /** 写入一条待回注指令（同 id 幂等覆盖）。 */
  enqueue(entry: InboxEntry): void {
    if (!entry.id || !entry.sid) return;
    mutateJson<InboxMap>(
      inboxFile(),
      inboxLockDir(),
      () => ({ ...DEFAULT_INBOX }),
      (map) => {
        map[entry.id] = entry;
      },
      (map) => pruneByAge(map, this.maxAgeMs),
    );
  }

  /**
   * 原子取走匹配条目（一次加锁内读改写，多进程不会重复投递）。
   * 取走的条目同时从文件删除。加锁失败时返回空数组，留待下次轮询。
   */
  take(pred: (e: InboxEntry) => boolean): InboxEntry[] {
    const taken: InboxEntry[] = [];
    mutateJson<InboxMap>(
      inboxFile(),
      inboxLockDir(),
      () => ({ ...DEFAULT_INBOX }),
      (map) => {
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (e && pred(e)) {
            taken.push(e);
            delete map[k];
          }
        }
      },
      (map) => pruneByAge(map, this.maxAgeMs),
    );
    return taken;
  }

  /** 读取单条（转发超时监控用）。 */
  get(id: string): InboxEntry | undefined {
    if (!id) return undefined;
    const map = readJson<InboxMap>(inboxFile(), () => ({ ...DEFAULT_INBOX }));
    return map[id];
  }

  /** 删除单条。 */
  remove(id: string): void {
    if (!id) return;
    mutateJson<InboxMap>(
      inboxFile(),
      inboxLockDir(),
      () => ({ ...DEFAULT_INBOX }),
      (map) => {
        delete map[id];
      },
    );
  }

  /** 当前条目数（测试用）。 */
  size(): number {
    return Object.keys(readJson<InboxMap>(inboxFile(), () => ({ ...DEFAULT_INBOX }))).length;
  }
}

// ── 投递决策 ────────────────────────────────────────────────────────

export interface DeliveryContext {
  /** 要注入的目标 session id（通知路由反查得到） */
  targetSid: string;
  /** 本进程持有的 session id 集合 */
  localSids: ReadonlySet<string>;
  /** 目标 session 在会话注册表中的条目（可能已过期/不存在） */
  registryEntry?: { pid: number; cwd: string };
  /** pid 存活探测 */
  isPidAlive: (pid: number) => boolean;
  /** 本进程 pid */
  myPid: number;
  /** 本进程当前激活的 session id */
  currentSid?: string;
  /** 当前激活 session 的 cwd */
  currentCwd?: string;
  /** 跨进程存活 session 列表（pid/cwd），用于同项目跨进程回退 */
  aliveSessions: Array<{ sid: string; pid: number; cwd: string }>;
}

export type DeliveryDecision =
  /** 本地回注（stale=true 表示目标会话已结束，回退到同项目的当前会话） */
  | { kind: 'local'; sid: string; stale: boolean }
  /** 转发给另一个存活进程（stale=true 表示按同项目回退选中的会话） */
  | { kind: 'forward'; sid: string; pid: number; stale: boolean }
  /** 目标会话（及其同项目会话）均已结束 */
  | { kind: 'gone' };

/**
 * 决定一条指令的投递方式。判定顺序：
 *  1. 目标 session 就在本进程 → 本地回注；
 *  2. 目标 session 在另一个存活进程 → 转发给它（精确匹配优先）；
 *  3. 目标 session 已结束 → 同项目（cwd 相同）回退：先本进程当前会话
 *     （pi 重启后 session id 变化场景），再其它进程的存活会话；
 *  4. 都没有 → 会话已结束。
 */
export function decideDelivery(ctx: DeliveryContext): DeliveryDecision {
  const { targetSid, localSids, registryEntry, isPidAlive, myPid, currentSid, currentCwd, aliveSessions } = ctx;

  // 1. 目标 session 在本进程
  if (localSids.has(targetSid)) {
    return { kind: 'local', sid: targetSid, stale: false };
  }

  // 2. 目标 session 在另一个存活进程 → 跨进程转发（不能误报「会话已结束」）
  if (registryEntry && registryEntry.pid !== myPid && isPidAlive(registryEntry.pid)) {
    return { kind: 'forward', sid: targetSid, pid: registryEntry.pid, stale: false };
  }

  // 3. 目标会话已不在 → 同项目回退（保留「重启后回复旧通知」能力）
  const cwd = registryEntry?.cwd;
  if (cwd) {
    // 3a. 本进程当前会话同项目（pi 重启后 session id 变化）
    if (
      currentSid &&
      currentSid !== targetSid &&
      currentCwd === cwd &&
      localSids.has(currentSid)
    ) {
      return { kind: 'local', sid: currentSid, stale: true };
    }
    // 3b. 其它进程的存活会话同项目
    const hit = aliveSessions.find(
      (a) =>
        a.sid !== targetSid &&
        a.cwd === cwd &&
        (a.pid !== myPid ? isPidAlive(a.pid) : localSids.has(a.sid)),
    );
    if (hit) {
      return { kind: 'forward', sid: hit.sid, pid: hit.pid, stale: true };
    }
  }

  // 4. 无处投递
  return { kind: 'gone' };
}
