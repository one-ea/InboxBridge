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

## 备份

需要备份的核心文件：

```text
data/inboxbridge.sqlite
```

不要把数据库文件提交到 Git。迁移是幂等的，备份恢复后可以再次运行：

```bash
npm run migrate
```

## 排障

- `chat not found`：bot 没进管理群，或 `TELEGRAM_MANAGEMENT_CHAT_ID` 填错。
- `not enough rights to create a topic`：bot 不是管理员，或缺少 Manage Topics 权限。
- `message thread not found`：Topic 已被删除或失效；InboxBridge 会在下一次用户来信时自动重建。
- 管理员普通回复没有外发：检查 `TELEGRAM_ADMIN_USER_IDS`，以及 BotFather privacy mode。
- 菜单没刷新：Telegram 客户端有缓存，重开聊天或重启客户端。
