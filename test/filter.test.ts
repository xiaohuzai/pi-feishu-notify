import { describe, it, expect } from 'vitest';
import { passesDurationFilter, shouldLog } from '../src/filter.js';

describe('passesDurationFilter', () => {
  const now = 100_000;

  it('未配置 minDurationMs（0/undefined）→ 不限制', () => {
    expect(passesDurationFilter(now - 10, now, undefined)).toBe(true);
    expect(passesDurationFilter(now - 10, now, 0)).toBe(true);
    expect(passesDurationFilter(undefined, now, 0)).toBe(true);
  });

  it('任务时长 >= 阈值 → 通过', () => {
    expect(passesDurationFilter(now - 60_000, now, 60_000)).toBe(true);
    expect(passesDurationFilter(now - 120_000, now, 60_000)).toBe(true);
  });

  it('任务时长 < 阈值 → 不通过', () => {
    expect(passesDurationFilter(now - 30_000, now, 60_000)).toBe(false);
    expect(passesDurationFilter(now - 59_999, now, 60_000)).toBe(false);
  });

  it('有阈值但无任务起点 → 保守不通过', () => {
    expect(passesDurationFilter(undefined, now, 60_000)).toBe(false);
  });
});

describe('shouldLog', () => {
  it('默认 normal：WARN/ERROR 输出，INFO 不输出', () => {
    expect(shouldLog('ERROR')).toBe(true);
    expect(shouldLog('WARN')).toBe(true);
    expect(shouldLog('INFO')).toBe(false);
  });

  it('quiet：只输出 ERROR', () => {
    expect(shouldLog('ERROR', 'quiet')).toBe(true);
    expect(shouldLog('WARN', 'quiet')).toBe(false);
    expect(shouldLog('INFO', 'quiet')).toBe(false);
  });

  it('verbose：全部输出', () => {
    expect(shouldLog('ERROR', 'verbose')).toBe(true);
    expect(shouldLog('WARN', 'verbose')).toBe(true);
    expect(shouldLog('INFO', 'verbose')).toBe(true);
  });

  it('未知严重级别按 INFO 处理', () => {
    expect(shouldLog('DEBUG' as string, 'normal')).toBe(false);
    expect(shouldLog('DEBUG' as string, 'verbose')).toBe(true);
  });
});
