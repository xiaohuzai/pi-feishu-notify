/**
 * pi-feishu-notify — 通知发送过滤逻辑（纯函数，可单测）
 *
 *  - 最短时长过滤：任务太短（< minDurationMs）不发通知
 *  - 日志级别过滤：按 logLevel 决定哪些级别的日志输出
 */

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
