# 08 · 配置项参考

配置由 [runtime/config.ts](../../src/runtime/config.ts) 的 zod schema 统一定义。控制台可编辑的键列在 `editableConfigKeys`，敏感键列在 `sensitiveConfigKeys`。

## 1. 配置来源与优先级

```text
进程环境变量 / Worker [vars]  ← 最高
        ↑ 覆盖
SQLite app_settings（Web 控制台保存）
        ↑ 覆盖
.env 文件（仅当进程环境变量未提供该键）
        ↑ 覆盖
zod schema 默认值
```

- 合并逻辑：`loadConfigFromSources(storedEnv, env=process.env)` 内部 `{ ...storedEnv, ...env }`。
- `.env` 由 `loadEnv` 读取，且**已存在于环境变量的键不会被 `.env` 覆盖**，便于 PM2 / 托管平台覆盖密钥。
- 引导类配置（`DATABASE_URL`、`WEB_CONSOLE_PORT`）通过 `loadDatabaseConfig` 单独解析，无需 Telegram 凭据即可启动控制台。

## 2. 运行必需项

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | string（≥1） | 无（必需） | BotFather 获取的 bot token。敏感项 |
| `TELEGRAM_MANAGEMENT_CHAT_ID` | number | 无（必需） | 开启 Topics 的私密 supergroup ID（通常 `-100` 开头） |
| `TELEGRAM_ADMIN_USER_IDS` | 逗号分隔的数字列表 | `""`（校验要求 ≥1） | 允许代发与执行命令的管理员 Telegram user_id 白名单 |

> 三者齐备是 bot 启动的前提；缺任一项时运行时保持空闲并在控制台展示问题。

## 3. 更新接收方式

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `TELEGRAM_UPDATE_MODE` | `polling` \| `webhook` | `polling` | 更新接收方式。webhook 模式必须提供 URL |
| `TELEGRAM_WEBHOOK_URL` | URL（可空） | 无 | webhook 公网地址，建议路径 `/telegram/webhook` |
| `TELEGRAM_WEBHOOK_SECRET` | string | `""` | webhook 密钥；留空时用 bot token 的 SHA-256 |

## 4. 数据库与控制台

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | string | `file:./data/inboxbridge.sqlite` | SQLite 路径（`file:` 前缀可省略）；Workers 下由 D1 绑定替代 |
| `WEB_CONSOLE_PORT` | number | `3000` | Web 控制台端口（引导项，控制台内不可改） |
| `WEB_CONSOLE_SESSION_SECRET` | string | 无 | 控制台签名会话密钥。Workers 部署必需；Node 部署无需配置——启动时自动生成并持久化到 `app_settings` |

控制台内部持久化键（存于 `app_settings`，非环境变量）：
`WEB_CONSOLE_PASSWORD_HASH`（`salt:scryptHash`）、`WEB_CONSOLE_SETUP_TOKEN`（首次登录令牌）、`WEB_CONSOLE_SESSION_SECRET`（Node 启动时自动生成的签名密钥）。

## 5. 数据保留与自动清理

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `MESSAGE_RETENTION_DAYS` | 正整数 | `30` | 消息正文与 raw payload 保留天数；到期只清内容，保留行与映射 |
| `MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES` | 正整数 | `60` | 消息正文清理扫描间隔（分钟） |
| `DEFAULT_CONVERSATION_RETENTION_DAYS` | 正整数 \| `never`/`none`/`off`/`0` | `30` | 新会话默认销毁天数；以上关键字或 `0` 表示永不自动销毁 |
| `CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES` | 正整数 | `60` | 到期会话扫描间隔（分钟） |

## 6. 限流与投递可靠性

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `RATE_LIMIT_WINDOW_SECONDS` | 正整数 | `60` | 限流统计窗口（秒） |
| `RATE_LIMIT_MAX_MESSAGES` | 正整数 | `20` | 窗口内单用户允许的最大消息数 |
| `DELIVERY_RETRY_INTERVAL_SECONDS` | 正整数 | `30` | 失败投递重试扫描间隔（秒）；实际下限 5 秒 |

