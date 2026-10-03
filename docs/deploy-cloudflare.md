# Cloudflare Workers 部署

本文档描述如何把 InboxBridge 部署到 Cloudflare Workers + D1。入口为 `src/runtime/worker.ts`，配置见根目录 [wrangler.toml](../wrangler.toml)。

> **先读这个**：Workers 形态与 Node 形态行为不完全一致，D1 也有若干硬约束（事务、PRAGMA、FTS5）。动手前请先看 [07-workers-runtime.md](./code-wiki/07-workers-runtime.md) 的「D1 能力约束」一节。

## 0. 前置条件

- Cloudflare 账号，已登录 `wrangler`（`npx wrangler login`）。
- 本地 Node ≥ 24（与项目 `engines` 一致）。

## 1. 创建 D1 并回填 database_id

```bash
npx wrangler d1 create inboxbridge
```

命令会返回 `database_id`。把它填进 `wrangler.toml`（当前是占位全 0，**不改会部署失败**）：

```toml
[[d1_databases]]
binding = "DB"
database_name = "inboxbridge"
database_id = "<上一步返回的 id>"
```

## 2. 设置控制台会话密钥

Workers 形态**必须**提供 `WEB_CONSOLE_SESSION_SECRET`，否则控制台路由直接返回 503：

```bash
openssl rand -hex 32 | npx wrangler secret put WEB_CONSOLE_SESSION_SECRET
```

## 3. 提供 Telegram 配置

两种方式，二选一：

**A. 部署后用控制台配置（推荐，与 Node 形态一致）**

配置存进 D1 的 `app_settings`，无需重新部署：

```bash
npx wrangler deploy
# 打开 https://<worker>.<account>.workers.dev ，用 setup token 登录后填写
```

setup token 在 Worker 首次请求时生成并写入 D1；可在本地读出来：

```bash
npx wrangler d1 execute inboxbridge --remote \
  --command "SELECT value FROM app_settings WHERE key = 'WEB_CONSOLE_SETUP_TOKEN'"
```

**B. 用 `[vars]` 直接注入**

在 `wrangler.toml` 的 `[vars]` 中补充（注意 `TELEGRAM_UPDATE_MODE` 必须是 `webhook`）：

```toml
[vars]
TELEGRAM_UPDATE_MODE = "webhook"
TELEGRAM_MANAGEMENT_CHAT_ID = "-100xxxxxxxxxx"
TELEGRAM_ADMIN_USER_IDS = "123456789"
```

Bot Token 建议用 secret 而非 `[vars]`：

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

## 4. 部署

```bash
npx wrangler deploy
```

部署后先确认 Worker 存活：

```bash
curl -s https://<worker>.<account>.workers.dev/healthz
# {"status":"ok","database":"reachable"}
```

## 5. 注册 Telegram webhook（必做，容易漏）

**项目在 Workers 形态下不会自动调用 `setWebhook`** —— 该调用只存在于 Node 形态的启动流程中。这里需要你手动把 Telegram 指向 Worker，并带上密钥。

密钥规则：`TELEGRAM_WEBHOOK_SECRET` 优先；未设置时使用 **bot token 的 SHA-256（十六进制）**，与项目实现一致：

```bash
export TELEGRAM_BOT_TOKEN='<你的 bot token>'
SECRET=$(printf '%s' "$TELEGRAM_BOT_TOKEN" | sha256sum | cut -d' ' -f1)

curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://<worker>.<account>.workers.dev/telegram/webhook" \
  --data-urlencode "secret_token=${SECRET}"
```

若你自定义了 `TELEGRAM_WEBHOOK_SECRET`，把 `SECRET` 换成该值。校验与查看：

```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

`last_error_message` 为空、`pending_update_count` 不持续增长即正常。

## 6. 验证迁移（必做）

D1 与本机 SQLite 行为不同，`messages_fts` 建表与三条同步触发器**必须在真实 D1 上确认一次**。用 `--remote`（`--local` 走本地 SQLite，验证不了 D1）：

```bash
# 1) 表与虚拟表都在
npx wrangler d1 execute inboxbridge --remote \
  --command "SELECT type, name FROM sqlite_master WHERE name LIKE 'messages%' ORDER BY name;"
# 期望看到 messages、messages_fts 以及 messages_fts_insert/delete/update 三个触发器

# 2) 插入一条消息后，全文索引应能命中
npx wrangler d1 execute inboxbridge --remote \
  --command "INSERT INTO messages (conversation_id, direction, platform, message_type, text, created_at) VALUES (1,'inbound','telegram','text','部署验证关键字','2026-01-01T00:00:00.000Z');"
npx wrangler d1 execute inboxbridge --remote \
  --command "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH '\"部署验证\"';"
# 期望返回 1；返回 0 说明触发器或 trigram 分词器未生效
```

若第 1 步就报错，通常是两类原因：D1 该版本不支持 `trigram` 分词器，或 `CREATE TRIGGER` 语句未能通过 D1 的语句解析。前者需要把迁移里的 `tokenize='trigram'` 换成其它分词器（会牺牲中文子串检索），后者需要把触发器改由 `wrangler d1 execute --file` 预置。

## 7. 定时任务

`wrangler.toml` 已配置 `crons = ["*/15 * * * *"]`，`scheduled` 处理器每 15 分钟执行一次维护任务：过期会话销毁 → 消息正文保留清理 → 投递重试。

可通过 Dashboard 的 Workers → Cron Triggers 确认，或查看日志：

```bash
npx wrangler tail
```

## 8. 与 Node 形态的差异

| 维度 | Node 常驻 | Workers + D1 |
| --- | --- | --- |
| 更新接收 | polling 或 webhook | 只能 webhook（需手动注册，见第 5 步） |
| 事务 | `BEGIN`/`COMMIT` 真事务 | `D1Database::batch()` 原子提交（事务内不可读、嵌套会展平） |
| 定时任务 | 进程内三组定时器 | Cron，最小间隔受 Cron 表达式限制 |
| 控制台指标 | 真实统计 | `/metrics` 与运维列表返回占位空数据 |
| 会话存储 | 可选签名 Cookie 或内存 | 必须签名 Cookie |
| 冷启动 | 无 | 有；每 isolate 首次请求执行迁移（已按绑定记忆化） |

**当前建议**：若你需要完整的控制台指标与最简运维，优先用 Node 常驻形态（Serv00 / VPS）；Workers 形态更适合无服务器成本敏感、且能接受上述差异的场景。

## 9. 排错

| 现象 | 排查方向 |
| --- | --- |
| 部署报 `database_id` 相关错误 | `wrangler.toml` 里仍是占位全 0，未回填真实 ID |
| 控制台返回 503 | 未设置 `WEB_CONSOLE_SESSION_SECRET` |
| `/healthz` 返回 degraded | 查看 `npx wrangler tail`：多为 D1 不可达或配置不完整 |
| Telegram 无任何反应 | webhook 未注册 / URL 填错；用 `getWebhookInfo` 查看 `last_error_message` |
| webhook 返回 403 | `secret_token` 与项目期望值不一致（详见第 5 步的密钥规则） |
| 搜索无结果 | 迁移验证未通过，见第 6 步 |
| 保存控制台配置报错 | 多为 D1 事务相关；确认已部署包含写入缓冲实现的版本 |

## 相关文档

- [Serv00 部署（Node 常驻）](./deploy-serv00.md)
- [Workers 运行时详解](./code-wiki/07-workers-runtime.md)
- [配置项参考](./code-wiki/08-configuration.md)
