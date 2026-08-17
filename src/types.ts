/**
 * pi-feishu-notify — 类型定义
 */

/** 扩展配置（读取自 settings.json 的 feishu-notify 节，全局 + 项目覆盖） */
export interface FeishuNotifyConfig {
  /** 总开关（默认 true） */
  enabled?: boolean;
  /** 飞书自建应用 App ID */
  appId?: string;
  /** 飞书自建应用 App Secret */
  appSecret?: string;
  /** 域名：feishu（国内）| lark（国际版），默认 feishu */
  domain?: 'feishu' | 'lark' | string;
  /** 私聊：接收人 open_id（与 chatId 二选一，userId 优先） */
  userId?: string;
  /** 群聊：目标群 chat_id */
  chatId?: string;
  /** 上行回注开关（默认 true） */
  replyEnabled?: boolean;
  /** 群聊时是否要求 @ 机器人（默认 false：回复通知即可） */
  requireMention?: boolean;
  /** 转达后回执一条"已转达"（默认 true） */
  receipt?: boolean;
  /** 只处理来自该用户的消息（私聊 open_id），未配置则只处理单聊任意用户 */
  allowedSenderIds?: string[];
  /** 只处理来自这些群的消息（chat_id 列表） */
  allowedChatIds?: string[];
  /** 通知模板是否包含会话摘要 */
  includeSummary?: boolean;
  /** 崩溃残留状态清理天数 */
  staleDays?: number;
  /**
   * 最短任务时长（毫秒）。仅当本次任务从 agent_start 到
   * agent_settled 的耗时 >= 该值时才会发通知。
   * 未配置 / 0：不限制，任何任务都发。
   * 示例：minDurationMs: 60000 表示 1 分钟以上的任务才通知。
   */
  minDurationMs?: number;
  /**
   * 日志级别：
   *  - 'quiet'   ：只输出错误（ERROR）
   *  - 'normal'  ：输出警告和错误（WARN/ERROR），默认
   *  - 'verbose' ：输出全部（INFO/WARN/ERROR，含 notification-sent 等细节）
   * 设置为 'quiet' 或 'normal' 可减少通知日志对对话的干扰。
   */
  logLevel?: 'quiet' | 'normal' | 'verbose';
}

/** 飞书事件（SDK NormalizedMessage 的简化映射） */
export interface FeishuMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group' | string;
  senderId: string;
  senderName?: string;
  content: string;
  rawContentType: string;
  mentionedBot: boolean;
  mentionAll: boolean;
  rootId?: string;
  threadId?: string;
  replyToMessageId?: string;
  createTime: number;
}

/** 发送结果 */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** 通知记录：message_id → session 归属 */
export interface NotificationRecord {
  sid: string;
  ts: number;
}

/** 会话注册表条目 */
export interface SessionEntry {
  pid: number;
  cwd: string;
  startedAt: string;
}

/** 去重认领条目 */
export interface ClaimEntry {
  sid: string;
  ts: number;
}
