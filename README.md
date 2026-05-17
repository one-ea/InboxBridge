# InboxBridge

InboxBridge 是一个本地优先、隐私优先的双向沟通 bot。当前版本实装 Telegram 私聊入口：
外部用户给 bot 发消息后，消息会进入私密 Telegram Forum 管理群，并为每个外部联系人
创建或复用独立 Topic；白名单管理员在 Topic 内回复，bot 再代发回外部用户。

## 能力概览

- Telegram 私聊与私密 Forum Topic 双向桥接。
- 一个外部联系人对应一个管理 Topic。
- 管理员白名单校验，避免群成员越权代发。
- Telegram 原生命令菜单，支持会话查询、备注、标签、封禁、导出和销毁策略。
- `copyMessage` 失败时自动降级为文本摘要。
- Topic 失效后自动清理旧会话并重建。
- 支持按会话设置销毁策略：例如 7 天、30 天或永不销毁。
- SQLite 本地存储，适合 Serv00、VPS 和本地自托管。

## 快速开始

```bash
npm ci
cp .env.example .env
nano .env
npm run telegram:check
npm run migrate
npm run dev
```

本地自托管和 Serv00 建议使用：

```env
TELEGRAM_UPDATE_MODE=polling
AI_DRAFTS_ENABLED=false
```

## Telegram 要求

- 管理群必须是私密 supergroup，并启用 Forum Topics。
- bot 必须加入管理群，并具备发送消息和管理 topics 的权限。
- `TELEGRAM_ADMIN_USER_IDS` 必须填写允许代发回复的 Telegram 数字 ID。
- 外部用户必须先主动给 bot 发消息；InboxBridge 不绕过 Telegram 隐私规则。

可运行以下命令检查配置：

```bash
npm run telegram:check
TELEGRAM_CHECK_SEND_TEST=true npm run telegram:check
TELEGRAM_CHECK_TOPIC_TEST=true npm run telegram:check
```

## 管理命令

启动时 InboxBridge 会向 Telegram 注册原生命令菜单。点击输入框旁边的“菜单”按钮，
即可看到命令和解释；管理命令仍会校验 `TELEGRAM_ADMIN_USER_IDS` 白名单。

```text
/info                             汇总联系人、会话、Topic 和负责人信息
/profile                          查看联系人资料
/status                           查看会话状态
/expire <天数|never>              设置当前会话销毁策略
/expires                          查看当前会话销毁策略
/whoami                           查看你的 Telegram 管理员 ID
/history [数量]                   查看最近消息摘要，默认 10，最多 30
/note <内容>                      保存内部备注，不会外发
/notes [数量]                     查看最近内部备注，默认 5，最多 20
/tag <标签>                       添加标签
/untag <标签>                     移除标签
/tags                             列出当前会话标签
/priority low|normal|high|urgent  设置优先级
/assign <telegram_user_id>        分配负责人
/close                            关闭会话；用户再发消息会自动重开
/reopen 或 /open                  重新打开会话
/mute <时长，例如 2h>             静音提醒
/ban [原因]                       封禁联系人
/unban                            解除封禁
/delete confirm                   删除当前 Topic 并清理数据库会话信息
/draft                            重新生成 AI 草稿，不会自动发送
/export                           导出当前会话最近 200 条消息 JSON
/id                               查看当前 chat、Topic 和用户 ID
```

普通消息会默认转发给外部用户；以 `/` 开头的命令只作为管理操作处理。

## 会话销毁策略

默认策略由 `.env` 控制：

```env
DEFAULT_CONVERSATION_RETENTION_DAYS=30
CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES=60
```

`DEFAULT_CONVERSATION_RETENTION_DAYS` 可填正整数天数，也可以填 `never` 表示新会话默认不自动销毁。

每个会话可在 Topic 内单独设置：

```text
/expire 7
/expire 30
/expire never
/expires
```

销毁时会先删除 Telegram Forum Topic，再清理数据库中的会话、消息、备注、标签关联、AI 草稿和投递记录。

## 更多文档

- [架构说明](docs/architecture.md)
- [运维手册](docs/operations.md)
- [安全与隐私](docs/security.md)
