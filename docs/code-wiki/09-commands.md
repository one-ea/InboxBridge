# 09 · 命令参考

命令在管理群 Topic 内由 [commands.ts](../../src/channels/telegram/commands.ts) 的 `handleTopicCommand` 处理。**普通文本默认代发给外部用户**，以 `/` 开头的文本被视为命令，不会外发。

命令解析：去掉前导 `/`、剥离 `@botname`、转小写后匹配。所有命令执行都会（在适用的场景）写入审计日志。

## 1. 通用命令（`updates.ts`）

| 命令 | 场景 | 行为 |
| --- | --- | --- |
| `/start` | 私聊 | 回复就绪提示 |
| `/help` | 私聊 / 群 | 私聊返回使用说明；群内返回 `topicHelpText()` |
| `/id` | 任意 | 返回 `chat_id` / `chat_type` / `message_thread_id` / `from_id`，用于配置排查 |

## 2. Topic 管理命令

### 2.1 查看与定位

| 命令 | 用法 | 行为 |
| --- | --- | --- |
| `/menu` `/commands` `/help` | — | 输出命令菜单 |
| `/info` | — | 汇总联系人、会话、Topic、负责人、标签、AI 开关 |
| `/profile` | — | 查看联系人资料 |
| `/status` | — | 查看会话状态、优先级、负责人、静音、销毁策略、AI 开关、最近消息时间 |
| `/expire` `/ttl` | `/expire <天数\|never>` | 设置当前会话销毁策略并写审计（`never`→不自动销毁） |
| `/expires` | — | 查看当前销毁策略 |
| `/whoami` | — | 返回你的 Telegram user_id |
| `/history` | `/history [数量]` | 最近消息摘要，默认 10，最多 30 |
| `/search` | `/search <关键词>` | 在当前会话历史中搜索，最多 20 条 |

### 2.2 备注与标签

| 命令 | 用法 | 行为 |
| --- | --- | --- |
| `/note` | `/note <内容>` | 保存内部备注（不外发） |
| `/notes` | `/notes [数量]` | 查看最近备注，默认 5，最多 20 |
| `/tag` | `/tag <标签>` | 添加标签（小写化，幂等） |
| `/untag` | `/untag <标签>` | 移除标签 |
| `/tags` | — | 列出当前会话标签 |

### 2.3 会话处理

| 命令 | 用法 | 行为 |
| --- | --- | --- |
| `/priority` | `/priority low\|normal\|high\|urgent` | 设置优先级 |
| `/assign` | `/assign <telegram_user_id>` | 分配负责人（必须为纯数字） |
| `/mine` | — | 列出分配给自己（当前 user_id）的会话，最多 20 |
| `/close` | — | 关闭会话（用户再发消息会自动重开） |
| `/open` `/reopen` | — | 重新打开会话 |
| `/mute` | `/mute <时长>` | 静音提醒，支持 `m` / `h` / `d`（如 `/mute 2h`） |

### 2.4 安全与危险操作

| 命令 | 用法 | 行为 |
| --- | --- | --- |
| `/ban` | `/ban [原因]` | 封禁联系人，后续来信被拒收 |
| `/unban` | — | 解除封禁 |
| `/delete` | `/delete confirm` | 删除当前 Topic 并清理数据库会话数据（需二次确认） |
| `/reset` | `/reset confirm` | 清空消息、草稿、备注、标签，保留联系人映射与 Topic（需二次确认） |
| `/audit` | `/audit [数量]` | 查看本会话最近审计记录，默认 20，最多 50 |

> `/delete` 会先调用 `deleteForumTopic`，再执行 `ConversationService.deleteConversationData`；`/reset` 只清理会话内容。

### 2.5 导出

| 命令 | 行为 |
| --- | --- |
| `/export` | 导出当前会话最近 200 条消息为 JSON 文档（含会话与联系人信息） |

### 2.6 AI 草稿

| 命令 | 用法 | 行为 |
| --- | --- | --- |
| `/draft` | `/draft` | 重新生成草稿（结果只发到 Topic） |
| `/draft view` | — | 查看当前 ready 草稿 |
| `/draft send` | — | 发送当前草稿给外部用户（成功标记 `sent`，失败保留可重试） |
| `/draft discard` | — | 丢弃当前草稿 |
| `/ai_on` | — | 开启当前会话的 AI 草稿（若全局未启用会提示） |
| `/ai_off` | — | 关闭当前会话的 AI 草稿 |

## 3. 命令菜单注册

[menu.ts](../../src/channels/telegram/menu.ts) 通过 `registerTelegramMenu` 注册两套原生命令菜单：

- `privateBotCommands` → Telegram 私聊作用域（`all_private_chats`）。
- `adminBotCommands` → 管理群作用域（`chat_id = TELEGRAM_MANAGEMENT_CHAT_ID`）。

同时调用 `setChatMenuButton({ menu_button: { type: "commands" } })` 启用菜单按钮，无需发送 `/help` 即可看到命令列表。菜单由 Telegram 客户端缓存，更新后可能需要重开聊天。

## 4. 参数解析规则

| 解析器 | 规则 |
| --- | --- |
| `splitCommand` | 按空白切分，命令去 `/`、去 `@` 后缀、转小写 |
| `parseDuration` | `^(\d+)(m\|h\|d)$` → ISO 时间（相对 UTC 偏移） |
| `parseLimit` | 非正整数回退默认值；超过上限则截断 |
| `parseRetentionDays` | `never/none/off/0` → `null`（永不）；非正整数 → `undefined`（用法错误） |

## 5. 未匹配命令

`handleTopicCommand` 返回 `false` 时，`handleManagementMessage` 回复"未知命令。发送 /help 查看可用命令列表。"
