# 03 · 数据模型与存储

存储层通过 [ports/database.ts](../../src/ports/database.ts) 的 `Database` 抽象屏蔽数据库差异：

- Node 运行时：[storage/client.ts](../../src/storage/client.ts) 用内置 `node:sqlite`（`DatabaseSync`）实现，`file:` 前缀会被去除并自动创建父目录，连接后执行 `PRAGMA foreign_keys = ON`。
- Workers 运行时：[storage/d1.ts](../../src/storage/d1.ts) 适配 Cloudflare D1 的 `prepare/bind/run/first/all`。

所有行类型定义在 [storage/schema.ts](../../src/storage/schema.ts)。

## 1. 实体关系

```text
contacts (1) ──< conversations (1) ──< messages
    │                  │  │
    │                  │  └──< ai_drafts
    │                  │  └──< admin_notes
    │                  │  └──< conversation_tags >── tags
    │                  └──1 telegram_topics
    │
    └──1 blocks

messages (1) ──< deliveries (source_message_id, 可空)

app_settings   —— 独立键值表（控制台配置）
audit_logs     —— 关联 conversations 的操作审计
```

## 2. 表结构

### 2.1 `contacts` —— 外部联系人

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | 主键 |
| `platform` | TEXT NOT NULL | 渠道标识（当前为 `telegram`） |
| `external_user_id` | TEXT NOT NULL | 渠道内用户 ID（Telegram 数字 ID 的字符串形式） |
| `username` | TEXT | 渠道用户名 |
| `display_name` | TEXT | 展示名 |
| `status` | TEXT NOT NULL DEFAULT `'active'` | `active` / `blocked` |
| `created_at` / `updated_at` | TEXT NOT NULL | ISO 时间戳 |

唯一索引：`contacts_platform_external_uidx(platform, external_user_id)`。联系人身份在会话删除后仍保留（用于维持封禁与身份映射）。

### 2.2 `conversations` —— 会话

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK | 主键 |
| `contact_id` | INTEGER NOT NULL FK → contacts | 所属联系人 |
| `status` | TEXT NOT NULL DEFAULT `'open'` | `open` / `closed` |
| `assigned_admin_id` | TEXT | 负责人 Telegram user_id |
| `priority` | TEXT NOT NULL DEFAULT `'normal'` | `low` / `normal` / `high` / `urgent` |
| `muted_until` | TEXT | 静音截止时间 |
| `retention_days` | INTEGER | 单会话销毁天数；`NULL` = 永不 |
| `expires_at` | TEXT | 到期销毁时间；`NULL` = 不自动销毁 |
| `created_at` / `updated_at` / `last_message_at` | TEXT | 时间戳 |
| `ai_enabled` | INTEGER NOT NULL DEFAULT 1 | 单会话 AI 草稿开关（迁移补列） |

索引：`conversations_contact_idx(contact_id)`、`conversations_expires_idx(expires_at)`。

### 2.3 `telegram_topics` —— 会话 ↔ Forum Topic 映射

| 列 | 说明 |
| --- | --- |
| `id` / `conversation_id` (FK, UNIQUE) | 主键 / 会话一对一 |
| `management_chat_id` | 管理群 ID（字符串） |
| `message_thread_id` | Forum Topic 线程 ID |
| `topic_name` | Topic 名称 |
| `created_at` / `updated_at` | 时间戳 |

唯一索引：`telegram_topics_conversation_uidx(conversation_id)`、`telegram_topics_thread_uidx(management_chat_id, message_thread_id)`。

### 2.4 `messages` —— 消息

| 列 | 说明 |
| --- | --- |
| `id` / `conversation_id` (FK) / `contact_id` (FK, 可空) | 主键与关联 |
| `direction` | `inbound` / `outbound` / `internal` |
| `platform` / `message_type` | 渠道与类型（text/photo/video/...） |
| `text` | 文本或 caption |
| `raw_payload` | 原始 update JSON 字符串（用于重试复制） |
| `external_message_id` | Telegram `message_id`，重试复制时使用 |
| `created_at` | 创建时间 |
| `expires_at` | 正文保留到期时间（`internal` 消息为 `NULL`，不清理） |

