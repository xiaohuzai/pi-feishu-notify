/**
 * pi-feishu-notify — 通知内容构建（纯函数，可单测）
 *
 * 把任务完成通知构造成飞书 post 可渲染的 markdown：
 *  - 默认 markdown 格式（标题/加粗/引用/代码块）
 *  - 可回退到纯文本（messageFormat: 'text'）
 */

import type { FeishuNotifyConfig } from './types.js';

/** 从 assistant 消息的 content 数组里提取纯文本（跳过 thinking / toolCall）。 */
export function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n').trim();
}

export interface NotificationMeta {
  project: string;
  sid: string;
  time: string;
}

/** 拼接任务完成通知（markdown 版）。 */
export function buildNotificationMarkdown(
  meta: NotificationMeta,
  summary?: string,
): string {
  const lines = [
    '## ✅ pi 主对话已完成',
    '',
    `**项目**：${meta.project}`,
    `**会话**：${meta.sid.slice(0, 8)}`,
    `**时间**：${meta.time}`,
  ];
  if (summary) {
    lines.push('', '---', '', summary);
  }
  lines.push('', '> 回复本消息可继续指挥该会话');
  return lines.join('\n');
}

/** 拼接任务完成通知（纯文本版，兼容旧行为）。 */
export function buildNotificationText(
  meta: NotificationMeta,
  summary?: string,
): string {
  const lines = [
    '✅ pi 主对话已完成',
    `项目: ${meta.project}`,
    `会话: ${meta.sid.slice(0, 8)}`,
    `时间: ${meta.time}`,
  ];
  if (summary) lines.push('', summary);
  lines.push('', '回复本消息可继续指挥该会话。');
  return lines.join('\n');
}

/**
 * 按配置选格式构建通知内容。
 * messageFormat 缺省视为 'markdown'（默认 markdown 美化）。
 */
export function buildNotification(
  cfg: FeishuNotifyConfig,
  meta: NotificationMeta,
  summary?: string,
): { format: 'markdown' | 'text'; content: string } {
  if (cfg.messageFormat === 'text') {
    return { format: 'text', content: buildNotificationText(meta, summary) };
  }
  return { format: 'markdown', content: buildNotificationMarkdown(meta, summary) };
}

/**
 * 从飞书回复消息里提取要回注的文本。
 *
 * SDK 已把 post 消息转成纯文本（convertPost），text 消息 content 是纯文本；
 * 这里统一取 content.trim()，并对「JSON 外壳」做兜底（如 text 消息的
 * {"text":"..."} 形式），保证 post/text 两类回复都能拿到干净文本。
 */
export function extractReplyText(content: string, rawContentType?: string): string {
  const trimmed = content.trim();
  // post 类型：SDK 已转纯文本，直接返回
  if (rawContentType === 'post') return trimmed;
  // text 类型：可能是 {"text":"..."} 外壳，也可能是纯文本
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === 'string') return parsed.text.trim();
    } catch {
      // fallthrough → 原样返回
    }
  }
  return trimmed;
}
