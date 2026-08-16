/**
 * pi-feishu-notify — 配置加载
 *
 * 从 settings.json 读取 feishu-notify 节（全局 + 项目覆盖），支持 ${NAME} /
 * ${NAME:-fallback} 环境变量展开。兼容旧 pi-lark / lark-notify 节的凭证迁移。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type { FeishuNotifyConfig } from './types.js';

const SECTION_KEY = 'feishu-notify';

/** ${NAME} / ${NAME:-fallback} 环境变量展开（递归对象/数组）。 */
export function resolveEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
      const sepIdx = expr.indexOf(':-');
      const name = sepIdx >= 0 ? expr.slice(0, sepIdx) : expr;
      const fallback = sepIdx >= 0 ? expr.slice(sepIdx + 2) : '';
      const envVal = name ? process.env[name] : undefined;
      if (envVal !== undefined && envVal !== '') return envVal;
      return fallback;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnvVars(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveEnvVars(v);
    return out;
  }
  return value;
}

/** 读取 settings 中指定节（全局 + 项目覆盖，仅读取本机配置）。 */
export function loadSettingsSection(cwd: string, key: string): Record<string, unknown> {
  const read = (file: string): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const section = parsed?.[key];
      return section && typeof section === 'object' && !Array.isArray(section)
        ? (section as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  const globalCfg = read(join(homedir(), '.pi', 'agent', 'settings.json'));
  const projectCfg = read(join(cwd, '.pi', 'settings.json'));
  return { ...globalCfg, ...projectCfg };
}

/**
 * 兼容迁移：旧 lark-notify / pi-lark 节的 appId/appSecret/domain 也接受，
 * 这样从 pi-lark-notify 或 @amaster.ai/pi-lark 迁移时 settings 无需改动。
 */
export function loadConfig(cwd: string): FeishuNotifyConfig {
  const read = (file: string, key: string): FeishuNotifyConfig => {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      const section = parsed?.[key];
      return section && typeof section === 'object' && !Array.isArray(section)
        ? (section as FeishuNotifyConfig)
        : {};
    } catch {
      return {};
    }
  };
  const globalCfg = read(join(homedir(), '.pi', 'agent', 'settings.json'), SECTION_KEY);
  const projectCfg = read(join(cwd, '.pi', 'settings.json'), SECTION_KEY);
  const merged = { ...globalCfg, ...projectCfg };

  // 凭证回退：lark-notify（pi-lark-notify 扩展）→ pi-lark（@amaster.ai/pi-lark）
  if (!merged.appId || !merged.appSecret) {
    for (const legacyKey of ['lark-notify', 'pi-lark']) {
      const legacy = {
        ...read(join(homedir(), '.pi', 'agent', 'settings.json'), legacyKey),
        ...read(join(cwd, '.pi', 'settings.json'), legacyKey),
      } as FeishuNotifyConfig;
      if (!merged.appId) merged.appId = legacy.appId;
      if (!merged.appSecret) merged.appSecret = legacy.appSecret;
      if (!merged.domain) merged.domain = legacy.domain;
    }
  }
  return resolveEnvVars(merged) as FeishuNotifyConfig;
}

/** 判断配置是否具备发送能力（appId + appSecret + 目标 userId/chatId 至少其一）。 */
export function canSend(cfg: FeishuNotifyConfig): boolean {
  return Boolean(cfg.appId && cfg.appSecret && (cfg.userId || cfg.chatId));
}
