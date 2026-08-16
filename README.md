# pi-feishu-notify

**pi 主对话 ⇄ 飞书双向桥**：pi 任务完成时推送飞书通知，在飞书里**回复通知**即可远程指挥对应 pi 会话继续执行。

**不依赖 `lark-cli`** —— 基于官方 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接直连飞书，无需安装任何额外 CLI 工具，也无需公网回调。

## 特性

- ✅ **不依赖 lark-cli**：官方 SDK 直连，零额外工具链
- ✅ **session 级通知**：任务结束（`agent_settled`）自动推送飞书通知
- ✅ **回复回注**：在飞书里回复通知，指令自动注入对应 pi 会话继续执行
- ✅ **双向桥**：pi → 飞书（通知）/ 飞书 → pi（指令）
- ✅ **跨进程去重**：多 pi 进程场景下同一消息只处理一次
- ✅ **崩溃自愈**：自动清理死进程残留状态
- ✅ **配置灵活**：全局 + 项目级覆盖，支持环境变量插值，兼容旧 `lark-notify` 配置迁移

## 安装

```bash
# 通过 git 安装（推荐）
pi install git:github.com/xiaohuzai/pi-feishu-notify

# 或本地路径
pi install ./path/to/pi-feishu-notify
```

## 前置条件

1. 一个**飞书企业自建应用**（[飞书开放平台](https://open.feishu.cn/) → 开发者后台 → 创建企业自建应用）
2. 在应用配置里：
   - **机器人**：启用机器人能力
   - **事件订阅**：添加 `接收消息 im.message.receive_v1` 事件
   - **权限**：`im:message`、`im:message:send_as_bot`（发送消息）
   - **长连接**：事件订阅方式选择 **使用长连接接收事件**（SDK WebSocket 方式，无需公网 URL）

3. 拿到应用的 `App ID` 和 `App Secret`，并确定通知目标：
   - **私聊**：把机器人加为联系人，获取你的 `open_id`（通过 [获取用户ID](https://open.feishu.cn/document/uAjLw4CM/ugTN1YjL4UTN24CO1UjN/trouble-shooting/get-uid) 工具）
   - **群聊**：创建群聊并拉机器人进群，获取群 `chat_id`（机器人发一条消息后，用 [获取群信息](https://open.feishu.cn/document/server-docs/im-v1/chat/get) 查询）

## 配置

在 `~/.pi/agent/settings.json`（全局）或项目 `.pi/settings.json`（项目覆盖）中添加：

```json
{
  "feishu-notify": {
    "enabled": true,
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "userId": "ou_xxxxxxxx",        // 私聊：你的 open_id（与 chatId 二选一，userId 优先）
    "chatId": "oc_xxxxxxxx",        // 群聊：群 chat_id
    "replyEnabled": true,           // 是否允许回复回注
    "receipt": true,                // 转达后回执一条"已收到"
    "requireMention": false,        // 群聊时是否要求 @ 机器人
    "allowedSenderIds": [],         // 私聊白名单（open_id 列表），不填则只处理 p2p 单聊
    "allowedChatIds": [],           // 群聊白名单（chat_id 列表）
    "includeSummary": true
  }
}
```

> **安全建议**：`appSecret` 使用 `${ENV_VAR}` 占位符，通过环境变量注入，避免明文写入配置文件。支持 `${NAME}` 和 `${NAME:-fallback}` 语法。

### 旧配置迁移

从 `pi-lark-notify` 迁移时，`appId` / `appSecret` / `domain` 会自动从旧的 `lark-notify` 节读取，无需改动 settings。

## 使用

配置完成后启动 pi（或 `/reload`），扩展自动生效：

1. **收到通知**：pi 每次任务结束（`agent_settled`）自动向飞书发送一条通知，内容为最近一次回复摘要：
   ```
   ✅ [pi] 任务完成
   <任务结果摘要>

   回复本消息可继续指挥该会话。
   ```

2. **回复指挥**：在飞书里直接**回复**这条通知，输入你要的指令（无需 @ 机器人）。消息会注入到对应的 pi 会话继续执行，执行完成后会再收到新的通知。

3. **手动通知**：在 pi 里执行 `/feishu-notify <消息>` 可手动发送一条通知到飞书；`/feishu-notify` 无参数时查看扩展状态。

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

- **下行**：`agent_settled` → `client.im.message.create` 发送通知，拿到 `message_id`，记录到 `~/.pi/agent/feishu-notify-router.json`（`message_id → session` 映射）
- **上行**：SDK 长连接收到消息 → 若 `replyToMessageId` 命中路由表 → 跨进程去重认领 → `pi.sendUserMessage` 回注指令
- **常驻单例**：WebSocket consumer 是进程级单例，跨 session 共享，不随 session 切换断开
- **去重**：`~/.pi/agent/feishu-notify-dedup.json` 记录已处理消息，跨进程互斥

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
│   └── state.ts             # 状态文件原子读写 + 目录锁
└── test/                    # 单元测试（vitest）
```

## 卸载

```bash
pi remove git:github.com/xiaohuzai/pi-feishu-notify
```

## License

[MIT](LICENSE)
