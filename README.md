# pi-feishu-notify

> **Languages**: **English** · [简体中文](README.zh-CN.md)

**Bidirectional bridge between pi main conversations and Feishu (Lark)**: when a pi task finishes, a notification is pushed to Feishu — and you can **reply to the notification in Feishu** to remotely command that pi session to continue.

**No `lark-cli` dependency** — it connects directly to Feishu over the official `@larksuiteoapi/node-sdk` WebSocket long connection. No extra CLI tools, no public callback URL needed.

## Features

- ✅ **No lark-cli**: official SDK direct connection, zero extra toolchain
- ✅ **Session-scoped notifications**: auto-sends a Feishu notification when a task finishes (`agent_settled`)
- ✅ **Reply-and-inject**: reply to the notification in Feishu; your instruction is injected into the corresponding pi session to keep it going
- ✅ **Bidirectional bridge**: pi → Feishu (notifications) / Feishu → pi (instructions)
- ✅ **Markdown formatting**: notifications render as Feishu rich text (`post`) with clean titles, bold, code blocks, and quotes
- ✅ **Final result only**: follow-up replies send only the filtered final result (markdown notification) — thinking/tool-call content never reaches Feishu
- ✅ **Progress feedback**: long tasks refresh an elapsed-time progress line (plus project/session) in place on the receipt, so you never wait blindly
- ✅ **Cross-process dedup**: the same message is processed only once across multiple pi processes
- ✅ **Crash self-healing**: automatically cleans up residual state from dead processes
- ✅ **Flexible config**: global + project-level overrides, environment variable interpolation, auto-detect `userId`/`chatId`
- ✅ **i18n**: English-first by default; Chinese is automatic in `zh_*` environments, or force it via `locale`

## Install

```bash
# via npm (published in the pi.dev/packages community directory)
pi install npm:pi-feishu-notify

# or via git
pi install git:github.com/xiaohuzai/pi-feishu-notify

# or a local path
pi install ./path/to/pi-feishu-notify
```

## Prerequisites