投递重试累计上限为 `MAX_DELIVERY_ATTEMPTS = 8`（`deliveries.ts`）——同步重试 3 次 + 后台若干次，超限标记 `permanent_failure`。

## 7. AI 草稿（OpenAI-compatible）

| 变量 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `AI_DRAFTS_ENABLED` | boolean 字符串 | `true` | 全局开关；关闭则无需其余 AI 配置 |
| `OPENAI_COMPATIBLE_BASE_URL` | URL（可空） | 无 | 基础地址，系统请求 `{base}/chat/completions` |
| `OPENAI_COMPATIBLE_API_KEY` | string（可空） | 无 | API Key。敏感项 |
| `OPENAI_COMPATIBLE_MODEL` | string（可空） | 无 | 模型名 |
| `AI_DRAFT_CONTEXT_LIMIT` | 正整数 | `20` | 生成草稿时读取的最近消息条数 |

`isAiConfigured(config)` 要求 `AI_DRAFTS_ENABLED && BASE_URL && API_KEY && MODEL` 全部非空。草稿仅发送到管理 Topic，不自动回复外部用户；单会话可用 `/ai_on`、`/ai_off` 覆盖。

## 8. 敏感键与编辑权限

- **敏感键**（`sensitiveConfigKeys`）：`TELEGRAM_BOT_TOKEN`、`OPENAI_COMPATIBLE_API_KEY`——控制台以密码框渲染、不回显，留空表示保持原值。
- **控制台可编辑**（`editableConfigKeys`）：`TELEGRAM_BOT_TOKEN`、`TELEGRAM_MANAGEMENT_CHAT_ID`、`TELEGRAM_UPDATE_MODE`、`TELEGRAM_WEBHOOK_URL`、`TELEGRAM_ADMIN_USER_IDS`、`MESSAGE_RETENTION_DAYS`、`MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES`、`DEFAULT_CONVERSATION_RETENTION_DAYS`、`CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES`、`RATE_LIMIT_WINDOW_SECONDS`、`RATE_LIMIT_MAX_MESSAGES`、`DELIVERY_RETRY_INTERVAL_SECONDS`、`AI_DRAFTS_ENABLED`、`OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_API_KEY`、`OPENAI_COMPATIBLE_MODEL`、`AI_DRAFT_CONTEXT_LIMIT`。
- **非可编辑**（引导项，仅环境变量）：`DATABASE_URL`、`WEB_CONSOLE_PORT`、`TELEGRAM_WEBHOOK_SECRET`。

## 9. 控制台配置分组

| 分组 slug | 标题 | 包含字段 |
| --- | --- | --- |
| `security` | 访问安全 | 控制台密码 |
| `telegram` | Telegram 基础配置 | Bot Token、管理群 ID、管理员白名单 |
| `runtime` | 运行方式 | `TELEGRAM_UPDATE_MODE`、`TELEGRAM_WEBHOOK_URL` |
| `retention` | 数据保留与自动清理 | 消息保留天数、扫描间隔、默认销毁、过期扫描间隔 |
| `ratelimit` | 限流设置 | 窗口秒数、窗口内最大消息数 |
| `delivery` | 投递可靠性 | 重试扫描间隔 |
| `ai-drafts` | AI 草稿 | 开关、服务地址、API Key、模型、上下文条数 |

## 10. 诊断用环境变量

| 变量 | 说明 |
| --- | --- |
| `TELEGRAM_CHECK_SEND_TEST=true` | `npm run telegram:check` 时向管理群发送测试消息 |
| `TELEGRAM_CHECK_TOPIC_TEST=true` | 创建测试 Topic、发消息并尝试删除 |

`.env.example` 提供了可直接复制的示例（常规部署只保留 `DATABASE_URL` 与 `WEB_CONSOLE_PORT`）。
