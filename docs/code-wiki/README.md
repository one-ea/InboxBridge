# InboxBridge Code Wiki

> 本目录是 InboxBridge 的项目代码 Wiki，面向开发者，覆盖整体架构、模块职责、关键类与函数、数据模型、配置项、命令与运行方式。
>
> 使用说明类文档（部署、运维、安全）见 [../architecture.md](../architecture.md)、[../operations.md](../operations.md)、[../security.md](../security.md)。

## 项目简介

InboxBridge 是一个**本地自托管、隐私优先的 Telegram 双向沟通中枢**。它把外部用户与 bot 的私聊消息，路由到你自己私密 Telegram Forum 管理群中对应的 Topic；白名单管理员在 Topic 内回复后，消息由 bot 代发回外部用户。

- **技术栈**：Node.js ≥ 24、TypeScript（ESM）、grammY、pino、zod、内置 `node:sqlite`。
- **可部署形态**：Node.js 常驻进程（默认）或 Cloudflare Workers（D1 + Cron + Webhook）。
- **存储**：本地 SQLite（默认 `file:./data/inboxbridge.sqlite`）或 Cloudflare D1。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [01-architecture.md](./01-architecture.md) | 整体架构、分层、依赖方向、双向数据流、可靠性策略 |
| [02-modules.md](./02-modules.md) | 目录/文件级模块职责与模块依赖关系 |
| [03-data-model.md](./03-data-model.md) | 数据库表结构、字段语义、迁移机制 |
| [04-domain-services.md](./04-domain-services.md) | 领域层关键类与函数（会话、投递、AI 草稿、审计、限流等） |
| [05-channels-telegram.md](./05-channels-telegram.md) | Telegram 渠道适配层：更新分发、消息桥接、媒体、Topic、命令 |
| [06-runtime.md](./06-runtime.md) | 运行时入口、配置加载、Web 控制台、定时任务、优雅关停 |
| [07-workers-runtime.md](./07-workers-runtime.md) | Cloudflare Workers 运行时（Fetch / Scheduled / D1） |
| [08-configuration.md](./08-configuration.md) | 全部环境变量与配置项、来源优先级、敏感项 |
| [09-commands.md](./09-commands.md) | 管理群 Topic 内全部管理员命令参考 |
| [10-development.md](./10-development.md) | 构建、测试、迁移、诊断、部署与 CI |

## 快速开始

```bash
npm ci
npm run migrate
npm run dev
```

首次启动会先开启 Web 控制台并在日志输出 setup token。打开 `http://localhost:3000`，用 setup token 登录、设置控制台密码，并填写 Telegram bot token、管理群 ID 与管理员 user_id。保存后 bot 会自动启动。

## 目录总览

```text
src/
├── channels/telegram/   # Telegram 渠道适配层（bot、更新、消息、媒体、Topic、命令、菜单、webhook）
├── domain/              # 业务领域层（会话、投递、重试、AI 草稿、审计、限流、权限、保留/销毁）
├── ports/               # 存储端口抽象（Database / PreparedStatement）
├── storage/             # SQLite / D1 适配、schema 类型、幂等迁移
├── runtime/             # 入口、配置、维护任务、Web 控制台、Workers 运行时
└── tools/               # 部署与诊断脚本（migrate、retention-cleanup、check-telegram）
test/
└── core.test.ts         # node:test 单测（覆盖配置、存储、Workers、控制台、领域服务）
docs/                    # 架构 / 运维 / 安全文档 + 本代码 Wiki
.monkeycode/specs/       # 各功能特性的需求与设计规格（requirements/design）
```

## 关键约定

- **消息默认外发**：管理群 Topic 内的普通消息视为代发内容；以 `/` 开头的文本按管理命令处理，不外发。
- **白名单管理员**：只有 `TELEGRAM_ADMIN_USER_IDS` 中的数字 ID 可代发消息或执行命令；群成员身份不自动等价于 InboxBridge 管理员。
- **Topic 即会话**：一个外部联系人对一个 Topic，映射存于 `telegram_topics` 表；Topic 被删除后下次来信会自动重建。
- **隐私优先**：`MESSAGE_RETENTION_DAYS` 定期清理消息正文与 raw payload；`DEFAULT_CONVERSATION_RETENTION_DAYS` 控制整段会话销毁。
