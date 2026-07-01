import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { editableConfigKeys, sensitiveConfigKeys } from "./config.js";
import { AppSettingsService } from "../domain/app-settings.js";

const passwordHashKey = "WEB_CONSOLE_PASSWORD_HASH";
const setupTokenKey = "WEB_CONSOLE_SETUP_TOKEN";
const sessionCookie = "inboxbridge_session";
const maxFormBodyBytes = 64 * 1024;

interface FieldMeta {
  key: (typeof editableConfigKeys)[number];
  label: string;
  note: string;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "url";
}

const fieldGroups: Array<{ title: string; description: string; fields: FieldMeta[] }> = [
  {
    title: "Telegram 基础配置",
    description: "这三项保存后，InboxBridge 才会启动 bot。",
    fields: [
      {
        key: "TELEGRAM_BOT_TOKEN",
        label: "Bot Token",
        note: "从 Telegram 的 @BotFather 获取，用于连接你的 bot。敏感项已隐藏，留空表示保持现有值。",
        placeholder: "例如：123456:ABC-DEF...",
      },
      {
        key: "TELEGRAM_MANAGEMENT_CHAT_ID",
        label: "管理群 ID",
        note: "已开启 Topics 的私密 supergroup ID，通常以 -100 开头。",
        placeholder: "例如：-1001234567890",
        inputMode: "numeric",
      },
      {
        key: "TELEGRAM_ADMIN_USER_IDS",
        label: "管理员用户 ID 白名单",
        note: "允许在 Topic 内代发回复和执行命令的 Telegram 数字 user_id，多个值用英文逗号分隔。",
        placeholder: "例如：123456789,987654321",
      },
    ],
  },
  {
    title: "运行方式",
    description: "自托管和 Serv00 推荐使用 polling；公网 HTTPS 部署可使用 webhook。",
    fields: [
      {
        key: "TELEGRAM_UPDATE_MODE",
        label: "接收更新方式",
        note: "polling 表示主动拉取 Telegram 更新；webhook 表示 Telegram 主动推送到你的公网地址。",
      },
      {
        key: "TELEGRAM_WEBHOOK_URL",
        label: "Webhook 地址",
        note: "仅在接收更新方式选择 webhook 时填写，路径建议使用 /telegram/webhook。",
        placeholder: "例如：https://example.com/telegram/webhook",
        inputMode: "url",
      },
    ],
  },
  {
    title: "数据保留与自动清理",
    description: "控制消息正文和会话 Topic 的保留周期。",
    fields: [
      {
        key: "MESSAGE_RETENTION_DAYS",
        label: "消息内容保留天数",
        note: "只清理已存储的正文和 raw payload，保留会话映射与 Topic。",
        placeholder: "默认：30",
        inputMode: "numeric",
      },
      {
        key: "MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES",
        label: "消息正文清理扫描间隔",
        note: "运行中的 bot 每隔多少分钟清理一次过期的消息正文和 raw payload。保留会话映射与 Topic。",
        placeholder: "默认：60",
        inputMode: "numeric",
      },
      {
        key: "DEFAULT_CONVERSATION_RETENTION_DAYS",
        label: "新会话默认销毁时间",
        note: "填写正整数表示多少天后销毁；填写 never 表示默认长期保留。",
        placeholder: "默认：30，可填 never",
      },
      {
        key: "CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES",
        label: "过期会话扫描间隔",
        note: "运行中的 bot 每隔多少分钟检查一次到期会话。数值越小越及时，调用也更频繁。",
        placeholder: "默认：60",
        inputMode: "numeric",
      },
    ],
  },
  {
    title: "限流设置",
    description: "限制外部用户私聊入口的基础消息频率。",
    fields: [
      {
        key: "RATE_LIMIT_WINDOW_SECONDS",
        label: "限流窗口秒数",
        note: "在这个时间窗口内统计同一用户的消息数量。",
        placeholder: "默认：60",
        inputMode: "numeric",
      },
      {
        key: "RATE_LIMIT_MAX_MESSAGES",
        label: "窗口内最大消息数",
        note: "超过该数量后，系统会限制该用户继续发送消息。",
        placeholder: "默认：20",
        inputMode: "numeric",
      },
    ],
  },
  {
    title: "投递可靠性",
    description: "控制失败出站消息的自动重试行为。",
    fields: [
      {
        key: "DELIVERY_RETRY_INTERVAL_SECONDS",
        label: "重试扫描间隔秒数",
        note: "运行中的 bot 每隔多少秒扫描一次失败的出站投递并尝试重发。最大重试 8 次（含初始同步重试）。",
        placeholder: "默认：30",
        inputMode: "numeric",
      },
    ],
  },
  {
    title: "AI 草稿",
    description: "AI 只生成给管理员看的回复草稿，系统不会自动回复外部用户。",
    fields: [
      {
        key: "AI_DRAFTS_ENABLED",
        label: "启用 AI 草稿",
        note: "关闭后无需填写 OpenAI-compatible 配置。普通部署建议先关闭。",
      },
      {
        key: "OPENAI_COMPATIBLE_BASE_URL",
        label: "AI 服务地址",
        note: "OpenAI-compatible 接口基础地址，系统会请求 /chat/completions。",
        placeholder: "例如：https://api.openai.com/v1",
        inputMode: "url",
      },
      {
        key: "OPENAI_COMPATIBLE_API_KEY",
        label: "AI API Key",
        note: "AI 服务密钥。敏感项已隐藏，留空表示保持现有值。",
      },
      {
        key: "OPENAI_COMPATIBLE_MODEL",
        label: "AI 模型名称",
        note: "用于生成管理员回复草稿的模型名称。",
        placeholder: "例如：gpt-4o-mini",
      },
      {
        key: "AI_DRAFT_CONTEXT_LIMIT",
        label: "草稿上下文消息数",
        note: "生成草稿时读取最近多少条会话消息。",
        placeholder: "默认：20",
        inputMode: "numeric",
      },
    ],
  },
];

export interface ConsoleStatus {
  bot: "running" | "stopped";
  issues: string[];
}

export interface MetricsSnapshot {
  messages: {
    inbound_total: number;
    outbound_total: number;
    internal_total: number;
  };
  deliveries: {
    pending: number;
    sent: number;
    failed: number;
    permanent_failure: number;
  };
  conversations: {
    open: number;
    closed: number;
  };
  ai_drafts: {
    pending: number;
    ready: number;
    failed: number;
  };
  uptime_seconds: number;
  timestamp: string;
}

export interface ConversationListItemView {
  id: number;
  status: "open" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  assignedAdminId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  contactDisplayName: string | null;
  contactUsername: string | null;
  topicName: string | null;
  messageThreadId: number | null;
}

export interface DeliveryView {
  id: number;
  sourceMessageId: number | null;
  target: string;
  status: "pending" | "sent" | "failed" | "permanent_failure";
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationsOverview {
  messages: { inboundTotal: number; outboundTotal: number; internalTotal: number };
  deliveries: { pending: number; sent: number; failed: number; permanentFailure: number };
  conversations: { open: number; closed: number };
  aiDrafts: { pending: number; ready: number; failed: number; sent: number; discarded: number };
  uptimeSeconds: number;
}

export interface AuditLogView {
  id: number;
  adminId: string;
  conversationId: number;
  action: string;
  detail: string | null;
  createdAt: string;
}

export interface MessageSearchView {
  id: number;
  conversationId: number;
  direction: string;
  messageType: string;
  text: string | null;
  createdAt: string;
  contactDisplayName: string | null;
  topicName: string | null;
}

export const auditActionOptions = [
  "ban",
  "unban",
  "assign",
  "priority",
  "close",
  "reopen",
  "mute",
  "delete",
  "reset",
  "expire",
  "ai_on",
  "ai_off",
  "draft_send",
  "draft_discard",
  "tag",
  "untag",
  "note",
] as const;

export interface WebConsoleOptions {
  settings: AppSettingsService;
  port: number;
  getStatus: () => ConsoleStatus | Promise<ConsoleStatus>;
  onConfigSaved: () => Promise<void>;
  telegramWebhook?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  dbHealthCheck: () => boolean | Promise<boolean>;
  collectMetrics: () => MetricsSnapshot | Promise<MetricsSnapshot>;
  collectOperationsOverview: () => OperationsOverview | Promise<OperationsOverview>;
  listConversations: (opts: { page: number; status?: string; assignedTo?: string; pageSize: number }) => { items: ConversationListItemView[]; total: number } | Promise<{ items: ConversationListItemView[]; total: number }>;
  listFailedDeliveries: (opts: { page: number; pageSize: number }) => { items: DeliveryView[]; total: number } | Promise<{ items: DeliveryView[]; total: number }>;
  scheduleRetry: (deliveryId: number) => Promise<void>;
  listAuditLogs: (opts: { page: number; adminId?: string; action?: string; pageSize: number }) => { items: AuditLogView[]; total: number } | Promise<{ items: AuditLogView[]; total: number }>;
  searchMessages: (opts: { query: string; page: number; pageSize: number }) => { items: MessageSearchView[]; total: number } | Promise<{ items: MessageSearchView[]; total: number }>;
}

type SessionKind = "password" | "setup";
type OperationsTab = "overview" | "conversations" | "deliveries" | "audit" | "search";
export type WebConsoleSessionStore = Map<string, SessionKind>;

class FormBodyTooLargeError extends Error {}

export async function ensureSetupToken(settings: AppSettingsService): Promise<string | undefined> {
  if (await settings.get(passwordHashKey)) return undefined;
  const existing = await settings.get(setupTokenKey);
  if (existing) return existing;
  const token = randomBytes(16).toString("hex");
  await settings.setMany({ [setupTokenKey]: token });
  return token;
}

export async function startWebConsole(options: WebConsoleOptions): Promise<Server> {
  const sessions = new Map<string, SessionKind>();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/telegram/webhook" && req.method === "POST" && options.telegramWebhook) {
        await options.telegramWebhook(req, res);
        return;
      }

