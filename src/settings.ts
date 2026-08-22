/**
 * pi-feishu-notify — 持久化工具
 *
 * 把自动识别的 userId / chatId 写入项目 .pi/settings.json 的 feishu-notify 节。
 * 只补写缺失字段，不覆盖已有配置，不触碰文件里其他配置。
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FeishuNotifyConfig } from './types.js';
import { resolveLocale, messages } from './i18n.js';

export interface PersistResult {
  ok: boolean;
  written?: string[];
  error?: string;
}

/**
 * 把自动识别的 userId / chatId 持久化到 cwd/.pi/settings.json。
 * @param discoveredUserId 自动识别的 open_id（未配置 userId 时补写）
 * @param discoveredChatIds 自动识别的 chat_id 列表（未配置 chatId 且仅 1 个时补写）
 */
export function persistDiscovered(
  cwd: string,
  cfg: FeishuNotifyConfig,
  discoveredUserId: string | undefined,
  discoveredChatIds: string[],
): PersistResult {
  try {
    const settingsPath = join(cwd, '.pi', 'settings.json');
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      } catch {
        // 文件损坏则从空开始
      }
    }
    const section = (settings['feishu-notify'] ??= {});
    const err = messages(resolveLocale(cfg.locale)).error;
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      return { ok: false, error: err.notObject };
    }
    const written: string[] = [];
    if (!cfg.userId && discoveredUserId) {
      (section as Record<string, unknown>).userId = discoveredUserId;
      written.push('userId');
    }
    // chatId：未配置且只有一个已识别群聊时补写，避免多群歧义
    if (!cfg.chatId && discoveredChatIds.length === 1) {
      (section as Record<string, unknown>).chatId = discoveredChatIds[0];
      written.push('chatId');
    }
    if (written.length === 0) {
      return { ok: false, error: err.nothingToWrite };
    }
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    return { ok: true, written };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
