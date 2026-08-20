/**
 * pi-feishu-notify — 通知发送过滤逻辑（纯函数，可单测）
 *
 *  - 最短时长过滤：任务太短（< minDurationMs）不发通知
 *  - 日志级别过滤：按 logLevel 决定哪些级别的日志输出
 *  - 上行消息过滤：飞书回复是否允许处理（shouldHandle）
 */

import type { FeishuMessage, FeishuNotifyConfig } from './types.js';

export type LogVerbosity = 'quiet' | 'normal' | 'verbose';

/**
 * 任务时长是否达到发送阈值。
 * @param taskStart 任务开始时间戳（agent_start），无则视为不限（无任务起点）
 * @param now       当前时间戳
 * @param minDurationMs 最短时长（毫秒），<=0 表示不限
 */
export function passesDurationFilter(
  taskStart: number | undefined,
  now: number,
  minDurationMs?: number,
): boolean {
  const minMs = Number(minDurationMs) || 0;
  if (minMs <= 0) return true;
  if (taskStart === undefined) return false; // 没有任务起点，保守不通知
  return now - taskStart >= minMs;
}

/**
 * 某条日志（按严重级别）在当前 logLevel 下是否应该输出。
 * @param severity 日志严重级别（INFO/WARN/ERROR）
 * @param verbosity 配置的 logLevel（默认 'normal'）
 */
export function shouldLog(
  severity: string,
  verbosity: LogVerbosity = 'normal',
): boolean {
  const rank: Record<string, number> = { ERROR: 3, WARN: 2, INFO: 1 };
  const threshold: Record<LogVerbosity, number> = { quiet: 3, normal: 2, verbose: 1 };
  return (rank[severity] ?? 1) >= (threshold[verbosity] ?? 2);
}

/**
 * 是否应该处理这条上行消息（回复通知回注场景）。纯函数，可单测。
 *
 * 规则：
 *  - 只看文本消息；忽略机器人自己发的消息
 *  - 私聊：配置了 allowedSenderIds 则必须在白名单内；否则任意私聊都处理
 *  - 群聊：必须来自「已知群」——
 *      cfg.allowedChatIds 显式配置的群 ∪ cfg.chatId（通知目标群）∪ knownChatIds（自动识别过的群）
 *    三者都为空则群聊一律忽略（避免误回注）；可选要求 @ 机器人
 *
 * @param msg 收到的飞书消息
 * @param cfg 该消息归属的配置
 * @param knownChatIds 自动识别过的群 chat_id 集合（可空）
 */
export function shouldHandle(
  msg: FeishuMessage,
  cfg: FeishuNotifyConfig,
  knownChatIds?: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): boolean {
  // 只看文本消息
  if (msg.rawContentType !== 'text') return false;
  // 忽略自己（机器人）发的消息
  if (msg.senderName && msg.senderName.startsWith('@')) return false;
  if (msg.senderName === 'pi-feishu-notify') return false;

  // 私聊：白名单（未配置则只允许 p2p 单聊任意用户）
  if (msg.chatType === 'p2p') {
    if (Array.isArray(cfg.allowedSenderIds) && cfg.allowedSenderIds.length > 0) {
      if (!cfg.allowedSenderIds.includes(msg.senderId)) return false;
    }
    return true;
  }

  // 群聊：必须来自「已知群」
  const known = new Set<string>(cfg.allowedChatIds ?? []);
  if (cfg.chatId) known.add(cfg.chatId);
  if (knownChatIds) {
    for (const cid of knownChatIds.keys()) known.add(cid);
  }
  if (known.size === 0 || !known.has(msg.chatId)) return false;
  // （可选）要求 @ 机器人
  if (cfg.requireMention === true && !msg.mentionedBot) return false;
  return true;
}