      if (url.pathname === "/healthz" && req.method === "GET") {
        let dbReachable = false;
        try {
          dbReachable = await options.dbHealthCheck();
        } catch {
          dbReachable = false;
        }
        const botRunning = (await options.getStatus()).bot === "running";
        const healthy = dbReachable && botRunning;
        send(
          res,
          healthy ? 200 : 503,
          "application/json",
          JSON.stringify({
            status: healthy ? "ok" : "degraded",
            bot: botRunning ? "running" : "stopped",
            db: dbReachable ? "reachable" : "unreachable",
            uptime_seconds: Math.round(process.uptime()),
            timestamp: new Date().toISOString(),
          }),
        );
        return;
      }

      if (url.pathname === "/login" && req.method === "GET") {
        await renderLogin(res, options.settings);
        return;
      }

      if (url.pathname === "/login" && req.method === "POST") {
        const form = await readForm(req);
        const sessionKind = await loginSessionKind(options.settings, form);
        if (sessionKind) {
          const session = randomBytes(24).toString("hex");
          sessions.set(session, sessionKind);
          res.setHeader("set-cookie", `${sessionCookie}=${session}; HttpOnly; SameSite=Lax; Path=/`);
          redirect(res, "/");
          return;
        }
        await renderLogin(res, options.settings, "登录凭据无效。");
        return;
      }

      const sessionKind = authenticatedSessionKind(req, sessions);
      if (!sessionKind) {
        redirect(res, "/login");
        return;
      }

      if (url.pathname === "/metrics" && req.method === "GET") {
        try {
          const metrics = await options.collectMetrics();
          send(res, 200, "application/json", JSON.stringify(metrics));
        } catch {
          send(res, 500, "application/json", JSON.stringify({ error: "metrics query failed" }));
        }
        return;
      }

      if (url.pathname === "/operations/deliveries/retry" && req.method === "POST") {
        const form = await readForm(req);
        const deliveryId = Number(form.get("delivery_id"));
        if (deliveryId > 0) {
          await options.scheduleRetry(deliveryId);
        }
        redirect(res, "/operations/deliveries?retryed=1");
        return;
      }

      if (url.pathname === "/config" && req.method === "POST") {
        const form = await readForm(req);
        const values = await configValuesFromForm(options.settings, form);
        const password = form.get("WEB_CONSOLE_PASSWORD")?.trim();
        if (sessionKind === "setup" && !password) {
          send(res, 400, "text/plain", "首次配置必须设置控制台密码。");
          return;
        }
        if (password) values[passwordHashKey] = hashPassword(password);
        if (password) values[setupTokenKey] = "";
        await options.settings.setMany(values);
        await options.onConfigSaved();
        const group = form.get("group") ?? "security";
        redirect(res, `/config/${group}?saved=1`);
        return;
      }

      if (url.pathname === "/" && req.method === "GET") {
        await renderOverview(res, options, url.searchParams.get("saved") === "1");
        return;
      }

      if (url.pathname.startsWith("/config") && req.method === "GET") {
        await renderConfigPage(res, options, url.pathname, url.searchParams);
        return;
      }

      if (url.pathname.startsWith("/operations") && req.method === "GET") {
        await renderOperationsPage(res, options, url.pathname, url.searchParams);
        return;
      }

