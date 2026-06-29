# 安全与隐私

## 不应提交的内容

- `data/*.sqlite`
- `.env`
- Telegram bot token
- OpenAI-compatible API key
- 私钥、备份文件、真实用户导出数据

`.gitignore` 已忽略这些常见路径，但提交前仍建议执行：

```bash
git diff --cached
npm audit
```

## 管理员白名单

只有 `TELEGRAM_ADMIN_USER_IDS` 中的 Telegram 数字 ID 可以在管理群 Topic 内代发消息或执行管理命令。群管理员身份本身不等于 InboxBridge 管理员。

## 删除与销毁

- `/delete confirm` 会删除当前 Topic，并清理数据库中的会话、消息、备注、标签关联、AI 草稿和投递记录。
- `/expire <天数|never>` 设置单个会话销毁策略。
- 到期销毁会先删除 Telegram Topic，再删除数据库内容。
- 联系人身份会保留，以维护封禁状态和基本身份映射。

## AI 草稿

AI 草稿只发送到管理 Topic，不会自动回复外部用户。开启前请确认供应商、网关和日志策略满足你的隐私要求。