索引：`messages_conversation_idx`、`messages_expires_idx`。保留到期后仅清空 `text` / `raw_payload`，行与映射保留。

### 2.5 `deliveries` —— 投递记录

| 列 | 说明 |
| --- | --- |
| `id` / `source_message_id` (FK messages, 可空) | 主键与源消息 |
| `target` | 目标标识：`telegram-topic:<threadId>` 或 `telegram-user:<userId>` |
| `status` | `pending` / `sent` / `failed` / `permanent_failure` |
| `attempt_count` | 已尝试次数 |
| `last_error` | 最后一次错误 |
| `next_retry_at` | 下次重试时间（`failed` 时有效） |
| `created_at` / `updated_at` | 时间戳 |

索引：`deliveries_retry_idx(status, next_retry_at)`。

### 2.6 `admin_notes` —— 内部备注

`id`、`conversation_id` (FK)、`admin_user_id`、`note`、`created_at`。备注不会外发。

### 2.7 `blocks` —— 封禁

`id`、`contact_id` (FK, UNIQUE)、`reason`、`created_by`、`created_at`。存在记录即视为已封禁；封禁同时会把 `contacts.status` 置为 `blocked`。

### 2.8 `tags` / `conversation_tags` —— 标签

- `tags`：`id`、`name` (UNIQUE)、`created_at`（名称统一小写）。
- `conversation_tags`：`id`、`conversation_id` (FK)、`tag_id` (FK)、`created_at`，唯一 `(conversation_id, tag_id)`。

### 2.9 `ai_drafts` —— AI 草稿

| 列 | 说明 |
| --- | --- |
| `id` / `conversation_id` (FK) / `source_message_id` (FK messages, 可空) | 主键与关联 |
| `draft_text` | 草稿正文（保留清理时会被置空） |
| `status` | `pending` / `ready` / `failed` / `sent` / `discarded` |
| `error` | 失败原因 |
| `created_at` / `updated_at` | 时间戳 |

索引：`ai_drafts_conversation_idx`。

### 2.10 `app_settings` —— 控制台配置

`key` (PK)、`value`、`updated_at`。Web 控制台保存的配置以键值形式持久化在此表。

### 2.11 `audit_logs` —— 审计日志

`id`、`admin_id`、`conversation_id` (FK)、`action`、`detail`、`created_at`。
索引：`audit_logs_conversation_idx(conversation_id, created_at DESC)`、`audit_logs_admin_idx(admin_id, created_at DESC)`。

## 3. 迁移机制

[storage/migrations/0001_initial.ts](../../src/storage/migrations/0001_initial.ts) 定义 `MigrationDefinition`：

- `statements`：幂等 DDL（`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`）。
- `columns`：需要补的列（`conversations.retention_days`、`expires_at`、`ai_enabled`）。
- `afterColumns`：补列后重建索引。

[storage/migrations/runner.ts](../../src/storage/migrations/runner.ts) 的 `runMigration` 依次执行 statements → 通过 `addColumnIfMissing`（`PRAGMA table_info` 判断）按需 `ALTER TABLE ADD COLUMN` → 执行 afterColumns。迁移完全幂等，恢复备份后可安全重跑。

## 4. 常见写路径

- **创建消息**：`ConversationService.createMessage` 计算 `expires_at`（非 internal 时 = now + `MESSAGE_RETENTION_DAYS`），并更新 `conversations.last_message_at`。
- **删除会话**：`deleteConversationData` 在事务内按 `deliveries → ai_drafts → conversation_tags → admin_notes → telegram_topics → messages → conversations` 顺序删除（先删依赖，再删主表）。
- **重置会话**：`resetConversation` 清空消息/草稿/标签/备注，保留会话与 Topic 映射。
