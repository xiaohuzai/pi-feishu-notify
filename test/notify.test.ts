import { describe, it, expect } from 'vitest';
import {
  extractAssistantText,
  extractReplyText,
  buildNotification,
  buildNotificationMarkdown,
  buildNotificationText,
} from '../src/notify.js';
import type { FeishuNotifyConfig } from '../src/types.js';

const meta = {
  project: 'my-app',
  sid: 'session-abcdef123456',
  time: '2026-08-21 12:00:00',
};

describe('extractAssistantText', () => {
  it('字符串直接返回', () => {
    expect(extractAssistantText('hello')).toBe('hello');
  });

  it('content 数组只取 text 部分（跳过 thinking/toolCall）', () => {
    const content = [
      { type: 'text', text: '你好' },
      { type: 'thinking', text: '（思考过程）' },
      { type: 'toolCall', name: 'bash' },
      { type: 'text', text: '，世界' },
    ];
    expect(extractAssistantText(content)).toBe('你好\n，世界');
  });

  it('空/非数组返回空串', () => {
    expect(extractAssistantText(null)).toBe('');
    expect(extractAssistantText({})).toBe('');
    expect(extractAssistantText([])).toBe('');
  });
});

describe('buildNotificationMarkdown', () => {
  it('包含标题/元信息/摘要/回复引导（中文 locale）', () => {
    const md = buildNotificationMarkdown(meta, '任务完成摘要', 'zh');
    expect(md).toContain('## ✅ pi 主对话已完成');
    expect(md).toContain('**项目**：my-app');
    expect(md).toContain('**会话**：session-'); // 前 8 位
    expect(md).toContain('**时间**：2026-08-21 12:00:00');
    expect(md).toContain('---');
    expect(md).toContain('任务完成摘要');
    expect(md).toContain('> 回复本消息可继续指挥该会话。');
  });

  it('英文 locale 输出英文文案', () => {
    const md = buildNotificationMarkdown(meta, 'task summary', 'en');
    expect(md).toContain('## ✅ pi main task completed');
    expect(md).toContain('**Project**：my-app');
    expect(md).toContain('**Session**：session-');
    expect(md).toContain('**Time**：2026-08-21 12:00:00');
    expect(md).toContain('> Reply to this message to keep guiding this session.');
  });

  it('无摘要时省略摘要区', () => {
    const md = buildNotificationMarkdown(meta, undefined, 'zh');
    expect(md).not.toContain('---');
    expect(md).toContain('> 回复本消息可继续指挥该会话。');
  });
});

describe('buildNotificationText', () => {
  it('纯文本版中文格式', () => {
    const text = buildNotificationText(meta, '摘要', 'zh');
    expect(text).toContain('✅ pi 主对话已完成');
    expect(text).toContain('项目: my-app');
    expect(text).toContain('回复本消息可继续指挥该会话。');
  });

  it('纯文本版英文格式', () => {
    const text = buildNotificationText(meta, 'summary', 'en');
    expect(text).toContain('✅ pi main task completed');
    expect(text).toContain('Project: my-app');
    expect(text).toContain('Reply to this message to keep guiding this session.');
  });
});

describe('buildNotification', () => {
  it('默认 markdown 格式（中文 locale）', () => {
    const r = buildNotification({ locale: 'zh' } as FeishuNotifyConfig, meta, '摘要');
    expect(r.format).toBe('markdown');
    expect(r.content).toContain('## ✅');
    expect(r.content).toContain('**项目**：my-app');
  });

  it('英文 locale 默认 markdown', () => {
    const r = buildNotification({ locale: 'en' } as FeishuNotifyConfig, meta, 'summary');
    expect(r.format).toBe('markdown');
    expect(r.content).toContain('## ✅ pi main task completed');
  });

  it('messageFormat=text 回退纯文本（中文 locale）', () => {
    const r = buildNotification({ messageFormat: 'text', locale: 'zh' } as FeishuNotifyConfig, meta, '摘要');
    expect(r.format).toBe('text');
    expect(r.content).toContain('项目: my-app');
  });
});

describe('extractReplyText', () => {
  it('text 纯文本直接返回', () => {
    expect(extractReplyText('继续', 'text')).toBe('继续');
  });

  it('text 带 JSON 外壳解析', () => {
    expect(extractReplyText('{"text":"继续"}', 'text')).toBe('继续');
  });

  it('post 类型（SDK 已转纯文本）直接返回', () => {
    expect(extractReplyText('继续\n\n细节', 'post')).toBe('继续\n\n细节');
  });

  it('去除首尾空白', () => {
    expect(extractReplyText('  继续  ', 'text')).toBe('继续');
  });
});
