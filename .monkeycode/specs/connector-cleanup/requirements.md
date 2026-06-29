# Requirements Document: Connector Abstraction Cleanup

## Introduction

InboxBridge 的 `src/connectors/` 目录定义了 `Connector` 接口和三个实现（telegram-connector、stub-email-connector、stub-web-connector），但整个目录在 `src/` 内零引用。实际 Telegram 消息流直接使用 grammy ctx（`src/channels/telegram/`），功能远超 connector 接口（支持 copyMessage、媒体处理、Topic 路由、降级策略）。

本功能删除未使用的 connector 抽象层，消除"写了不用"的代码债务。当未来真正需要多渠道接入时，基于实际需求重新设计抽象。

## Glossary

- **Connector 抽象层**：`src/connectors/` 目录，包含 `connector.ts` 接口和三个实现
- **实际消息流**：`src/channels/telegram/` 中直接使用 grammy ctx 的实现

## Requirements

### Requirement 1: 删除未使用的 connector 代码

**User Story:** AS 代码维护者，我希望删除未使用且会误导的抽象层，以便代码库反映实际架构。

#### Acceptance Criteria

1. WHEN 清理执行，the system SHALL 删除 `src/connectors/connector.ts`
2. WHEN 清理执行，the system SHALL 删除 `src/connectors/telegram-connector.ts`
3. WHEN 清理执行，the system SHALL 删除 `src/connectors/stub-email-connector.ts`
4. WHEN 清理执行，the system SHALL 删除 `src/connectors/stub-web-connector.ts`
5. WHEN 清理执行，the system SHALL 删除 `src/connectors/` 目录本身
6. WHEN 清理完成，the system SHALL 无任何文件 import `connectors/` 路径

### Requirement 2: 文档同步

**User Story:** AS 文档读者，我希望架构文档反映实际代码结构，不提及已删除的抽象。

#### Acceptance Criteria

1. WHEN 清理执行，the system SHALL 更新 `docs/architecture.md`，移除对 connector 抽象层的描述
2. WHEN 清理执行，the system SHALL 更新 README 中提及 connector 骨架的措辞，改为"未来扩展方向"而非"已有骨架"

### Requirement 3: 不破坏现有功能

**User Story:** AS 用户，我希望清理后 bot 功能完全不受影响。

#### Acceptance Criteria

1. WHEN 清理完成，the system SHALL 通过 `npm run verify`（check + 25 tests + audit）
2. WHEN 清理完成，the system SHALL 现有 Telegram 消息流（入站、出站、命令、Topic 路由）行为不变
3. WHEN 清理完成，the system SHALL 数据库结构和配置项不受影响

### Requirement 4: 保留多渠道扩展记录

**User Story:** AS 未来开发者，我希望了解多渠道接入是计划方向，但当前未实装。

#### Acceptance Criteria

1. WHEN 清理执行，the system SHALL 在 `docs/architecture.md` 的"未来方向"章节记录"多渠道接入（Email/Web）为后续扩展方向，当前仅 Telegram 渠道"
2. WHEN 清理执行，the system SHALL 不保留任何 stub 代码作为"占位"
