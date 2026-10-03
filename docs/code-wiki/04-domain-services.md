# 04 · 领域服务（关键类与函数）

领域层位于 `src/domain/`，承载业务规则与状态变更，仅依赖 `Database` 端口与 grammY 的 `Api`，不感知具体运行时。

## 1. `ConversationService`

[conversations.ts](../../src/domain/conversations.ts) —— 最核心的仓储与状态服务。构造参数：

```ts
new ConversationService(db, retentionDays, defaultConversationRetentionDays)
```

- `retentionDays`：消息正文保留天数，用于写入 `messages.expires_at`。
- `defaultConversationRetentionDays`：新会话默认销毁天数；`null` 表示永不。

### 关键方法

| 方法 | 说明 |
| --- | --- |
| `getOrCreateConversation(input: ContactInput): ConversationBundle` | 按 `(platform, externalUserId)` 查/建联系人（更新用户名与展示名），并复用或创建最新会话；新会话按默认保留策略写入 `retention_days` / `expires_at` |
| `isBlocked(contactId)` / `blockContact(contactId, createdBy, reason?)` / `unblockContact(contactId)` | 封禁状态读写（`blocks` 表 + `contacts.status`） |
| `setConversationStatus(id, "open"\|"closed")` | 打开/关闭会话 |
| `setPriority(id, priority)` | 设置 `low/normal/high/urgent` |
| `assign(id, adminUserId)` / `listByAssignee(adminId, limit)` | 分配负责人 / 查询某人名下会话 |
| `mute(id, mutedUntil)` | 静音提醒至指定时间 |
| `setConversationRetention(id, days \| null)` | 设置单会话销毁策略并返回更新后的会话 |
| `setAiEnabled(id, bool)` / `getAiEnabled(id)` | 单会话 AI 草稿开关（缺省视为开启） |
| `addNote` / `recentNotes(limit)` | 内部备注写入 / 读取 |
| `addTag` / `removeTag` / `listTags` | 标签（名称统一小写，幂等 upsert） |
| `deleteConversationData(id)` | **事务**内级联删除投递、草稿、标签关联、备注、Topic、消息、会话（保留联系人） |
| `resetConversation(id)` | **事务**内清空消息/草稿/标签/备注，保留会话与 Topic |
| `expiredConversations(now?)` | 联表查询 `expires_at <= now` 的会话及其 Topic |
| `createMessage(input): Message` | 写入消息、计算 `expires_at`、刷新 `last_message_at` |
| `getTopicByThread(chatId, threadId)` / `getTopicByConversation(id)` | Topic 反查 |
| `saveTopic(input): TelegramTopic` | Topic upsert（按 `conversation_id` 冲突更新） |
| `getConversation(id)` / `getContact(id)` / `getMessage(id)` | 单条读取 |
| `recentMessages(id, limit)` | 最近消息（倒序） |
| `conversationStats()` / `messageStats()` | 概览统计（按 `status` / `direction` 聚合） |
| `listConversations({status?, assignedTo?, limit, offset})` | 分页列表（联表联系人/Topic，`last_message_at DESC NULLS LAST`） |
| `searchMessagesInConversation(id, query, limit)` | 会话内 `LIKE` 搜索（转义 `%`/`_`） |
| `searchMessages({query, conversationId?, limit, offset})` | 全局搜索 + 总数 |

辅助函数：`nowIso()`、`addDaysIso(days, from?)`。

## 2. `DeliveryService`

[deliveries.ts](../../src/domain/deliveries.ts) —— 投递状态机。常量 `MAX_DELIVERY_ATTEMPTS = 8`。

| 方法 | 说明 |
| --- | --- |
| `createPending(sourceMessageId, target): number` | 新建 `pending` 投递，返回自增 ID |
| `markSent(id)` | 置为 `sent`，清空错误 |
| `markFailed(id, error, attemptCount)` | 置为 `failed`，`next_retry_at = now + min(60000, 2^attemptCount * 1000)`（指数退避封顶 60 秒） |
| `dueFailed(now?)` | 查出 `failed` 且已到重试时间的记录 |
| `markPermanentFailure(id, error)` | 置为 `permanent_failure`，清空 `next_retry_at` |
| `stats()` | 按状态聚合计数 |
| `listFailedDeliveries({limit, offset})` | 分页列出 `failed` / `permanent_failure` |
| `scheduleRetry(id)` | 手动将 `next_retry_at` 置为当前时间（运维页"重试"按钮） |

## 3. 投递重试工作器

[delivery-retry.ts](../../src/domain/delivery-retry.ts) —— `startDeliveryRetryWorker(deps): () => void`，返回停止函数。

