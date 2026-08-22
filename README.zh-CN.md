# pi-feishu-notify

> **Languages**: [English](README.md) · **简体中文**

**pi 主对话 ⇄ 飞书双向桥**：pi 任务完成时推送飞书通知，在飞书里**回复通知**即可远程指挥对应 pi 会话继续执行。

**不依赖 `lark-cli`** —— 基于官方 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接直连飞书，无需安装任何额外 CLI 工具，也无需公网回调。

## 特性

- ✅ **不依赖 lark-cli**：官方 SDK 直连，零额外工具链
- ✅ **session 级通知**：任务结束（`agent_settled`）自动推送飞书通知
- ✅ **回复回注**：在飞书里回复通知，指令自动注入对应 pi 会话继续执行
- ✅ **双向桥**：pi → 飞书（通知）/ 飞书 → pi（指令）
- ✅ **markdown 美化**：通知默认以飞书富文本（post）渲染，标题/加粗/代码块/引用清晰美观
- ✅ **只发最终结果**：回复回注后同样只发过滤后的最终结果（markdown 通知），thinking/工具调用内容不会推给飞书
- ✅ **进度反馈**：长任务期间在回执消息上原地刷新「已用时 Xs」，不会在飞书侧干等
- ✅ **跨进程去重**：多 pi 进程场景下同一消息只处理一次
- ✅ **崩溃自愈**：自动清理死进程残留状态
- ✅ **配置灵活**：全局 + 项目级覆盖，支持环境变量插值，自动识别 userId/chatId

## 安装

```bash
# 通过 npm 安装（发布到 pi.dev/packages 社区目录）
pi install npm:pi-feishu-notify

# 或通过 git 安装
pi install git:github.com/xiaohuzai/pi-feishu-notify

# 或本地路径
pi install ./path/to/pi-feishu-notify
```

## 前置条件

