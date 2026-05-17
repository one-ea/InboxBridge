# InboxBridge

InboxBridge 是一个本地优先的双向沟通 bot。第一版实现 Telegram 私聊入口：
外部用户给 bot 发消息后，消息会进入私密 Telegram Forum 管理群，并为每个外部联系人
创建或复用一个独立 Topic；管理员在对应 Topic 内回复，bot 再代发回外部用户。

## 快速开始

```bash
npm install
cp .env.example .env
npm run telegram:check
npm run migrate
npm run dev
```

本地自托管建议使用 `TELEGRAM_UPDATE_MODE=polling`，不需要公网 HTTPS 入口。
只有在 `TELEGRAM_WEBHOOK_URL` 指向可访问的 HTTPS 地址时，才使用 `webhook` 模式。

## Telegram 要求

- 管理群必须是私密 supergroup，并启用 Forum Topics。
- bot 需要发送消息和管理 topics 的权限。
- `TELEGRAM_ADMIN_USER_IDS` 必须填写允许代发回复的 Telegram 用户 ID。
- 外部用户必须先主动给 bot 发消息；InboxBridge 不绕过 Telegram 的隐私规则。
- 可运行 `npm run telegram:check` 检查 bot token、管理群、Forum Topics 和 bot 权限。

需要实际测试发送权限时：

```bash
TELEGRAM_CHECK_SEND_TEST=true npm run telegram:check
TELEGRAM_CHECK_TOPIC_TEST=true npm run telegram:check
```

第二条会临时创建一个测试 Topic、发送测试消息，然后尝试删除该测试 Topic。

## 常用命令

启动时 InboxBridge 会向 Telegram 注册原生命令菜单。点击输入框旁边的“菜单”
按钮，就能看到下面这些命令和解释；管理命令执行仍然会校验 `TELEGRAM_ADMIN_USER_IDS`
白名单。

管理 Topic 内可用：

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
```

普通消息会默认转发给外部用户；以 `/` 开头的命令只作为管理操作处理。

任意 Telegram 聊天中也可以发送：

```text
/id
```

用于查看当前 `chat_id`、`message_thread_id` 和发送者 ID，方便配置 `.env`。

## Serv00 部署提示

Serv00 建议使用 polling 模式：

```env
TELEGRAM_UPDATE_MODE=polling
AI_DRAFTS_ENABLED=false
DEFAULT_CONVERSATION_RETENTION_DAYS=30
CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES=60
```

首次部署：

```bash
git pull
npm ci
npm run telegram:check
npm run migrate
npm run dev
```

确认前台运行正常后，再用 PM2、daemon 或 `@reboot` cron 做常驻。若 `npm run telegram:check`
显示 `can_manage_topics=false`，请把 bot 提升为管理群管理员并开启 Manage Topics 权限。

## 会话销毁策略

InboxBridge 支持按会话设置销毁时间。销毁时会先删除 Telegram Forum Topic，再清理数据库中的
会话、消息、备注、标签关联、AI 草稿和投递记录。

默认策略由 `.env` 控制：

```env
DEFAULT_CONVERSATION_RETENTION_DAYS=30
CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES=60
```

`DEFAULT_CONVERSATION_RETENTION_DAYS` 可填正整数天数，也可以填 `never` 表示新会话默认不自动销毁。

每个会话可在 Topic 内单独设置：

```text
/expire 7       当前会话 7 天后销毁
/expire 30      当前会话 30 天后销毁
/expire never   当前会话不自动销毁
/expires        查看当前会话销毁策略
```

后台会按 `CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES` 定时扫描到期会话。
