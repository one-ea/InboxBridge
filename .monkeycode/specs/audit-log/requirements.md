# 审计日志 (Audit Log) 需求规格

## 1. 概述

持久化记录白名单管理员在 Topic 内执行的关键操作，便于多管理员协作场景下追溯谁在何时对哪个会话做了什么操作。

## 2. 背景

当前所有管理员命令（ban/assign/delete/reset/close/mute/priority 等）执行后仅回复一条 Telegram 消息，没有持久化记录。多管理员场景下无法回答"谁关闭了这个会话"、"谁重置了消息"、"谁封禁了这个联系人"等问题。

## 3. 范围

### 3.1 In Scope

- 新增 `audit_logs` 表，记录管理员操作
- `AuditService`：写入、查询、统计
- 在以下命令执行成功后埋点：ban/unban/assign/priority/close/reopen/mute/delete/reset/expire/ai_on/ai_off/draft send/draft discard/tag/untag/note
- `/audit [N]` 命令：在当前 Topic 内查看最近 N 条审计记录（默认 20，最多 50）
- Web 控制台 `/operations/audit` 页面：分页审计日志，按管理员 ID 和操作类型筛选

### 3.2 Out of Scope

- 审计日志的自动清理策略（后续随消息保留策略一起处理）
- 审计日志导出（后续随 export 功能扩展）
- 操作撤销/回滚

## 4. 需求 (EARS)

### REQ-1: 审计日志持久化
**WHEN** 管理员执行列入审计清单的命令 **AND** 命令执行成功时，**THE SYSTEM SHALL** 在 `audit_logs` 表中写入一条记录，包含管理员 ID、操作类型、目标会话 ID、操作详情和时间戳。

### REQ-2: 审计记录字段
**THE audit_logs TABLE SHALL** 包含以下字段：id（自增主键）、admin_id（TEXT，执行操作的管理员 Telegram user_id）、conversation_id（INTEGER，目标会话 ID）、action（TEXT，操作类型枚举）、detail（TEXT，可空的附加信息如封禁原因/优先级值/分配目标）、created_at（TEXT，ISO 8601 时间戳）。

### REQ-3: /audit 命令
**WHEN** 管理员在 Topic 内发送 `/audit` 或 `/audit <N>` **AND** 当前会话存在时，**THE SYSTEM SHALL** 返回该会话最近 N 条审计记录（默认 20，最多 50），按时间倒序排列，每条记录显示时间、管理员 ID、操作和详情。

### REQ-4: Web 审计页面认证
**WHEN** 未认证用户访问 `/operations/audit` 时，**THE SYSTEM SHALL** 重定向到登录页，行为与 `/operations/overview` 一致。

### REQ-5: Web 审计页面查询
**WHEN** 已认证管理员访问 `/operations/audit` 时，**THE SYSTEM SHALL** 展示分页审计日志（每页 50 条），支持按管理员 ID 和操作类型筛选，每条记录显示时间、管理员、会话 ID、操作、详情。

### REQ-6: 操作类型枚举
**THE action field SHALL** 使用以下固定值：`ban`、`unban`、`assign`、`priority`、`close`、`reopen`、`mute`、`delete`、`reset`、`expire`、`ai_on`、`ai_off`、`draft_send`、`draft_discard`、`tag`、`untag`、`note`。

### REQ-7: 埋点不阻断主流程
**WHEN** 审计日志写入失败时，**THE SYSTEM SHALL** 记录错误日志并继续执行，不阻断主命令流程，不向管理员暴露审计写入错误。

## 5. 非功能性需求

- 性能：审计日志查询使用 `(conversation_id, created_at DESC)` 复合索引和 `(admin_id)` 索引
- 审计日志写入使用同步 SQLite 操作，与命令在同一事务外独立写入
- `/audit` 命令响应时间不超过 500ms（50 条记录内）
