# 02 · 模块职责与依赖

## 1. 模块依赖关系

```text
tools/* ─┐
         ├─→ runtime/config, storage/client, storage/migrations, domain/*
main.ts ─┤
         ├─→ channels/telegram/* ─→ domain/* ─→ ports/database
worker.ts┤                          ↑
         └─→ storage/d1 ────────────┘
web-console ─→ domain/app-settings, runtime/config, web-console-session
```

- 入口层（`runtime/main.ts`、`runtime/worker.ts`、`tools/*`）负责组装依赖。
- `channels/telegram/factory.ts` 是 Node 侧的依赖装配点，把 `config` + `Database` 组合成 grammY `Bot` 与 `TelegramMessageDeps`。
- `domain/*` 只依赖 `ports/database.ts` 的 `Database` 接口和 grammY 的 `Api` 类型，不感知具体运行时。

## 2. 文件级职责清单

### 2.1 `src/runtime/` —— 运行时与接入

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| [main.ts](../../src/runtime/main.ts) | Node 常驻进程入口：建库、迁移、setup token、启动控制台、装配并重启 bot、注册定时任务、优雅关停 | 顶层副作用脚本（无导出） |
| [config.ts](../../src/runtime/config.ts) | 基于 zod 的配置 schema、环境变量加载与优先级、配置校验、AI 是否就绪 | `loadConfig`、`loadConfigFromSources`、`configIssues`、`loadDatabaseConfig`、`loadEnv`、`isAiConfigured`、`editableConfigKeys`、`sensitiveConfigKeys` |
| [maintenance.ts](../../src/runtime/maintenance.ts) | 维护任务的统一封装：过期会话销毁、消息保留清理 | `runConversationExpiryJob`、`runMessageRetentionJob`、`runMaintenanceJobs` |
| [web-console.ts](../../src/runtime/web-console.ts) | 无框架的 HTTP 控制台：登录/会话、配置页、运维页、`/healthz`、`/metrics`、webhook 转发；内联 HTML/CSS/JS | `startWebConsole`、`handleWebConsoleRequest`、`ensureSetupToken`、`WebConsoleOptions` |
| [web-console-session.ts](../../src/runtime/web-console-session.ts) | HMAC 签名会话 Cookie 的签发与校验 | `createSignedSessionCookie`、`verifySignedSessionCookie`、`expireSessionCookie` |
| [worker.ts](../../src/runtime/worker.ts) | Cloudflare Workers 入口：D1 迁移、`/healthz`、`/telegram/webhook`、控制台路由、Cron 维护 | `handleWorkerFetch`、`handleWorkerScheduled`、`createWorkerTelegramWebhookHandler`、`workerEnvToConfigMap`、默认 `fetch`/`scheduled` |

### 2.2 `src/channels/telegram/` —— Telegram 渠道层

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| [factory.ts](../../src/channels/telegram/factory.ts) | 依赖装配：创建 `Bot` 与各领域服务，注册更新处理 | `createTelegramBot` |
| [updates.ts](../../src/channels/telegram/updates.ts) | 注册 grammY 更新处理：`/start`、`/help`、`/id` 与统一 `message` 分发、错误捕获 | `registerTelegramUpdates` |
| [messages.ts](../../src/channels/telegram/messages.ts) | 桥接核心：私聊入站与群内出站处理、投递重试/降级、Topic 失效自愈 | `handlePrivateMessage`、`handleManagementMessage`、`TelegramMessageDeps` |
| [media.ts](../../src/channels/telegram/media.ts) | 消息类型识别、文本提取、摘要、`copyMessage` 封装 | `detectMessageType`、`extractText`、`summarizeTelegramMessage`、`copyTelegramMessage` |
| [topics.ts](../../src/channels/telegram/topics.ts) | Topic 命名规则与"获取或创建"逻辑 | `buildTopicName`、`ensureTelegramTopic` |
| [menu.ts](../../src/channels/telegram/menu.ts) | 注册 Telegram 原生命令菜单（私聊作用域 + 管理群作用域）与菜单按钮 | `privateBotCommands`、`adminBotCommands`、`registerTelegramMenu` |
| [commands.ts](../../src/channels/telegram/commands.ts) | Topic 内管理命令解析与执行（`/info`、`/expire`、`/draft` 等） | `handleTopicCommand`、`topicHelpText`、`TopicContext`、`CommandDeps` |
| [bot.ts](../../src/channels/telegram/bot.ts) | bot 生命周期与 webhook：启动、轮询、webhook 注册与密钥校验 | `startTelegramBot`、`prepareTelegramBot`、`startTelegramPolling`、`configureTelegramWebhook`、`createTelegramWebhookHandler`（并转导出 `createTelegramBot`） |
| [worker-webhook.ts](../../src/channels/telegram/worker-webhook.ts) | 面向 Workers 的 `Request`/`Response` webhook 回调 | `createWorkerTelegramWebhookHandler` |
| [secrets.ts](../../src/channels/telegram/secrets.ts) | 使用 WebCrypto 计算 webhook 密钥（Workers 环境无 `node:crypto`） | `telegramWebhookSecret` |

