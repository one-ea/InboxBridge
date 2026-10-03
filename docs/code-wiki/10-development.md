# 10 · 开发、构建与部署

## 1. 技术栈与工程约束

| 项 | 值 |
| --- | --- |
| Node.js | `>=24`（`engines`，使用内置 `node:sqlite` 与 `--test`） |
| 语言 | TypeScript，ESM（`"type":"module"`），`module`/`moduleResolution` = `NodeNext` |
| 编译 | `tsc` → `dist/`，`rootDir=.`、`outDir=dist`，`include: src/**/*.ts, test/**/*.ts` |
| 严格性 | `strict`、`noUnusedLocals`、`noUnusedParameters` |
| 运行依赖 | `grammy`（Telegram）、`pino`（日志）、`zod`（配置校验） |
| 数据库特性 | 需要 SQLite FTS5 与 `trigram` 分词器（≥ 3.34）；本地 `node:sqlite` 为 3.49，Cloudflare D1 同样基于 3.4x |
| 开发依赖 | `typescript`、`@types/node` |

> 由于 `rootDir` 为项目根，构建产物路径为 `dist/src/...` 与 `dist/test/...`。

## 2. npm 脚本

| 脚本 | 命令 | 说明 |
| --- | --- | --- |
| `dev` | `npm run build && node dist/src/runtime/main.js` | 构建并启动（前台） |
| `start` | `node dist/src/runtime/main.js` | 直接启动已构建产物 |
| `clean` | `rm -rf dist` | 清理构建产物 |
| `build` | `tsc -p tsconfig.json` | 编译 |
| `check` | `tsc -p tsconfig.json --noEmit` | 仅类型检查 |
| `test` | `npm run build && node --test dist/test/*.js` | 编译后运行 `node:test` |
| `verify` | `npm run check && npm test && npm audit` | 类型检查 + 测试 + 安全审计 |
| `migrate` | `npm run build && node dist/src/tools/migrate.js` | 应用幂等迁移 |
| `backup` | `npm run build && node dist/src/tools/backup.js` | 生成一致性快照，`--keep N` 只保留最新 N 份 |
| `retention:cleanup` | `npm run build && node dist/src/tools/retention-cleanup.js` | 手动执行一次保留清理 |
| `telegram:check` | `npm run build && node dist/src/tools/check-telegram.js` | 校验 Telegram token/群/权限 |

## 3. 本地开发流程

```bash
npm ci
npm run migrate       # 初始化数据库
npm run dev           # 构建并启动
```

首次启动日志会输出 setup token：

```text
Open the web console and use this setup token to finish InboxBridge configuration.
```

打开 `http://localhost:3000` → 用 setup token 登录 → 设置控制台密码 → 填写 Bot Token / 管理群 ID / 管理员白名单 → 保存后 bot 自动启动。

## 4. Telegram 前置与诊断

前置条件：

- 管理群必须是私密 `supergroup` 且启用 Forum Topics。
- bot 已加入管理群，并具发送消息、管理 Topics 权限。
- `TELEGRAM_ADMIN_USER_IDS` 填写允许代发/执行命令的数字 user_id。
- 外部用户须先主动联系 bot（不绕过 Telegram 隐私限制）。

诊断：

```bash
npm run telegram:check
TELEGRAM_CHECK_SEND_TEST=true npm run telegram:check     # 真实发送测试
TELEGRAM_CHECK_TOPIC_TEST=true npm run telegram:check    # 建/发/删测试 Topic
```

[check-telegram.ts](../../src/tools/check-telegram.ts) 依次校验：`getMe`、`getChat`（并检查 `supergroup` 与 `is_forum`）、`getChatMember`（`can_manage_topics` 等），再执行可选的发送/Topic 测试。

## 5. 测试

