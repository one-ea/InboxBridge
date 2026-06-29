# 审计日志 (Audit Log) 技术设计

## 1. 架构概览

```
commands.ts  --(成功后)--> AuditService.log()
                               |
                               v
                          audit_logs 表
                               ^
                               |
web-console.ts <-- listAuditLogs() -- AuditService.list()
main.ts --------> listAuditLogs 回调 -----> /operations/audit
```

## 2. 数据库变更

### 2.1 audit_logs 表

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT NOT NULL,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_conversation_idx ON audit_logs(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_admin_idx ON audit_logs(admin_id, created_at DESC);
```

追加到 `0001_initial.ts` 的 `statements` 数组末尾（`app_settings` 之后）。无需 `addColumnIfMissing`，因为是全新表。

## 3. AuditService 设计

### 3.1 文件位置
`src/domain/audit.ts`

### 3.2 接口

```typescript
export interface AuditLogEntry {
  id: number;
  adminId: string;
  conversationId: number;
  action: string;
  detail: string | null;
  createdAt: string;
}

export interface AuditListOptions {
  conversationId?: number;   // 按会话筛选
  adminId?: string;          // 按管理员筛选
  action?: string;           // 按操作类型筛选
  limit: number;
  offset: number;
}

export class AuditService {
  constructor(private db: DatabaseSync) {}

  log(entry: {
    adminId: string;
    conversationId: number;
    action: string;
    detail?: string;
  }): void;

  list(opts: AuditListOptions): { items: AuditLogEntry[]; total: number };

  listByConversation(conversationId: number, limit: number): AuditLogEntry[];
}
```

### 3.3 实现要点

- `log()` 使用 `INSERT INTO audit_logs (admin_id, conversation_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`
- `created_at` 使用 `new Date().toISOString()`
- `log()` 内部 try/catch，失败时只 console.error（不依赖 pino，因为 AuditService 在命令处理中调用，保持与 ConversationService 同级的纯 domain 服务）
- `list()` 动态拼接 WHERE 子句，按 `created_at DESC` 排序
- `listByConversation()` 是 `list()` 的快捷方法，用于 `/audit` 命令

## 4. 命令埋点

### 4.1 CommandDeps 扩展

```typescript
export interface CommandDeps {
  config: AppConfig;
  conversations: ConversationService;
  aiDrafts: AiDraftService;
  deliveries: DeliveryService;
  audit: AuditService;  // 新增
}
```

### 4.2 埋点位置

在 `handleTopicCommand` 的各 case 分支中，命令执行成功后调用 `deps.audit.log()`。埋点清单：

| 命令 | action | detail |
|------|--------|--------|
| /ban | `ban` | 封禁原因（args 或 null） |
| /unban | `unban` | null |
| /assign | `assign` | 分配目标 user_id |
| /priority | `priority` | 新优先级值 |
| /close | `close` | null |
| /reopen | `reopen` | null |
| /mute | `mute` | 静音截止时间 |
| /delete confirm | `delete` | null |
| /reset confirm | `reset` | null |
| /expire | `expire` | 新策略（天数或 "never"） |
| /ai_on | `ai_on` | null |
| /ai_off | `ai_off` | null |
| /draft send | `draft_send` | 草稿 ID |
| /draft discard | `draft_discard` | 草稿 ID |
| /tag | `tag` | 标签名 |
| /untag | `untag` | 标签名 |
| /note | `note` | null（备注内容不记入审计，保护隐私） |

### 4.3 新增 /audit 命令

在 `handleTopicCommand` 中新增 case：

```typescript
case "audit": {
  const limit = parseLimit(args, 20, 50);
  const logs = deps.audit.listByConversation(conversation.id, limit);
  if (logs.length === 0) {
    await ctx.reply("当前会话暂无审计记录。");
    return true;
  }
  const lines = logs.map(l =>
    `${l.createdAt} admin=${l.adminId} ${l.action}${l.detail ? ` (${l.detail})` : ""}`
  );
  await ctx.reply([`最近 ${logs.length} 条审计记录：`, ...lines].join("\n"));
  return true;
}
```

### 4.4 菜单更新

`topicHelpText()` 中 "安全与辅助" 区块新增：
```
/audit [数量] - 查看本会话最近审计记录，默认 20，最多 50
```

## 5. Web 控制台

### 5.1 路由

- `GET /operations/audit` — 审计日志列表页
  - 查询参数：`page`（页码）、`admin_id`（管理员筛选）、`action`（操作类型筛选）

### 5.2 WebConsoleOptions 扩展

```typescript
listAuditLogs: (opts: {
  page: number;
  adminId?: string;
  action?: string;
  pageSize: number;
}) => { items: AuditLogView[]; total: number };
```

### 5.3 AuditLogView 接口

```typescript
export interface AuditLogView {
  id: number;
  adminId: string;
  conversationId: number;
  action: string;
  detail: string | null;
  createdAt: string;
}
```

### 5.4 渲染

`renderAuditLogs(res, data, page, adminId, action)`:
- 顶部筛选表单：管理员 ID 输入框 + 操作类型下拉框
- 表格列：ID、时间、管理员、会话 ID、操作、详情
- 复用 `opsPage()`，activeNav 新增 `"audit"`

### 5.5 导航

`opsPage()` 的 header 新增 "审计" 链接：
```html
<a href="/operations/audit" class="${activeNav === "audit" ? "active" : ""}">审计</a>
```

## 6. main.ts 接入

### 6.1 import

```typescript
import { AuditService } from "../domain/audit.js";
```

### 6.2 listAuditLogs 回调

```typescript
listAuditLogs: (opts) => {
  const audit = new AuditService(handle.db);
  const result = audit.list({
    adminId: opts.adminId || undefined,
    action: opts.action || undefined,
    limit: opts.pageSize,
    offset: (opts.page - 1) * opts.pageSize,
  });
  return {
    items: result.items.map(a => ({ ...a })),
    total: result.total,
  };
},
```

### 6.3 bot.ts 注入

`createTelegramBot` 中创建 `AuditService` 实例并注入 `deps.audit`。

## 7. 测试计划

1. AuditService.log 写入并查询
2. AuditService.list 分页和筛选
3. AuditService.listByConversation
4. /audit 命令返回审计记录
5. Web 审计页面认证重定向
6. Web 审计页面 HTML 渲染

## 8. 影响范围

| 文件 | 变更类型 |
|------|----------|
| `src/storage/migrations/0001_initial.ts` | 新增 audit_logs 表和索引 |
| `src/domain/audit.ts` | 新建 |
| `src/channels/telegram/commands.ts` | CommandDeps 新增 audit、17 处埋点、新增 /audit 命令 |
| `src/channels/telegram/bot.ts` | createTelegramBot 注入 AuditService |
| `src/runtime/web-console.ts` | 新增 AuditLogView、listAuditLogs 回调、/operations/audit 路由、renderAuditLogs、导航 |
| `src/runtime/main.ts` | import AuditService、listAuditLogs 回调 |
| `test/core.test.ts` | 新增 AuditService 测试、/audit 命令测试、web 审计页面测试、所有 startWebConsole 调用加 stub |
