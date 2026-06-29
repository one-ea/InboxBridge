import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { editableConfigKeys, sensitiveConfigKeys } from "./config.js";
import { AppSettingsService } from "../core/app-settings.js";

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
      <form method="post" action="/login" class="card login-card">
        ${error ? `<p class="banner danger">${escapeHtml(error)}</p>` : ""}
        <div class="field">
          <p class="field-note">${hasPassword ? "请输入首次设置时保存的控制台密码。" : "首次进入请使用启动日志中的 setup token，登录后立即设置控制台密码。"}</p>
          <label for="login-secret">${label}</label>
          <input id="login-secret" type="password" name="${name}" autocomplete="current-password" autofocus required>
        </div>
        <button type="submit">进入控制台</button>
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
    ? `<ul class="issue-list">${status.issues.map((issue) => `<li>${translateIssue(issue)}</li>`).join("")}</ul>`
    : "<p class=\"status-copy\">配置完整，bot 可以正常启动。</p>";
  const groups = fieldGroups.map((group) => renderGroup(group, stored)).join("\n");
  const navigation = ["访问安全", ...fieldGroups.map((group) => group.title)]
    .map(
      (title, index) =>
        `<button type="button" class="tab-button${index === 0 ? " active" : ""}" data-tab="tab-${index}">${escapeHtml(title)}</button>`,
    )
    .join("");
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
        <span class="status-pill ${status.bot === "running" ? "ok" : "warn"}">${status.bot === "running" ? "Bot 运行中" : "Bot 待配置"}</span>
      </section>
      ${saved ? `<p class="banner success">配置已保存，运行状态已刷新。</p>` : ""}
      <div class="dashboard-shell">
        <aside class="sidebar">
          <section class="card status-card">
            <div class="section-heading">
              <p class="eyebrow">运行状态</p>
              <h2>当前检查结果</h2>
            </div>
            ${issueList}
          </section>
          <section class="card setup-card">
            <p class="eyebrow">配置进度</p>
            <div class="progress-number">${completedRequired}/3</div>
            <p class="hint">基础配置包含 Bot Token、管理群 ID 和管理员白名单。</p>
            <div class="progress-track"><span style="width:${Math.round((completedRequired / 3) * 100)}%"></span></div>
          </section>
          <nav class="card quick-nav" aria-label="配置页切换">
            <p class="eyebrow">配置页</p>
            ${navigation}
          </nav>
        </aside>
        <form method="post" action="/config" class="config-panel">
          <section class="config-section access-section tab-panel active" data-panel="tab-0">
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
            <button type="submit">保存并重启 Bot</button>
          </div>
        </form>
      </div>`),
  );
}

function renderGroup(group: (typeof fieldGroups)[number], stored: NodeJS.ProcessEnv): string {
  const index = fieldGroups.indexOf(group) + 1;
  return `<section class="config-section tab-panel" data-panel="tab-${index}">
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
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
    :root{color-scheme:light;--bg:#eef3fb;--panel:#fff;--ink:#142033;--muted:#667085;--line:#d9e2ef;--brand:#2454ff;--brand-dark:#183bc2;--ok:#047857;--warn:#b45309;--danger:#b42318;--soft:#f8fbff;--shadow:0 18px 45px rgba(20,32,51,.08)}*{box-sizing:border-box}body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 8% 0%,#dce8ff 0,#eef3fb 30%,#f8fafc 100%);color:var(--ink)}main{max-width:1240px;margin:0 auto;padding:28px 20px 42px}h1{font-size:40px;line-height:1.05;margin:0}h2{font-size:20px;margin:0 0 8px}.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:18px;padding:26px;border:1px solid rgba(36,84,255,.16);border-radius:26px;background:linear-gradient(135deg,#fff,#edf4ff);box-shadow:var(--shadow)}.hero.compact{display:block;max-width:620px;margin:40px auto 18px}.hero-copy{max-width:760px;margin:10px 0 0;color:var(--muted);font-size:16px;line-height:1.7}.eyebrow{margin:0 0 8px;color:var(--brand);font-size:12px;font-weight:850;letter-spacing:.14em;text-transform:uppercase}.dashboard-shell{display:grid;grid-template-columns:300px minmax(0,1fr);gap:18px;align-items:start}.sidebar{position:sticky;top:18px;display:grid;gap:14px}.card,.config-section,.config-panel{background:rgba(255,255,255,.95);border:1px solid var(--line);border-radius:22px;box-shadow:0 12px 34px rgba(20,32,51,.06);backdrop-filter:blur(10px)}.card{padding:20px}.login-card{max-width:620px;margin:0 auto}.status-card{border-left:5px solid var(--brand)}.setup-card{background:linear-gradient(180deg,#fff,#f8fbff)}.progress-number{font-size:38px;font-weight:900;letter-spacing:-.04em}.progress-track{height:10px;border-radius:999px;background:#e8eef8;overflow:hidden;margin-top:14px}.progress-track span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,var(--brand),#6d8cff)}.quick-nav{display:grid;gap:10px}.tab-button{width:100%;border:1px solid #e7edf7;border-radius:16px;background:#fbfdff;color:var(--ink);box-shadow:none;text-align:left;font-weight:800;padding:13px 14px;cursor:pointer}.tab-button:hover{border-color:#b9c7ff;color:var(--brand);background:#f8fbff}.tab-button.active{border-color:#9fb2ff;color:var(--brand);background:#eef4ff;box-shadow:inset 4px 0 0 var(--brand)}.config-panel{padding:0;background:transparent;border:0;box-shadow:none;backdrop-filter:none}.config-section{display:none;min-height:520px;padding:26px;margin:0;border-top:4px solid var(--brand)}.config-section.active{display:block}.section-heading{margin-bottom:22px}.split-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.section-badge{white-space:nowrap;border-radius:999px;background:#eef2ff;color:#3444a3;font-size:12px;font-weight:850;padding:6px 10px}.hint,.field-note,.status-copy{color:var(--muted);font-size:14px;line-height:1.65;margin:0}.field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.field{min-width:0}.single-field{max-width:560px}.field-note{margin:0 0 8px;padding:10px 12px;border-radius:12px;background:var(--soft);border:1px solid #e7edf7}label{display:block;margin:0 0 7px;font-weight:780}code{display:inline-block;margin-left:6px;padding:2px 6px;border-radius:999px;background:#eef2ff;color:#3444a3;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:750}input,select{width:100%;border:1px solid #cbd5e1;border-radius:12px;padding:12px 13px;font:inherit;background:white;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}input:focus,select:focus{border-color:var(--brand);box-shadow:0 0 0 4px rgba(36,84,255,.14)}button{border:0;border-radius:999px;background:var(--brand);color:white;font-weight:850;padding:13px 22px;cursor:pointer;box-shadow:0 10px 26px rgba(36,84,255,.26)}button:hover{background:var(--brand-dark)}.form-actions{position:sticky;bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 20px;margin-top:16px;border:1px solid var(--line);border-radius:20px;background:rgba(247,249,253,.96);box-shadow:0 16px 38px rgba(20,32,51,.10);backdrop-filter:blur(14px)}.form-actions strong{display:block;margin-bottom:4px}.banner{border-radius:16px;padding:13px 15px;margin:0 0 16px;font-weight:760}.banner.success{background:#ecfdf5;color:var(--ok);border:1px solid #bbf7d0}.banner.danger{background:#fff1f2;color:var(--danger);border:1px solid #fecdd3}.status-pill{white-space:nowrap;border-radius:999px;padding:9px 14px;font-weight:850}.status-pill.ok{color:var(--ok);background:#ecfdf5;border:1px solid #bbf7d0}.status-pill.warn{color:var(--warn);background:#fffbeb;border:1px solid #fde68a}.issue-list{display:grid;gap:10px;margin:0;padding:0;list-style:none}.issue-list li{padding:12px 14px;border-radius:14px;background:#fffbeb;border:1px solid #fde68a;color:#7c2d12}.issue-list span{display:block;margin-top:4px;color:#92400e;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}footer{color:#94a3b8;font-size:12px;margin-top:24px;text-align:center}@media (max-width:980px){main{padding:22px 14px 34px}.dashboard-shell{grid-template-columns:1fr}.sidebar{position:static;grid-template-columns:repeat(2,minmax(0,1fr))}.quick-nav{grid-column:1/-1;display:flex;overflow-x:auto;padding-bottom:4px}.tab-button{min-width:150px;text-align:center}.tab-button.active{box-shadow:inset 0 -4px 0 var(--brand)}.field-grid{grid-template-columns:1fr}.config-section{min-height:auto}.form-actions{position:static}}@media (max-width:640px){h1{font-size:30px}.hero{display:block;padding:20px;border-radius:22px}.status-pill{display:inline-block;margin-top:16px}.sidebar{grid-template-columns:1fr}.config-section,.card{border-radius:18px;padding:17px}.split-heading{display:block}.section-badge{display:inline-block;margin-top:10px}.form-actions{display:block}.form-actions button{width:100%;margin-top:14px}code{display:block;width:max-content;margin:6px 0 0}}
  </style></head><body><main>${body}<footer>InboxBridge ${fingerprint}</footer></main><script>
    document.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.getAttribute('data-tab');
        document.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
        document.querySelectorAll('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.getAttribute('data-panel') === target));
      });
    });
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
