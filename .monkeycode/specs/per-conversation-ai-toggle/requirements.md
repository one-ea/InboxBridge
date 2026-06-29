# Requirements Document: Per-Conversation AI Toggle

## Introduction

InboxBridge 的 AI 草稿功能当前只有全局开关（`AI_DRAFTS_ENABLED`），无法按会话精细控制。`/ai_on` 和 `/ai_off` 命令已注册到 Telegram 菜单，但回复"当前版本尚未实现按会话开关 AI"。

本功能在 `conversations` 表新增 `ai_enabled` 列，实装 `/ai_on` `/ai_off` 命令，并让 AI 草稿生成逻辑在全局开关开启的前提下进一步检查会话级开关。

## Glossary

- **全局 AI 开关**：`AI_DRAFTS_ENABLED` 配置项，控制整个 bot 是否使用 AI
- **会话级 AI 开关**：`conversations.ai_enabled` 列，控制单个会话是否生成 AI 草稿
- **生效条件**：全局开关为 true 且会话级开关为 true 时，AI 草稿才生成

## Requirements

### Requirement 1: 会话级开关数据模型

**User Story:** AS 系统，我需要持久化每个会话的 AI 开关状态，以便重启后状态保留。

#### Acceptance Criteria

1. WHEN 迁移执行，the system SHALL 在 `conversations` 表新增 `ai_enabled` 列，类型 INTEGER，默认值 1
2. WHEN 新会话创建，the system SHALL 设置 `ai_enabled` 为 1（默认开启）
3. WHEN 迁移在已有数据上执行，the system SHALL 将所有现有会话的 `ai_enabled` 设为 1

### Requirement 2: 实装 /ai_on 命令

**User Story:** AS 管理员，我希望对特定会话开启 AI 草稿，以便对需要辅助的会话启用 AI。

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送 `/ai_on`，the system SHALL 将该会话的 `ai_enabled` 设为 1
2. WHEN 开关操作完成，the system SHALL 回复确认消息，说明 AI 草稿已对该会话开启
3. IF 全局 AI 开关为关闭状态，the system SHALL 在确认消息中提示"全局 AI 未开启，需先在控制台启用"

### Requirement 3: 实装 /ai_off 命令

**User Story:** AS 管理员，我希望对特定会话关闭 AI 草稿，以便对敏感会话禁用 AI 辅助。

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送 `/ai_off`，the system SHALL 将该会话的 `ai_enabled` 设为 0
2. WHEN 开关操作完成，the system SHALL 回复确认消息，说明 AI 草稿已对该会话关闭
3. WHILE 会话 `ai_enabled` 为 0，the system SHALL 阻止入站消息触发的自动草稿生成和 `/draft` 命令的草稿生成

### Requirement 4: 草稿生成前置检查

**User Story:** AS 管理员，我希望 AI 草稿只在明确开启的会话中生成，以便控制 AI 使用范围。

#### Acceptance Criteria

1. WHEN 入站消息触发自动草稿生成，the system SHALL 先检查全局开关和会话级开关，两者均为开启时才生成
2. WHEN 管理员执行 `/draft` 命令，the system SHALL 先检查全局开关和会话级开关，两者均为开启时才生成
3. WHEN 会话级开关为关闭，the system SHALL 返回 `disabled` 状态，不调用 AI provider
4. WHEN 会话级开关为关闭且管理员执行 `/draft`，the system SHALL 回复提示"该会话已关闭 AI 草稿，使用 /ai_on 开启"

### Requirement 5: 会话信息展示开关状态

**User Story:** AS 管理员，我希望在会话信息中看到 AI 开关状态，以便了解当前会话的 AI 配置。

#### Acceptance Criteria

1. WHEN 管理员执行 `/info`，the system SHALL 在输出中显示 `ai_enabled` 当前值（开启/关闭）
2. WHEN 管理员执行 `/status`，the system SHALL 在输出中显示 `ai_enabled` 当前值
