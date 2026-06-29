# Requirements Document

## Introduction

InboxBridge 当前缺少三个稳定性基础设施：(1) 未捕获的 Promise rejection 和未捕获异常没有兜底，进程可能静默吞错或崩溃；(2) 关键热路径（消息投递失败、过期 Topic 删除、grammy update 错误）使用 `console.error` 绕过 pino，丢失结构化字段、日志级别和 JSON 输出能力；(3) Web 控制台没有健康检查和 metrics 端点，容器编排无法探测进程存活，运维无法监控积压的失败投递、活跃会话数等关键指标。

本功能补齐这三个基础设施层，为后续所有功能提供稳定的可观测性基础。

## Glossary

- **Process**: 运行中的 InboxBridge Node.js 进程，入口为 `src/runtime/main.ts`。
- **Logger**: 全局 pino 实例（`main.ts:21`），所有模块应通过依赖注入或模块级实例使用。
- **Unhandled rejection**: 被 Promise 拒绝但未在 await 链路中被 `.catch()` 捕获的 rejection。
- **Uncaught exception**: 同步代码中未被 try/catch 捕获的异常。
- **Health check**: HTTP 端点 `/healthz`，返回进程存活状态和关键依赖可达性。
- **Metrics**: HTTP 端点 `/metrics`，返回进程运行指标（消息计数、投递状态、会话数等）。
- **Hot path**: 消息投递、定时器回调、grammy update 处理等高频执行路径。
- **Runtime**: 由 `restartRuntime` / `stopRuntime` 管理的 bot 生命周期，包括 bot 实例、定时器和 worker。

## Requirements

### Requirement 1: Unhandled Rejection 兜底

**User Story:** AS 运维人员, I want 未捕获的 Promise rejection 被记录到结构化日志, so that 排障时能在日志系统中检索到完整的错误上下文

#### Acceptance Criteria

1. WHEN Node.js 进程触发 `unhandledRejection` 事件, the Process SHALL 通过 pino logger 以 error 级别记录错误对象和 rejection 原因
2. WHEN `unhandledRejection` 被记录后, the Process SHALL 继续运行（不退出进程），保持 bot 和定时器正常工作
3. IF 同一错误消息在 60 秒内重复触发 `unhandledRejection` 超过 5 次, the Process SHALL 记录一条 warn 级别的去重日志并在该 60 秒窗口内抑制后续重复记录

### Requirement 2: Uncaught Exception 兜底

**User Story:** AS 运维人员, I want 未捕获的同步异常被记录后触发受控退出, so that 进程管理器（systemd/PM2/容器编排）能自动重启进程并恢复一致状态

#### Acceptance Criteria

1. WHEN Node.js 进程触发 `uncaughtException` 事件, the Process SHALL 通过 pino logger 以 fatal 级别记录错误对象、堆栈和触发上下文
2. WHEN `uncaughtException` 被记录后, the Process SHALL 调用 `stopRuntime()` 执行受控关闭（停止 bot、清理定时器和 worker）
3. WHEN `stopRuntime()` 完成或超过 10 秒（取先到者）, the Process SHALL 以退出码 1 调用 `process.exit(1)`
4. IF `uncaughtException` 发生在 `stopRuntime()` 执行期间, the Process SHALL 跳过重复的 `stopRuntime()` 调用，直接等待退出超时

### Requirement 3: 热路径日志统一到 pino

**User Story:** AS 运维人员, I want 所有关键路径的错误日志通过 pino 输出, so that 日志格式统一、可被日志采集器正确解析、支持结构化字段检索

#### Acceptance Criteria

1. WHEN `src/channels/telegram/messages.ts` 中的投递失败路径执行, the Process SHALL 通过注入的 pino logger 以 error 级别记录 conversationId、deliveryId、target、error.message 和 error.stack
2. WHEN `src/domain/conversation-expiry.ts` 中的 Topic 删除失败, the Process SHALL 通过注入的 pino logger 以 error 级别记录 conversationId、threadId、error.message
3. WHEN `src/channels/telegram/updates.ts` 中的 grammy update 处理失败, the Process SHALL 通过注入的 pino logger 以 error 级别记录 update_id、error.message 和 error.stack
4. WHILE 替换 console.error 为 pino logger, the Process SHALL 保持原有的用户可见行为不变（例如不向 Telegram 用户暴露内部错误细节）

### Requirement 4: 健康检查端点

**User Story:** AS 容器编排系统, I want 通过 HTTP 端点探测进程存活和依赖可达性, so that 能实现 liveness 和 readiness 探测

#### Acceptance Criteria

1. WHEN 收到 `GET /healthz` 请求, the Web Console SHALL 返回 HTTP 200 和 JSON 格式的健康状态
2. WHILE 返回健康状态, the JSON SHALL 包含 `status`（"ok" 或 "degraded"）、`bot`（"running" 或 "stopped"）、`db`（"reachable" 或 "unreachable"）、`uptime_seconds`（进程运行秒数）、`timestamp`（ISO 8601）
3. IF bot 处于 stopped 状态或数据库不可达, the Web Console SHALL 返回 HTTP 503 和 `status: "degraded"`
4. WHEN 收到 `GET /healthz` 请求, the Web Console SHALL 不要求认证（公开端点）

### Requirement 5: Metrics 端点

**User Story:** AS 运维人员, I want 通过 HTTP 端点获取运行指标, so that 能监控消息吞吐量、投递积压和会话活跃度

#### Acceptance Criteria

1. WHEN 收到 `GET /metrics` 请求, the Web Console SHALL 返回 HTTP 200 和 JSON 格式的指标快照
2. WHILE 返回指标, the JSON SHALL 包含以下字段：`messages`（含 `inbound_total`、`outbound_total`、`pending_deliveries`、`failed_deliveries`、`permanent_failure_deliveries`）、`conversations`（含 `active_total`、`closed_total`、`expired_total`）、`ai_drafts`（含 `pending_total`、`ready_total`、`failed_total`）、`uptime_seconds`、`timestamp`
3. WHEN 收到 `GET /metrics` 请求, the Web Console SHALL 要求与 Dashboard 相同的 session 认证（非公开端点，防止数据泄漏）
4. IF 指标查询过程中数据库报错, the Web Console SHALL 返回 HTTP 500 和 `{"error": "metrics query failed"}`
5. WHILE 计算投递和会话计数, the Web Console SHALL 通过单次 SQL 查询聚合，避免全表扫描

### Requirement 6: 优雅关闭超时

**User Story:** AS 运维人员, I want 进程在收到 SIGINT/SIGTERM 后在有限时间内退出, so that 不会因为 bot.stop() 卡住而无法重启

#### Acceptance Criteria

1. WHEN 进程收到 SIGINT 或 SIGTERM, the Process SHALL 启动 `stopRuntime()` 并设置 10 秒超时
2. IF `stopRuntime()` 在 10 秒内完成, the Process SHALL 关闭数据库连接并以退出码 0 退出
3. IF `stopRuntime()` 超过 10 秒未完成, the Process SHALL 记录一条 warn 日志，关闭数据库连接并以退出码 1 强制退出