      send(res, 404, "text/plain", "页面不存在");
    } catch (error) {
      if (error instanceof FormBodyTooLargeError) {
        send(res, 413, "text/plain", "请求体过大。");
        return;
      }
      send(res, 500, "text/plain", `控制台处理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port);
  });
  return server;
}

export async function handleWebConsoleRequest(
  request: Request,
  options: WebConsoleOptions,
  sessions: WebConsoleSessionStore = new Map(),
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const res = new FetchResponseSink();

    if (url.pathname === "/healthz" && request.method === "GET") {
      let dbReachable = false;
      try {
        dbReachable = await options.dbHealthCheck();
      } catch {
        dbReachable = false;
      }
      const botRunning = (await options.getStatus()).bot === "running";
      const healthy = dbReachable && botRunning;
      return jsonResponse(
        {
          status: healthy ? "ok" : "degraded",
          bot: botRunning ? "running" : "stopped",
          db: dbReachable ? "reachable" : "unreachable",
        },
        healthy ? 200 : 503,
      );
    }

    if (url.pathname === "/login" && request.method === "GET") {
      await renderLogin(res.asServerResponse(), options.settings);
      return res.toResponse();
    }

    const sessionKind = authenticatedFetchSessionKind(request, sessions);
    if (!sessionKind) return redirectResponse("/login");

    if (url.pathname === "/" && request.method === "GET") {
      await renderOverview(res.asServerResponse(), options, url.searchParams.get("saved") === "1");
      return res.toResponse();
    }

    if (url.pathname.startsWith("/config") && request.method === "GET") {
      await renderConfigPage(res.asServerResponse(), options, url.pathname, url.searchParams);
      return res.toResponse();
    }

    if (url.pathname.startsWith("/operations") && request.method === "GET") {
      await renderOperationsPage(res.asServerResponse(), options, url.pathname, url.searchParams);
      return res.toResponse();
    }

    return textResponse("页面不存在", 404);
  } catch (error) {
    if (error instanceof FormBodyTooLargeError) return textResponse("请求体过大。", 413);
    return textResponse(`控制台处理失败：${error instanceof Error ? error.message : String(error)}`, 500);
  }
}

class FetchResponseSink {
  statusCode = 200;
  private readonly headers = new Headers();
  private body = "";

  asServerResponse(): ServerResponse {
    const sink = this;
    return {
      setHeader: (name: string, value: number | string | readonly string[]) => {
        if (Array.isArray(value)) sink.headers.set(name, value.join(", "));
        else sink.headers.set(name, String(value));
      },
      end: (body?: string | Buffer) => {
        if (body !== undefined) sink.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      },
      get statusCode() {
        return sink.statusCode;
      },
      set statusCode(value: number) {
        sink.statusCode = value;
      },
    } as unknown as ServerResponse;
  }

  toResponse(): Response {
    return new Response(this.body, { status: this.statusCode, headers: this.headers });
  }
}

function authenticatedFetchSessionKind(request: Request, sessions: WebConsoleSessionStore): SessionKind | undefined {
  const cookie = request.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
  return token ? sessions.get(token) : undefined;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

async function renderLogin(res: ServerResponse, settings: AppSettingsService, error = ""): Promise<void> {
  const hasPassword = Boolean(await settings.get(passwordHashKey));
  const label = hasPassword ? "控制台密码" : "首次设置令牌";
  const name = hasPassword ? "password" : "setupToken";
  send(
    res,
    200,
    "text/html; charset=utf-8",
    page("登录控制台", `
      <section class="hero compact">
        <p class="eyebrow">InboxBridge</p>
        <h1>登录控制台</h1>
        <p class="hero-copy">用于配置 Telegram bot、数据保留策略、限流和 AI 草稿。</p>
      </section>
      <form method="post" action="/login" class="card login-card" autocomplete="on">
        ${error ? `<p class="banner danger" role="alert"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg><span>${escapeHtml(error)}</span></p>` : ""}
        <div class="field single-field">
          <p class="field-note">${hasPassword ? "请输入首次设置时保存的控制台密码。" : "首次进入请使用启动日志中的 setup token，登录后立即设置控制台密码。"}</p>
          <label for="login-secret">${escapeHtml(label)}</label>
          <input id="login-secret" type="password" name="${name}" autocomplete="current-password" autofocus required>
        </div>
        <div style="margin-top:var(--space-4)">
          <button type="submit"><span class="spinner" aria-hidden="true"></span><span class="btn-label">进入控制台</span></button>
        </div>
      </form>`),
  );
}

const configGroupSlugs: Array<{ slug: string; title: string }> = [
  { slug: "security", title: "访问安全" },
  { slug: "telegram", title: "Telegram 基础配置" },
  { slug: "runtime", title: "运行方式" },
  { slug: "retention", title: "数据保留与自动清理" },
  { slug: "ratelimit", title: "限流设置" },
  { slug: "delivery", title: "投递可靠性" },
  { slug: "ai-drafts", title: "AI 草稿" },
];

async function renderOverview(
  res: ServerResponse,
  options: WebConsoleOptions,
  saved: boolean,
): Promise<void> {
  const status = await options.getStatus();
  const stored = await options.settings.all();
  const completedRequired = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_MANAGEMENT_CHAT_ID", "TELEGRAM_ADMIN_USER_IDS"].filter(
    (key) => Boolean(stored[key]),
  ).length;
  const issueList = status.issues.length
    ? `<ul class="issue-list">${status.issues.map((issue) => `<li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg><span class="issue-content">${translateIssue(issue)}</span></li>`).join("")}</ul>`
    : `<p class="status-copy"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-4px;margin-right:6px;color:var(--color-ok)"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>配置完整，bot 可以正常启动。</p>`;
  const statusRunning = status.bot === "running";

  let opsMetrics = "";
  try {
    const data = await options.collectOperationsOverview();
    opsMetrics = `
      <div class="ops-grid">
        <div class="ops-card"><h3>消息</h3>
          <div class="ops-metric"><span class="label">入站</span><span class="value">${data.messages.inboundTotal}</span></div>
          <div class="ops-metric"><span class="label">出站</span><span class="value">${data.messages.outboundTotal}</span></div>
        </div>
        <div class="ops-card"><h3>投递</h3>
          <div class="ops-metric"><span class="label">sent</span><span class="value ok">${data.deliveries.sent}</span></div>
          <div class="ops-metric"><span class="label">failed</span><span class="value ${data.deliveries.failed > 0 ? "danger" : ""}">${data.deliveries.failed}</span></div>
        </div>
        <div class="ops-card"><h3>会话</h3>
          <div class="ops-metric"><span class="label">open</span><span class="value ok">${data.conversations.open}</span></div>
          <div class="ops-metric"><span class="label">closed</span><span class="value">${data.conversations.closed}</span></div>
        </div>
      </div>`;
  } catch {
    opsMetrics = `<p class="hint" style="margin:var(--space-4) 0">Bot 未完成配置，运维数据暂不可用。</p>`;
  }

  const savedBanner = saved
    ? `<p class="banner success" role="status"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg><span>配置已保存，运行状态已刷新。</span></p>`
    : "";

  send(
    res,
    200,
    "text/html; charset=utf-8",
    page("InboxBridge 控制台", `
      <section class="hero">
        <div>
          <p class="eyebrow">InboxBridge</p>
          <h1>控制台概览</h1>
          <p class="hero-copy">运行状态、配置进度和关键指标一览。</p>
        </div>
        <span class="status-pill ${statusRunning ? "ok" : "warn"}" role="status"><span class="dot" aria-hidden="true"></span>${statusRunning ? "Bot 运行中" : "Bot 待配置"}</span>
      </section>
      ${savedBanner}
      <div class="dashboard-shell">
        <aside class="sidebar">
          <section class="card status-card" aria-label="运行状态">
            <div class="section-heading">
              <div>
                <p class="eyebrow">运行状态</p>
                <h2>当前检查结果</h2>
              </div>
            </div>
            ${issueList}
          </section>
          <section class="card setup-card" aria-label="配置进度">
            <p class="eyebrow">配置进度</p>
            <div class="progress-number" aria-live="polite">${completedRequired}/3</div>
            <p class="hint">基础配置包含 Bot Token、管理群 ID 和管理员白名单。</p>
            <div class="progress-track" role="progressbar" aria-valuenow="${completedRequired}" aria-valuemin="0" aria-valuemax="3"><span style="width:${Math.round((completedRequired / 3) * 100)}%"></span></div>
          </section>
          <nav class="card quick-nav" aria-label="快捷入口">
            <p class="eyebrow">仪表盘</p>
            <a href="/config/security" class="ops-link">配置仪表盘</a>
            <a href="/operations" class="ops-link">运维仪表盘</a>
          </nav>
        </aside>
        <div class="config-panel">
          <section class="config-section active">
            <div class="section-heading">
              <div>
                <p class="eyebrow">关键指标</p>
                <h2>实时数据</h2>
              </div>
              <a href="/operations" class="ops-link" style="display:inline">查看详情</a>
            </div>
            ${opsMetrics}
          </section>
        </div>
      </div>`),
  );
}

async function renderConfigPage(
  res: ServerResponse,
  options: WebConsoleOptions,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const slug = pathname.replace(/^\/config\/?/, "") || "security";
  const groupIndex = configGroupSlugs.findIndex((g) => g.slug === slug);
  const validSlug = groupIndex >= 0 ? slug : "security";
  const currentIndex = groupIndex >= 0 ? groupIndex : 0;

  const settings = options.settings;
  const stored = await settings.all();
  const needsPassword = !(await settings.get(passwordHashKey));
  const statusRunning = (await options.getStatus()).bot === "running";
  const saved = searchParams.get("saved") === "1";

  const nav = configGroupSlugs
    .map((g, i) => `<a href="/config/${g.slug}" class="ops-nav-link${i === currentIndex ? " active" : ""}">${escapeHtml(g.title)}</a>`)
    .join("\n");

  let formBody: string;
  if (currentIndex === 0) {
    formBody = `
      <div class="section-heading split-heading">
        <div>
          <p class="eyebrow">访问安全</p>
          <h2>${needsPassword ? "设置控制台密码" : "修改控制台密码"}</h2>
          <p class="hint">${needsPassword ? "首次配置必须设置密码，后续登录使用该密码。" : "留空表示保持现有密码。"}</p>
        </div>
        <span class="section-badge">本地保存</span>
      </div>
      <div class="field single-field">
        <p class="field-note">控制台密码只保存在本地 SQLite 数据库中，用于保护配置页面。</p>
        <label for="WEB_CONSOLE_PASSWORD">控制台密码</label>
        <input id="WEB_CONSOLE_PASSWORD" type="password" name="WEB_CONSOLE_PASSWORD" autocomplete="new-password" ${needsPassword ? "required" : ""}>
      </div>`;
  } else {
    const group = fieldGroups[currentIndex - 1];
    formBody = `
      <div class="section-heading split-heading">
        <div>
          <p class="eyebrow">配置分组 ${currentIndex}</p>
          <h2>${escapeHtml(group.title)}</h2>
          <p class="hint">${escapeHtml(group.description)}</p>
        </div>
        <span class="section-badge">${group.fields.length} 项</span>
      </div>
      <div class="field-grid">
        ${group.fields.map((field) => renderField(field, stored[field.key] ?? "")).join("\n")}
      </div>`;
  }

  const savedBanner = saved
    ? `<p class="banner success" role="status"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg><span>配置已保存，运行状态已刷新。</span></p>`
    : "";

  const pageTitle = configGroupSlugs[currentIndex].title;

  send(
    res,
    200,
    "text/html; charset=utf-8",
    page(`配置 · ${pageTitle} - InboxBridge`, `
      <nav class="ops-topnav" aria-label="配置分组">
        ${nav}
      </nav>
      <section class="hero">
        <div>
          <a href="/" class="back-link" aria-label="返回概览"><svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>概览</a>
          <p class="eyebrow">配置仪表盘</p>
          <h1>${escapeHtml(pageTitle)}</h1>
          <p class="hero-copy">管理 bot 连接、管理员白名单、数据保留、限流和 AI 草稿。</p>
        </div>
        <span class="status-pill ${statusRunning ? "ok" : "warn"}" role="status"><span class="dot" aria-hidden="true"></span>${statusRunning ? "Bot 运行中" : "Bot 待配置"}</span>
      </section>
      ${savedBanner}
      <form method="post" action="/config" class="config-panel" aria-label="配置表单">
        <input type="hidden" name="group" value="${validSlug}">
        <section class="config-section active">
          ${formBody}
        </section>
        <div class="form-actions">
          <div>
            <strong>保存后立即生效</strong>
            <p class="hint">系统会重新读取配置；配置完整时 bot 会自动启动。</p>
          </div>
          <button type="submit"><span class="spinner" aria-hidden="true"></span><span class="btn-label">保存</span></button>
        </div>
      </form>`),
  );
}

const opsRoutes: Array<{ pattern: RegExp; key: OperationsTab }> = [
  { pattern: /^\/operations\/?$/, key: "overview" },
  { pattern: /^\/operations\/overview\/?$/, key: "overview" },
  { pattern: /^\/operations\/conversations\/?$/, key: "conversations" },
  { pattern: /^\/operations\/deliveries\/?$/, key: "deliveries" },
  { pattern: /^\/operations\/audit\/?$/, key: "audit" },
  { pattern: /^\/operations\/search\/?$/, key: "search" },
];

async function renderOperationsPage(
  res: ServerResponse,
  options: WebConsoleOptions,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<void> {
  const route = opsRoutes.find((r) => r.pattern.test(pathname));
  if (!route) {
    send(res, 404, "text/plain", "运维页面不存在");
    return;
  }
  const tab = route.key;
  const retryed = searchParams.get("retryed") === "1";

  let opsBody: string;
  try {
    if (tab === "overview") {
      opsBody = renderOperationsOverviewBody(await options.collectOperationsOverview(), retryed);
    } else if (tab === "conversations") {
      const pageNum = Math.max(1, Number(searchParams.get("page") ?? "1"));
      const convStatus = searchParams.get("status") ?? undefined;
      const assignedTo = searchParams.get("assigned_to") ?? undefined;
      const data = await options.listConversations({ page: pageNum, status: convStatus, assignedTo, pageSize: 50 });
      opsBody = renderConversationsBody(data, pageNum, convStatus, assignedTo);
    } else if (tab === "deliveries") {
      const pageNum = Math.max(1, Number(searchParams.get("page") ?? "1"));
      const data = await options.listFailedDeliveries({ page: pageNum, pageSize: 50 });
      opsBody = renderDeliveriesBody(data, pageNum);
    } else if (tab === "audit") {
      const pageNum = Math.max(1, Number(searchParams.get("page") ?? "1"));
      const adminId = searchParams.get("admin_id") ?? undefined;
      const action = searchParams.get("action") ?? undefined;
      const data = await options.listAuditLogs({ page: pageNum, adminId, action, pageSize: 50 });
      opsBody = renderAuditLogsBody(data, pageNum, adminId, action);
    } else {
      const query = searchParams.get("q") ?? "";
      const pageNum = Math.max(1, Number(searchParams.get("page") ?? "1"));
      const data = query.trim()
        ? await options.searchMessages({ query: query.trim(), page: pageNum, pageSize: 50 })
        : { items: [], total: 0 };
      opsBody = renderSearchBody(data, query, pageNum);
    }
  } catch {
    opsBody = `<div class="ops-empty">Bot 未完成配置，运维数据暂不可用。请先在配置控制台填写 Bot Token、管理群 ID 和管理员白名单。</div>`;
  }

  const navItems: Array<{ key: OperationsTab; href: string; label: string }> = [
    { key: "overview", href: "/operations", label: "概览" },
    { key: "conversations", href: "/operations/conversations", label: "会话" },
    { key: "deliveries", href: "/operations/deliveries", label: "投递" },
    { key: "audit", href: "/operations/audit", label: "审计" },
    { key: "search", href: "/operations/search", label: "搜索" },
  ];
  const nav = navItems
    .map((item) => `<a href="${item.href}" class="ops-nav-link${tab === item.key ? " active" : ""}">${item.label}</a>`)
    .join("\n");
  const pageTitle = navItems.find((n) => n.key === tab)?.label ?? "运维";

  send(
    res,
    200,
    "text/html; charset=utf-8",
    page(`运维 · ${pageTitle} - InboxBridge`, `
      <nav class="ops-topnav" aria-label="运维导航">
        ${nav}
      </nav>
      <section class="hero">
        <div>
          <a href="/" class="back-link" aria-label="返回概览"><svg class="icon icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>概览</a>
          <p class="eyebrow">运维仪表盘</p>
          <h1>${escapeHtml(pageTitle)}</h1>
          <p class="hero-copy">监控会话、投递、审计与消息检索。</p>
        </div>
      </section>
      <div class="config-panel"><section class="config-section active">${opsBody}</section></div>
    `),
  );
}

function renderField(field: FieldMeta, value: string): string {
  const key = field.key;
  const inputId = `field-${key}`;
  const meta = `<p class="field-note">${escapeHtml(field.note)}</p><label for="${inputId}">${escapeHtml(field.label)} <code>${key}</code></label>`;
  if (key === "TELEGRAM_UPDATE_MODE") {
    return `<div class="field">${meta}<select id="${inputId}" name="${key}"><option value="polling"${value !== "webhook" ? " selected" : ""}>轮询模式 polling</option><option value="webhook"${value === "webhook" ? " selected" : ""}>Webhook 模式 webhook</option></select></div>`;
  }
  if (key === "AI_DRAFTS_ENABLED") {
    return `<div class="field">${meta}<select id="${inputId}" name="${key}"><option value="false"${value === "false" ? " selected" : ""}>关闭 false</option><option value="true"${value !== "false" ? " selected" : ""}>开启 true</option></select></div>`;
  }
  const type = sensitiveConfigKeys.has(key) ? "password" : "text";
  const shown = sensitiveConfigKeys.has(key) ? "" : value;
  const placeholder = sensitiveConfigKeys.has(key) && value ? "已保存，留空保持不变" : (field.placeholder ?? "");
  const inputMode = field.inputMode ? ` inputmode="${field.inputMode}"` : "";
  return `<div class="field">${meta}<input id="${inputId}" type="${type}" name="${key}" value="${escapeHtml(shown)}" placeholder="${escapeHtml(placeholder)}"${inputMode}></div>`;
}

function translateIssue(issue: string): string {
  const labels = new Map<string, string>();
  for (const group of fieldGroups) {
    for (const field of group.fields) labels.set(field.key, field.label);
  }

  for (const [key, label] of labels) {
    if (issue.includes(key)) {
      if (issue.includes("received undefined") || issue.includes("received NaN")) {
        return `${escapeHtml(label)} 尚未填写。<span>${escapeHtml(key)}</span>`;
      }
      if (issue.includes("Invalid url")) return `${escapeHtml(label)} 必须是完整 URL。<span>${escapeHtml(key)}</span>`;
      return `${escapeHtml(label)} 配置无效。<span>${escapeHtml(issue)}</span>`;
    }
  }

  if (issue.includes("TELEGRAM_WEBHOOK_URL is required")) return "Webhook 模式需要填写 Webhook 地址。";
  if (issue.includes("TELEGRAM_ADMIN_USER_IDS must contain")) return "管理员用户 ID 白名单至少需要填写 1 个 Telegram 数字 user_id。";
  return escapeHtml(issue);
}

async function configValuesFromForm(settings: AppSettingsService, form: URLSearchParams): Promise<Record<string, string>> {
  const current = await settings.all();
  const values: Record<string, string> = {};
  for (const key of editableConfigKeys) {
    const value = form.get(key)?.trim() ?? "";
    if (sensitiveConfigKeys.has(key) && !value && current[key]) continue;
    values[key] = value;
  }
  return values;
}

async function loginSessionKind(settings: AppSettingsService, form: URLSearchParams): Promise<SessionKind | undefined> {
  const hash = await settings.get(passwordHashKey);
  if (hash) return verifyPassword(form.get("password") ?? "", hash) ? "password" : undefined;
  const setupToken = await settings.get(setupTokenKey);
  return setupToken && form.get("setupToken") === setupToken ? "setup" : undefined;
}

function authenticatedSessionKind(req: IncomingMessage, sessions: Map<string, SessionKind>): SessionKind | undefined {
  const cookie = req.headers.cookie ?? "";
  const token = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
    ?.slice(sessionCookie.length + 1);
  return token ? sessions.get(token) : undefined;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxFormBodyBytes) throw new FormBodyTooLargeError("form body too large");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function page(title: string, body: string): string {
  const fingerprint = createHash("sha256").update(title).digest("hex").slice(0, 8);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f6f8fc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)"><title>${escapeHtml(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"><style>
:root{color-scheme:light dark;--font-sans:"Inter",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;--radius-sm:6px;--radius-md:8px;--radius-lg:10px;--radius-xl:12px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-7:32px;--space-8:40px;--shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow-md:0 2px 8px rgba(0,0,0,.06);--shadow-lg:0 8px 24px rgba(0,0,0,.08);--ring:0 0 0 2px var(--color-ring);--transition:120ms cubic-bezier(.4,0,.2,1);--ease-out:cubic-bezier(0,.55,.45,1)}
@media (prefers-color-scheme:light){:root{--color-bg:#fafafa;--color-surface:#ffffff;--color-surface-2:#f5f5f5;--color-surface-3:#ededed;--color-overlay:#ffffff;--color-border:#e5e5e5;--color-border-strong:#d4d4d4;--color-text:#171717;--color-text-secondary:#525252;--color-text-muted:#a3a3a3;--color-primary:#171717;--color-primary-hover:#000000;--color-primary-soft:#f5f5f5;--color-primary-soft-text:#171717;--color-accent:#0070f3;--color-ok:#0070f3;--color-ok-soft:#f0f7ff;--color-ok-border:#bfdbfe;--color-warn:#f5a623;--color-warn-soft:#fffbeb;--color-warn-border:#fde68a;--color-danger:#e5484d;--color-danger-soft:#fef2f2;--color-danger-border:#fecaca;--color-ring:rgba(0,112,243,.4);--color-card-border:#e5e5e5;--color-hero-border:#e5e5e5;--color-hero-bg:#ffffff}}
@media (prefers-color-scheme:dark){:root{--color-bg:#0a0a0a;--color-surface:#111111;--color-surface-2:#1a1a1a;--color-surface-3:#262626;--color-overlay:#111111;--color-border:#262626;--color-border-strong:#404040;--color-text:#ededed;--color-text-secondary:#a3a3a3;--color-text-muted:#525252;--color-primary:#ededed;--color-primary-hover:#ffffff;--color-primary-soft:#1a1a1a;--color-primary-soft-text:#ffffff;--color-accent:#3291ff;--color-ok:#3291ff;--color-ok-soft:rgba(50,145,255,.1);--color-ok-border:rgba(50,145,255,.3);--color-warn:#f5a623;--color-warn-soft:rgba(245,166,35,.1);--color-warn-border:rgba(245,166,35,.3);--color-danger:#ff6366;--color-danger-soft:rgba(255,99,102,.1);--color-danger-border:rgba(255,99,102,.3);--color-ring:rgba(50,145,255,.5);--color-card-border:#262626;--color-hero-border:#262626;--color-hero-bg:#111111}}
[data-theme="light"]{color-scheme:light;--color-bg:#fafafa;--color-surface:#ffffff;--color-surface-2:#f5f5f5;--color-surface-3:#ededed;--color-overlay:#ffffff;--color-border:#e5e5e5;--color-border-strong:#d4d4d4;--color-text:#171717;--color-text-secondary:#525252;--color-text-muted:#a3a3a3;--color-primary:#171717;--color-primary-hover:#000000;--color-primary-soft:#f5f5f5;--color-primary-soft-text:#171717;--color-accent:#0070f3;--color-ok:#0070f3;--color-ok-soft:#f0f7ff;--color-ok-border:#bfdbfe;--color-warn:#f5a623;--color-warn-soft:#fffbeb;--color-warn-border:#fde68a;--color-danger:#e5484d;--color-danger-soft:#fef2f2;--color-danger-border:#fecaca;--color-ring:rgba(0,112,243,.4);--color-card-border:#e5e5e5;--color-hero-border:#e5e5e5;--color-hero-bg:#ffffff}
[data-theme="dark"]{color-scheme:dark;--color-bg:#0a0a0a;--color-surface:#111111;--color-surface-2:#1a1a1a;--color-surface-3:#262626;--color-overlay:#111111;--color-border:#262626;--color-border-strong:#404040;--color-text:#ededed;--color-text-secondary:#a3a3a3;--color-text-muted:#525252;--color-primary:#ededed;--color-primary-hover:#ffffff;--color-primary-soft:#1a1a1a;--color-primary-soft-text:#ffffff;--color-accent:#3291ff;--color-ok:#3291ff;--color-ok-soft:rgba(50,145,255,.1);--color-ok-border:rgba(50,145,255,.3);--color-warn:#f5a623;--color-warn-soft:rgba(245,166,35,.1);--color-warn-border:rgba(245,166,35,.3);--color-danger:#ff6366;--color-danger-soft:rgba(255,99,102,.1);--color-danger-border:rgba(255,99,102,.3);--color-ring:rgba(50,145,255,.5);--color-card-border:#262626;--color-hero-border:#262626;--color-hero-bg:#111111}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-sans);background:var(--color-bg);color:var(--color-text);line-height:1.5;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;min-height:100vh;min-height:100dvh;font-feature-settings:"cv11","ss01"}
main{max-width:1200px;margin:0 auto;padding:var(--space-7) var(--space-5) var(--space-8);padding-top:max(var(--space-7),env(safe-area-inset-top));padding-bottom:max(var(--space-8),env(safe-area-inset-bottom))}
h1{font-size:clamp(24px,3vw,32px);line-height:1.2;letter-spacing:-.02em;margin:0;font-weight:700}
h2{font-size:16px;line-height:1.4;letter-spacing:-.01em;margin:0 0 var(--space-2);font-weight:600}
p{margin:0}
a{color:var(--color-accent);text-decoration:none;transition:color var(--transition)}
a:hover{color:var(--color-primary-hover)}
.icon{width:20px;height:20px;flex-shrink:0;stroke-width:2;stroke:currentColor;fill:none;stroke-linecap:round;stroke-linejoin:round}
.icon-sm{width:16px;height:16px}
.icon-lg{width:24px;height:24px}
.theme-toggle{position:fixed;top:max(var(--space-4),env(safe-area-inset-top));right:var(--space-4);z-index:50;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-text-secondary);cursor:pointer;transition:border-color var(--transition),color var(--transition)}
.theme-toggle:hover{border-color:var(--color-border-strong);color:var(--color-text)}
.theme-toggle:active{transform:scale(.96)}
.theme-toggle:focus-visible{outline:none;box-shadow:var(--ring)}
.theme-toggle .icon-sun{display:none}
.theme-toggle .icon-moon{display:block}
[data-theme="dark"] .theme-toggle .icon-sun{display:block}
[data-theme="dark"] .theme-toggle .icon-moon{display:none}
@media (prefers-color-scheme:dark){.theme-toggle .icon-sun{display:block}.theme-toggle .icon-moon{display:none}}
@media (prefers-color-scheme:dark){[data-theme="light"] .theme-toggle .icon-sun{display:none}[data-theme="light"] .theme-toggle .icon-moon{display:block}}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-5);margin-bottom:var(--space-6);padding:0 0 var(--space-4) 0;border-bottom:1px solid var(--color-border)}
.hero.compact{display:block;max-width:560px;margin:var(--space-8) auto var(--space-5)}
.hero-copy{max-width:680px;margin:var(--space-2) 0 0;color:var(--color-text-secondary);font-size:14px;line-height:1.6}
.back-link{width:max-content;display:inline-flex;align-items:center;gap:var(--space-2);margin:0 0 var(--space-3);padding:5px var(--space-3);border:1px solid var(--color-border);border-radius:999px;background:var(--color-surface);color:var(--color-text-secondary);font-size:13px;font-weight:500;box-shadow:var(--shadow-sm);transition:background var(--transition),border-color var(--transition),color var(--transition),transform var(--transition)}
.back-link:hover{background:var(--color-surface-2);border-color:var(--color-border-strong);color:var(--color-text)}
.back-link:active{transform:translateX(-1px)}
.back-link:focus-visible{outline:none;box-shadow:var(--ring)}
.eyebrow{margin:0 0 var(--space-1);color:var(--color-text-muted);font-size:12px;font-weight:500;letter-spacing:0;text-transform:none}
.dashboard-shell{display:grid;grid-template-columns:240px minmax(0,1fr);gap:var(--space-6);align-items:start}
.sidebar{position:sticky;top:var(--space-5);display:grid;gap:var(--space-3)}
.card,.config-section{background:var(--color-surface);border:1px solid var(--color-card-border);border-radius:var(--radius-md);box-shadow:var(--shadow-sm)}
.card{padding:var(--space-4)}
.config-panel{padding:0;background:transparent;border:0;box-shadow:none}
.status-card{border-left:2px solid var(--color-border-strong)}
.status-card .section-heading{display:flex;align-items:center;gap:var(--space-2)}
.status-card .section-heading .icon{color:var(--color-text-secondary)}
.setup-card{background:var(--color-surface)}
.progress-number{font-size:24px;font-weight:700;letter-spacing:-.03em;line-height:1;margin-top:var(--space-1)}
.progress-track{height:4px;border-radius:999px;background:var(--color-surface-3);overflow:hidden;margin-top:var(--space-2)}
.progress-track span{display:block;height:100%;border-radius:inherit;background:var(--color-accent);transition:width 300ms var(--ease-out)}
.quick-nav{display:grid;gap:var(--space-1)}
.ops-link{display:block;width:100%;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--color-text-secondary);text-align:left;font:inherit;font-weight:500;font-size:13px;padding:var(--space-2) var(--space-3);cursor:pointer;text-decoration:none;transition:background var(--transition),color var(--transition)}
.ops-link:hover{background:var(--color-surface-2);color:var(--color-text)}
.ops-link:active{transform:scale(.98)}
.tab-button{width:100%;border:1px solid transparent;border-radius:var(--radius-sm);background:transparent;color:var(--color-text-secondary);text-align:left;font-weight:500;font:inherit;font-weight:500;font-size:13px;padding:var(--space-2) var(--space-3);cursor:pointer;transition:background var(--transition),color var(--transition);position:relative}
.tab-button:hover{background:var(--color-surface-2);color:var(--color-text)}
.tab-button:active{transform:scale(.98)}
.tab-button.active{border-color:transparent;color:var(--color-text);background:var(--color-surface-2)}
.tab-button:focus-visible{outline:none;box-shadow:var(--ring)}
.config-section{display:none;padding:var(--space-5);border-top:0}
.config-section.active{display:block;animation:fade-in 150ms var(--ease-out)}
@keyframes fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.config-section.active{animation:none}.progress-track span,.theme-toggle,.tab-button{transition:none}}
.section-heading{margin-bottom:var(--space-5)}
.split-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4)}
.section-badge{white-space:nowrap;border-radius:999px;background:var(--color-primary-soft);color:var(--color-primary-soft-text);font-size:12px;font-weight:600;padding:var(--space-1) var(--space-3)}
.hint,.field-note,.status-copy{color:var(--color-text-secondary);font-size:14px;line-height:1.65}
.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-5)}
.field{min-width:0}
.single-field{max-width:560px}
.field-note{margin:0 0 var(--space-2);padding:var(--space-2) var(--space-3);border-radius:var(--radius-sm);background:var(--color-surface-2);border:1px solid var(--color-border);font-size:13px}
label{display:block;margin:0 0 var(--space-1);font-weight:500;font-size:13px}
code{display:inline-block;margin-left:var(--space-1);padding:1px var(--space-1);border-radius:4px;background:var(--color-surface-3);color:var(--color-text-secondary);font-family:var(--font-mono);font-size:11px;font-weight:500}
input,select{width:100%;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:8px var(--space-3);font:inherit;font-size:14px;background:var(--color-surface);color:var(--color-text);outline:none;transition:border-color var(--transition),box-shadow var(--transition);min-height:36px}
input::placeholder{color:var(--color-text-muted)}
input:hover,select:hover{border-color:var(--color-border-strong)}
input:focus,select:focus{border-color:var(--color-accent);box-shadow:var(--ring)}
input:disabled,select:disabled{opacity:.5;cursor:not-allowed}
button[type="submit"],button[type="button"].primary{border:1px solid var(--color-primary);border-radius:var(--radius-sm);background:var(--color-primary);color:var(--color-bg);font:inherit;font-weight:600;font-size:14px;padding:8px var(--space-5);cursor:pointer;transition:background var(--transition),transform var(--transition);min-height:36px;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2)}
button[type="submit"]:hover{background:var(--color-primary-hover)}
button[type="submit"]:active{transform:scale(.97)}
button[type="submit"]:focus-visible{outline:none;box-shadow:var(--ring)}
button[type="submit"]:disabled{opacity:.5;cursor:not-allowed;transform:none}
button[type="submit"] .spinner{width:14px;height:14px;border:2px solid rgba(255,255,255,.3);border-top-color:#fff;border-radius:50%;animation:spin 600ms linear infinite;display:none}
button[type="submit"][data-loading="true"] .spinner{display:inline-block}
button[type="submit"][data-loading="true"] .btn-label{opacity:.85}
@keyframes spin{to{transform:rotate(360deg)}}
.form-actions{position:sticky;bottom:var(--space-3);display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-3) var(--space-4);margin-top:var(--space-4);border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface);box-shadow:var(--shadow-md)}
.form-actions strong{display:block;margin-bottom:var(--space-1);font-weight:600;font-size:14px}
.banner{display:flex;align-items:flex-start;gap:var(--space-2);border-radius:var(--radius-sm);padding:var(--space-2) var(--space-3);margin:0 0 var(--space-3);font-weight:500;line-height:1.5;font-size:13px}
.banner .icon{flex-shrink:0;margin-top:1px;width:16px;height:16px}
.banner.success{background:var(--color-ok-soft);color:var(--color-ok);border:1px solid var(--color-ok-border)}
.banner.danger{background:var(--color-danger-soft);color:var(--color-danger);border:1px solid var(--color-danger-border)}
.status-pill{display:inline-flex;align-items:center;gap:var(--space-2);white-space:nowrap;border-radius:999px;padding:4px var(--space-3);font-weight:500;font-size:13px}
.status-pill .dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.status-pill.ok{color:var(--color-ok);background:var(--color-ok-soft);border:1px solid var(--color-ok-border)}
.status-pill.ok .dot{background:var(--color-ok)}
.status-pill.warn{color:var(--color-warn);background:var(--color-warn-soft);border:1px solid var(--color-warn-border)}
.status-pill.warn .dot{background:var(--color-warn)}
.issue-list{display:grid;gap:var(--space-1);margin:0;padding:0;list-style:none}
.issue-list li{display:flex;gap:var(--space-2);padding:var(--space-2) var(--space-3);border-radius:var(--radius-sm);background:var(--color-warn-soft);border:1px solid var(--color-warn-border);color:var(--color-text);font-size:13px}
.issue-list li .icon{color:var(--color-warn);flex-shrink:0;margin-top:1px;width:16px;height:16px}
.issue-list li .issue-content{flex:1;min-width:0}
.issue-list span{display:block;margin-top:var(--space-1);color:var(--color-text-muted);font-size:11px;font-family:var(--font-mono);word-break:break-all}
.login-card{max-width:400px;margin:0 auto}
.login-card button[type="submit"]{width:100%}
footer{color:var(--color-text-muted);font-size:11px;margin-top:var(--space-6);text-align:center;font-family:var(--font-mono)}
@media (max-width:1024px){.dashboard-shell{grid-template-columns:200px minmax(0,1fr)}}
@media (max-width:980px){main{padding:var(--space-6) var(--space-4) var(--space-7)}.dashboard-shell{grid-template-columns:1fr}.sidebar{position:static;grid-template-columns:repeat(2,minmax(0,1fr))}.quick-nav{grid-column:1/-1;display:flex;overflow-x:auto;padding-bottom:var(--space-1);scroll-snap-type:x mandatory}.tab-button{min-width:120px;scroll-snap-align:start;text-align:center}.tab-button.active{box-shadow:inset 0 -2px 0 var(--color-accent)}.config-section{padding:var(--space-4)}}
@media (max-width:640px){h1{font-size:28px}.hero{display:block;padding:var(--space-5);border-radius:var(--radius-lg)}.status-pill{display:inline-flex;margin-top:var(--space-4)}.sidebar{grid-template-columns:1fr}.field-grid{grid-template-columns:1fr}.config-section,.card{border-radius:var(--radius-md);padding:var(--space-4)}.split-heading{display:block}.section-badge{display:inline-block;margin-top:var(--space-2)}.form-actions{display:block;padding:var(--space-4)}.form-actions button[type="submit"]{width:100%;margin-top:var(--space-3)}code{display:block;width:max-content;margin:var(--space-1) 0 0}}
.skip-link{position:absolute;left:-9999px;top:0;z-index:100;padding:var(--space-3) var(--space-4);background:var(--color-primary);color:#fff;border-radius:0 0 var(--radius-sm) 0;font-weight:600}
.skip-link:focus{left:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
${opsExtraCss}
  </style></head><body><a href="#main-content" class="skip-link">跳到主要内容</a><button type="button" class="theme-toggle" aria-label="切换主题" title="切换浅色/暗色模式" onclick="toggleTheme()"><svg class="icon icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg><svg class="icon icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button><main id="main-content">${body}<footer>InboxBridge ${fingerprint}</footer></main><script>
    (function(){
      try{
        var saved=localStorage.getItem("ib-theme");
        if(saved)document.documentElement.setAttribute("data-theme",saved);
      }catch(e){}
      window.toggleTheme=function(){
        var prefersDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;
        var current=document.documentElement.getAttribute("data-theme");
        var next;
        if(current){next=current==="dark"?"light":"dark"}
        else{next=prefersDark?"light":"dark"}
        document.documentElement.setAttribute("data-theme",next);
        try{localStorage.setItem("ib-theme",next)}catch(e){}
      };
    })();
    var form=document.querySelector('form[action="/config"]');
    if(form){
      form.addEventListener('submit',function(){
        var btn=form.querySelector('button[type="submit"]');
        if(btn){btn.setAttribute('data-loading','true');btn.setAttribute('disabled','');var label=btn.querySelector('.btn-label');if(label&&label.dataset.original){label.textContent=label.dataset.original}}
      });
    }
  </script></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

const opsExtraCss = `
.ops-topnav{display:flex;gap:var(--space-1);align-items:center;flex-wrap:wrap;margin-bottom:var(--space-5);padding:0 0 var(--space-3) 0;border-bottom:1px solid var(--color-border)}
.ops-nav-link{color:var(--color-text-secondary);text-decoration:none;font-size:13px;font-weight:500;padding:6px var(--space-3);border-radius:var(--radius-sm);transition:background var(--transition),color var(--transition)}
.ops-nav-link:hover{background:var(--color-surface-2);color:var(--color-text)}
.ops-nav-link.active{color:var(--color-text);background:var(--color-surface-2)}
.ops-nav-sep{color:var(--color-border-strong);margin:0 var(--space-1)}
.ops-link.active{color:var(--color-text);background:var(--color-surface-2)}
.ops-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--space-3);margin-bottom:var(--space-6)}
.ops-card{background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:var(--space-4)}
.ops-card h3{margin:0 0 var(--space-3);font-size:11px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;font-weight:500}
.ops-metric{display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px}
.ops-metric .label{color:var(--color-text-secondary);font-family:var(--font-mono)}
.ops-metric .value{font-family:var(--font-mono);font-weight:600;font-size:15px}
.ops-metric .value.ok{color:var(--color-ok)}
.ops-metric .value.warn{color:var(--color-warn)}
.ops-metric .value.danger{color:var(--color-danger)}
.ops-table{width:100%;border-collapse:collapse;font-size:13px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);overflow:hidden}
.ops-table th{text-align:left;padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--color-border);color:var(--color-text-muted);font-weight:500;font-size:12px;background:var(--color-surface-2)}
.ops-table td{padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--color-border)}
.ops-table tr:last-child td{border-bottom:0}
.ops-table tr:hover td{background:var(--color-surface-2)}
.ops-badge{display:inline-block;padding:1px var(--space-2);border-radius:4px;font-size:11px;font-weight:500;font-family:var(--font-mono)}
.ops-badge.open{background:var(--color-ok-soft);color:var(--color-ok)}
.ops-badge.closed{background:var(--color-surface-3);color:var(--color-text-muted)}
.ops-badge.failed{background:var(--color-warn-soft);color:var(--color-warn)}
.ops-badge.permanent_failure{background:var(--color-danger-soft);color:var(--color-danger)}
.ops-badge.sent,.ops-badge.ready{background:var(--color-ok-soft);color:var(--color-ok)}
.ops-badge.pending{background:var(--color-warn-soft);color:var(--color-warn)}
.ops-btn{padding:3px var(--space-2);border:1px solid var(--color-border-strong);background:transparent;color:var(--color-text-secondary);border-radius:var(--radius-sm);cursor:pointer;font-size:12px;font-family:inherit;transition:background var(--transition),color var(--transition)}
.ops-btn:hover{background:var(--color-surface-2);color:var(--color-text)}
.ops-pager{display:flex;gap:var(--space-1);justify-content:center;margin-top:var(--space-4)}
.ops-pager a{padding:4px var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-sm);text-decoration:none;color:var(--color-text-secondary);font-size:13px;font-family:var(--font-mono)}
.ops-pager a:hover{background:var(--color-surface-2)}
.ops-pager .current{background:var(--color-primary);color:var(--color-bg);border-color:var(--color-primary)}
.ops-empty{text-align:center;padding:var(--space-8);color:var(--color-text-muted);font-size:13px}
.ops-filter-form{display:flex;gap:var(--space-2);margin-bottom:var(--space-3);align-items:flex-end;flex-wrap:wrap}
.ops-filter-form label{font-size:11px;color:var(--color-text-muted);display:block;margin-bottom:var(--space-1)}
.ops-filter-form input,.ops-filter-form select{padding:6px var(--space-2);border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-surface);color:var(--color-text);font:inherit;font-size:13px;min-height:32px}
.ops-uptime{color:var(--color-text-muted);font-size:13px;margin-top:var(--space-4)}
`;

function renderOperationsOverviewBody(data: OperationsOverview, showRetryBanner: boolean): string {
  const banner = showRetryBanner ? `<div class="banner success"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg><span>投递已加入重试队列，将在下次扫描时重试。</span></div>` : "";
  return `
    ${banner}
    <div class="ops-grid">
      <div class="ops-card"><h3>消息总量</h3>
        <div class="ops-metric"><span class="label">入站</span><span class="value">${data.messages.inboundTotal}</span></div>
        <div class="ops-metric"><span class="label">出站</span><span class="value">${data.messages.outboundTotal}</span></div>
        <div class="ops-metric"><span class="label">内部</span><span class="value">${data.messages.internalTotal}</span></div>
      </div>
      <div class="ops-card"><h3>投递状态</h3>
        <div class="ops-metric"><span class="label">pending</span><span class="value ${data.deliveries.pending > 0 ? "warn" : ""}">${data.deliveries.pending}</span></div>
        <div class="ops-metric"><span class="label">sent</span><span class="value ok">${data.deliveries.sent}</span></div>
        <div class="ops-metric"><span class="label">failed</span><span class="value ${data.deliveries.failed > 0 ? "danger" : ""}">${data.deliveries.failed}</span></div>
        <div class="ops-metric"><span class="label">permanent_failure</span><span class="value ${data.deliveries.permanentFailure > 0 ? "danger" : ""}">${data.deliveries.permanentFailure}</span></div>
      </div>
      <div class="ops-card"><h3>会话</h3>
        <div class="ops-metric"><span class="label">open</span><span class="value ok">${data.conversations.open}</span></div>
        <div class="ops-metric"><span class="label">closed</span><span class="value">${data.conversations.closed}</span></div>
      </div>
      <div class="ops-card"><h3>AI 草稿</h3>
        <div class="ops-metric"><span class="label">pending</span><span class="value">${data.aiDrafts.pending}</span></div>
        <div class="ops-metric"><span class="label">ready</span><span class="value ok">${data.aiDrafts.ready}</span></div>
        <div class="ops-metric"><span class="label">failed</span><span class="value">${data.aiDrafts.failed}</span></div>
        <div class="ops-metric"><span class="label">sent</span><span class="value">${data.aiDrafts.sent}</span></div>
        <div class="ops-metric"><span class="label">discarded</span><span class="value">${data.aiDrafts.discarded}</span></div>
      </div>
    </div>
    <p class="ops-uptime">进程运行时长：${Math.floor(data.uptimeSeconds / 3600)}h ${Math.floor((data.uptimeSeconds % 3600) / 60)}m</p>
  `;
}

function renderConversationsBody(
  data: { items: ConversationListItemView[]; total: number },
  page: number,
  status: string | undefined,
  assignedTo: string | undefined,
): string {
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  const buildTabUrl = (params: Record<string, string | undefined>): string => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    const qs = sp.toString();
    return `/operations/conversations${qs ? `?${qs}` : ""}`;
  };
  const filterLinks = ["", "open", "closed"]
    .map((s) => {
      const label = s === "" ? "全部" : s === "open" ? "open" : "closed";
      const active = (status ?? "") === s ? "current" : "";
      return `<a href="${buildTabUrl({ status: s || undefined, assigned_to: assignedTo })}" class="${active}">${label}</a>`;
    })
    .join("");
  const assignedValue = assignedTo ? escapeHtml(assignedTo) : "";
  const buildPageUrl = (p: number): string => buildTabUrl({ status, assigned_to: assignedTo, page: p > 1 ? String(p) : undefined });
  const rows = data.items.length
    ? data.items
        .map(
          (c) => `<tr>
        <td>${c.id}</td>
        <td>${escapeHtml(c.topicName ?? "-")}</td>
        <td>${escapeHtml(c.contactDisplayName ?? "-")}</td>
        <td><span class="ops-badge ${c.status}">${c.status}</span></td>
        <td>${escapeHtml(c.priority)}</td>
        <td>${escapeHtml(c.assignedAdminId ?? "-")}</td>
        <td>${c.lastMessageAt ?? "-"}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="7" class="ops-empty">没有符合条件的会话。</td></tr>`;
  const pager = Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1)
    .map((p) => `<a href="${buildPageUrl(p)}" class="${p === page ? "current" : ""}">${p}</a>`)
    .join("");
  return `
    <h2>会话列表 <span style="color:var(--color-text-muted);font-weight:400">(${data.total})</span></h2>
    <div class="ops-pager" style="justify-content:flex-start;margin-bottom:var(--space-4)">${filterLinks}</div>
    <form method="get" action="/operations/conversations" class="ops-filter-form">
      <div><label>负责人 ID</label><input type="text" name="assigned_to" value="${assignedValue}" placeholder="可选"></div>
      <button type="submit" class="ops-btn">筛选</button>
    </form>
    <table class="ops-table">
      <thead><tr><th>ID</th><th>Topic</th><th>联系人</th><th>状态</th><th>优先级</th><th>负责人</th><th>最后消息</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${totalPages > 1 ? `<div class="ops-pager">${pager}</div>` : ""}
  `;
}

function renderDeliveriesBody(
  data: { items: DeliveryView[]; total: number },
  page: number,
): string {
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  const rows = data.items.length
    ? data.items
        .map(
          (d) => `<tr>
        <td>${d.id}</td>
        <td style="font-family:var(--font-mono);font-size:13px">${escapeHtml(d.target)}</td>
        <td><span class="ops-badge ${d.status}">${d.status}</span></td>
        <td>${d.attemptCount}/8</td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(d.lastError ?? "-")}</td>
        <td>${d.createdAt}</td>
        <td>${d.nextRetryAt ?? "-"}</td>
        <td>${d.status === "failed" ? `<form method="post" action="/operations/deliveries/retry" style="display:inline"><input type="hidden" name="delivery_id" value="${d.id}"><button type="submit" class="ops-btn">重试</button></form>` : "-"}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="8" class="ops-empty">没有失败投递记录。</td></tr>`;
  const pager = Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1)
    .map((p) => `<a href="/operations/deliveries?page=${p}" class="${p === page ? "current" : ""}">${p}</a>`)
    .join("");
  return `
    <h2>失败投递队列 <span style="color:var(--color-text-muted);font-weight:400">(${data.total})</span></h2>
    <table class="ops-table">
      <thead><tr><th>ID</th><th>目标</th><th>状态</th><th>尝试</th><th>最后错误</th><th>创建时间</th><th>下次重试</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${totalPages > 1 ? `<div class="ops-pager">${pager}</div>` : ""}
  `;
}

function renderAuditLogsBody(
  data: { items: AuditLogView[]; total: number },
  page: number,
  adminId: string | undefined,
  action: string | undefined,
): string {
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  const actionOptions = auditActionOptions
    .map((a) => `<option value="${a}" ${action === a ? "selected" : ""}>${a}</option>`)
    .join("");
  const adminValue = adminId ? escapeHtml(adminId) : "";
  const buildTabUrl = (p: number): string => {
    const sp = new URLSearchParams({ tab: "audit" });
    if (p > 1) sp.set("page", String(p));
    if (adminId) sp.set("admin_id", adminId);
    if (action) sp.set("action", action);
    const qs = sp.toString();
    return `/operations/audit${qs ? `?${qs}` : ""}`;
  };
  const rows = data.items.length
    ? data.items
        .map(
          (a) => `<tr>
        <td>${a.id}</td>
        <td>${escapeHtml(a.createdAt)}</td>
        <td>${escapeHtml(a.adminId)}</td>
        <td>${a.conversationId}</td>
        <td><span class="ops-badge">${escapeHtml(a.action)}</span></td>
        <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.detail ?? "-")}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="6" class="ops-empty">没有符合条件的审计记录。</td></tr>`;
  const pager = Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1)
    .map((p) => `<a href="${buildTabUrl(p)}" class="${p === page ? "current" : ""}">${p}</a>`)
    .join("");
  return `
    <h2>审计日志 <span style="color:var(--color-text-muted);font-weight:400">(${data.total})</span></h2>
    <form method="get" action="/operations/audit" class="ops-filter-form">
      <div><label>管理员 ID</label><input type="text" name="admin_id" value="${adminValue}" placeholder="可选"></div>
      <div><label>操作类型</label><select name="action"><option value="">全部</option>${actionOptions}</select></div>
      <button type="submit" class="ops-btn">筛选</button>
    </form>
    <table class="ops-table">
      <thead><tr><th>ID</th><th>时间</th><th>管理员</th><th>会话 ID</th><th>操作</th><th>详情</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${totalPages > 1 ? `<div class="ops-pager">${pager}</div>` : ""}
  `;
}

function renderSearchBody(
  data: { items: MessageSearchView[]; total: number },
  query: string,
  page: number,
): string {
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(data.total / pageSize));
  const queryValue = escapeHtml(query);
  const buildTabUrl = (p: number): string => {
    const sp = new URLSearchParams();
    if (query) sp.set("q", query);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return `/operations/search${qs ? `?${qs}` : ""}`;
  };
  const rows = data.items.length
    ? data.items
        .map(
          (m) => `<tr>
        <td>${m.id}</td>
        <td>${escapeHtml(m.createdAt)}</td>
        <td>${m.conversationId}</td>
        <td>${escapeHtml(m.topicName ?? "-")}</td>
        <td>${escapeHtml(m.contactDisplayName ?? "-")}</td>
        <td><span class="ops-badge">${escapeHtml(m.direction)}</span></td>
        <td style="max-width:400px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.text ?? `[${m.messageType}]`)}</td>
      </tr>`,
        )
        .join("")
    : query.trim()
      ? `<tr><td colspan="7" class="ops-empty">未找到匹配的消息。</td></tr>`
      : `<tr><td colspan="7" class="ops-empty">输入关键词开始搜索。</td></tr>`;
  const pager = Array.from({ length: Math.min(totalPages, 10) }, (_, i) => i + 1)
    .map((p) => `<a href="${buildTabUrl(p)}" class="${p === page ? "current" : ""}">${p}</a>`)
    .join("");
  return `
    <h2>消息搜索${query.trim() ? ` <span style="color:var(--color-text-muted);font-weight:400">(${data.total})</span>` : ""}</h2>
    <form method="get" action="/operations/search" class="ops-filter-form" style="align-items:center">
      <input type="text" name="q" value="${queryValue}" placeholder="搜索消息内容..." style="flex:1;min-width:240px">
      <button type="submit" class="ops-btn">搜索</button>
    </form>
    <table class="ops-table">
      <thead><tr><th>ID</th><th>时间</th><th>会话</th><th>Topic</th><th>联系人</th><th>方向</th><th>内容</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${totalPages > 1 ? `<div class="ops-pager">${pager}</div>` : ""}
  `;
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("location", location);
  res.end();
}

function send(res: ServerResponse, statusCode: number, contentType: string, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", contentType);
  res.end(body);
}
