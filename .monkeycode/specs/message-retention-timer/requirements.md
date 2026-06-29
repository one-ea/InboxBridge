# Requirements Document: Message Retention Timer

## Introduction

InboxBridge 承诺"默认 30 天清理消息内容"，`RetentionService.cleanupExpired` 已实现将 `messages.text` 和 `messages.raw_payload` 置 NULL 的逻辑。但此服务只在 CLI 工具 `tools/retention-cleanup.ts` 中被调用，运行时 `main.ts` 无定时器调用它，导致运行中的 bot 不会自动清理过期消息正文，需手动跑 `npm run retention:cleanup`。

本功能在运行时新增一个定时器，周期性调用 `RetentionService.cleanupExpired`，使隐私承诺自动兑现。

## Glossary

- **消息正文清理**：将 `messages` 表中 `expires_at <= now` 的行的 `text` 和 `raw_payload` 置为 NULL，保留行本身和会话映射
- **RetentionService**：已有服务类，`cleanupExpired(now)` 返回本次清理的行数

## Requirements

### Requirement 1: 运行时定时清理

**User Story:** AS 用户，我希望运行中的 bot 自动清理过期消息正文，以便隐私保留策略自动兑现，无需手动执行 CLI。

#### Acceptance Criteria

1. WHEN bot 运行时启动，the system SHALL 启动一个定时器，以固定间隔（默认 60 分钟）调用 `RetentionService.cleanupExpired`
2. WHEN 定时器触发，the system SHALL 调用 `cleanupExpired(nowIso())` 清理所有到期消息正文
3. WHEN 清理返回受影响行数大于 0，the system SHALL 记录一条 info 日志，包含清理的行数
4. WHEN 清理返回受影响行数为 0，the system SHALL 记录一条 debug 日志
5. WHEN bot 关闭，the system SHALL 清除定时器

### Requirement 2: 配置化扫描间隔

**User Story:** AS 部署者，我希望能够调整清理间隔，以便在存储敏感和性能之间平衡。

#### Acceptance Criteria

1. WHEN bot 启动，the system SHALL 读取 `MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES` 配置项（默认 60）作为清理间隔
2. WHEN 配置值小于 1，the system SHALL 使用默认值 60 并记录一条 warning 日志
3. WHEN Web 控制台保存配置触发 `restartRuntime`，the system SHALL 用新配置值重建定时器

### Requirement 3: 与会话过期清理的关系

**User Story:** AS 系统维护者，我希望消息清理和会话清理各司其职，互不干扰。

#### Acceptance Criteria

1. WHILE 消息正文清理定时器运行，the system SHALL 独立于会话过期扫描定时器，两者互不阻塞
2. WHEN 会话被过期清理删除整行数据，the system SHALL 不影响消息清理（已删除的会话对应消息行通过外键或会话查询关联，清理逻辑只看 `expires_at` 字段）
3. WHEN 消息正文被清理但会话仍存在，the system SHALL 保留会话映射、Topic、标签、备注等元数据
