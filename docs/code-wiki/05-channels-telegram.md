# 05 · Telegram 渠道适配层

`src/channels/telegram/` 负责把 Telegram update 翻译为领域调用，并把领域结果翻译为 Telegram API 调用。它是唯一与 grammY 具体 API 强耦合的层。

## 1. 依赖装配：`createTelegramBot`

[factory.ts](../../src/channels/telegram/factory.ts)

```ts
createTelegramBot(config: AppConfig, db: Database, logger: Logger): Bot
```

创建 grammY `Bot` 并组装 `TelegramMessageDeps`：

```ts
{
  config,
  conversations: new ConversationService(db, MESSAGE_RETENTION_DAYS, DEFAULT_CONVERSATION_RETENTION_DAYS),
  deliveries:    new DeliveryService(db),
  permissions:   new PermissionService(TELEGRAM_ADMIN_USER_IDS),
  rateLimit:     new RateLimitService(RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX_MESSAGES),
  aiDrafts:      new AiDraftService(db, conversations, config),
  audit:         new AuditService(db),
  logger:        logger.child({ module: "telegram.messages" }),
}
```

最后调用 `registerTelegramUpdates(bot, deps)`。

## 2. 更新分发：`registerTelegramUpdates`

[updates.ts](../../src/channels/telegram/updates.ts)

| 处理器 | 行为 |
| --- | --- |
| `/start` | 私聊回复就绪提示 |
| `/help` | 私聊回复使用说明；群内回复 `topicHelpText()` |
| `/id` | 回复 `chat_id` / `chat_type` / `message_thread_id` / `from_id`（便于配置排查） |
| `bot.on("message")` | 私聊 → `handlePrivateMessage`；其他（管理群）→ `handleManagementMessage` |
| `bot.catch` | 记录 update 处理异常（含 `update_id`），防止单个更新导致 bot 崩溃 |

轮询模式通过 `allowed_updates: ["message"]` 只订阅消息类更新。

## 3. 消息桥接核心：`messages.ts`

[messages.ts](../../src/channels/telegram/messages.ts)

辅助函数：`fullName`、`displayName`（拼接昵称 / `@username` / `id=`）、`contactInputFromTelegramUser`、`truncateText`（上限 `MAX_MESSAGE_LENGTH = 4000`）、`fallbackText`（构造降级文本摘要）、`isMessageThreadNotFound`（错误识别）。

### 3.1 `handlePrivateMessage(ctx, deps)` —— 入站

1. 取私聊消息与发送者，构造联系人输入。
2. `getOrCreateConversation` 获取 `{ contact, conversation }`。
3. 封禁检查 → 限流检查（key = `telegram:<fromId>`）。
4. 若会话为 `closed`，自动重开并通知 Topic。
5. `createMessage(direction="inbound")` 保存消息。
6. `ensureTelegramTopic` 获取/创建 Topic；失败则告知用户"管理收件箱暂不可用"。
7. `copyWithDelivery` 复制到 Topic（target = `telegram-topic:<threadId>`，允许降级到主消息区）。
8. 遇到 `message thread not found`：删除旧会话数据 → 重建会话 → 重建消息 → 重建 Topic → 重投，并通知管理群。
9. 其他失败：向用户与管理群报告，保留可重试投递记录。
10. 计算会话是否处于静音期（`ConversationService.isMuted`）。
11. `urgent` 且有负责人且未静音 → 发送紧急提醒。
12. 若处于静音期则到此为止（不推送 AI 草稿，也跳过草稿生成以节省调用）。
13. `aiDrafts.generate`：成功则把草稿发到 Topic；失败且全局启用则提示原因。

### 3.2 `handleManagementMessage(ctx, deps)` —— 出站

1. 校验 `message.chat.id === TELEGRAM_MANAGEMENT_CHAT_ID`，忽略 bot 自身消息。
2. 必须有 `message_thread_id`（Topic 内）。
3. `permissions.isAdmin`：非白名单直接拒绝。
4. `getTopicByThread` → `getConversation` → `getContact`；任一缺失则忽略。
5. 文本以 `/` 开头 → `handleTopicCommand`（未知命令提示 `/help`）。
6. 联系人被封禁 → 拒绝并提示先 `/unban`。
7. `createMessage(direction="outbound")` → `copyWithDelivery` 到用户私聊（target = `telegram-user:<userId>`）。

### 3.3 `copyWithDelivery(input)` —— 统一投递

