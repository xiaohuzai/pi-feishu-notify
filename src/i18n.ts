/**
 * pi-feishu-notify — 轻量国际化（i18n）
 *
 * 运行时用户可见文本（飞书通知、回执、/feishu-notify 命令输出、错误消息）
 * 通过 locale 配置切换：
 *  - 'auto'（默认）：按 LANG / LC_ALL / LC_MESSAGES 环境变量自动判断，
 *    中文环境（zh_*）输出中文，其他环境输出英文
 *  - 'en'：强制英文（面向全球开发者的默认主语言）
 *  - 'zh'：强制中文
 *
 * 设计原则：English-first——文档、画廊卡片、日志、脚本默认英文，
 * 保证全球开发者开箱即用；中文通过环境变量或显式配置启用。
 */

export type Locale = 'en' | 'zh';
export type LocaleSetting = 'auto' | Locale;

/** 运行时文案表。Key 为稳定英文标识，值随 locale 切换。 */
export interface I18nMessages {
  notification: {
    title: string;
    project: string;
    session: string;
    time: string;
    replyHint: string;
  };
  receipt: {
    /** 收到回复、正在处理 */
    received: string;
    /** 会话已结束，无法回注 */
    sessionGone: string;
    /** 转达失败 */
    relayFailed: string;
    /** 处理中进度（带已用时秒数） */
    progress: string;
    /** 处理完成，结果见下一条 */
    done: string;
  };
  command: {
    description: string;
    muted: string;
    unmuted: string;
    whoamiUser: string;
    whoamiChat: string;
    whoamiUnknown: string;
    whoamiNotConfigured: string;
    whoamiKnownChats: string;
    whoamiHint: string;
    bindNoIds: string;
    bindWritten: string;
    bindFailed: string;
    status: string;
    notConfigured: string;
    sent: string;
    sendFailed: string;
  };
  hint: {
    autoTarget: string;
    startupBind: string;
  };
  error: {
    missingTarget: string;
    sendFailed: string;
    sendError: string;
    noMessageId: string;
    channelNotReady: string;
    missingCredentials: string;
    notObject: string;
    nothingToWrite: string;
  };
  inject: {
    /** 注入给 pi 的 followUp prompt 前缀 */
    prompt: string;
  };
  log: {
    sessionGone: string;
  };
}

const en: I18nMessages = {
  notification: {
    title: 'pi main task completed',
    project: 'Project',
    session: 'Session',
    time: 'Time',
    replyHint: 'Reply to this message to keep guiding this session.',
  },
  receipt: {
    received: 'Received your reply, processing…',
    sessionGone: 'This pi session has ended and can no longer receive commands. Please start a new task in a new session.',
    relayFailed: 'Failed to relay: ',
    progress: '⏳ Still working… {{seconds}}s elapsed',
    done: '✅ Done — see the result in the next message.',
  },
  command: {
    description: 'Send a notification to Feishu, or inspect extension status; off/on to mute, whoami to inspect detected IDs, bind to persist them',
    muted: 'feishu-notify: This session is muted — no more automatic notifications will be sent. Use /feishu-notify on to resume.',
    unmuted: 'feishu-notify: Automatic notifications restored for this session.',
    whoamiUser: 'userId (open_id)',
    whoamiChat: 'chatId',
    whoamiUnknown: 'not detected — send the bot a message in Feishu first',
    whoamiNotConfigured: 'not configured',
    whoamiKnownChats: 'Detected group chat ids:',
    whoamiHint: 'Put the values above into the feishu-notify section of settings.json to pin them, or run /feishu-notify bind to write them automatically.',
    bindNoIds: 'feishu-notify: No IDs detected yet. Send the bot a message in Feishu first (DM or @bot in a group), then run bind again.',
    bindWritten: 'feishu-notify: Written to project .pi/settings.json ({{fields}}). Restart the session or /reload to apply.',
    bindFailed: 'feishu-notify: Failed to write: ',
    status: 'feishu-notify: enabled={{enabled}}, appId={{appId}}, connected={{connected}}, {{extra}}',
    notConfigured: 'feishu-notify: Not configured or disabled (need appId/appSecret/userId)',
    sent: 'Sent to Feishu ✓',
    sendFailed: 'Send failed: ',
  },
  hint: {
    autoTarget: 'userId not set in settings.json, falling back to auto-detected value; run /feishu-notify bind to persist',
    startupBind: 'feishu-notify: auto-detected your open_id ({{openid}}…), but userId is not set in settings.json. Run /feishu-notify bind to write it, or /feishu-notify whoami to inspect.',
  },
  error: {
    missingTarget: 'feishu-notify: missing send target (userId/chatId)',
    sendFailed: 'Feishu send failed: ',
    sendError: 'Feishu send error: ',
    noMessageId: 'Feishu send succeeded but no message_id returned',
    channelNotReady: 'Feishu long connection not ready',
    missingCredentials: 'feishu-notify: missing appId/appSecret configuration',
    notObject: 'feishu-notify section is not an object, cannot write',
    nothingToWrite: 'No fields to write (userId/chatId already configured, or multiple group chats and cannot decide)',
  },
  inject: {
    prompt: 'A Feishu user{{name}} replied to the notification, requesting: ',
  },
  log: {
    sessionGone: 'session ended, cannot relay command',
  },
};

