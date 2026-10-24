import { describe, it, expect, afterEach } from 'vitest';
import { getFeishuClient, resetFeishuClient } from '../src/feishu.js';

// 只覆盖参数校验的快速失败路径，不触网：缺凭证/缺目标时在任何 API 调用前返回
describe('FeishuClient 参数校验（快速失败，不触网）', () => {
  afterEach(() => resetFeishuClient());

  it('sendMarkdown 缺凭证 → missingCredentials（不再白等长连接超时）', async () => {
    const client = getFeishuClient({});
    const r = await client.sendMarkdown('hi', { userId: 'ou_x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('sendText 缺凭证 → missingCredentials', async () => {
    const client = getFeishuClient({});
    const r = await client.sendText('hi', { userId: 'ou_x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('sendText 缺发送目标 → missingTarget', async () => {
    const client = getFeishuClient({ appId: 'a', appSecret: 's' });
    const r = await client.sendText('hi', {});
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('sendMarkdown 缺发送目标 → missingTarget', async () => {
    const client = getFeishuClient({ appId: 'a', appSecret: 's' });
    const r = await client.sendMarkdown('hi', {});
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('updateText 空 messageId → false（不发请求）', async () => {
    const client = getFeishuClient({ appId: 'a', appSecret: 's' });
    expect(await client.updateText('', 'x')).toBe(false);
  });
});
