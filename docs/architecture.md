# 架构说明

InboxBridge 的目标是做一个隐私优先的双向沟通中枢。当前版本实装 Telegram 私聊入口，并把每个外部联系人映射到私密 Telegram Forum 管理群中的独立 Topic。

## 数据流

```text
外部用户私聊 bot
  -> Telegram update
  -> 联系人与会话映射
  -> 创建或复用 Forum Topic
  -> copyMessage / 降级文本摘要
  -> 管理群 Topic

管理员在 Topic 回复
  -> 白名单校验
  -> copyMessage / 降级文本摘要
  -> 外部用户私聊
```

## 主要模块

- `src/runtime/`：运行时入口、配置加载和 Web 控制台。
- `src/channels/telegram/`：Telegram bot 适配层，包含更新处理、菜单注册、Topic 管理和消息复制。
- `src/domain/`：业务核心，包括控制台配置、会话、投递记录、限流、AI 草稿、过期销毁。
- `src/connectors/`：跨渠道 connector 接口和 Telegram、Email、Web Chat 适配骨架。
- `src/storage/`：SQLite 连接、schema 类型和幂等迁移。
- `src/tools/`：部署和诊断脚本。

## 可靠性策略

- Telegram `copyMessage` 失败时，自动降级为文本摘要。
- Topic 被删除或失效时，下一次用户来信会清理旧会话并重建新 Topic。
- 到期会话销毁时，先删除 Telegram Topic，再清理数据库会话数据。
- SQLite 保存 Web 控制台配置，shell 环境变量优先，方便 PM2/托管平台覆盖配置。

## 隐私边界

- 不尝试绕过 Telegram 隐私限制，外部用户必须先主动联系 bot。
- 管理员代发必须通过 `TELEGRAM_ADMIN_USER_IDS` 白名单。
- SQLite 数据库、`.env` 和构建产物都不进入 Git。
- `MESSAGE_RETENTION_DAYS` 清理消息正文和 raw payload；`DEFAULT_CONVERSATION_RETENTION_DAYS` 控制完整会话销毁。
