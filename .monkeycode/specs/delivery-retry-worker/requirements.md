# Requirements Document: Delivery Retry Worker

## Introduction

InboxBridge 当前的出站消息投递在内存内同步重试 3 次，失败后写入 `deliveries` 表并标记 `status='failed'`、`next_retry_at` 按指数退避计算。但 `deliveries.dueFailed()` 查询方法已实现却无任何运行时代码消费它，导致失败消息永久停留在数据库中，不会被再次投递。

本功能补齐一个后台定时 worker，周期性消费到期失败的出站投递记录，重新尝试发送，达到最大重试次数后在对应管理 Topic 通知管理员。

## Glossary

- **出站投递**：管理员在管理群 Topic 内回复，bot 代发给外部用户的消息
- **Delivery**：`deliveries` 表的一行记录，追踪单条消息的投递状态
- **dueFailed**：`status='failed'` 且 `next_retry_at <= now` 的投递记录
- **attemptCount**：已重试次数，初始为同步阶段写入的值（当前固定为 3）
- **maxAttempts**：本功能定义的最大重试上限，值为 8（含初始 3 次同步重试 + 5 次异步重试）

## Requirements

### Requirement 1: 定时消费失败投递

**User Story:** AS 系统维护者，我希望 bot 运行时自动重试失败的出站投递，以便临时网络故障不会导致消息永久丢失。

#### Acceptance Criteria

1. WHEN bot 运行时启动，the system SHALL 启动一个定时器，以固定间隔（默认 30 秒）扫描 `dueFailed` 投递记录
2. WHEN 定时器触发，the system SHALL 调用 `DeliveryService.dueFailed()` 获取所有到期的失败投递
3. WHILE 定时器正在处理一批投递，the system SHALL 串行处理每条记录，避免并发投递同一消息
4. WHEN `dueFailed` 返回空列表，the system SHALL 跳过本轮处理，不产生额外开销

### Requirement 2: 重新投递失败消息

**User Story:** AS 管理员，我希望失败的出站消息在后续被自动重新发送，以便我的回复最终能送达外部用户。

#### Acceptance Criteria

1. WHEN worker 取到一条 dueFailed 投递，the system SHALL 通过 `source_message_id` 查询 `messages` 表获取原始消息内容
2. WHEN 原始消息存在且包含 `external_message_id`，the system SHALL 解析 `target` 字段获取目标 chatId，调用 Telegram API 重新发送
3. WHEN 重新发送成功，the system SHALL 调用 `markSent(deliveryId)` 更新投递状态为 sent
4. WHEN 重新发送失败，the system SHALL 调用 `markFailed(deliveryId, error, attemptCount + 1)` 记录错误并计算下一次退避时间
5. IF 原始消息已被清理（`text` 和 `raw_payload` 均为 NULL），the system SHALL 将投递标记为永久失败，不进行重试

### Requirement 3: 重试上限与永久失败处理

**User Story:** AS 系统维护者，我希望失败投递有明确的重试上限，以便资源不会被无限占用。

#### Acceptance Criteria

1. WHEN 投递的 `attemptCount` 达到 8，the system SHALL 停止重试该投递，将状态更新为 `permanent_failure`
2. WHEN 投递被标记为永久失败，the system SHALL 在对应管理 Topic 发送一条提示消息，内容包含失败原因和原始消息摘要
3. IF 永久失败投递对应的 Topic 已不存在，the system SHALL 仅记录日志，不抛出异常

### Requirement 4: 配置化扫描间隔

**User Story:** AS 部署者，我希望能够调整 worker 的扫描间隔，以便在不同硬件环境下平衡及时性和资源消耗。

#### Acceptance Criteria

1. WHEN bot 启动，the system SHALL 读取 `DELIVERY_RETRY_INTERVAL_SECONDS` 配置项（默认 30）作为扫描间隔
2. WHEN 配置值小于 5，the system SHALL 使用默认值 30 并记录一条 warning 日志
3. WHEN bot 关闭，the system SHALL 清除定时器，避免进程退出时残留定时器

### Requirement 5: 可观测性

**User Story:** AS 系统维护者，我希望 worker 的运行状态可观测，以便排查投递异常。

#### Acceptance Criteria

1. WHEN worker 每轮扫描完成，the system SHALL 记录一条 debug 日志，包含本轮处理的投递数量
2. WHEN 单条投递重试成功，the system SHALL 记录一条 info 日志，包含 deliveryId 和 attemptCount
3. WHEN 单条投递重试失败，the system SHALL 记录一条 warn 日志，包含 deliveryId、attemptCount 和错误信息
4. WHEN 投递被标记为永久失败，the system SHALL 记录一条 error 日志
