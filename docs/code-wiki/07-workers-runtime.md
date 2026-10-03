# 07 · Cloudflare Workers 运行时

InboxBridge 除 Node 常驻进程外，还提供 Cloudflare Workers 部署形态，入口为 [worker.ts](../../src/runtime/worker.ts)，配置见根目录 [wrangler.toml](../../wrangler.toml)。

## 1. 绑定与触发配置

```toml
name = "inboxbridge"
main = "src/runtime/worker.ts"
compatibility_date = "2026-07-01"

[triggers]
crons = ["*/15 * * * *"]

[[d1_databases]]
binding = "DB"
database_name = "inboxbridge"
database_id = "00000000-0000-0000-0000-000000000000"

[vars]
TELEGRAM_UPDATE_MODE = "webhook"
```

- `DB`：D1 数据库绑定（`D1DatabaseBinding`）。
- Cron：每 15 分钟触发一次 `scheduled`。
- Workers 必须使用 **webhook 模式**（无长驻轮询进程）。

## 2. 入口

```ts
export default {
  fetch: handleWorkerFetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(handleWorkerScheduled(controller, env, ctx));
  },
};
```

### 2.1 `handleWorkerFetch(request, env, options?)`

1. `new D1DatabaseAdapter(env.DB)`，并通过 `ensureMigrated(env.DB, db)` 确保 schema 就绪——迁移结果按 **D1 绑定对象**记忆化（`WeakSet`），同一 isolate 内只执行一次，避免每个请求都跑一遍 DDL 与索引探测。
2. 路由：
   - `/healthz` → 执行 `SELECT 1`，返回 `{status:"ok", database:"reachable"}`。
   - `/telegram/webhook` → 使用注入的 handler 或 `createDefaultTelegramWebhookHandler`。
   - 控制台路径（`/`、`/login`、`/logout`、`/metrics`、`/config*`、`/operations*`）→ `handleWorkerWebConsoleRequest`。
   - 其他 → 404 JSON。

### 2.2 `createDefaultTelegramWebhookHandler(db, env, options)`

从 D1 读取 `app_settings` 并与 Worker 环境变量合并（`loadConfigFromSources`），构造 bot 与 webhook handler（密钥来自 `telegramWebhookSecret`，使用 WebCrypto）。

### 2.3 `handleWorkerWebConsoleRequest(request, db, env)`

- 要求 `WEB_CONSOLE_SESSION_SECRET`，缺失则 503。
- 复用 `handleWebConsoleRequest`，但注入的运行时回调为 **只读/占位实现**：
  - `getStatus`：依据配置校验结果返回 `running` / `stopped`。
  - `collectMetrics` / `collectOperationsOverview` / `listConversations` / `listFailedDeliveries` / `listAuditLogs` / `searchMessages`：返回空数据（Workers 形态下控制台主要用于配置与会话管理，不承载 bot 进程内指标）。
  - `onConfigSaved`、`scheduleRetry`：空操作。

### 2.4 `handleWorkerScheduled(...)`

1. D1 迁移（同一记忆化逻辑）。
2. 从 `app_settings` + env 加载配置。
3. `createTelegramBot`（仅用于拿到 `api`）。
4. `runMaintenanceJobs`：过期会话销毁 + 消息保留清理 + **投递重试**（`retryDueDeliveries` 单次扫描，使 Workers 形态也具备出站消息重试能力）。
5. 记录 summary 日志。

## 3. 环境变量映射

`workerEnvToConfigMap(env)`：把 Worker `env` 中所有 `string` 类型的绑定收集为 `ConfigMap`，与 `app_settings` 合并后交给 zod 解析。因此 Workers 部署下配置可来自：

- **Worker 环境变量 / `[vars]`**（覆盖）
- **D1 `app_settings`**（控制台保存值）

## 4. 与 Node 形态的差异

| 维度 | Node 常驻 | Cloudflare Workers |
| --- | --- | --- |
| 数据库 | `node:sqlite`（本地文件） | D1 |
| 更新接收 | polling 或本地 webhook | webhook（`/telegram/webhook`） |
| 定时任务 | `setInterval`（三个循环） | Cron `scheduled`（维护 + 投递重试） |
| 投递重试 | 常驻 worker 定期扫描 | Cron 内的单次扫描（`retryDueDeliveries`） |
| 控制台会话 | 可选签名 Cookie 或内存 Map | 必须签名 Cookie（`WEB_CONSOLE_SESSION_SECRET`） |
| 指标 | 真实统计（`collectMetrics`） | 占位空数据 |
| 依赖注入 | 直接构造 | 支持通过 `WorkerRuntimeOptions` 注入（便于单测） |
| 事务 | `BEGIN`/`COMMIT`/`ROLLBACK` 真事务 | D1 只有 auto-commit，`transaction()` 退化为顺序执行（不保证原子性） |
| 原始 SQL | `exec` 直接执行 | `exec` 走 D1 原生 `D1Database::exec`，可承载含分号的 `CREATE TRIGGER` |

## 5. D1 能力约束（部署前必读）

D1 是 Cloudflare 的托管 SQLite，有几处与本地 SQLite 不同的硬约束，代码已针对性适配：

- **事务**：D1 运行在 auto-commit 模式，显式 `BEGIN`/`COMMIT` 会报错；原子写只能通过 `D1Database::batch()`，而它要求一次性给出全部语句。因此存储端口的 `transaction()` 在 D1 上只顺序执行回调，`deleteConversationData`、`resetConversation`、`setMany` 在 Workers 形态下**不具备原子性**（失败可能留下部分删除的中间状态，属已知取舍）。
- **原始 SQL**：`D1Database::prepare()` 面向单条语句，含分号的触发器函数体需交给 `D1Database::exec()`，适配器的 `exec` 因此改为调用 D1 原生 `exec`。
- **FTS5**：官方支持 FTS5 模块；`trigram` 分词器在 D1 上亦有生产用例，但**建议在真实 D1 上验证一次迁移**（`wrangler d1 execute --remote` 或部署测试 Worker，注意 `--local` 走本地 SQLite 无法验证 D1 行为）。
- **PRAGMA**：仅部分兼容（`table_info`、`foreign_keys` 等在列）；迁移执行器用到的 `PRAGMA table_info` 可用。会话级配置类 PRAGMA 不支持。
- **按行计费**：计费按"读取的行数"而非返回行数，`LIKE '%kw%'` 这类全表扫描在大表上代价明显——这也是消息搜索改用 FTS 索引的原因之一。

## 6. 测试友好性

`WorkerRuntimeOptions` 允许注入 `telegramWebhookHandler`、`createTelegramBot`、`createTelegramWebhookHandler`、`runMaintenanceJobs`、`logger`，因此 [test/worker.test.ts](../../test/worker.test.ts) 的 "Workers runtime" 用例无需真实网络即可覆盖 health、webhook 路由、迁移记忆化、控制台登录与 scheduled 维护。

> D1 侧依赖 SQLite FTS5 与 `trigram` 分词器（SQLite ≥ 3.34）；本地 `node:sqlite` 为 3.49，已实测支持。
