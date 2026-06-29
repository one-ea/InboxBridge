# Requirements Document

## Introduction

InboxBridge 的 Web 控制台当前只有配置编辑功能，缺少运维视图。运维人员必须进 Telegram 翻 Topic 才能看会话状态，失败投递没有可视化入口只能 SQL 查库，没有消息量趋势无法判断 bot 是否正常工作。本功能在 Web 控制台新增三个运维页面：会话列表、失败投递队列、消息统计概览，使运维人员能在浏览器内完成日常监控和干预。

## Glossary

- **Operations dashboard**: Web 控制台中的运维视图区域，包含会话列表、投递队列、统计概览。
- **Conversation list**: 分页展示所有会话的列表，支持按状态筛选。
- **Delivery queue**: 失败投递（status=failed 或 permanent_failure）的列表视图。
- **Stats overview**: 消息计数、投递状态分布、会话活跃度的聚合卡片。
- **Manual retry**: 运维人员在 Web 端手动触发某条失败投递的重试。

## Requirements

### Requirement 1: 运维导航入口

**User Story:** AS 运维人员, I want 在控制台顶部有运维视图入口, so that 能快速切换到会话列表和投递监控

#### Acceptance Criteria

1. WHEN 已登录用户访问控制台首页, the Web Console SHALL 在顶部导航栏显示"配置"和"运维"两个入口
2. WHEN 用户点击"运维"入口, the Web Console SHALL 跳转到 `/operations` 页面
3. WHILE 显示运维页面, the Web Console SHALL 在侧边栏显示"概览"、"会话"、"投递"三个子导航

### Requirement 2: 统计概览页

**User Story:** AS 运维人员, I want 在概览页看到关键指标卡片, so that 一眼判断系统是否正常

#### Acceptance Criteria

1. WHEN 用户访问 `/operations` 或 `/operations/overview`, the Web Console SHALL 显示统计概览页
2. WHILE 显示概览页, the Web Console SHALL 展示以下卡片：消息总量（入站/出站）、投递状态分布（pending/sent/failed/permanent_failure）、会话状态分布（open/closed）、AI 草稿状态分布（pending/ready/failed/sent/discarded）、进程运行时长
3. WHEN 统计数据查询失败, the Web Console SHALL 在对应卡片位置显示"数据不可用"而非空白
4. WHILE 展示投递状态, the Web Console SHALL 对 failed 和 permanent_failure 数量用警示色高亮（非零时）

### Requirement 3: 会话列表页

**User Story:** AS 运维人员, I want 在 Web 端查看所有会话列表, so that 不用进 Telegram 翻 Topic

#### Acceptance Criteria

1. WHEN 用户访问 `/operations/conversations`, the Web Console SHALL 显示会话列表页
2. WHILE 显示会话列表, the Web Console SHALL 展示每条会话的：Topic 名称、联系人显示名、状态（open/closed）、优先级、负责人、最后消息时间、创建时间
3. WHEN 会话数量超过 50 条, the Web Console SHALL 分页展示，每页 50 条，底部显示分页导航
4. WHEN 用户点击状态筛选器（全部/open/closed）, the Web Console SHALL 按筛选条件重新查询并展示
5. WHILE 排序会话列表, the Web Console SHALL 默认按最后消息时间倒序排列（最新的在前）

### Requirement 4: 失败投递队列页

**User Story:** AS 运维人员, I want 在 Web 端查看失败投递队列, so that 能发现积压的未投递消息

#### Acceptance Criteria

1. WHEN 用户访问 `/operations/deliveries`, the Web Console SHALL 显示失败投递队列页
2. WHILE 显示投递队列, the Web Console SHALL 展示每条失败投递的：ID、目标、状态（failed/permanent_failure）、尝试次数、最后错误、创建时间、下次重试时间
3. WHEN 投递状态为 failed, the Web Console SHALL 在该行显示"重试"按钮
4. WHEN 用户点击"重试"按钮, the Web Console SHALL 将该投递的 next_retry_at 重置为当前时间，触发 worker 在下次扫描时立即重试
5. WHEN 手动重试触发后, the Web Console SHALL 回复确认消息并刷新列表
6. WHILE 排序投递队列, the Web Console SHALL 默认按创建时间正序排列（最早的在前）

### Requirement 5: 运维数据查询方法

**User Story:** AS 开发者, I want Domain Service 提供分页查询方法, so that Web 控制台能高效获取运维数据

#### Acceptance Criteria

1. WHEN Web 控制台请求会话列表, the ConversationService SHALL 提供 `listConversations(options: { status?: string; limit: number; offset: number })` 方法，返回会话列表和总数
2. WHEN Web 控制台请求失败投递列表, the DeliveryService SHALL 提供 `listFailedDeliveries(options: { limit: number; offset: number })` 方法，返回失败投递列表和总数
3. WHEN Web 控制台请求手动重试, the DeliveryService SHALL 提供 `scheduleRetry(deliveryId: number)` 方法，将 next_retry_at 重置为当前时间
4. WHILE 执行分页查询, the Domain Service SHALL 使用 LIMIT 和 OFFSET，避免全表加载

## Data Models

无新增数据库表。运维视图完全基于现有 `conversations`、`deliveries`、`messages`、`ai_drafts` 表的查询。

## Non-Functional Requirements

### Requirement 6: 查询性能

1. WHILE 会话列表查询, the Domain Service SHALL 使用 `conversations` 表的 `last_message_at` 索引排序
2. WHILE 失败投递查询, the Domain Service SHALL 使用 `deliveries` 表的 `status` 索引筛选
3. WHEN 运维页面加载, the Web Console SHALL 在 2 秒内返回完整 HTML（含数据查询）

## References

- 现有 Web 控制台：`src/runtime/web-console.ts`
- 现有 Domain Service：`src/domain/conversations.ts`、`src/domain/deliveries.ts`
- 稳定性地基的 metrics 方法：本批次 stability-foundation 功能
