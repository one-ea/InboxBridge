# Serv00 部署（Node 常驻形态）

本文档描述如何把 InboxBridge 部署到 [Serv00](https://www.serv00.com/)（FreeBSD 免费虚拟主机）。Serv00 使用 **Node 常驻进程**形态，与本地/VPS 部署共用同一入口 `dist/src/runtime/main.js`。

> 项目依赖全部是纯 JS（grammy / pino / zod），SQLite 用 Node 内置的 `node:sqlite`，**不需要编译工具链**，这一点对 Serv00 这类共享主机很重要。

## 0. 前置条件

1. 已在 Serv00 注册账号，并能用 SSH 登录（`ssh <用户名>@s<N>.serv00.com`，主机号见欢迎邮件）。
2. 在 DevilWeb 面板中开启 **Additional services → Run your own applications → Enabled**。不开启则家目录下的文件无法添加可执行权限，进程起不来。
3. 在面板 **Port reservation** 中保留一个 TCP 端口，记为 `<PORT>`。Serv00 不能随意绑定端口，必须用面板分配的端口。

## 1. 切换到 Node.js 24

Serv00 预装了多个 Node 版本（`node16`…`node26`）。项目要求 **Node ≥ 24**。以下命令来自 Serv00 官方文档，把默认的 `node`/`npm` 指向 v24：

```bash
mkdir -p ~/bin
ln -fs /usr/local/bin/node24 ~/bin/node
ln -fs /usr/local/bin/npm24 ~/bin/npm
source $HOME/.bash_profile

node -v   # 应输出 v24.x
```

### 校验内置 SQLite（必做）

`node:sqlite` 是硬依赖，缺少则程序无法启动：

```bash
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(':memory:'); db.exec(\"CREATE VIRTUAL TABLE t USING fts5(x, tokenize='trigram')\"); console.log('node:sqlite + FTS5 trigram OK');"
```

输出 `node:sqlite + FTS5 trigram OK` 才能继续；若报 `Cannot find module 'node:sqlite'`，说明该 FreeBSD 构建未包含 SQLite 模块，需要换用其它 Node 版本或改用其它部署形态。

## 2. 获取代码并构建

```bash
cd ~/domains/<你的域名>        # 或任意自有目录
git clone https://github.com/one-ea/InboxBridge.git inboxbridge
cd inboxbridge
npm ci
npm run migrate
```

`npm run migrate` 会创建 schema、`messages_fts` 全文索引与同步触发器。迁移是幂等的，可重复执行。

## 3. 启动一次，完成控制台配置

```bash
WEB_CONSOLE_PORT=<PORT> npm run dev
```

日志会输出 setup token：

```text
{"level":30,...,"setupToken":"<token>","msg":"Open the web console and use this setup token to finish InboxBridge configuration."}
```

用浏览器打开 `http://<你的域名>:<PORT>`，用该 token 登录 → 设置控制台密码 → 填写 Bot Token、管理群 ID、管理员 user_id。保存后 bot 会自动启动。

Serv00 建议在控制台里同时设置：

```env
TELEGRAM_UPDATE_MODE=polling
AI_DRAFTS_ENABLED=false
```

> **关于控制台暴露面**：控制台监听 `0.0.0.0:<PORT>`，即保留端口对公网可达。它已有密码保护 + 登录限流（默认 300 秒 / 10 次），但仍是公网入口。若不希望长期暴露，可在配置完成后通过防火墙规则限制访问来源，或只在需要改配置时临时启动。

先按 `Ctrl+C` 停掉前台进程，确认无误后再交给进程管理器。

## 4. 用 PM2 常驻

Serv00 可用 PM2 管理常驻进程（社区有一键安装脚本，也可自行 `npm i -g pm2`）。安装后路径通常为 `~/.npm-global/bin/pm2`：

```bash
~/.npm-global/bin/pm2 start dist/src/runtime/main.js \
  --name inboxbridge \
  --cwd ~/domains/<你的域名>/inboxbridge
~/.npm-global/bin/pm2 save
~/.npm-global/bin/pm2 logs inboxbridge
```

环境变量有两种给法，任选其一：

- 在项目根目录写 `.env`（shell 变量优先级高于 `.env`，见 [08-configuration.md](./code-wiki/08-configuration.md)）；
- 或写入 `~/.bashrc` 后重启进程。

至少需要：

```env
DATABASE_URL=file:./data/inboxbridge.sqlite
WEB_CONSOLE_PORT=<PORT>
```

### 开机/掉线自启

Serv00 会回收长期空闲的进程，用 crontab 做保活（`crontab -e`）：

```cron
@reboot ~/.npm-global/bin/pm2 resurrect
*/5 * * * * ~/.npm-global/bin/pm2 resurrect >/dev/null 2>&1
```

> Serv00 要求每 3 个月至少登录一次面板或 SSH，否则账号可能被回收。

### 日志轮转

PM2 日志默认无限增长，长期运行会占满 Serv00 的 3GB 配额。安装官方轮转模块：

```bash
~/.npm-global/bin/pm2 install pm2-logrotate
~/.npm-global/bin/pm2 set pm2-logrotate:max_size 10M
~/.npm-global/bin/pm2 set pm2-logrotate:retain 7
```

### 维护定时任务

会话过期清理、消息正文保留清理和投递重试三组定时器**已在进程内运行**，不要再挂 cron 调 `npm run retention:cleanup`，否则会和进程内任务重复执行。

## 5. 验证

```bash
# 健康检查：Bot 运行中 + DB 可达时返回 200，否则 503
curl -s http://127.0.0.1:<PORT>/healthz

# Telegram 侧权限自检
npm run telegram:check
```

然后用外部测试账号私聊 bot，管理群应自动出现对应 Topic；白名单管理员在 Topic 内发普通消息即可代发给外部用户。

## 6. 备份

数据库使用 WAL 模式，运行期间会产生 `-wal` 与 `-shm` 附属文件，**最近的提交还在 `-wal` 里**。因此运行中直接复制 `data/inboxbridge.sqlite` 拿到的可能是不完整快照，请用内置的在线备份命令：

```bash
# 默认写入 <数据库目录>/backups/inboxbridge-<时间戳>.sqlite
npm run backup

# 也可以指定输出路径
npm run backup -- /path/to/snapshot.sqlite
```

该命令走 SQLite 在线备份 API，**进程无需停止**，产出的快照自带一致性（恢复时不需要 `-wal`/`-shm`）。文件名使用 UTC 时间戳、精确到毫秒，同一秒内多次执行也不会互相覆盖。

### 保留策略

`--keep N` 在备份完成后只保留最新的 N 份快照，更旧的会被删除：

```bash
npm run backup -- --keep 14        # 保留最新 14 份
npm run backup -- --keep=14        # 等号写法同样有效
```

四点行为约定：

- 只删除文件名符合 `inboxbridge-<UTC 时间戳>.sqlite` 规则的快照，**备份目录里的其它文件不会被碰**；
- 刚生成的那份快照永远保留，即使系统时钟回拨让它看起来是最旧的；
- 单个文件删除失败只打印告警并保留文件，不影响备份本身是否成功；
- 保留策略作用于「新快照所在目录」，且只统计符合命名规则的历史快照。若你用了自定义文件名（如 `npm run backup -- /path/custom.sqlite --keep 3`），这一份不计入保留数量，也永远不会被删除。

不加 `--keep` 时不会删除任何文件。定期备份可配合保留策略交给 crontab：

```cron
0 4 * * * cd ~/domains/<你的域名>/inboxbridge && npm run backup -- --keep 14 >> ~/inboxbridge-backup.log 2>&1
```

`~/inboxbridge-backup.log` 每次只追加一行，可随备份文件一起清理。

恢复步骤：停止进程 → 用备份文件替换 `data/inboxbridge.sqlite`（同时删除残留的 `-wal`/`-shm`）→ 重跑幂等迁移：

```bash
npm run migrate
```

不要把数据库文件或备份目录提交到 Git。

## 7. 排错

| 现象 | 排查方向 |
| --- | --- |
| 进程启动即退出 | 确认已开启 Run your own applications；确认 `node -v` 为 v24+ |
| `Cannot find module 'node:sqlite'` | 该 Node 构建无 SQLite 模块，换版本或换部署形态 |
| 端口被占用 / 无法绑定 | 必须使用面板保留的端口，且未被其它进程占用 |
| `chat not found` | bot 未加入管理群，或 `TELEGRAM_MANAGEMENT_CHAT_ID` 填错 |
| `not enough rights to create a topic` | bot 非管理员或缺少 Manage Topics 权限 |
| 管理员回复未外发 | 检查 `TELEGRAM_ADMIN_USER_IDS` 与 BotFather privacy mode |
| 进程过一阵子就没了 | 保活 cron 未生效；检查 `pm2 logs` 与 Serv00 的资源限制 |

## 相关文档

- [Cloudflare Workers 部署](./deploy-cloudflare.md)
- [配置项参考](./code-wiki/08-configuration.md)
- [运维手册](./operations.md) · [安全与隐私](./security.md)
