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

export interface WebConsoleOptions {
  settings: AppSettingsService;
  port: number;
  getStatus: () => ConsoleStatus;
  onConfigSaved: () => Promise<void>;
  telegramWebhook?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

type SessionKind = "password" | "setup";

class FormBodyTooLargeError extends Error {}

export function ensureSetupToken(settings: AppSettingsService): string | undefined {
  if (settings.get(passwordHashKey)) return undefined;
  const existing = settings.get(setupTokenKey);
  if (existing) return existing;
  const token = randomBytes(16).toString("hex");
  settings.setMany({ [setupTokenKey]: token });
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

      if (url.pathname === "/login" && req.method === "GET") {
        renderLogin(res, options.settings);
        return;
      }

      if (url.pathname === "/login" && req.method === "POST") {
        const form = await readForm(req);
        const sessionKind = loginSessionKind(options.settings, form);
        if (sessionKind) {
          const session = randomBytes(24).toString("hex");
          sessions.set(session, sessionKind);
          res.setHeader("set-cookie", `${sessionCookie}=${session}; HttpOnly; SameSite=Lax; Path=/`);
          redirect(res, "/");
          return;
        }
        renderLogin(res, options.settings, "登录凭据无效。");
        return;
      }

      const sessionKind = authenticatedSessionKind(req, sessions);
      if (!sessionKind) {
        redirect(res, "/login");
        return;
      }

      if (url.pathname === "/" && req.method === "GET") {
        renderDashboard(res, options.settings, options.getStatus(), url.searchParams.get("saved") === "1");
        return;
      }

      if (url.pathname === "/config" && req.method === "POST") {
        const form = await readForm(req);
        const values = configValuesFromForm(options.settings, form);
        const password = form.get("WEB_CONSOLE_PASSWORD")?.trim();
        if (sessionKind === "setup" && !password) {
          send(res, 400, "text/plain", "首次配置必须设置控制台密码。");
          return;
        }
        if (password) values[passwordHashKey] = hashPassword(password);
        if (password) values[setupTokenKey] = "";
        options.settings.setMany(values);
        await options.onConfigSaved();
        redirect(res, "/?saved=1");
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

function renderLogin(res: ServerResponse, settings: AppSettingsService, error = ""): void {
  const hasPassword = Boolean(settings.get(passwordHashKey));
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
        <button type="submit"><span class="spinner" aria-hidden="true"></span><span class="btn-label">进入控制台</span></button>
      </form>`),
  );
}

function renderDashboard(res: ServerResponse, settings: AppSettingsService, status: ConsoleStatus, saved: boolean): void {
  const stored = settings.all();
  const needsPassword = !settings.get(passwordHashKey);
  const completedRequired = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_MANAGEMENT_CHAT_ID", "TELEGRAM_ADMIN_USER_IDS"].filter(
    (key) => Boolean(stored[key]),
  ).length;
  const issueList = status.issues.length
    ? `<ul class="issue-list">${status.issues.map((issue) => `<li><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/></svg><span class="issue-content">${translateIssue(issue)}</span></li>`).join("")}</ul>`
    : `<p class="status-copy"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="vertical-align:-4px;margin-right:6px;color:var(--color-ok)"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg>配置完整，bot 可以正常启动。</p>`;
  const groups = fieldGroups.map((group) => renderGroup(group, stored)).join("\n");
  const navigation = ["访问安全", ...fieldGroups.map((group) => group.title)]
    .map(
      (title, index) =>
        `<button type="button" class="tab-button${index === 0 ? " active" : ""}" data-tab="tab-${index}" aria-selected="${index === 0 ? "true" : "false"}">${escapeHtml(title)}</button>`,
    )
    .join("");
  const statusRunning = status.bot === "running";
  send(
    res,
    200,
    "text/html; charset=utf-8",
    page("InboxBridge 控制台", `
      <section class="hero">
        <div>
          <p class="eyebrow">InboxBridge</p>
          <h1>控制台</h1>
          <p class="hero-copy">集中管理 bot 连接、管理员白名单、数据保留、限流和 AI 草稿。常规部署无需手写环境变量。</p>
        </div>
        <span class="status-pill ${statusRunning ? "ok" : "warn"}" role="status"><span class="dot" aria-hidden="true"></span>${statusRunning ? "Bot 运行中" : "Bot 待配置"}</span>
      </section>
      ${saved ? `<p class="banner success" role="status"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/></svg><span>配置已保存，运行状态已刷新。</span></p>` : ""}
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
          <nav class="card quick-nav" aria-label="配置页切换">
            <p class="eyebrow">配置页</p>
            ${navigation}
          </nav>
        </aside>
        <form method="post" action="/config" class="config-panel" aria-label="配置表单">
          <section class="config-section access-section tab-panel active" data-panel="tab-0" aria-hidden="false">
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
            </div>
          </section>
          ${groups}
          <div class="form-actions">
            <div>
              <strong>保存后立即生效</strong>
              <p class="hint">系统会重新读取配置；配置完整时 bot 会自动启动。</p>
            </div>
            <button type="submit"><span class="spinner" aria-hidden="true"></span><span class="btn-label">保存并重启 Bot</span></button>
          </div>
        </form>
      </div>`),
  );
}

function renderGroup(group: (typeof fieldGroups)[number], stored: NodeJS.ProcessEnv): string {
  const index = fieldGroups.indexOf(group) + 1;
  return `<section class="config-section tab-panel" data-panel="tab-${index}" aria-hidden="true">
    <div class="section-heading split-heading">
      <div>
        <p class="eyebrow">配置分组 ${index}</p>
        <h2>${escapeHtml(group.title)}</h2>
        <p class="hint">${escapeHtml(group.description)}</p>
      </div>
      <span class="section-badge">${group.fields.length} 项</span>
    </div>
    <div class="field-grid">
      ${group.fields.map((field) => renderField(field, stored[field.key] ?? "")).join("\n")}
    </div>
  </section>`;
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

function configValuesFromForm(settings: AppSettingsService, form: URLSearchParams): Record<string, string> {
  const current = settings.all();
  const values: Record<string, string> = {};
  for (const key of editableConfigKeys) {
    const value = form.get(key)?.trim() ?? "";
    if (sensitiveConfigKeys.has(key) && !value && current[key]) continue;
    values[key] = value;
  }
  return values;
}

function loginSessionKind(settings: AppSettingsService, form: URLSearchParams): SessionKind | undefined {
  const hash = settings.get(passwordHashKey);
  if (hash) return verifyPassword(form.get("password") ?? "", hash) ? "password" : undefined;
  return settings.get(setupTokenKey) && form.get("setupToken") === settings.get(setupTokenKey) ? "setup" : undefined;
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#f6f8fc" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b1220" media="(prefers-color-scheme: dark)"><title>${escapeHtml(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet"><style>
:root{color-scheme:light dark;--font-sans:"Fira Sans",ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:"Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace;--radius-xs:8px;--radius-sm:12px;--radius-md:16px;--radius-lg:20px;--radius-xl:24px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-7:32px;--space-8:40px;--shadow-sm:0 1px 2px rgba(15,23,42,.06);--shadow-md:0 8px 24px rgba(15,23,42,.08);--shadow-lg:0 18px 48px rgba(15,23,42,.12);--ring:0 0 0 3px var(--color-ring);--transition:160ms cubic-bezier(.4,0,.2,1);--ease-out:cubic-bezier(0,.55,.45,1)}
@media (prefers-color-scheme:light){:root{--color-bg:#f6f8fc;--color-bg-gradient:radial-gradient(circle at 12% -8%,#dbe7ff 0,#f6f8fc 38%,#ffffff 100%);--color-surface:#ffffff;--color-surface-2:#f8fafc;--color-surface-3:#f1f5f9;--color-overlay:rgba(255,255,255,.92);--color-border:#e2e8f0;--color-border-strong:#cbd5e1;--color-text:#0f172a;--color-text-secondary:#475569;--color-text-muted:#94a3b8;--color-primary:#2563eb;--color-primary-hover:#1d4ed8;--color-primary-soft:#eff4ff;--color-primary-soft-text:#1e40af;--color-accent:#0ea5e9;--color-ok:#059669;--color-ok-soft:#ecfdf5;--color-ok-border:#a7f3d0;--color-warn:#d97706;--color-warn-soft:#fffbeb;--color-warn-border:#fde68a;--color-danger:#dc2626;--color-danger-soft:#fef2f2;--color-danger-border:#fecaca;--color-ring:rgba(37,99,235,.35);--color-card-border:rgba(226,232,240,.8);--color-hero-border:rgba(37,99,235,.16);--color-hero-bg:linear-gradient(135deg,#ffffff,#eff4ff)}}
@media (prefers-color-scheme:dark){:root{--color-bg:#0b1220;--color-bg-gradient:radial-gradient(circle at 12% -8%,#1e293b 0,#0b1220 42%,#020617 100%);--color-surface:#111a2e;--color-surface-2:#0e1626;--color-surface-3:#16223a;--color-overlay:rgba(17,26,46,.86);--color-border:#1f2a40;--color-border-strong:#334155;--color-text:#f1f5f9;--color-text-secondary:#94a3b8;--color-text-muted:#64748b;--color-primary:#3b82f6;--color-primary-hover:#60a5fa;--color-primary-soft:rgba(59,130,246,.14);--color-primary-soft-text:#93c5fd;--color-accent:#38bdf8;--color-ok:#10b981;--color-ok-soft:rgba(16,185,129,.12);--color-ok-border:rgba(16,185,129,.34);--color-warn:#f59e0b;--color-warn-soft:rgba(245,158,11,.12);--color-warn-border:rgba(245,158,11,.34);--color-danger:#ef4444;--color-danger-soft:rgba(239,68,68,.12);--color-danger-border:rgba(239,68,68,.34);--color-ring:rgba(59,130,246,.45);--color-card-border:rgba(31,42,64,.8);--color-hero-border:rgba(59,130,246,.24);--color-hero-bg:linear-gradient(135deg,#111a2e,#1a2740)}}
[data-theme="light"]{color-scheme:light;--color-bg:#f6f8fc;--color-bg-gradient:radial-gradient(circle at 12% -8%,#dbe7ff 0,#f6f8fc 38%,#ffffff 100%);--color-surface:#ffffff;--color-surface-2:#f8fafc;--color-surface-3:#f1f5f9;--color-overlay:rgba(255,255,255,.92);--color-border:#e2e8f0;--color-border-strong:#cbd5e1;--color-text:#0f172a;--color-text-secondary:#475569;--color-text-muted:#94a3b8;--color-primary:#2563eb;--color-primary-hover:#1d4ed8;--color-primary-soft:#eff4ff;--color-primary-soft-text:#1e40af;--color-accent:#0ea5e9;--color-ok:#059669;--color-ok-soft:#ecfdf5;--color-ok-border:#a7f3d0;--color-warn:#d97706;--color-warn-soft:#fffbeb;--color-warn-border:#fde68a;--color-danger:#dc2626;--color-danger-soft:#fef2f2;--color-danger-border:#fecaca;--color-ring:rgba(37,99,235,.35);--color-card-border:rgba(226,232,240,.8);--color-hero-border:rgba(37,99,235,.16);--color-hero-bg:linear-gradient(135deg,#ffffff,#eff4ff)}
[data-theme="dark"]{color-scheme:dark;--color-bg:#0b1220;--color-bg-gradient:radial-gradient(circle at 12% -8%,#1e293b 0,#0b1220 42%,#020617 100%);--color-surface:#111a2e;--color-surface-2:#0e1626;--color-surface-3:#16223a;--color-overlay:rgba(17,26,46,.86);--color-border:#1f2a40;--color-border-strong:#334155;--color-text:#f1f5f9;--color-text-secondary:#94a3b8;--color-text-muted:#64748b;--color-primary:#3b82f6;--color-primary-hover:#60a5fa;--color-primary-soft:rgba(59,130,246,.14);--color-primary-soft-text:#93c5fd;--color-accent:#38bdf8;--color-ok:#10b981;--color-ok-soft:rgba(16,185,129,.12);--color-ok-border:rgba(16,185,129,.34);--color-warn:#f59e0b;--color-warn-soft:rgba(245,158,11,.12);--color-warn-border:rgba(245,158,11,.34);--color-danger:#ef4444;--color-danger-soft:rgba(239,68,68,.12);--color-danger-border:rgba(239,68,68,.34);--color-ring:rgba(59,130,246,.45);--color-card-border:rgba(31,42,64,.8);--color-hero-border:rgba(59,130,246,.24);--color-hero-bg:linear-gradient(135deg,#111a2e,#1a2740)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font-family:var(--font-sans);background:var(--color-bg);background-image:var(--color-bg-gradient);background-attachment:fixed;color:var(--color-text);line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;min-height:100vh;min-height:100dvh}
main{max-width:1240px;margin:0 auto;padding:var(--space-7) var(--space-5) var(--space-8);padding-top:max(var(--space-7),env(safe-area-inset-top));padding-bottom:max(var(--space-8),env(safe-area-inset-bottom))}
h1{font-size:clamp(28px,4vw,40px);line-height:1.1;letter-spacing:-.02em;margin:0;font-weight:700}
h2{font-size:20px;line-height:1.3;letter-spacing:-.01em;margin:0 0 var(--space-2);font-weight:600}
p{margin:0}
a{color:var(--color-primary);text-decoration:none;transition:color var(--transition)}
a:hover{color:var(--color-primary-hover)}
.icon{width:20px;height:20px;flex-shrink:0;stroke-width:2;stroke:currentColor;fill:none;stroke-linecap:round;stroke-linejoin:round}
.icon-sm{width:16px;height:16px}
.icon-lg{width:24px;height:24px}
.theme-toggle{position:fixed;top:max(var(--space-4),env(safe-area-inset-top));right:var(--space-4);z-index:50;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--color-border);border-radius:var(--radius-full,999px);background:var(--color-overlay);color:var(--color-text);cursor:pointer;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:var(--shadow-sm);transition:border-color var(--transition),background var(--transition),transform var(--transition)}
.theme-toggle:hover{border-color:var(--color-border-strong);transform:scale(1.05)}
.theme-toggle:active{transform:scale(.95)}
.theme-toggle:focus-visible{outline:none;box-shadow:var(--ring)}
.theme-toggle .icon-sun{display:none}
.theme-toggle .icon-moon{display:block}
[data-theme="dark"] .theme-toggle .icon-sun{display:block}
[data-theme="dark"] .theme-toggle .icon-moon{display:none}
@media (prefers-color-scheme:dark){.theme-toggle .icon-sun{display:block}.theme-toggle .icon-moon{display:none}}
@media (prefers-color-scheme:dark){[data-theme="light"] .theme-toggle .icon-sun{display:none}[data-theme="light"] .theme-toggle .icon-moon{display:block}}
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:var(--space-5);margin-bottom:var(--space-5);padding:var(--space-6);border:1px solid var(--color-hero-border);border-radius:var(--radius-xl);background:var(--color-hero-bg);box-shadow:var(--shadow-md)}
.hero.compact{display:block;max-width:560px;margin:var(--space-8) auto var(--space-5)}
.hero-copy{max-width:680px;margin:var(--space-3) 0 0;color:var(--color-text-secondary);font-size:16px;line-height:1.65}
.eyebrow{margin:0 0 var(--space-2);color:var(--color-primary);font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.dashboard-shell{display:grid;grid-template-columns:300px minmax(0,1fr);gap:var(--space-5);align-items:start}
.sidebar{position:sticky;top:var(--space-5);display:grid;gap:var(--space-4)}
.card,.config-section{background:var(--color-overlay);border:1px solid var(--color-card-border);border-radius:var(--radius-lg);box-shadow:var(--shadow-md);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.card{padding:var(--space-5)}
.config-panel{padding:0;background:transparent;border:0;box-shadow:none}
.status-card{border-left:4px solid var(--color-primary)}
.status-card .section-heading{display:flex;align-items:center;gap:var(--space-2)}
.status-card .section-heading .icon{color:var(--color-primary)}
.setup-card{background:linear-gradient(180deg,var(--color-surface),var(--color-surface-2))}
.progress-number{font-size:36px;font-weight:700;letter-spacing:-.04em;line-height:1;margin-top:var(--space-1)}
.progress-track{height:8px;border-radius:999px;background:var(--color-surface-3);overflow:hidden;margin-top:var(--space-3)}
.progress-track span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--color-primary),var(--color-accent));transition:width 400ms var(--ease-out)}
.quick-nav{display:grid;gap:var(--space-2)}
.tab-button{width:100%;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface-2);color:var(--color-text);text-align:left;font-weight:500;font:inherit;font-weight:500;padding:var(--space-3) var(--space-4);cursor:pointer;transition:border-color var(--transition),background var(--transition),color var(--transition),transform var(--transition);position:relative}
.tab-button:hover{border-color:var(--color-primary);color:var(--color-primary);background:var(--color-primary-soft)}
.tab-button:active{transform:scale(.98)}
.tab-button.active{border-color:var(--color-primary);color:var(--color-primary);background:var(--color-primary-soft);box-shadow:inset 4px 0 0 var(--color-primary)}
.tab-button:focus-visible{outline:none;box-shadow:var(--ring)}
.config-section{display:none;padding:var(--space-6);border-top:4px solid var(--color-primary)}
.config-section.active{display:block;animation:fade-in 220ms var(--ease-out)}
@keyframes fade-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion:reduce){.config-section.active{animation:none}.progress-track span,.theme-toggle,.tab-button{transition:none}}
.section-heading{margin-bottom:var(--space-5)}
.split-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-4)}
.section-badge{white-space:nowrap;border-radius:999px;background:var(--color-primary-soft);color:var(--color-primary-soft-text);font-size:12px;font-weight:600;padding:var(--space-1) var(--space-3)}
.hint,.field-note,.status-copy{color:var(--color-text-secondary);font-size:14px;line-height:1.65}
.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-5)}
.field{min-width:0}
.single-field{max-width:560px}
.field-note{margin:0 0 var(--space-2);padding:var(--space-3) var(--space-3);border-radius:var(--radius-sm);background:var(--color-surface-2);border:1px solid var(--color-border)}
label{display:block;margin:0 0 var(--space-2);font-weight:500}
code{display:inline-block;margin-left:var(--space-1);padding:2px var(--space-2);border-radius:6px;background:var(--color-primary-soft);color:var(--color-primary-soft-text);font-family:var(--font-mono);font-size:12px;font-weight:500}
input,select{width:100%;border:1px solid var(--color-border-strong);border-radius:var(--radius-sm);padding:11px var(--space-3);font:inherit;background:var(--color-surface);color:var(--color-text);outline:none;transition:border-color var(--transition),box-shadow var(--transition);min-height:44px}
input::placeholder{color:var(--color-text-muted)}
input:hover,select:hover{border-color:var(--color-primary)}
input:focus,select:focus{border-color:var(--color-primary);box-shadow:var(--ring)}
input:disabled,select:disabled{opacity:.5;cursor:not-allowed}
button[type="submit"],button[type="button"].primary{border:0;border-radius:var(--radius-sm);background:var(--color-primary);color:#fff;font:inherit;font-weight:600;padding:12px var(--space-6);cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,.28);transition:background var(--transition),transform var(--transition),box-shadow var(--transition);min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2)}
button[type="submit"]:hover{background:var(--color-primary-hover);box-shadow:0 6px 20px rgba(37,99,235,.36)}
button[type="submit"]:active{transform:scale(.97)}
button[type="submit"]:focus-visible{outline:none;box-shadow:var(--ring),0 4px 14px rgba(37,99,235,.28)}
button[type="submit"]:disabled{opacity:.6;cursor:not-allowed;transform:none}
button[type="submit"] .spinner{width:18px;height:18px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:spin 600ms linear infinite;display:none}
button[type="submit"][data-loading="true"] .spinner{display:inline-block}
button[type="submit"][data-loading="true"] .btn-label{opacity:.85}
@keyframes spin{to{transform:rotate(360deg)}}
.form-actions{position:sticky;bottom:var(--space-4);display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);padding:var(--space-4) var(--space-5);margin-top:var(--space-4);border:1px solid var(--color-card-border);border-radius:var(--radius-lg);background:var(--color-overlay);box-shadow:var(--shadow-lg);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
.form-actions strong{display:block;margin-bottom:var(--space-1);font-weight:600}
.banner{display:flex;align-items:flex-start;gap:var(--space-3);border-radius:var(--radius-md);padding:var(--space-3) var(--space-4);margin:0 0 var(--space-4);font-weight:500;line-height:1.55}
.banner .icon{flex-shrink:0;margin-top:1px}
.banner.success{background:var(--color-ok-soft);color:var(--color-ok);border:1px solid var(--color-ok-border)}
.banner.danger{background:var(--color-danger-soft);color:var(--color-danger);border:1px solid var(--color-danger-border)}
.status-pill{display:inline-flex;align-items:center;gap:var(--space-2);white-space:nowrap;border-radius:999px;padding:8px var(--space-4);font-weight:600;font-size:14px}
.status-pill .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.status-pill.ok{color:var(--color-ok);background:var(--color-ok-soft);border:1px solid var(--color-ok-border)}
.status-pill.ok .dot{background:var(--color-ok);box-shadow:0 0 0 3px var(--color-ok-soft)}
.status-pill.warn{color:var(--color-warn);background:var(--color-warn-soft);border:1px solid var(--color-warn-border)}
.status-pill.warn .dot{background:var(--color-warn);box-shadow:0 0 0 3px var(--color-warn-soft)}
.issue-list{display:grid;gap:var(--space-2);margin:0;padding:0;list-style:none}
.issue-list li{display:flex;gap:var(--space-3);padding:var(--space-3) var(--space-4);border-radius:var(--radius-md);background:var(--color-warn-soft);border:1px solid var(--color-warn-border);color:var(--color-text)}
.issue-list li .icon{color:var(--color-warn);flex-shrink:0;margin-top:1px}
.issue-list li .issue-content{flex:1;min-width:0}
.issue-list span{display:block;margin-top:var(--space-1);color:var(--color-text-muted);font-size:12px;font-family:var(--font-mono);word-break:break-all}
.login-card{max-width:560px;margin:0 auto}
.login-card button[type="submit"]{width:100%}
footer{color:var(--color-text-muted);font-size:12px;margin-top:var(--space-6);text-align:center;font-family:var(--font-mono)}
@media (max-width:1024px){.dashboard-shell{grid-template-columns:260px minmax(0,1fr)}}
@media (max-width:980px){main{padding:var(--space-6) var(--space-4) var(--space-7)}.dashboard-shell{grid-template-columns:1fr}.sidebar{position:static;grid-template-columns:repeat(2,minmax(0,1fr))}.quick-nav{grid-column:1/-1;display:flex;overflow-x:auto;padding-bottom:var(--space-1);scroll-snap-type:x mandatory}.tab-button{min-width:140px;scroll-snap-align:start;text-align:center}.tab-button.active{box-shadow:inset 0 -3px 0 var(--color-primary)}.config-section{padding:var(--space-5)}}
@media (max-width:640px){h1{font-size:28px}.hero{display:block;padding:var(--space-5);border-radius:var(--radius-lg)}.status-pill{display:inline-flex;margin-top:var(--space-4)}.sidebar{grid-template-columns:1fr}.field-grid{grid-template-columns:1fr}.config-section,.card{border-radius:var(--radius-md);padding:var(--space-4)}.split-heading{display:block}.section-badge{display:inline-block;margin-top:var(--space-2)}.form-actions{display:block;padding:var(--space-4)}.form-actions button[type="submit"]{width:100%;margin-top:var(--space-3)}code{display:block;width:max-content;margin:var(--space-1) 0 0}}
.skip-link{position:absolute;left:-9999px;top:0;z-index:100;padding:var(--space-3) var(--space-4);background:var(--color-primary);color:#fff;border-radius:0 0 var(--radius-sm) 0;font-weight:600}
.skip-link:focus{left:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
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
    document.querySelectorAll('[data-tab]').forEach(function(button){
      button.addEventListener('click',function(){
        var target=button.getAttribute('data-tab');
        document.querySelectorAll('[data-tab]').forEach(function(item){item.classList.toggle('active',item===button);item.setAttribute('aria-selected',item===button?'true':'false')});
        document.querySelectorAll('[data-panel]').forEach(function(panel){panel.classList.toggle('active',panel.getAttribute('data-panel')===target);panel.setAttribute('aria-hidden',panel.getAttribute('data-panel')===target?'false':'true')});
      });
    });
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
