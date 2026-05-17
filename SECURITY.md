# 安全策略

## 支持范围

当前项目仍处于早期版本，安全修复优先覆盖 `main` 分支。

## 报告安全问题

请不要在公开 Issue 中披露可被利用的安全细节。建议通过 GitHub Security Advisory 私下报告，或联系仓库维护者后再提供复现信息。

报告时请尽量包含：

- 影响范围和触发条件。
- 复现步骤或最小复现样例。
- 可能泄露的数据类型，例如 Telegram 用户信息、消息正文、bot token 或 AI API key。
- 建议修复方向。

## 敏感数据边界

以下内容不得提交到仓库：

- `.env`
- `data/*.sqlite`
- Telegram bot token
- OpenAI-compatible API key
- 私钥、备份文件、真实用户导出数据

## 默认安全姿态

- 外部用户必须先主动联系 bot；项目不尝试绕过 Telegram 隐私限制。
- 管理员代发必须通过 `TELEGRAM_ADMIN_USER_IDS` 白名单。
- AI 草稿只发送到管理 Topic，不自动回复外部用户。
- 会话删除和到期销毁应同步清理 Telegram Topic 与数据库会话数据。
