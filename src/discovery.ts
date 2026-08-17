/**
 * pi-feishu-notify — 自动识别结果的跨进程持久化
 *
 * 用户在飞书给机器人发消息后自动识别出的 userId / chatId 会写入
 * ~/.pi/agent/feishu-notify-discovered.json，供下次启动时提示持久化，
 * 也方便 whoami 在没有新消息时仍能看到上次识别的值。
 */
import { join } from 'node:path';
import { stateDir, mutateJson, readJson } from './state.js';

export interface DiscoveredState {
  /** 最近一次 p2p 私聊识别的 open_id */
  userId?: string;
  /** 识别到的 chat_id 列表（去重） */
  chatIds: string[];
  /** 最后更新时间（ms） */
  updatedAt: number;
}

function discoveredFile(): string {
  return join(stateDir(), 'feishu-notify-discovered.json');
}
function discoveredLock(): string {
  return join(stateDir(), 'feishu-notify-discovered.lock');
}

const EMPTY: DiscoveredState = { chatIds: [], updatedAt: 0 };

/** 读取已持久化的识别结果（无则返回空）。 */
export function loadDiscovered(): DiscoveredState {
  const st = readJson<DiscoveredState>(discoveredFile(), () => EMPTY);
  return {
    userId: typeof st?.userId === 'string' ? st.userId : undefined,
    chatIds: Array.isArray(st?.chatIds) ? st.chatIds.filter((x): x is string => typeof x === 'string') : [],
    updatedAt: typeof st?.updatedAt === 'number' ? st.updatedAt : 0,
  };
}

/** 合并记录一条识别结果（userId 覆盖，chatId 追加去重），写回磁盘。 */
export function recordDiscovered(userId: string | undefined, chatId: string | undefined): void {
  mutateJson<DiscoveredState>(
    discoveredFile(),
    discoveredLock(),
    () => ({ ...EMPTY }),
    (st) => {
      if (userId) st.userId = userId;
      if (chatId && !st.chatIds.includes(chatId)) st.chatIds.push(chatId);
      st.updatedAt = Date.now();
    },
  );
}
