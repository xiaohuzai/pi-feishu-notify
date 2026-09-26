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
  /**
   * 允许处理消息的群（chat_id 列表）。实际放行范围是三者的并集：
   * allowedChatIds ∪ 通知目标 chatId ∪ 自动识别过的群；三者都为空时群聊一律忽略。
   */
  allowedChatIds?: string[];
  /** 通知模板是否包含会话摘要（默认 true；false 只发元信息） */
  includeSummary?: boolean;
  /** 残留状态（会话注册表历史、通知路由记录）保留天数，默认 7 */
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
  /**
   * 通知/回复的消息格式：
   *  - 'markdown'：飞书 post 富文本渲染（标题/加粗/代码块等），默认
   *  - 'text'    ：纯文本（兼容旧行为）
   */
  messageFormat?: 'markdown' | 'text';
  /**
   * 界面语言：'auto'（默认，按 LANG 环境变量自动判断）| 'en'（英文）| 'zh'（中文）。
   * 影响飞书通知、回执、/feishu-notify 命令输出等用户可见文本。
   */
  locale?: 'auto' | 'en' | 'zh';
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

/**
 * 跨进程回注收件箱条目。
 *
 * 飞书长连接是集群投递（一条事件只随机到达一个 client），回复通知的消息可能
 * 落在非目标 session 所在的 pi 进程上。收到事件的进程把指令写进收件箱，
 * 目标进程（pid）轮询取回后本地回注——pi.sendUserMessage 只能注入本进程会话。
 */
export interface InboxEntry {
  /** 幂等 id（用飞书回复消息的 message_id，重复转发覆盖同一条） */
  id: string;
  /** 目标 session id */
  sid: string;
  /** 目标 session 所在 pi 进程的 pid */
  pid: number;
  /** 注入指令文本 */
  text: string;
  /** 回复者昵称（注入 prompt 用） */
  senderName?: string;
  /** 目标会话的项目目录（会话消失时做同项目回退判断） */
  cwd?: string;
  /** 转发方已发「正在转达」回执的 message_id（目标进程接管进度刷新用） */
  receiptMsgId?: string;
  /** 回执开关（转发方配置的快照；目标会话无处投递时决定是否补发告知） */
  receipt?: boolean;
  /** 回执语言（转发方解析好的，目标进程未必有该会话的配置） */
  locale?: 'en' | 'zh';
  /** 已转发跳数（防同项目回退在多进程间来回转发） */
  hops?: number;
  /** 回复来源（目标会话无处投递时告知用户用） */
  replyChatId?: string;
  replySenderId?: string;
  replyChatType?: string;
  ts: number;
}