1. A **Feishu enterprise self-built app** ([Feishu Open Platform](https://open.feishu.cn/) → Developer Console → Create Enterprise Self-built App)
2. In the app configuration:
   - **Bot**: enable the bot capability
   - **Event subscription**: add the `Receive message im.message.receive_v1` event
   - **Permissions**:
     - `im:message`, `im:message:send_as_bot` (send messages) — required for markdown notifications
     - `im:message` (update messages) — needed by the progress heartbeat to refresh the receipt in place
   - **Long connection**: set the event subscription mode to **Receive events via long connection** (SDK WebSocket mode — no public URL required)
3. Get the app's **App ID** and **App Secret**, and add the bot as a contact (DM) or pull it into a group (group notifications).

> **Note on permission changes**: after modifying permissions, you must **publish a new version** under *Version Management* for them to take effect. (Many people change settings and see no effect simply because they skipped this step.)

> The notification target `userId` (open_id) and `chatId` (group chat_id) **don't need to be fetched manually**: after configuring and starting, just send the bot a message and it will auto-detect them (see "How to get userId / chatId" below).

## Configuration

Add to `~/.pi/agent/settings.json` (global) or project `.pi/settings.json` (project override):

```json
{
  "feishu-notify": {
    "enabled": true,
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "replyEnabled": true,           // whether to allow reply-and-inject
    "receipt": true,                // send a "received" receipt after relaying
    "requireMention": false,        // in groups, whether @bot is required
    "allowedSenderIds": [],         // DM whitelist (open_id list); empty = only handle p2p DMs
    "allowedChatIds": [],           // group whitelist (chat_id list); empty = still allow the "notification target chatId" and "auto-detected groups"
    "includeSummary": true,
    "minDurationMs": 0,             // min task duration (ms); only notify when >= this value; 0/absent = no limit
    "logLevel": "normal",           // 'quiet'|'normal'|'verbose': log verbosity; normal no longer spams notification-sent
    "messageFormat": "markdown",    // notification/reply format: 'markdown' (default, Feishu rich text) | 'text' (plain)
    "locale": "auto"                // 'auto' (default, detect via LANG) | 'en' (English) | 'zh' (中文)
  }
}
```

> **`userId` / `chatId` are not required**: when unset, the extension auto-detects the send target — send the bot a DM to detect your `userId`, or send a message in a group to detect that group's `chatId`, and it's used automatically (use `/feishu-notify bind` to pin the detected values into config). Only configure them manually if you want to lock the send target.

> **Security tip**: use `${ENV_VAR}` placeholders for `appSecret`, injected via environment variables to avoid plaintext in config files. Supports `${NAME}` and `${NAME:-fallback}` syntax.

### How to get userId / chatId? Auto-detection

`userId` (open_id) and `chatId` (group chat_id) don't need to be looked up manually. **Just send the bot a message in Feishu** and the extension remembers it automatically:

- **DM**: send the bot a message → your `userId` (open_id) is auto-detected
- **Group**: pull the bot into a group, @bot and send a message → that group's `chatId` is auto-detected

Once detected:

- **Automatic fallback**: if `userId` isn't set in settings, notifications go to the just-detected DM user automatically (first time it hints you can persist with `/feishu-notify bind`).
- **`/feishu-notify whoami`**: view the currently detected `userId` / `chatId` (usually unneeded; use it for troubleshooting or to lock targets manually).
- **`/feishu-notify bind`**: write the detected values into project `.pi/settings.json` (only fills missing fields, never overwrites existing config); takes effect after restart or `/reload`.
- **Survives restarts**: detection results are stored in `~/.pi/agent/feishu-notify-discovered.json`. On next startup, if `userId` isn't configured but was detected before, pi shows a one-time hint to use `/feishu-notify bind`.

> Tip: DM auto-fallback is the smoothest onboarding — configure `appId/appSecret`, add the bot as a friend, send a message, hand a task to pi, and the notification comes back.

## Usage

Start pi after configuring (or `/reload`) — the extension activates automatically:

1. **Receive a notification**: when a pi task finishes (`agent_settled`), a notification is sent to Feishu automatically, containing **project name, session ID, time** and the latest reply summary, so you can tell multi-tasks apart:
   ```
   ✅ pi main task completed
   Project: my-project
   Session: 01a00b5b
   Time: 2026/8/17 00:17:00

   <task result summary>

   Reply to this message to keep guiding this session.
   ```

2. **Reply to command**: in Feishu, just **reply** to the notification with your instruction (no need to @ the bot). The message is injected into the corresponding pi session to continue, and you'll receive a new notification when it finishes.
   - **Group replies**: replies are accepted as long as the group is the "notification target `chatId`", the "`allowedChatIds` whitelist", or an "auto-detected group" (with `requireMention: false`, no @bot needed).
   - **Injection survives restarts**: pi generates a new session id after restart, but the reply automatically falls back to the current session in the same project (same cwd) to continue — no more "session ended" dead-ends due to an old session id mismatch.

3. **Manual notification**: run `/feishu-notify <message>` in pi to send a notification to Feishu manually; `/feishu-notify` with no args shows extension status (muted state, min duration threshold, auto-detected userId).

### Reduce log noise / control notification frequency

- **Quiet logs**: default `logLevel: 'normal'` only outputs warnings and errors — daily `[feishu-notify] notification-sent {...}` no longer spams. Set `'quiet'` (errors only) to be quieter, or `'verbose'` (includes send details) for troubleshooting.
- **Only notify long tasks**: set `minDurationMs` (ms); tasks shorter than this between `agent_start` and `agent_settled` don't notify. E.g. `minDurationMs: 60000` = short tasks under 1 minute stay silent.
- **Per-session mute**: run `/feishu-notify off` (or `mute`) to mute the current session — no more automatic notifications after tasks finish; `/feishu-notify on` (or `unmute`) to restore. Good for workflows you want to keep local.

## How it works

```
┌────────────┐   agent_settled    ┌──────────────┐  SDK WebSocket  ┌────────┐
│  pi session │ ─────────────────▶ │  Notification │  long conn      │ Feishu │
│  (main)     │ ◀───────────────── │     Router    │                 │  App   │
└────────────┘   sendUserMessage   └──────────────┘  ◀── reply ─────  └────────┘
      ▲                │               │
      │                │               └── lookup target session by replyToMessageId
      └────────────────┴── command injection
```

- **Downstream**: `agent_settled` → sends a markdown rich-text notification, gets the `message_id`, records `message_id → session` mapping in `~/.pi/agent/feishu-notify-router.json`
- **Upstream**: the SDK long connection receives a message → if `replyToMessageId` hits the routing table → cross-process dedup claim → `pi.sendUserMessage` injects the command
- **Resident singleton**: the WebSocket consumer is a process-level singleton shared across sessions, and doesn't drop when sessions switch
- **Dedup**: `~/.pi/agent/feishu-notify-dedup.json` records processed messages with cross-process mutual exclusion

## Markdown formatting & reply behavior

### Notification markdown formatting (default)

Task-completion notifications are sent as Feishu rich text (`post` message + `md` element) by default, with title, bold, lists, code blocks, and quotes rendered natively by Feishu:

```markdown
## ✅ pi main task completed

**Project**: my-app
**Session**: a1b2c3d4
**Time**: 2026-08-21 12:00:00

---

(task summary, code blocks/lists preserved as-is)

> Reply to this message to keep guiding this session.
```

Set `messageFormat: "text"` to fall back to plain text.

### Reply behavior: final result only + progress feedback

When you **reply to a notification** in Feishu to command pi to continue:

1. The reply is received → a "received your reply, processing…" receipt is sent immediately
2. Long tasks → the receipt message is **updated in place** with "⏳ Still working… Ns elapsed — project: xxx / session: a1b2c3d4" (every 15s by default, via `im.v1.message.update`), so you know the bot is alive, working, and which project/session it's handling — no blind waiting
3. Done → the receipt updates to "✅ Done — see the result in the next message", then a **new markdown notification** is sent containing only the filtered **final result** (`lastAssistantText`: the last assistant message passed through `extractAssistantText`, which skips `thinking`/`toolCall` parts)
4. You can reply to that final result message to keep commanding

> **Why no live streaming**: streaming requires pushing `text_delta` token by token to Feishu; some providers emit reasoning/tool-calls as plain text deltas, so thinking and tool-call details leak out. That's why we only send the **settled final result** — consistent with initial task notifications, guaranteeing Feishu always sees a clean final answer.

> **Progress heartbeat needs the update-message permission**: refreshing the receipt uses `im.v1.message.update` (same `im:message` permission); if the app lacks it, progress refresh silently fails without affecting the receipt or the final result.

### Reply compatibility

The SDK converts received rich-text (`post`) messages to plain text, so no matter whether you reply to a markdown notification or a plain text message, the injected command is extracted correctly.

## Language (i18n)

User-visible text — Feishu notifications, receipts, `/feishu-notify` command output, and error messages — follows the `locale` setting:

- **`auto` (default)**: detects the environment via `LANG` / `LC_ALL` / `LC_MESSAGES`; `zh_*` environments get Chinese, everything else gets English.
- **`en`**: force English (the default main language for global developers).
- **`zh`**: force Chinese (简体中文).

Docs (this README) and the gallery description are English-first, with a [简体中文版](README.zh-CN.md) available. Log events and developer scripts use English.

## File structure

```
pi-feishu-notify/
├── extensions/
│   └── feishu-notify.ts     # pi extension entry (event hooks + commands)
├── src/
│   ├── types.ts             # type definitions
│   ├── config.ts            # config loading (global + project + env interpolation + legacy migration)
│   ├── feishu.ts            # Feishu SDK client (send + long connection, process-level singleton)
│   ├── router.ts            # notification routing + cross-process dedup
│   ├── sessions.ts          # session registry (crash self-healing)
│   ├── filter.ts            # send/log filtering (minDurationMs, logLevel)
│   ├── notify.ts            # notification content building (markdown formatting + reply text extraction)
│   ├── settings.ts          # auto-detected ID persistence (/feishu-notify bind)
│   ├── discovery.ts         # cross-process persistence of detection results (restart hint)
│   ├── i18n.ts              # lightweight internationalization (en/zh messages)
│   └── state.ts             # state file atomic read/write + directory lock
├── scripts/                 # developer helper scripts (capture open_id, verify credentials)
└── test/                    # unit tests (vitest)
```

## Uninstall

```bash
# npm install
pi remove npm:pi-feishu-notify

# git install
pi remove git:github.com/xiaohuzai/pi-feishu-notify
```

## License

[MIT](LICENSE)
