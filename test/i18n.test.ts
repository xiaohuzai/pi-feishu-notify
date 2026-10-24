import { describe, it, expect, afterEach } from 'vitest';
import { resolveLocale, format } from '../src/i18n.js';

/** 临时设置/清除 locale 相关环境变量，结束后恢复。 */
const SAVED: Record<string, string | undefined> = {};
const ENV_KEYS = ['LANG', 'LC_ALL', 'LC_MESSAGES'] as const;

function setEnv(vars: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) {
    if (!(k in SAVED)) SAVED[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

describe('resolveLocale（auto 探测）', () => {
  it('只有 LANG：zh_CN → zh，en_US → en', () => {
    setEnv({ LANG: 'zh_CN.UTF-8' });
    expect(resolveLocale(undefined)).toBe('zh');
    setEnv({ LANG: 'en_US.UTF-8' });
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('LC_ALL 优先于 LANG（POSIX 优先级回归）', () => {
    setEnv({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' });
    expect(resolveLocale(undefined)).toBe('en');
    setEnv({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' });
    expect(resolveLocale(undefined)).toBe('zh');
  });

  it('LC_MESSAGES 优先于 LANG（无 LC_ALL 时）', () => {
    setEnv({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' });
    expect(resolveLocale(undefined)).toBe('zh');
  });

  it('无任何环境变量 → en（English-first）', () => {
    setEnv({});
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('显式配置覆盖环境变量', () => {
    setEnv({ LANG: 'zh_CN.UTF-8' });
    expect(resolveLocale('en')).toBe('en');
    setEnv({ LANG: 'en_US.UTF-8' });
    expect(resolveLocale('zh')).toBe('zh');
  });
});

describe('format（{{key}} 插值）', () => {
  it('替换已知 key，未知 key 原样保留', () => {
    expect(format('hello {{name}}, {{missing}}', { name: 'world' })).toBe(
      'hello world, {{missing}}',
    );
  });

  it('数字/布尔转字符串', () => {
    expect(format('{{n}} {{b}}', { n: 3, b: true })).toBe('3 true');
  });
});
