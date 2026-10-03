# 06 · 运行时与 Web 控制台

## 1. 配置加载：[runtime/config.ts](../../src/runtime/config.ts)

基于 zod 的配置解析，是全局唯一的配置真源。

| 函数 | 说明 |
| --- | --- |
| `loadEnv(env?, envPath?)` | 读取 `.env`，**shell 环境变量优先**（已存在的键不覆盖），支持单/双引号去壳 |
| `loadConfig(env?)` | 用 `envSchema` 解析并做跨字段校验（webhook 模式必须有 URL；管理员白名单至少 1 个） |
| `loadConfigFromSources(storedEnv, env?)` | 合并来源：`{ ...storedEnv, ...env }` —— 控制台保存值打底，进程环境变量覆盖 |
| `configIssues(storedEnv, env?)` | 返回校验错误列表（供控制台展示与启动前检查） |
| `loadDatabaseConfig(env?)` | 仅解析 `DATABASE_URL` 与 `WEB_CONSOLE_PORT`（无需 Telegram 配置即可启动控制台） |
| `isAiConfigured(config)` | AI 是否就绪（开关开启且 URL/Key/Model 均非空） |

配置优先级（高 → 低）：**进程环境变量 > SQLite `app_settings`（控制台保存） > `.env` 文件 > schema 默认值**。

## 2. 进程入口：[runtime/main.ts](../../src/runtime/main.ts)

启动顺序：

```text
loadDatabaseConfig()
→ createDb(DATABASE_URL) + PRAGMA foreign_keys=ON
→ migrate(client)
→ new AppSettingsService(db)
→ ensureSetupToken(settings)  // 无密码时生成并打印 setup token
→ startWebConsole({...})      // 先起控制台，后起 bot
→ restartRuntime()            // 配置完整才启动 bot
```

### 关键内部函数

| 函数 | 说明 |
| --- | --- |
| `restartRuntime()` | 串行化（`restartQueue`）重启，避免并发重入 |
| `restartRuntimeUnlocked()` | `stopRuntime` → `configIssues` 校验（不完整则告警并等待）→ `createTelegramBot` → 装配 webhook/polling → 注册三个定时器与重试工作器 |
| `runExpirySweep()` | 载入最新配置后执行 `runConversationExpiryJob` |
| `runMessageRetentionSweep()` | 执行 `runMessageRetentionJob` |
| `stopRuntime()` | 清定时器、停重试工作器、清 webhook、停 polling bot |

### 定时任务

| 任务 | 间隔配置 | 说明 |
| --- | --- | --- |
| 过期会话销毁 | `CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES`（默认 60） | 删除到期会话的 Telegram Topic 与库数据 |
| 消息保留清理 | `MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES`（默认 60） | 清理过期消息正文与 AI 草稿 |
| 投递重试 | `DELIVERY_RETRY_INTERVAL_SECONDS`（默认 30） | 由 `startDeliveryRetryWorker` 管理 |

### 稳定性处理

- `unhandledRejection`：按错误消息在 60 秒窗口内去重，超过 5 次后抑制日志。
- `uncaughtException`：记录 fatal 后触发受控关停。
- `SIGINT` / `SIGTERM`：`gracefulShutdown`，10 秒超时强制退出（`process.exit(1)`），正常则关闭数据库后 `exit(0)`。

### 控制台与运行时的桥梁

`main.ts` 通过 `startWebConsole` 注入大量回调（`getStatus`、`onConfigSaved`、`collectMetrics`、`collectOperationsOverview`、`listConversations`、`listFailedDeliveries`、`scheduleRetry`、`listAuditLogs`、`searchMessages`、`dbHealthCheck`、`telegramWebhook`），控制台因此完全无需直接依赖运行时实例。保存配置后 `onConfigSaved` 即 `restartRuntime`，实现"保存后即时生效"。

## 3. Web 控制台

控制台由三个模块组成，`handleWebConsoleRequest(request, options, sessions, loginAttempts)` 是唯一入口，同时服务 Node `http` 与 Workers `fetch`（后两个参数为跨请求状态，均有默认值）：

| 模块 | 职责 |
| --- | --- |
| [web-console.ts](../../src/runtime/web-console.ts) | 路由与鉴权：登录/登出、限流、会话 Cookie、`/healthz`、`/metrics`、webhook 转发 |
| [web-console-render.ts](../../src/runtime/web-console-render.ts) | 渲染：HTML/CSS 页面骨架与各页/表格输出（`send`、`redirect` 等输出原语） |
| [web-console-shared.ts](../../src/runtime/web-console-shared.ts) | 共享契约：`app_settings` 键名、视图类型、`WebConsoleOptions`（无运行时依赖，避免循环引用） |

### 3.1 认证

