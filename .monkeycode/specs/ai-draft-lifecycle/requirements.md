# Requirements Document

## Introduction

InboxBridge 的 AI 草稿功能当前只实现了 `generate`（生成草稿）。存在四个缺口：(1) 草稿永久留存，无过期清理机制，`ai_drafts` 表会无限增长；(2) 管理员看到草稿后只能手动复制粘贴发送，没有 `/draft send` 命令直接投递；(3) 无法丢弃不满意的草稿，`/draft discard` 缺失；(4) `ai-drafts.ts` 的 `fetch` 调用无超时、无重试，AI 接口慢响应会阻塞消息处理主链路；若 `generate` 在 INSERT 后 UPDATE 前进程崩溃，草稿永远卡在 `pending` 状态。

本功能补齐草稿的完整生命周期：生成 → 查看 → 发送/丢弃 → 过期清理，并增强 fetch 的健壮性。

## Glossary

- **Draft**: `ai_drafts` 表中的一条记录，状态为 `pending`/`ready`/`failed`/`discarded`/`sent`。
- **Active draft**: 会话中最近一条 `ready` 状态的草稿，是 `/draft send` 和 `/draft discard` 的操作对象。
- **Draft generation**: 调用 AI 接口生成回复文本的过程，对应 `AiDraftService.generate`。
- **Draft dispatch**: 将草稿文本作为出站消息投递给外部用户的过程。
- **Draft retention**: 过期草稿的清理策略，由定时器驱动。
- **Stale pending draft**: `pending` 状态超过阈值时间的草稿，视为进程崩溃残留。

## Requirements

### Requirement 1: 草稿发送命令

**User Story:** AS 管理员, I want 用 /draft send 直接发送当前草稿给外部用户, so that 不需要手动复制粘贴

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送 `/draft send`, the System SHALL 查找该会话最近一条 `ready` 状态的草稿
2. WHEN 找到 ready 草稿, the System SHALL 将草稿文本作为出站消息投递给外部用户（通过 bot.api.sendMessage 到外部用户 chatId）
3. WHEN 投递成功, the System SHALL 将草稿状态更新为 `sent` 并记录投递时间
4. WHEN 投递失败, the System SHALL 回复管理员失败原因，草稿状态保持 `ready`（可重试发送）
5. IF 未找到 ready 草稿, the System SHALL 回复"当前没有可发送的草稿，使用 /draft 生成。"

### Requirement 2: 草稿丢弃命令

**User Story:** AS 管理员, I want 用 /draft discard 丢弃不满意的草稿, so that 避免误发且保持草稿列表整洁

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送 `/draft discard`, the System SHALL 查找该会话最近一条 `ready` 状态的草稿
2. WHEN 找到 ready 草稿, the System SHALL 将草稿状态更新为 `discarded` 并回复"草稿已丢弃。"
3. IF 未找到 ready 草稿, the System SHALL 回复"当前没有可丢弃的草稿。"

### Requirement 3: 草稿查看命令

**User Story:** AS 管理员, I want 用 /draft view 查看当前草稿而不重新生成, so that 避免浪费 AI 调用

#### Acceptance Criteria

1. WHEN 管理员在 Topic 内发送 `/draft view`, the System SHALL 查找该会话最近一条 `ready` 状态的草稿
2. WHEN 找到 ready 草稿, the System SHALL 回复草稿文本（带"不会自动发送"提示）
3. IF 未找到 ready 草稿, the System SHALL 回复"当前没有草稿，使用 /draft 生成。"
4. WHEN 管理员在 Topic 内发送 `/draft`（无参数）, the System SHALL 保持现有行为（重新生成草稿）

### Requirement 4: 草稿过期清理

**User Story:** AS 运维人员, I want 过期草稿被自动清理, so that ai_drafts 表不会无限增长

#### Acceptance Criteria

1. WHILE 消息正文清理定时器运行（复用 MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES 间隔）, the System SHALL 清理 `created_at` 早于 MESSAGE_RETENTION_DAYS 的草稿
2. WHEN 清理草稿, the System SHALL 删除草稿行的 `draft_text` 和 `error` 字段（软清理，保留行用于审计），并将状态为 `pending` 的残留草稿标记为 `failed`
3. IF MESSAGE_RETENTION_DAYS 为 0, the System SHALL 跳过草稿清理（表示永久保留）

### Requirement 5: Stale pending 草稿回收

**User Story:** AS 运维人员, I want 卡在 pending 状态的草稿被自动标记为 failed, so that 进程崩溃残留的草稿不会永远占用 pending 状态

#### Acceptance Criteria

1. WHILE 草稿清理定时器运行, the System SHALL 将 `pending` 状态且 `created_at` 超过 5 分钟的草稿标记为 `failed`，error 字段记录"Draft generation timed out (process may have restarted)"
2. WHEN stale pending 草稿被标记为 failed, the System SHALL 记录一条 warn 日志包含草稿 ID 和会话 ID

### Requirement 6: AI fetch 超时与重试

**User Story:** AS 运维人员, I want AI 接口调用有超时和重试保护, so that 慢响应不会阻塞消息处理主链路

#### Acceptance Criteria

1. WHEN 调用 AI 接口, the System SHALL 设置 15 秒超时（通过 `AbortSignal.timeout(15000)`）
2. IF AI 接口首次调用因超时或 5xx 错误失败, the System SHALL 等待 2 秒后重试一次
3. IF 重试仍失败, the System SHALL 将草稿标记为 `failed` 并返回错误信息
4. IF AI 接口返回 4xx 错误（非 5xx）, the System SHALL 不重试，直接标记为 `failed`
5. WHILE AI fetch 执行, the System SHALL 在 logger 中记录请求耗时和重试次数

### Requirement 7: 草稿状态扩展

**User Story:** AS 开发者, I want 草稿状态包含 sent 和 discarded, so that 能区分已发送、已丢弃和生成失败的草稿

#### Acceptance Criteria

1. WHEN 草稿被发送, the status SHALL 更新为 `sent`
2. WHEN 草稿被丢弃, the status SHALL 更新为 `discarded`
3. WHILE 查询 ready 草稿, the System SHALL 只返回 `status = 'ready'` 的草稿
4. WHILE 统计草稿（metrics 端点）, the System SHALL 按 status 分组计数，包含 sent 和 discarded
