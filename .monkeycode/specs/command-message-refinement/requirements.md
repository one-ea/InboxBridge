# Requirements Document

## Introduction

InboxBridge 的命令系统和消息流存在多处体验和安全缺口：(1) 缺少 `/reset` 命令（重置会话但保留联系人映射）；(2) `/assign` 不校验参数是否为数字，会写入非法值；(3) 未知命令只回复"未知命令"而不提示 `/help`；(4) `/help`、`/ai_on`、`/ai_off` 未注册到 Telegram 命令菜单，管理员只能手敲；(5) closed 会话被用户发消息自动重开时，管理员无通知；(6) 超长消息（>4096 字符）无长度校验，AI 草稿或拼接上下文可能超限导致 sendMessage 失败。

本功能补齐这些缺口，提升命令系统的完整性和消息流的健壮性。

## Glossary

- **Command menu**: Telegram bot 的命令补全菜单，通过 `setMyCommands` 注册。
- **Session reset**: 清空会话的消息历史但保留联系人映射和 Topic，与 `/delete`（删除一切）和 `/close`（仅关闭状态）区分。
- **Closed conversation reopen**: closed 状态的会话收到外部用户消息时自动改为 open 的行为。
- **Message length limit**: Telegram sendMessage 的文本上限 4096 字符。

## Requirements

### Requirement 1: /reset 命令

**User Story:** AS 管理员, I want 用 /reset 重置会话消息历史但保留联系人映射, so that 能清理上下文而不丢失 Topic 和联系人关系

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送 `/reset confirm`, the System SHALL 删除该会话的所有 messages、ai_drafts、admin_notes、message_tags 记录，保留 conversation、contact 和 telegram_topics 记录
2. WHEN 管理员发送 `/reset`（无 confirm 参数）, the System SHALL 回复"危险操作：将清空当前会话的所有消息、草稿和备注。确认请发送 /reset confirm"
3. WHEN reset 完成, the System SHALL 回复"会话已重置。联系人映射和 Topic 已保留。"

### Requirement 2: /assign 参数校验

**User Story:** AS 管理员, I want /assign 拒绝非数字参数, so that assigned_admin_id 字段不会写入非法值

#### Acceptance Criteria

1. WHEN 管理员发送 `/assign abc`（非数字）, the System SHALL 回复"用法：/assign <telegram_user_id>，ID 必须为数字。"
2. WHEN 管理员发送 `/assign 123456789`, the System SHALL 写入 assigned_admin_id 并回复"已分配给 123456789。"
3. WHEN 管理员发送 `/assign`（无参数）, the System SHALL 回复用法提示

### Requirement 3: 未知命令提示

**User Story:** AS 管理员, I want 未知命令提示包含 /help 引导, so that 能快速发现可用命令

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送以 `/` 开头但未识别的命令, the System SHALL 回复"未知命令。发送 /help 查看可用命令列表。"

### Requirement 4: 命令菜单补齐

**User Story:** AS 管理员, I want /help /ai_on /ai_off 出现在命令菜单, so that 不需要手敲命令名

#### Acceptance Criteria

1. WHEN bot 启动并注册菜单, the System SHALL 将 `help`、`ai_on`、`ai_off` 加入 adminBotCommands 数组
2. WHILE 注册菜单, the description SHALL 分别为"查看可用命令"、"开启当前会话的 AI 草稿"、"关闭当前会话的 AI 草稿"
3. WHEN privateBotCommands 注册, the System SHALL 加入 `help` 命令（描述"查看使用帮助"），不加 `ai_on`/`ai_off`（外部用户无权操作）

### Requirement 5: Closed 会话重开通知

**User Story:** AS 管理员, I want closed 会话被用户消息重开时收到通知, so that 不会误以为会话仍处于关闭状态

#### Acceptance Criteria

1. WHEN 外部用户在 closed 会话中发送消息, the System SHALL 将会话状态改为 open
2. WHEN 会话从 closed 重开, the System SHALL 在该会话的 Topic 内发送一条 internal 消息"会话已自动重开（用户发送了新消息）。"
3. WHILE 发送重开通知, the System SHALL 使用 `message_thread_id` 确保通知发送到正确的 Topic

### Requirement 6: 消息长度校验

**User Story:** AS 运维人员, I want 超长消息被截断或拒绝, so that 不会因 Telegram 4096 字符限制导致投递失败

#### Acceptance Criteria

1. WHEN 出站消息文本超过 4000 字符, the System SHALL 截断为 3997 字符并追加"..."（总计 4000 字符）
2. WHEN AI 草稿生成结果超过 4000 字符, the System SHALL 截断草稿文本为 3997 字符并追加"..."
3. WHILE 拼接 AI 上下文, the System SHALL 限制上下文总长度为 12000 字符（从最近的 messages 中截取，超限时丢弃最旧的消息）

## Non-Functional Requirements

### Requirement 7: 帮助文本同步

1. WHILE 更新命令列表, the topicHelpText 函数和 menu.ts 的命令数组 SHALL 保持一致，新增 /reset 命令的帮助文本

## References

- 命令实现：`src/channels/telegram/commands.ts`
- 菜单注册：`src/channels/telegram/menu.ts`
- 消息流：`src/channels/telegram/messages.ts`
- 更新处理：`src/channels/telegram/updates.ts`