- 测试框架：Node 内置 `node:test`，无需额外依赖。
- 测试按模块拆分（共 99 个用例），共享夹具见 [test/support/harness.ts](../../test/support/harness.ts)：`config.test.ts`（配置）、`storage.test.ts`（迁移、事务、WAL 设置、在线备份与保留策略、D1 适配）、`worker.test.ts`（Workers 运行时与维护任务）、`web-console.test.ts`（控制台鉴权与渲染）、`conversations.test.ts`（会话、搜索、审计）、`telegram.test.ts`（权限、限流、Telegram 辅助）、`ai-drafts.test.ts`（草稿与投递）。
- 运行：

```bash
npm run check
npm test
npm run verify
```

> `npm test` 只编译不清理 `dist/`。删除或重命名测试文件后请先 `npm run clean`，否则旧的编译产物仍会参与 `node --test dist/test/*.js` 并让用例数虚高。

## 6. 数据与备份

- 默认数据库文件：`data/inboxbridge.sqlite`（本地）。
- 数据库使用 WAL 模式，运行期会产生 `-wal` / `-shm` 附属文件，因此**不要直接复制主文件**；用 `npm run backup`（内部走 `backupDatabase()`）生成一致性快照。
- 备份文件与数据库都不要提交到 Git（`data/` 已在 `.gitignore` 中）。
- 迁移幂等，恢复备份后可再次执行 `npm run migrate`。

## 7. 常驻部署

前台验证无误后交给进程管理器：

```bash
npm run build
node dist/src/runtime/main.js
```

PM2 示例：

```bash
pm2 start dist/src/runtime/main.js --name inboxbridge
pm2 save
pm2 logs inboxbridge
```

Serv00 / 本地自托管建议在控制台设置：

```env
TELEGRAM_UPDATE_MODE=polling
AI_DRAFTS_ENABLED=false
```

公网 HTTPS 部署可切换为 webhook 模式并填写 `TELEGRAM_WEBHOOK_URL`（路径建议 `/telegram/webhook`）。

### Cloudflare Workers 部署

入口已配置在 `wrangler.toml`（`main = "src/runtime/worker.ts"`）。部署时需：

1. 创建 D1 数据库并回填 `database_id`。
2. 配置 `WEB_CONSOLE_SESSION_SECRET` 与 Telegram 相关变量（`[vars]` 或 secrets）。
3. 部署后由 Cron `*/15 * * * *` 触发维护任务；Telegram 更新经 `/telegram/webhook` 进入。

详见 [07-workers-runtime.md](./07-workers-runtime.md)。

## 8. 持续集成

[.github/workflows/ci.yml](../../.github/workflows/ci.yml)：在 `pull_request` 与 `push` 到 `main` 时，使用 Node 24 执行

```bash
npm ci
npm run verify   # check + test + npm audit
```

另有 [.github/workflows/codeql.yml](../../.github/workflows/codeql.yml) 做静态安全分析，[.github/dependabot.yml](../../.github/dependabot.yml) 管理依赖更新。

## 9. 常见排障

| 现象 | 排查方向 |
| --- | --- |
| `chat not found` | bot 未加入管理群，或 `TELEGRAM_MANAGEMENT_CHAT_ID` 填错 |
| `not enough rights to create a topic` | bot 非管理员或缺少 Manage Topics 权限 |
| `message thread not found` | Topic 已被删除；系统会在下次来信时自动重建 |
| 管理员回复未外发 | 检查 `TELEGRAM_ADMIN_USER_IDS` 与 BotFather privacy mode |
| 菜单未刷新 | Telegram 客户端缓存，重开聊天或重启客户端 |
| 控制台端口占用 | 修改 `WEB_CONSOLE_PORT` |
| 配置保存后 bot 未启动 | 查看概览页问题列表；三项基础配置必须齐全 |

## 10. 提交前检查

- 不要提交 `data/*.sqlite`、`.env`、bot token、API key 或真实用户数据。
- 建议执行：`git diff --cached` 与 `npm run verify`。
- 许可证：MIT，见仓库根目录 [LICENSE](../../LICENSE)。