- 首次：无密码时用 `WEB_CONSOLE_SETUP_TOKEN` 登录（`ensureSetupToken` 以 16 字节随机 hex 生成并存表，仅日志输出一次）。
- 之后：`WEB_CONSOLE_PASSWORD_HASH` 存储 `salt:scryptHash`（`scryptSync` 32 字节 + `timingSafeEqual` 校验）。
- 会话：Node 通过 `ensureSessionSecret` 在 `app_settings` 持久化签名密钥（`WEB_CONSOLE_SESSION_SECRET`，首次启动生成，不进配置界面），使用 HMAC-SHA256 签名 Cookie（默认 8 小时），因此重启不会踢掉已登录会话；仅当调用方未提供密钥时才回退到内存 `Map<token, kind>`。Workers 必须由环境变量提供 `WEB_CONSOLE_SESSION_SECRET`。
- 登录限流：`POST /login` 在读取请求体前先按来源计数（默认 300 秒窗口、10 次尝试），超出返回 `429`。来源取 `x-forwarded-for` 首段 / `cf-connecting-ip` / `x-real-ip`，缺失时共用 `unknown` 桶——这仍能限制爆破，但共享桶意味着攻击者也可能顺带延误正常登录，因此建议前置可信代理并透传真实 IP。
- 首次 setup 会话强制设置密码后才能保存配置。

会话 Cookie 的实现见 [web-console-session.ts](../../src/runtime/web-console-session.ts)：`createSignedSessionCookie` / `verifySignedSessionCookie`（含过期校验与常数时间比较）/ `expireSessionCookie`。

### 3.2 路由

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 否 | 返回 JSON：`status` / `bot` / `db`；健康时 200，否则 503 |
| GET | `/login` | 否 | 登录页 |
| POST | `/login` | 否 | 校验 setup token 或密码，设置会话 Cookie |
| POST | `/logout` | 是 | 清除会话与 Cookie |
| GET | `/` | 是 | 控制台概览（状态、配置进度、关键指标） |
| GET | `/config/*` | 是 | 配置分组页（`security`/`telegram`/`runtime`/`retention`/`ratelimit`/`delivery`/`ai-drafts`） |
| POST | `/config` | 是 | 保存配置（敏感项留空保持原值），随后 `onConfigSaved()` |
| GET | `/metrics` | 是 | JSON 指标快照 |
| GET | `/operations/*` | 是 | 运维页（overview/conversations/deliveries/audit/search） |
| POST | `/operations/deliveries/retry` | 是 | 手动调度某条投递重试 |
| POST | `/telegram/webhook` | 否* | 仅 Node 侧转发到 Telegram webhook 处理器（自带密钥校验） |

> Node 服务器在 `startWebConsole` 中先拦截 `/telegram/webhook`，再转交共享处理器。

### 3.3 配置字段元数据

`fieldGroups` / `configGroupSlugs` / `renderField` 驱动配置页渲染：分组标题、字段说明、占位符、`inputMode`、下拉（`TELEGRAM_UPDATE_MODE`、`AI_DRAFTS_ENABLED`）。`sensitiveConfigKeys` 中的键渲染为密码框且不回显；`configValuesFromForm` 对敏感项空值保留原值。

### 3.4 页面渲染

- `page(title, body)`：内联完整 HTML + CSS（含明暗主题、响应式、无障碍 `skip-link`、主题切换脚本、表单提交 loading 状态），首字节即完整页面，无外部框架依赖（仅引入 Google Fonts）。
- 运维表格渲染：`renderOperationsOverviewBody` / `renderConversationsBody` / `renderDeliveriesBody` / `renderAuditLogsBody` / `renderSearchBody`，均含分页（每页 50，最多显示 10 个页码）。
- `escapeHtml` 统一转义；`translateIssue` 把 zod 校验错误翻译为中文标签提示。

## 4. 维护任务：[runtime/maintenance.ts](../../src/runtime/maintenance.ts)

| 函数 | 说明 |
| --- | --- |
| `runConversationExpiryJob(input)` | 转调 `sweepExpiredConversations`，注入配置中的保留天数 |
| `runMessageRetentionJob(input)` | 构造 `RetentionService` 并 `cleanupExpired` |
| `runMaintenanceJobs(input)` | 顺序执行两者，返回 `{ expiredConversations, expiredMessages }`；两个子任务均可通过参数注入（便于测试） |

Worker 的 Cron 与 Node 的定时器都复用这三个函数，保证行为一致。

## 5. Node HTTP 细节

- 控制台使用 `createServer` 监听 `WEB_CONSOLE_PORT`（默认 3000）；端口占用时 `listen` 的 `error` 事件会 reject。
- Node 请求被转换为标准 `Request`（`incomingMessageToRequest`）后交给共享处理器，再经 `writeFetchResponse` 写回 `ServerResponse`。
- `FetchResponseSink` 提供最小 `ServerResponse` 表面，使页面渲染函数可同时用于 Node 与 Workers。
- 登录表单体积上限 `maxFormBodyBytes = 64KB`，超限返回 413。
