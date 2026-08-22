import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { persistDiscovered } from '../src/settings.js';

const TMP = '/tmp/pi-fn-settings-test';

function readSettings(cwd: string): Record<string, unknown> {
  const p = join(cwd, '.pi', 'settings.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

describe('persistDiscovered', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('未配置 userId 且识别到 open_id → 补写 userId', () => {
    const r = persistDiscovered(TMP, {}, 'ou_abc', []);
    expect(r.ok).toBe(true);
    expect(r.written).toContain('userId');
    expect(readSettings(TMP)['feishu-notify']).toEqual({ userId: 'ou_abc' });
  });

  it('已配置 userId → 不覆盖（中文 locale 错误消息）', () => {
    const r = persistDiscovered(TMP, { userId: 'ou_existing', locale: 'zh' }, 'ou_new', []);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未发现');
    const p = join(TMP, '.pi', 'settings.json');
    expect(existsSync(p)).toBe(false); // 没有可写字段就不创建文件
  });

  it('未配置 chatId 且只识别到一个群 → 补写 chatId', () => {
    const r = persistDiscovered(TMP, {}, undefined, ['oc_chat1']);
    expect(r.ok).toBe(true);
    expect(r.written).toContain('chatId');
    expect(readSettings(TMP)['feishu-notify']).toEqual({ chatId: 'oc_chat1' });
  });

  it('识别到多个群 → 不写 chatId（避免歧义，中文 locale 错误消息）', () => {
    const r = persistDiscovered(TMP, { locale: 'zh' }, undefined, ['oc_a', 'oc_b']);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('多个群聊');
  });

  it('保留 settings 中其他配置节', () => {
    mkdirSync(join(TMP, '.pi'), { recursive: true });
    writeFileSync(
      join(TMP, '.pi', 'settings.json'),
      JSON.stringify({ model: 'x', 'feishu-notify': { appId: 'app' } }, null, 2),
    );
    const r = persistDiscovered(TMP, { appId: 'app' }, 'ou_keep', []);
    expect(r.ok).toBe(true);
    const s = readSettings(TMP);
    expect(s.model).toBe('x'); // 其他节保留
    expect(s['feishu-notify']).toEqual({ appId: 'app', userId: 'ou_keep' }); // 只补写 userId
  });

  it('feishu-notify 节不是对象 → 报错不写', () => {
    mkdirSync(join(TMP, '.pi'), { recursive: true });
    writeFileSync(join(TMP, '.pi', 'settings.json'), JSON.stringify({ 'feishu-notify': 'nope' }));
    const r = persistDiscovered(TMP, {}, 'ou_x', []);
    expect(r.ok).toBe(false);
  });
});
