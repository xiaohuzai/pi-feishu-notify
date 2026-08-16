import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resolveEnvVars, canSend } from '../src/config.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import type { FeishuNotifyConfig } from '../src/types.js';

const GLOBAL = join(homedir(), '.pi', 'agent', 'settings.json');
const PROJECT = join('/tmp', 'pi-fn-test-project', '.pi', 'settings.json');

function writeSettings(file: string, cfg: FeishuNotifyConfig) {
  mkdirSync(file.substring(0, file.lastIndexOf('/')), { recursive: true });
  const existing = (() => {
    try {
      return JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  })();
  existing['feishu-notify'] = cfg;
  writeFileSync(file, JSON.stringify(existing, null, 2));
}

describe('resolveEnvVars', () => {
  it('展开 ${NAME} 和 ${NAME:-fallback}', () => {
    process.env.FN_TEST_VAR = 'hello';
    expect(resolveEnvVars('${FN_TEST_VAR}')).toBe('hello');
    expect(resolveEnvVars('${FN_MISSING_VAR:-default}')).toBe('default');
    expect(resolveEnvVars('${FN_MISSING_VAR}')).toBe('');
    delete process.env.FN_TEST_VAR;
  });

  it('递归展开对象和数组', () => {
    process.env.FN_ARR = 'x';
    expect(
      resolveEnvVars({ a: '${FN_ARR}', list: ['${FN_ARR}', 'plain'] }),
    ).toEqual({ a: 'x', list: ['x', 'plain'] });
    delete process.env.FN_ARR;
  });
});

describe('loadConfig', () => {
  const cwd = '/tmp/pi-fn-test-project';

  beforeEach(() => {
    rmSync(join(homedir(), '.pi', 'agent', 'settings.json'), { force: true });
    rmSync(join('/tmp/pi-fn-test-project'), { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(join('/tmp/pi-fn-test-project'), { recursive: true, force: true });
  });

  it('读取全局配置', () => {
    writeSettings(GLOBAL, { appId: 'g-app', appSecret: 'g-secret' });
    const cfg = loadConfig(cwd);
    expect(cfg.appId).toBe('g-app');
    expect(cfg.appSecret).toBe('g-secret');
  });

  it('项目配置覆盖全局配置', () => {
    writeSettings(GLOBAL, { appId: 'g-app', appSecret: 'g-secret', userId: 'g-user' });
    writeSettings(PROJECT, { appId: 'p-app', chatId: 'p-chat' });
    const cfg = loadConfig(cwd);
    expect(cfg.appId).toBe('p-app'); // 覆盖
    expect(cfg.appSecret).toBe('g-secret'); // 继承
    expect(cfg.userId).toBe('g-user'); // 继承
    expect(cfg.chatId).toBe('p-chat'); // 项目新增
  });

  it('支持环境变量插值', () => {
    process.env.FN_APP_ID = 'env-app';
    process.env.FN_APP_SECRET = 'env-secret';
    writeSettings(GLOBAL, { appId: '${FN_APP_ID}', appSecret: '${FN_APP_SECRET}' });
    const cfg = loadConfig(cwd);
    expect(cfg.appId).toBe('env-app');
    expect(cfg.appSecret).toBe('env-secret');
    delete process.env.FN_APP_ID;
    delete process.env.FN_APP_SECRET;
  });

  it('兼容旧 lark-notify 凭证迁移', () => {
    // 全局只有旧节
    try {
      const existing = JSON.parse(require('node:fs').readFileSync(GLOBAL, 'utf8'));
      existing['lark-notify'] = { appId: 'legacy-app', appSecret: 'legacy-secret' };
      writeFileSync(GLOBAL, JSON.stringify(existing, null, 2));
    } catch {
      writeFileSync(GLOBAL, JSON.stringify({ 'lark-notify': { appId: 'legacy-app', appSecret: 'legacy-secret' } }, null, 2));
    }
    const cfg = loadConfig(cwd);
    expect(cfg.appId).toBe('legacy-app');
    expect(cfg.appSecret).toBe('legacy-secret');
  });

  it('canSend 判断发送能力', () => {
    expect(canSend({ appId: 'a', appSecret: 's', userId: 'u' })).toBe(true);
    expect(canSend({ appId: 'a', appSecret: 's', chatId: 'c' })).toBe(true);
    expect(canSend({ appId: 'a', appSecret: 's' })).toBe(false);
    expect(canSend({})).toBe(false);
    expect(canSend({ appId: 'a' })).toBe(false);
  });
});
