# InboxBridge

InboxBridge 是一个本地优先的双向沟通 bot。第一版实现 Telegram 私聊入口：
外部用户给 bot 发消息后，消息会进入私密 Telegram Forum 管理群，并为每个外部联系人
创建或复用一个独立 Topic；管理员在对应 Topic 内回复，bot 再代发回外部用户。

## 快速开始

```bash
npm install
cp .env.example .env
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

## 常用命令

管理 Topic 内可用：

```text
/profile
/status
/note <内容>
/tag <标签>
/untag <标签>
/priority low|normal|high|urgent
/assign <telegram_user_id>
/ban [原因]
/unban
/close
/reopen
/mute <时长，例如 2h>
/draft
/export
```

普通消息会默认转发给外部用户；以 `/` 开头的命令只作为管理操作处理。