1. 一个**飞书企业自建应用**（[飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 创建企业自建应用）
2. 在应用配置里：
   - **机器人**：启用机器人能力
   - **事件订阅**：添加 `接收消息 im.message.receive_v1` 事件
   - **权限**：
     - `im:message`、`im:message:send_as_bot`（发送消息）—— markdown 通知必需
     - `im:message`（更新消息）—— 进度心跳原地刷新回执消息需要（同一条权限，部分场景需 `im:message:send_as_bot` 已具备）
   - **长连接**：事件订阅方式选择 **使用长连接接收事件**（SDK WebSocket 方式，无需公网 URL）

3. 拿到应用的 `App ID` 和 `App Secret`，并把机器人加为联系人（私聊）或拉进群聊（群通知）。

> **注意权限变更生效时机**：修改权限后，需到 **版本管理** 发布一个新版本，权限才会真正生效（很多人改完配置后不生效，是因为漏了这步）。

> 通知目标 `userId`（open_id）和 `chatId`（群 chat_id）**无需手动获取**：配置好并启动后，给机器人发一条消息即可自动识别（见下文「userId / chatId 怎么获取」）。

## 配置

在 `~/.pi/agent/settings.json`（全局）或项目 `.pi/settings.json`（项目覆盖）中添加：

```json
{
  "feishu-notify": {
    "enabled": true,
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "replyEnabled": true,           // 是否允许回复回注
    "receipt": true,                // 转达后回执一条"已收到"
    "requireMention": false,        // 群聊时是否要求 @ 机器人
    "allowedSenderIds": [],         // 私聊白名单（open_id 列表），不填则只处理 p2p 单聊
    "allowedChatIds": [],           // 群聊白名单（chat_id 列表）；不填时仍会放行"通知目标 chatId"与"自动识别过的群"里的回复
    "includeSummary": true,
    "minDurationMs": 0,             // 任务最短时长（毫秒），>= 该值才发通知；0/缺省=不限制
    "logLevel": "normal",           // 'quiet'|'normal'|'verbose'：日志详细度，normal 默认不再刷 notification-sent
    "messageFormat": "markdown",    // 通知/回复格式：'markdown'（默认，飞书富文本）| 'text'（纯文本）
  }
}
```

> **`userId` / `chatId` 不是必填**：不配置时，扩展会自动识别通知目标——给机器人发一条私聊消息即识别出 `userId`，群里发消息即识别出 `chatId`，并自动用于发送（可用 `/feishu-notify bind` 把识别结果固定写入配置）。只有想锁定发送目标时才手动配置。

> **安全建议**：`appSecret` 使用 `${ENV_VAR}` 占位符，通过环境变量注入，避免明文写入配置文件。支持 `${NAME}` 和 `${NAME:-fallback}` 语法。

### userId / chatId 怎么获取？可以自动识别

`userId`（open_id）和 `chatId`（群 chat_id）不需要手动查。**只要你在飞书里给机器人发一条消息**，扩展就会自动记住：

- **私聊**：你给机器人发一条消息 → 自动识别出你的 `userId`（open_id）
- **群聊**：把机器人拉进群，在群里 @ 机器人发一条消息 → 自动识别出该群的 `chatId`

识别到后：

- **自动回退生效**：如果 settings 里没配 `userId`，通知会自动发到刚识别出来的私聊用户（首次会自动提示可用 `/feishu-notify bind` 持久化）。
- **`/feishu-notify whoami`**：查看当前已识别的 `userId` / `chatId`（一般不需要，排查或想手动锁定目标时用）。
- **`/feishu-notify bind`**：把识别到的值自动写入项目 `.pi/settings.json`（只补写缺失字段，不覆盖已有配置），重启或 `/reload` 后固定生效。
- **重启也能记住**：识别结果会存到 `~/.pi/agent/feishu-notify-discovered.json`。下次启动时若 settings 仍未配置 `userId` 但已识别过，pi 里会弹一条一次性提示，提醒你用 `/feishu-notify bind` 一键写入。

> 提示：私聊自动回退是最顺滑的入门方式——配好 `appId/appSecret`、机器人加好友后发条消息，再把 task 交给 pi，通知就会发回来。

## 使用

配置完成后启动 pi（或 `/reload`），扩展自动生效：

1. **收到通知**：pi 每次任务结束（`agent_settled`）自动向飞书发送一条通知，包含**项目名、会话 ID、时间**与最近一次回复摘要，方便多任务区分：
   ```
   ✅ pi 主对话已完成
   项目: my-project
   会话: 01a00b5b
   时间: 2026/8/17 00:17:00

   <任务结果摘要>

   回复本消息可继续指挥该会话。
   ```

2. **回复指挥**：在飞书里直接**回复**这条通知，输入你要的指令（无需 @ 机器人）。消息会注入到对应的 pi 会话继续执行，执行完成后会再收到新的通知。
   - **群聊回复**：只要该群是「通知目标 `chatId`」或「`allowedChatIds` 白名单」或「自动识别过的群」，回复都会被接收（`requireMention: false` 时无需 @ 机器人）。
   - **重启后仍可回注**：pi 重启会生成新的 session id，但回复会自动回退到同一项目（cwd 相同）的当前会话继续执行——不再因为旧会话 id 对不上而只回一句"会话已结束"。

3. **手动通知**：在 pi 里执行 `/feishu-notify <消息>` 可手动发送一条通知到飞书；`/feishu-notify` 无参数时查看扩展状态（含是否静音、最短时长阈值、是否已自动识别 userId）。

### 减少日志打扰 / 控制通知频率

- **日志安静**：默认 `logLevel: 'normal'` 只输出警告和错误，日常任务完成的 `[feishu-notify] notification-sent {...}` 不再刷屏。想更安静设 `'quiet'`（只报错），需要排查设 `'verbose'`（含发送细节）。
- **长任务才通知**：设置 `minDurationMs`（毫秒），任务从 `agent_start` 到 `agent_settled` 不足该时长则不发送。例如 `minDurationMs: 60000` 表示 1 分钟以内的短任务不打扰。
- **按会话静音**：在 pi 里执行 `/feishu-notify off`（或 `mute`）静音当前会话，任务完成后不再自动发通知；`/feishu-notify on`（或 `unmute`）恢复。适合某些只想本地、不想推飞书的工作场景。

## 工作原理

```
┌────────────┐   agent_settled    ┌──────────────┐  SDK WebSocket  ┌────────┐
│  pi session │ ─────────────────▶ │  Notification │ 长连接（直连）    │  飞书   │
│  (主对话)    │ ◀───────────────── │     Router    │                │  App   │
└────────────┘   sendUserMessage   └──────────────┘  ◀── 回复通知 ──  └────────┘
      ▲                │               │
      │                │               └── 按 replyToMessageId 反查目标 session
      └────────────────┴── 指令回注
```

- **下行**：`agent_settled` → 发送 markdown 富文本通知，拿到 `message_id`，记录到 `~/.pi/agent/feishu-notify-router.json`（`message_id → session` 映射）
- **上行**：SDK 长连接收到消息 → 若 `replyToMessageId` 命中路由表 → 跨进程去重认领 → `pi.sendUserMessage` 回注指令
- **常驻单例**：WebSocket consumer 是进程级单例，跨 session 共享，不随 session 切换断开
- **去重**：`~/.pi/agent/feishu-notify-dedup.json` 记录已处理消息，跨进程互斥

## markdown 美化 & 回复行为

### 通知 markdown 美化（默认）

任务完成通知默认以飞书富文本（`post` 消息 + `md` 元素）发送，由飞书原生渲染标题、加粗、列表、代码块、引用：

```markdown
## ✅ pi 主对话已完成

**项目**：my-app
**会话**：a1b2c3d4
**时间**：2026-08-21 12:00:00

---

（任务摘要，代码块/列表原样保留）

> 回复本消息可继续指挥该会话
```

设为 `messageFormat: "text"` 可回退为纯文本。

### 回复回注：只发最终结果 + 进度反馈

当你在飞书**回复通知**指挥 pi 继续时：

1. 收到回复 → 先发一条「已收到你的回复，正在处理…」回执
2. 长任务期间 → 该回执消息会**原地刷新**「⏳ 仍在处理中，已用时 Xs…」（默认每 15s 一次，`im.v1.message.update`），让你知道 bot 还活着、在干活，不会傻等
3. 处理完成 → 回执更新为「✅ 处理完成，结果见下一条消息」，随后**新发一条 markdown 通知**，只含过滤后的**最终结果**（`lastAssistantText`，对最后一条 assistant 消息做 `extractAssistantText`，跳过 thinking / toolCall 部分）
4. 你仍可回复这条最终结果消息继续指挥

> **为什么不做实时流式**：流式需要把 `text_delta` 实时逐条推给飞书；部分 provider 会把推理/工具调用也以普通文本增量下发，导致 thinking、工具调用细节跟着流出去。因此默认只发「结算后」的最终结果，与初始任务通知行为一致，保证飞书看到的永远是干净的最终答案。

> **进度心跳需要更新消息权限**：刷新回执用 `im.v1.message.update`（同 `im:message` 权限）；若应用未开通该权限，进度刷新会静默失败，不影响回执和最终结果发送。

### 回复兼容

SDK 会把收到的富文本（post）消息转成纯文本，因此无论你回复的是 markdown 通知还是普通文本消息，回注指令都能正确提取。

## 文件结构

```
pi-feishu-notify/
├── extensions/
│   └── feishu-notify.ts     # pi 扩展入口（事件钩子 + 命令）
├── src/
│   ├── types.ts             # 类型定义
│   ├── config.ts            # 配置加载（全局+项目+env 插值+旧配置迁移）
│   ├── feishu.ts            # 飞书 SDK 客户端（发送 + 长连接，进程级单例）
│   ├── router.ts            # 通知路由 + 跨进程去重
│   ├── sessions.ts          # 会话注册表（崩溃自愈）
│   ├── filter.ts            # 发送/日志过滤（minDurationMs、logLevel）
│   ├── notify.ts            # 通知内容构建（markdown 美化 + 回复文本提取）
│   ├── settings.ts          # 自动识别 ID 持久化（/feishu-notify bind）
│   ├── discovery.ts         # 识别结果跨进程持久化（重启提示用）
│   └── state.ts             # 状态文件原子读写 + 目录锁
└── test/                    # 单元测试（vitest）
```

## 卸载

```bash
# npm 安装方式
pi remove npm:pi-feishu-notify

# git 安装方式
pi remove git:github.com/xiaohuzai/pi-feishu-notify
```

## License

[MIT](LICENSE)
