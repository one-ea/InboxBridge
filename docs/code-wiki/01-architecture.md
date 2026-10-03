# 01 · 整体架构

## 1. 系统定位

InboxBridge 是一个**双向桥接服务**：把外部用户与 Telegram bot 的私聊（inbound）投递到私密 Forum 管理群中对应的 Topic；把白名单管理员在 Topic 内的回复（outbound）代发回外部用户。核心目标是让团队共享一个"收件箱"，同时不暴露个人 Telegram 账号。

渠道层当前只实装 Telegram；Email、Web Chat 为后续扩展方向（见 [../architecture.md](../architecture.md)）。

## 2. 分层架构

```text
┌─────────────────────────────────────────────────────────────┐
│ 接入层 Entrypoints                                           │
│  src/runtime/main.ts        Node 常驻进程入口（HTTP + 长轮询/本地 webhook）│
│  src/runtime/worker.ts      Cloudflare Workers（fetch + scheduled + D1）  │
│  src/tools/*.ts             CLI 脚本（migrate / retention / check）       │
└───────────────┬─────────────────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────┐
│ 渠道适配层 src/channels/telegram/                            │
│  bot / updates / messages / media / topics / menu / commands │
│  worker-webhook / secrets                                    │
│  职责：解析 Telegram update、鉴权、CopyMessage/降级、命令路由 │
└───────────────┬─────────────────────────────────────────────┘
                │ 依赖领域服务
┌───────────────▼─────────────────────────────────────────────┐
│ 领域层 src/domain/                                           │
│  conversations / deliveries / delivery-retry / ai-drafts     │
│  audit / app-settings / retention / conversation-expiry      │
│  permissions / rate-limit                                    │
│  职责：业务规则、状态机、事务、清理策略（与 Telegram 解耦，经 Api 注入）│
└───────────────┬─────────────────────────────────────────────┘
                │ 依赖端口
┌───────────────▼─────────────────────────────────────────────┐
│ 端口与存储 src/ports/ + src/storage/                         │
│  ports/database.ts           Database / PreparedStatement    │
│  storage/client.ts           node:sqlite 适配（Node）         │
│  storage/d1.ts               Cloudflare D1 适配              │
│  storage/schema.ts           行类型定义                       │
│  storage/migrations/         幂等迁移（DDL + 列补丁）         │
└─────────────────────────────────────────────────────────────┘
```

**依赖方向**：`runtime` → `channels` → `domain` → `ports` ← `storage`。领域层不直接依赖 grammY 的具体实现，只依赖注入的 `Api` 与 `Database` 端口，因此可在 Node 与 Workers 两种运行时复用。

## 3. 双向数据流

### 3.1 入站（外部用户 → 管理群）

```text
外部用户私聊 bot
  → Telegram update（allowed_updates: ["message"]）
  → registerTelegramUpdates → handlePrivateMessage
  → ConversationService.getOrCreateConversation（contact + conversation）
  → 封禁检查 / 限流检查（RateLimitService）
  → 若会话已关闭则自动重开
  → ConversationService.createMessage(direction=inbound)
  → ensureTelegramTopic（存在则复用，否则 createForumTopic 并落库）
  → copyWithDelivery（copyMessage，失败 3 次后降级文本摘要）
  → DeliveryService 记录 pending → sent/failed
  → 若 urgent 且有负责人：发送紧急提醒
  → AiDraftService.generate（可选，草稿只发到 Topic）
```

### 3.2 出站（管理群 → 外部用户）

```text
管理员在 Topic 内发消息
  → 校验 chat_id == TELEGRAM_MANAGEMENT_CHAT_ID，且非 bot
  → 取 message_thread_id，反查 telegram_topics → conversation → contact
  → PermissionService.isAdmin（不在白名单则拒绝）
  → 文本以 "/" 开头 → handleTopicCommand（命令，不外发）
  → 普通消息：createMessage(direction=outbound) → copyWithDelivery 到用户私聊
```

## 4. 运行时形态

| 形态 | 入口 | 更新接收 | 存储 | 定时任务 |
| --- | --- | --- | --- | --- |
| Node 常驻（默认） | [main.ts](../../src/runtime/main.ts) | polling 或 webhook（本地 HTTP 服务器） | `node:sqlite` | `setInterval`（过期会话、消息保留、投递重试） |
| Cloudflare Workers | [worker.ts](../../src/runtime/worker.ts) | webhook（`/telegram/webhook`） | D1 | Cron `*/15 * * * *` 触发 `scheduled` |

两种形态共享 `domain` 与 `channels` 的全部逻辑，差异被收敛在入口层：数据库适配器、更新接收方式、定时器实现。

## 5. 可靠性策略

- **投递重试**：`copyWithDelivery` 内同步重试 3 次（指数退避）；失败记录为 `failed`，由 `startDeliveryRetryWorker` 异步重试，累计上限 `MAX_DELIVERY_ATTEMPTS = 8`，超限标记 `permanent_failure` 并向 Topic 发送通知。
- **降级投递**：`copyMessage` 全部失败时，退化为文本摘要（可附带失败原因）；入站仍可尝试降级发送到管理群主消息区（`allowGeneralChatFallback`）。
- **Topic 自愈**：遇到 `message thread not found` 时，清理旧会话数据并重建 Topic，重新投递。
- **配置热重载**：Web 控制台保存后调用 `onConfigSaved` → `restartRuntime()` 重新加载配置并重启 bot。
- **优雅关停**：`SIGINT`/`SIGTERM` 与未捕获异常触发 `stopRuntime()`，10 秒超时后强制退出。
- **未处理拒绝去重**：`unhandledRejection` 在 60 秒窗口内对相同消息去重，避免日志风暴。

## 6. 隐私与安全边界

- 不绕过 Telegram 私信隐私限制——外部用户必须先主动联系 bot。
- 管理员代发/命令执行必须命中 `TELEGRAM_ADMIN_USER_IDS` 白名单（[permissions.ts](../../src/domain/permissions.ts)）。
- Web 控制台：首次使用 setup token 登录，随后以控制台密码（scrypt 加盐哈希）保护；会话通过 HMAC 签名 Cookie（Node 亦可内存会话）。
- Telegram Webhook 使用 `x-telegram-bot-api-secret-token` 头校验，缺失时以 bot token 的 SHA-256 作为默认密钥。
- 敏感配置（`TELEGRAM_BOT_TOKEN`、`OPENAI_COMPATIBLE_API_KEY`）在控制台以密码框呈现，留空表示保持原值。
- SQLite 数据库、`.env`、构建产物均已加入 `.gitignore`。

## 7. 设计规格索引

`.monkeycode/specs/` 下每个特性都有 `requirements.md` 与 `design.md`，是理解各功能演进意图的一手资料：

| 特性目录 | 主题 |
| --- | --- |
| `ai-draft-lifecycle` | AI 草稿生命周期 |
| `audit-log` | 审计日志 |
| `command-message-refinement` | 命令与消息处理细化 |
| `connector-cleanup` | 连接器/Topic 清理 |
| `delivery-retry-worker` | 投递重试工作器 |
| `message-retention-timer` | 消息保留定时清理 |
| `operations-dashboard` | 运维仪表盘 |
| `per-conversation-ai-toggle` | 单会话 AI 开关 |
| `stability-foundation` | 稳定性基础 |