### 2.3 `src/domain/` —— 业务领域层

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| [conversations.ts](../../src/domain/conversations.ts) | 联系人/会话/消息/Topic/标签/备注的核心仓储与状态变更，含统计、搜索、事务删除 | `ConversationService`、`nowIso`、`addDaysIso`、`ContactInput`、`ConversationBundle`、`ConversationListItem` |
| [deliveries.ts](../../src/domain/deliveries.ts) | 投递记录状态机（pending/sent/failed/permanent_failure）与查询 | `DeliveryService`、`MAX_DELIVERY_ATTEMPTS` |
| [delivery-retry.ts](../../src/domain/delivery-retry.ts) | 后台重试工作器：扫描到期失败投递并重发，超限永久失败并告警 | `startDeliveryRetryWorker`、`DeliveryRetryDeps` |
| [ai-drafts.ts](../../src/domain/ai-drafts.ts) | OpenAI-compatible 草稿生成（仅发给管理员）、草稿状态与统计 | `AiDraftService`、`DraftResult`、`DraftRow` |
| [audit.ts](../../src/domain/audit.ts) | 管理员操作审计日志写入与查询（写入失败不影响主流程） | `AuditService`、`AuditLogEntry` |
| [app-settings.ts](../../src/domain/app-settings.ts) | `app_settings` 键值配置的读写（控制台配置持久化） | `AppSettingsService` |
| [retention.ts](../../src/domain/retention.ts) | 消息正文保留清理 + 陈旧/终态 AI 草稿处理 | `RetentionService` |
| [conversation-expiry.ts](../../src/domain/conversation-expiry.ts) | 到期会话销毁：先删 Telegram Topic 再清库 | `sweepExpiredConversations` |
| [permissions.ts](../../src/domain/permissions.ts) | 管理员白名单判定 | `PermissionService` |
| [rate-limit.ts](../../src/domain/rate-limit.ts) | 内存滑动窗口限流（按 key 计数） | `RateLimitService`、`RateLimitResult` |

### 2.4 `src/storage/` 与 `src/ports/` —— 存储

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| [ports/database.ts](../../src/ports/database.ts) | 存储端口：`Database` / `PreparedStatement` / 值类型，供两种运行时实现 | `Database`、`ClosableDatabase`、`PreparedStatement`、`SqlValue`、`StatementResult` |
| [storage/client.ts](../../src/storage/client.ts) | Node `node:sqlite` 适配，处理 `file:` URL 与目录创建，开启外键 | `createDb`、`DbHandle` |
| [storage/d1.ts](../../src/storage/d1.ts) | Cloudflare D1 适配器，映射 `bind/run/first/all` | `D1DatabaseAdapter`、`D1DatabaseBinding` |
| [storage/schema.ts](../../src/storage/schema.ts) | 行类型定义（`Contact`、`Conversation`、`Message`、`TelegramTopic`、`Delivery`、`Tag`） | 类型接口 |
| [storage/migrations/0001_initial.ts](../../src/storage/migrations/0001_initial.ts) | 初始 schema DDL + 列补丁 + 索引 | `migrate` |
| [storage/migrations/runner.ts](../../src/storage/migrations/runner.ts) | 通用迁移执行器：执行 DDL、按需 `ALTER TABLE ADD COLUMN`、后置语句 | `runMigration`、`MigrationDefinition` |

### 2.5 `src/tools/` —— 脚本

| 文件 | 职责 | npm 脚本 |
| --- | --- | --- |
| [migrate.ts](../../src/tools/migrate.ts) | 打开数据库并执行幂等迁移 | `npm run migrate` |
| [retention-cleanup.ts](../../src/tools/retention-cleanup.ts) | 独立执行一次消息保留清理 | `npm run retention:cleanup` |
| [check-telegram.ts](../../src/tools/check-telegram.ts) | 校验 bot token、管理群、Forum/权限，可选用真实发送与建删 Topic 测试 | `npm run telegram:check` |

### 2.6 `test/`

| 文件 | 职责 |
| --- | --- |
| [core.test.ts](../../test/core.test.ts) | `node:test` 单测，覆盖配置解析与优先级、迁移与 D1 适配、Workers 运行时、Web 控制台（登录/会话/`/healthz`/`/metrics`/运维页）、会话服务、权限与限流、Telegram 辅助函数、投递统计、AI 草稿生命周期、消息搜索、审计日志 |

## 3. 装配关系（Node 侧）

```text
createTelegramBot(config, db, logger)
 ├─ new ConversationService(db, MESSAGE_RETENTION_DAYS, DEFAULT_CONVERSATION_RETENTION_DAYS)
 ├─ new DeliveryService(db)
 ├─ new PermissionService(TELEGRAM_ADMIN_USER_IDS)
 ├─ new RateLimitService(RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX_MESSAGES)
 ├─ new AiDraftService(db, conversations, config)
 ├─ new AuditService(db)
 └─ registerTelegramUpdates(bot, deps)
```

`main.ts` 还额外创建 `AppSettingsService`（配置读写）并在维护任务中复用 `ConversationService` / `DeliveryService` / `AiDraftService`。