- 启动时立即扫描一次，之后每 `DELIVERY_RETRY_INTERVAL_SECONDS`（≥5 秒）扫描一次。
- `retryDelivery` 逻辑：
  1. `attemptCount >= 8` → 永久失败。
  2. 无 `sourceMessageId` / 源消息不存在 / 正文已被保留清理 / 无 `external_message_id` → 永久失败。
  3. 解析 `target`（`parseDeliveryTarget`）：
     - `telegram-topic:<threadId>` → 复制到管理群对应 Topic，来源为管理群。
     - `telegram-user:<userId>` → 复制到用户私聊，来源为管理群。
  4. 成功 `markSent`；失败则 `attemptCount + 1`，达到上限永久失败，否则 `markFailed`。
- `markPermanentFailure` 会向对应 Topic/用户发送失败通知（含原因与消息预览）。

## 4. `AiDraftService`

[ai-drafts.ts](../../src/domain/ai-drafts.ts) —— AI 回复草稿，**只发给管理员，绝不自动回复外部用户**。

```ts
new AiDraftService(db, conversations, config)
```

常量：`MAX_DRAFT_LENGTH = 4000`、`MAX_CONTEXT_LENGTH = 12000`、`AI_FETCH_TIMEOUT_MS = 15000`、`AI_FETCH_RETRY_DELAY_MS = 2000`。

| 方法 | 说明 |
| --- | --- |
| `generate(conversationId, sourceMessageId?): DraftResult` | 先校验全局 AI 配置 (`isAiConfigured`) 与会话开关；插入 `pending` 草稿；取最近 `AI_DRAFT_CONTEXT_LIMIT` 条消息构建上下文；调用 `POST {BASE_URL}/chat/completions`（温度 0.4，中文系统提示，15 秒超时，最多 2 次尝试并间隔 2 秒）；成功写 `ready`，失败写 `failed` |
| `findReady(conversationId)` | 最新 `ready` 草稿 |
| `markSent(id)` / `markDiscarded(id)` | 草稿终态 |
| `stats()` | 各状态计数 |

`DraftResult.status`：`ready` / `failed` / `disabled`。

## 5. `AuditService`

[audit.ts](../../src/domain/audit.ts)

- `log(input)`：写入审计记录，**异常被吞掉**（审计失败不影响主流程）。
- `list(opts)`：按 `conversationId` / `adminId` / `action` 过滤分页。
- `listByConversation(conversationId, limit)`：会话内最近审计。

## 6. `AppSettingsService`

[app-settings.ts](../../src/domain/app-settings.ts)

- `all(): ConfigMap`：读取全部 `app_settings`。
- `get(key)`：读取单键。
- `setMany(values)`：事务内批量 upsert（控制台保存路径）。

## 7. `RetentionService`

[retention.ts](../../src/domain/retention.ts) —— `cleanupExpired(now?)` 返回清理条数，包含三部分：

1. **陈旧草稿恢复**：`pending` 且超过 5 分钟（`STALE_PENDING_THRESHOLD_MS`）的草稿置为 `failed`（进程重启保护）。
2. **草稿保留**：删除过期终态草稿（`sent`/`discarded`/`failed`），并软清理更早的 `draft_text` / `error`。
3. **消息正文保留**：将 `expires_at <= now` 的消息的 `text` 与 `raw_payload` 置空（保留行）。

## 8. 过期会话销毁

[conversation-expiry.ts](../../src/domain/conversation-expiry.ts) —— `sweepExpiredConversations({api, db, messageRetentionDays, defaultConversationRetentionDays, logger})`：

- 查 `expiredConversations`，对每条先 `deleteForumTopic`，**再** `deleteConversationData`，保证 Telegram 与数据库一致。
- 删除 Topic 失败时若错误为 `message thread not found` 则视为已删除继续清库；其他错误则记录并跳过（下次重试），避免静默丢状态。

## 9. `PermissionService`

[permissions.ts](../../src/domain/permissions.ts) —— `isAdmin(userId)`：判断给定 Telegram user_id 是否在构造时传入的白名单集合中。

## 10. `RateLimitService`

[rate-limit.ts](../../src/domain/rate-limit.ts) —— 内存滑动窗口限流。

- `check(key, now?)`：返回 `{ allowed, remaining, resetAt }`。
- 窗口内计数达到 `maxMessages` 则拒绝；窗口过期自动重置。
- 入站侧以 `telegram:<userId>` 为 key。

> 注意：限流状态保存在进程内存中，多实例部署时不是全局共享的。
