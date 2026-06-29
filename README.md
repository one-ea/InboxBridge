# InboxBridge

一个本地自托管、隐私优先的 Telegram 双向沟通中枢。

InboxBridge 面向“私信太多、又不想开放个人 Telegram 私聊”的场景：外部用户只需要私聊 bot，消息会被送入你的私密 Telegram Forum 管理群；每个外部联系人都会对应一个独立 Topic。白名单管理员在 Topic 内直接回复，bot 再把消息代发回外部用户。

> 项目仍处于早期版本，当前核心入口是 Telegram；Email、Web Chat 等渠道为后续扩展方向。

## 项目定位

- **替代个人私信入口**：把对外沟通收敛到 bot，减少暴露个人账号的需要。
- **团队共享收件箱**：多个白名单管理员可以在同一个私密 Forum 群里处理不同用户会话。
- **Topic 即会话**：一个外部联系人对应一个 Telegram Topic，天然适合跟进、备注、标签和导出。
- **隐私优先自托管**：SQLite 本地存储，默认 30 天清理消息内容，并支持按会话设置销毁策略。
- **可运营可扩展**：内置封禁、限流、备注、标签、优先级、负责人、AI 草稿和 Telegram 原生命令菜单。

## 工作方式

```text
外部用户私聊 bot
  -> InboxBridge 保存联系人和会话
  -> 创建或复用私密管理群 Topic
  -> 消息进入对应 Topic

白名单管理员在 Topic 回复
  -> InboxBridge 校验管理员 user_id
  -> bot 代发给外部用户
```

普通消息默认外发；以 `/` 开头的内容作为管理命令处理，不会直接发给用户。

## 核心能力

- Telegram 私聊与私密 Forum Topic 双向桥接。
- 每个外部联系人自动创建或复用独立 Topic。
- Telegram 原生命令菜单，无需额外 `/help`。
- 白名单管理员机制，群成员不等于可代发管理员。
- 文本、图片、视频、语音、音频、文件等常见 Telegram 消息复制转发。
- `copyMessage` 失败时自动降级为文本摘要。
- Topic 被管理员删除后，下次用户来信自动清理旧映射并重建会话。
- 会话可设置 7 天、30 天、永不销毁等不同策略。
- OpenAI-compatible AI 草稿只发到管理 Topic，不会自动回复用户。
- SQLite 本地存储，适合 Serv00、VPS、本地小主机和单实例自托管。

## 快速开始

```bash
npm ci
npm run migrate
npm run dev
```

首次启动会开启 Web 控制台并在日志输出 setup token。打开 `http://localhost:3000`，使用 setup token 登录，设置控制台密码，然后填写 Telegram bot token、管理群 ID 和管理员 user_id。常规部署无需 `.env`；`DATABASE_URL` 和 `WEB_CONSOLE_PORT` 都有默认值，可按需覆盖。

Serv00 或本地自托管通常在控制台中使用：

```env
TELEGRAM_UPDATE_MODE=polling
AI_DRAFTS_ENABLED=false
```

启动后，用外部测试账号私聊 bot；管理群会自动出现对应 Topic。白名单管理员在该 Topic 里发送普通消息，即可代发给外部用户。

## Wiki

完整使用说明请从 Wiki 入口开始：

- [Wiki 首页](https://github.com/one-ea/InboxBridge/wiki)：项目介绍、适用场景和文档导航。
- [完整部署指南](https://github.com/one-ea/InboxBridge/wiki/Deployment)：从 BotFather、Telegram 群权限到启动验证的全流程。
- [Serv00 部署指南](https://github.com/one-ea/InboxBridge/wiki/Serv00)：Serv00 / FreeBSD 环境下的 npm、构建、常驻运行和常见错误处理。
- [配置说明](https://github.com/one-ea/InboxBridge/wiki/Configuration)：逐项解释控制台配置和环境变量覆盖项，包含销毁策略、限流和 AI 草稿。
- [管理命令手册](https://github.com/one-ea/InboxBridge/wiki/Commands)：Topic 内全部白名单管理员命令。
- [排障手册](https://github.com/one-ea/InboxBridge/wiki/Troubleshooting)：常见 Telegram、npm、权限和 Topic 问题。

补充资料：

- [架构说明](docs/architecture.md)
- [运维手册](docs/operations.md)
- [安全与隐私](docs/security.md)

## Telegram 前置要求

- 管理群必须是私密 `supergroup`，并启用 Forum Topics。
- bot 必须加入管理群，并具备发送消息和管理 topics 的权限。
- `TELEGRAM_ADMIN_USER_IDS` 必须填写允许代发和执行命令的 Telegram 数字 user_id。
- 外部用户必须先主动联系 bot；InboxBridge 不绕过 Telegram 私信隐私限制。

权限检查：

```bash
npm run telegram:check
TELEGRAM_CHECK_SEND_TEST=true npm run telegram:check
TELEGRAM_CHECK_TOPIC_TEST=true npm run telegram:check
```

## 会话销毁策略

默认策略由 Web 控制台控制，也可用环境变量覆盖：

```env
DEFAULT_CONVERSATION_RETENTION_DAYS=30
CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES=60
```

- `DEFAULT_CONVERSATION_RETENTION_DAYS`：新会话默认多少天后销毁；可填 `never` 表示默认永不自动销毁。
- `CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES`：运行中的 bot 多久扫描一次到期会话；默认 `60` 表示约每小时检查一次。

单个会话可在 Topic 内覆盖：

```text
/expire 7
/expire 30
/expire never
/expires
```

到期销毁会先删除 Telegram Forum Topic，再清理数据库中的该会话、消息、备注、标签关联、AI 草稿和投递记录。

## 开发与验证

```bash
npm run check
npm test
npm run verify
```

当前项目使用 Node.js 24+、TypeScript、grammY 和 SQLite。构建产物、数据库和 `.env` 都已加入 Git 忽略；提交前仍建议检查差异，避免误提交真实 token、API key 或用户数据。

## 许可证

当前仓库尚未附带开源许可证文件。公开分发或商用前，请先补充明确许可证。
