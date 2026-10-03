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
0 4 * * * cd /path/to/inboxbridge && npm run backup -- --keep 14 >> ~/inboxbridge-backup.log 2>&1
```

`~/inboxbridge-backup.log` 每次只追加一行，可随备份一起清理。

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
