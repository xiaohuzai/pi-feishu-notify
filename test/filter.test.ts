import { describe, it, expect } from 'vitest';
import { passesDurationFilter, shouldHandle, shouldLog } from '../src/filter.js';
import type { FeishuMessage } from '../src/types.js';

function msg(partial: Partial<FeishuMessage>): FeishuMessage {
  return {
    messageId: 'm1',
    chatId: 'oc_group1',
    chatType: 'p2p',
    senderId: 'ou_user1',
    senderName: '张三',
    content: '继续',
    rawContentType: 'text',
    mentionedBot: false,
    mentionAll: false,
    createTime: 0,
    ...partial,
  };
}

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

describe('shouldHandle', () => {
  // ── 基础规则 ──────────────────────────────────────────────
  it('text / post 消息可处理，其它类型不处理', () => {
    expect(shouldHandle(msg({ rawContentType: 'text' }), {})).toBe(true);
    // post 富文本（SDK 已转纯文本）也处理，兼容 markdown 通知的回复
    expect(shouldHandle(msg({ rawContentType: 'post' }), {})).toBe(true);
    expect(shouldHandle(msg({ rawContentType: 'image' }), {})).toBe(false);
    expect(shouldHandle(msg({ rawContentType: 'sticker' }), {})).toBe(false);
  });

  it('机器人自己发的消息不处理', () => {
    expect(shouldHandle(msg({ senderName: 'pi-feishu-notify' }), {})).toBe(false);
    expect(shouldHandle(msg({ senderName: '@机器人' }), {})).toBe(false);
  });

  // ── 私聊 ──────────────────────────────────────────────────
  it('私聊未配置白名单 → 任意用户都处理', () => {
    expect(shouldHandle(msg({ chatType: 'p2p' }), {})).toBe(true);
  });

  it('私聊配置白名单 → 白名单外不处理', () => {
    const cfg = { allowedSenderIds: ['ou_allowed'] };
    expect(shouldHandle(msg({ chatType: 'p2p', senderId: 'ou_allowed' }), cfg)).toBe(true);
    expect(shouldHandle(msg({ chatType: 'p2p', senderId: 'ou_other' }), cfg)).toBe(false);
  });

  it('私聊 allowedSenderIds 为空数组 → 不限制', () => {
    expect(shouldHandle(msg({ chatType: 'p2p', senderId: 'ou_any' }), { allowedSenderIds: [] })).toBe(true);
  });

  // ── 群聊（旧逻辑：allowedChatIds 为空一律忽略）──────────────
  it('群聊 allowedChatIds 为空 且未配置 chatId → 忽略（安全默认）', () => {
    const cfg = { allowedChatIds: [] };
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_any' }), cfg)).toBe(false);
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_any' }), {})).toBe(false);
  });

  // ── 群聊：allowedChatIds 显式配置 ──────────────────────────
  it('群聊在 allowedChatIds 内 → 处理', () => {
    const cfg = { allowedChatIds: ['oc_group1'] };
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_group1' }), cfg)).toBe(true);
  });

  it('群聊不在 allowedChatIds 内 → 忽略', () => {
    const cfg = { allowedChatIds: ['oc_group1'] };
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_other' }), cfg)).toBe(false);
  });

  // ── 群聊：通知目标 chatId 自动放行 ──────────────────────────
  it('群聊未配 allowedChatIds 但来自通知目标 chatId → 处理（修复根因2）', () => {
    const cfg = { chatId: 'oc_group1' };
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_group1' }), cfg)).toBe(true);
    // 其它群仍忽略
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_other' }), cfg)).toBe(false);
  });

  // ── 群聊：自动识别过的群（knownChatIds）放行 ────────────────
  it('knownChatIds 里的群 → 处理', () => {
    const known = new Map<string, string>([['oc_discovered', 'ou_x']]);
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_discovered' }), {}, known)).toBe(true);
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_unknown' }), {}, known)).toBe(false);
  });

  // ── 群聊：@ 机器人要求 ─────────────────────────────────────
  it('requireMention=true 且未 @ 机器人 → 忽略', () => {
    const cfg = { chatId: 'oc_group1', requireMention: true };
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_group1', mentionedBot: false }), cfg)).toBe(false);
    expect(shouldHandle(msg({ chatType: 'group', chatId: 'oc_group1', mentionedBot: true }), cfg)).toBe(true);
  });
});