const zh: I18nMessages = {
  notification: {
    title: 'pi 主对话已完成',
    project: '项目',
    session: '会话',
    time: '时间',
    replyHint: '回复本消息可继续指挥该会话。',
  },
  receipt: {
    received: '已收到你的回复，正在处理…',
    sessionGone: '该 pi 会话已结束，无法回注指令。请在新会话中重新发起任务。',
    relayFailed: '转达失败：',
    progress: '⏳ 仍在处理中，已用时 {{seconds}}s…',
    done: '✅ 处理完成，结果见下一条消息。',
  },
  command: {
    description: '向飞书发送一条通知，或查看扩展状态；off/on 静音，whoami 查看识别到的 ID，bind 持久化',
    muted: 'feishu-notify: 当前会话已静音，任务完成后不再自动发送通知。使用 /feishu-notify on 恢复。',
    unmuted: 'feishu-notify: 当前会话已恢复自动通知。',
    whoamiUser: 'userId（open_id）',
    whoamiChat: 'chatId',
    whoamiUnknown: '（未识别，先在飞书给机器人发条消息）',
    whoamiNotConfigured: '（未配置）',
    whoamiKnownChats: '已识别的群聊 chat_id:',
    whoamiHint: '把上面的值填到 settings.json 的 feishu-notify 节即可固定，或 /feishu-notify bind 自动写入。',
    bindNoIds: 'feishu-notify: 尚未识别到任何 ID，先在飞书给机器人发一条消息（私聊或群里 @ 机器人）再执行 bind。',
    bindWritten: 'feishu-notify: 已写入项目 .pi/settings.json（{{fields}}）。重启会话或 /reload 生效。',
    bindFailed: 'feishu-notify: 写入失败: ',
    status: 'feishu-notify: enabled={{enabled}}, appId={{appId}}, connected={{connected}}, {{extra}}',
    notConfigured: 'feishu-notify: 未配置或已禁用（需要 appId/appSecret/userId）',
    sent: '已发送到飞书 ✓',
    sendFailed: '发送失败: ',
  },
  hint: {
    autoTarget: 'settings.json 未配置 userId，已回退到自动识别值；可用 /feishu-notify bind 持久化',
    startupBind: 'feishu-notify: 已自动识别你的 open_id（{{openid}}…），但 settings.json 尚未配置 userId。可执行 /feishu-notify bind 一键写入，或 /feishu-notify whoami 查看。',
  },
  error: {
    missingTarget: 'feishu-notify: 缺少发送目标（userId/chatId）',
    sendFailed: '飞书发送失败: ',
    sendError: '飞书发送异常: ',
    noMessageId: '飞书发送成功但未返回 message_id',
    channelNotReady: '飞书长连接未就绪',
    missingCredentials: 'feishu-notify: 缺少 appId/appSecret 配置',
    notObject: 'feishu-notify 节不是对象，无法写入',
    nothingToWrite: '未发现需要补写的字段（userId/chatId 已配置，或多个群聊无法确定）',
  },
  inject: {
    prompt: '飞书用户{{name}}回复了通知，请求：',
  },
  log: {
    sessionGone: '会话已结束，无法回注指令',
  },
};

/** 解析 locale 配置为具体语言。 */
export function resolveLocale(setting: LocaleSetting | undefined): Locale {
  if (setting === 'en' || setting === 'zh') return setting;
  // auto：按环境变量探测
  const lang = (process.env.LANG ?? process.env.LC_ALL ?? process.env.LC_MESSAGES ?? '')
    .toLowerCase();
  return lang.startsWith('zh') ? 'zh' : 'en';
}

/** 取某个 locale 的文案表。 */
export function messages(locale: Locale): I18nMessages {
  return locale === 'zh' ? zh : en;
}

/** 简单 {{key}} 模板插值。 */
export function format(template: string, vars: Record<string, string | number | boolean>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) =>
    key in vars ? String(vars[key]) : `{{${key}}}`,
  );
}
