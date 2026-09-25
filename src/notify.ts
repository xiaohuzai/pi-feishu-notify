/**
 * pi-feishu-notify — 通知内容构建（纯函数，可单测）
 *
 * 把任务完成通知构造成飞书 post 可渲染的 markdown：
 *  - 默认 markdown 格式（标题/加粗/引用/代码块）
 *  - 可回退到纯文本（messageFormat: 'text'）
 */

import type { FeishuNotifyConfig } from './types.js';
import { resolveLocale, messages, type Locale } from './i18n.js';

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
  return stripThinkingMarkers(parts.join('\n').trim());
}

/**
 * 防御性清理：某些 provider/配置下思考内容会以文本形式混进 text 增量
 * （如 requiresThinkingAsText 把 thinking 转成 text 块，或 qwen 把思考包在
 * `~~...~~` 里下发）。这里只清理几种明确的思考标记，避免误伤正常 markdown：
 *  - `<thinking>...</thinking>`：
 *  - 行首的 `~~...~~`（qwen 思考段，一般位于回答最前面）
 *  - ````<thinking>...```` 代码块包裹的思考
 */
export function stripThinkingMarkers(text: string): string {
  if (!text) return text;
  let out = text;
  // `<thinking>...</thinking>`（含多行）
  out = out.replace(/<\s*thinking\s*>[\s\S]*?<\/\s*thinking\s*>/gi, '');
  // qwen 行首 `~~...~~` 思考段（可能跨多行，直到不再以 ~~ 续行）。
  // 开闭 `~~` 均不允许是 `~~~` 的一部分，避免误删 `~~~` 代码围栏。
  out = out.replace(/^~~(?!~)[\s\S]*?(?<!~)~~\s*/m, '');
  return out.trim();
}

/**
 * 剥掉 text 消息的 `{"text":"..."}` JSON 外壳，取出纯文本。
 *
 * 只对「看起来是 JSON」的 content 做解析（text 消息 content 是 {"text":"..."}）；
 * SDK 对 post 消息已转成纯文本，纯文本即使是合法 JSON（如 "123"、`{"a":1}`）
 * 也不该被误拆——解析不出 text 字段时原样返回。
 */
export function unwrapTextShell(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as { text?: unknown };
      if (typeof parsed.text === 'string') return parsed.text.trim();
    } catch {
      // 不是合法 JSON → 原样返回
    }
  }
  return trimmed;
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
  locale: Locale = 'en',
): string {
  const m = messages(locale);
  const lines = [
    `## ✅ ${m.notification.title}`,
    '',
    `**${m.notification.project}**：${meta.project}`,
    `**${m.notification.session}**：${meta.sid.slice(0, 8)}`,
    `**${m.notification.time}**：${meta.time}`,
  ];
  if (summary) {
    lines.push('', '---', '', summary);
  }
  lines.push('', `> ${m.notification.replyHint}`);
  return lines.join('\n');
}

/** 拼接任务完成通知（纯文本版，兼容旧行为）。 */
export function buildNotificationText(
  meta: NotificationMeta,
  summary?: string,
  locale: Locale = 'en',
): string {
  const m = messages(locale);
  const lines = [
    `✅ ${m.notification.title}`,
    `${m.notification.project}: ${meta.project}`,
    `${m.notification.session}: ${meta.sid.slice(0, 8)}`,
    `${m.notification.time}: ${meta.time}`,
  ];
  if (summary) lines.push('', summary);
  lines.push('', `${m.notification.replyHint}`);
  return lines.join('\n');
}

/**
 * 按配置选格式构建通知内容。
 * messageFormat 缺省视为 'markdown'（默认 markdown 美化）；
 * locale 缺省视为 auto（按 LANG 环境变量判断）；
 * includeSummary === false 时省略会话摘要。
 */
export function buildNotification(
  cfg: FeishuNotifyConfig,
  meta: NotificationMeta,
  summary?: string,
): { format: 'markdown' | 'text'; content: string } {
  const locale = resolveLocale(cfg.locale);
  const effectiveSummary = cfg.includeSummary === false ? undefined : summary;
  if (cfg.messageFormat === 'text') {
    return { format: 'text', content: buildNotificationText(meta, effectiveSummary, locale) };
  }
  return { format: 'markdown', content: buildNotificationMarkdown(meta, effectiveSummary, locale) };
}

/**
 * 从飞书回复消息里提取要回注的文本。
 *
 * SDK 已把 post 消息转成纯文本（convertPost），text 消息 content 可能带
 * `{"text":"..."}` JSON 外壳；这里统一剥壳取纯文本，保证 post/text 两类
 * 回复都能拿到干净文本。
 */
export function extractReplyText(content: string, rawContentType?: string): string {
  // post 类型：SDK 已转纯文本，直接返回（其正文可能是 JSON 形状，不能剥壳）
  if (rawContentType === 'post') return content.trim();
  return unwrapTextShell(content);
}
