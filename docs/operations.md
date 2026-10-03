# 运维手册

## 首次部署

```bash
npm ci
npm run migrate
npm run dev
```

首次启动时，程序会先启动 Web 控制台并在日志输出 setup token。打开 `http://localhost:3000`，使用 setup token 登录，设置控制台密码并填写 Telegram 配置。保存后 bot 会自动启动或重启。配置完成后再执行：

```bash
npm run telegram:check
```

Serv00 建议在控制台中使用：

```env
TELEGRAM_UPDATE_MODE=polling
AI_DRAFTS_ENABLED=false
```

## 常用命令

```bash
# 编译 TypeScript
npm run build

# 类型检查
npm run check

# 编译并运行 node:test
npm test

# 依次执行类型检查、测试和安全审计
npm run verify

# 应用幂等数据库迁移
npm run migrate

# 生成一致性数据库快照（进程运行中也可执行）
npm run backup

# 手动补跑过期消息清理（进程内已有定时任务，通常无需手动执行）
npm run retention:cleanup

# 检查 Telegram token、群和权限
npm run telegram:check
```

真实测试 Telegram 发送权限：

```bash
TELEGRAM_CHECK_SEND_TEST=true npm run telegram:check
TELEGRAM_CHECK_TOPIC_TEST=true npm run telegram:check
```

第二条会临时创建测试 Topic、发送测试消息，然后尝试删除该 Topic。

## 常驻运行

前台确认无误后再交给进程管理器：

```bash
npm run build
node dist/src/runtime/main.js
```

如果使用 PM2：

```bash
pm2 start dist/src/runtime/main.js --name inboxbridge
pm2 save
pm2 logs inboxbridge
```

### 日志轮转

PM2 日志默认无限增长，长期运行会占满磁盘配额。安装官方轮转模块：

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

### 维护定时任务

会话过期清理、消息正文保留清理和投递重试三组定时器**已在进程内运行**，不要再挂 cron 调 `npm run retention:cleanup`，否则会和进程内任务重复执行。该命令只用于手动补跑（例如调整 `MESSAGE_RETENTION_DAYS` 后想立即生效）。

## 备份

数据库使用 WAL 模式，运行期间会产生 `-wal` 与 `-shm` 附属文件，**最近的提交还在 `-wal` 里**。所以运行中直接复制 `data/inboxbridge.sqlite` 拿到的可能是不完整快照，请用内置的在线备份命令：

```bash
# 默认写入 <数据库目录>/backups/inboxbridge-<时间戳>.sqlite
npm run backup

# 也可以指定输出路径
npm run backup -- /path/to/snapshot.sqlite
```

该命令走 SQLite 在线备份 API，**进程无需停止**，产出的快照自带一致性（恢复时不需要 `-wal`/`-shm`）。

定期备份可用 crontab，注意保留策略以免占满磁盘：

```cron
0 4 * * * cd /path/to/inboxbridge && npm run backup >> ~/inboxbridge-backup.log 2>&1
```

恢复步骤：停止进程 → 用备份文件替换 `data/inboxbridge.sqlite`（同时删除残留的 `-wal`/`-shm`）→ 重跑幂等迁移：

```bash
npm run migrate
```

不要把数据库文件或备份目录提交到 Git。

## 排障

- `chat not found`：bot 没进管理群，或 `TELEGRAM_MANAGEMENT_CHAT_ID` 填错。
- `not enough rights to create a topic`：bot 不是管理员，或缺少 Manage Topics 权限。
- `message thread not found`：Topic 已被删除或失效；InboxBridge 会在下一次用户来信时自动重建。
- 管理员普通回复没有外发：检查 `TELEGRAM_ADMIN_USER_IDS`，以及 BotFather privacy mode。
- 菜单没刷新：Telegram 客户端有缓存，重开聊天或重启客户端。