- 先 `createPending` 记录投递。
- **优先** `copyMessage`（保留媒体/格式/ caption），最多同步重试 3 次，退避 `2^attempt * 250ms`。
- 若错误为 `message thread not found` → 直接 `markFailed` 并抛出，交由上层重建 Topic（不当作可降级错误隐藏）。
- 否则尝试降级文本摘要 `sendMessage`（可注入 `{{copyError}}`）；入站还允许降级到管理群主消息区。
- 全部失败 → `markFailed(attemptCount=3)` 并抛出，等待后台重试。

## 4. 媒体处理：`media.ts`

[media.ts](../../src/channels/telegram/media.ts)

- `detectMessageType(message)`：按 `text` → 媒体键（`photo`/`video`/`voice`/`audio`/`document`/`sticker`/`contact`/`location`/`poll`/`animation`/`video_note`）→ `caption` → `unsupported` 顺序判定。
- `extractText(message)`：返回 `text` 或 `caption`。
- `summarizeTelegramMessage(message)`：`[type] text` 摘要。
- `copyTelegramMessage(ctx, targetChatId, fromChatId, messageId, {messageThreadId})`：封装 `copyMessage`，返回新消息 ID。

## 5. Topic 管理：`topics.ts`

[topics.ts](../../src/channels/telegram/topics.ts)

- `buildTopicName(bundle)`：`display | @username | id<末4位>`；无昵称/用户名时回退 `User <末4位>`。
- `ensureTelegramTopic({api, conversations, bundle, managementChatId, forceCreate?})`：已有映射则复用，否则 `createForumTopic` 并 `saveTopic`。

## 6. 命令菜单：`menu.ts`

[menu.ts](../../src/channels/telegram/menu.ts)

- `privateBotCommands`：私聊作用域命令（`all_private_chats`）。
- `adminBotCommands`：管理群作用域命令。
- `registerTelegramMenu(api, config)`：分别调用 `setMyCommands` 设置两个作用域，并 `setChatMenuButton({menu_button:{type:"commands"}})` 启用原生命令菜单按钮。

## 7. 管理命令：`commands.ts`

[commands.ts](../../src/channels/telegram/commands.ts)

- `handleTopicCommand(ctx, deps, topicContext, text): Promise<boolean>`：解析命令并分发；返回 `false` 表示未知命令。
- 解析工具：`splitCommand`（去 `/`、去 `@botname`、小写）、`parseDuration`（`2h`/`1d`）、`parseLimit`（带上下限）、`parseRetentionDays`（`never/none/off/0` → `null`）。
- 展示工具：`topicHelpText()`、`profileText()`、`messagePreview()`、`retentionText()`。
- 命令覆盖小组/处理/安全/AI 草稿四类，完整清单见 [09-commands.md](./09-commands.md)。

## 8. bot 生命周期与 webhook

[bot.ts](../../src/channels/telegram/bot.ts)

| 函数 | 说明 |
| --- | --- |
| `startTelegramBot(bot, config)` | 先 `prepareTelegramBot`，再按模式分流（polling / webhook） |
| `prepareTelegramBot(bot, config)` | 注册命令菜单 |
| `startTelegramPolling(bot)` | `bot.start({ allowed_updates: ["message"] })` |
| `configureTelegramWebhook(bot, config)` | `setWebhook(url, { secret_token })` |
| `createTelegramWebhookHandler(bot, config)` | 异步返回 Node `(req,res)` 处理器，用 `webhookCallback(bot,"http")` 并前置密钥校验 |

webhook 密钥：`TELEGRAM_WEBHOOK_SECRET` 优先，否则用 `TELEGRAM_BOT_TOKEN` 的 SHA-256（见 `telegramWebhookSecret`）。校验使用 `timingSafeEqual`，请求头为 `x-telegram-bot-api-secret-token`。

## 9. Workers webhook

[worker-webhook.ts](../../src/channels/telegram/worker-webhook.ts) 与 [secrets.ts](../../src/channels/telegram/secrets.ts)

- `createWorkerTelegramWebhookHandler(bot, expectedSecret, callbackFactory?)`：基于 `webhookCallback(bot, "cloudflare-mod")`，先校验密钥再转交；密钥不符返回 403。
- `telegramWebhookSecret(config)`：用 WebCrypto `crypto.subtle.digest` 计算 SHA-256（Workers 无 `node:crypto`）。
