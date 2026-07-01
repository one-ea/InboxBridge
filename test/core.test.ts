import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configIssues, loadConfig, loadConfigFromSources, loadDatabaseConfig, loadEnv } from "../src/runtime/config.js";
import { handleWebConsoleRequest, startWebConsole } from "../src/runtime/web-console.js";
import { AppSettingsService } from "../src/domain/app-settings.js";
import { ConversationService } from "../src/domain/conversations.js";
import { DeliveryService } from "../src/domain/deliveries.js";
import { PermissionService } from "../src/domain/permissions.js";
import { RateLimitService } from "../src/domain/rate-limit.js";
import { RetentionService } from "../src/domain/retention.js";
import { AiDraftService } from "../src/domain/ai-drafts.js";
import { AuditService } from "../src/domain/audit.js";
import { createDb, type DbHandle } from "../src/storage/client.js";
import { D1DatabaseAdapter } from "../src/storage/d1.js";
import { migrate } from "../src/storage/migrations/0001_initial.js";
import { runMigration } from "../src/storage/migrations/runner.js";
import { runMaintenanceJobs } from "../src/runtime/maintenance.js";
import { handleWorkerFetch, handleWorkerScheduled, workerEnvToConfigMap, type WorkerEnv } from "../src/runtime/worker.js";
import { createWorkerTelegramWebhookHandler } from "../src/channels/telegram/worker-webhook.js";
import { buildTopicName } from "../src/channels/telegram/topics.js";
import { detectMessageType, extractText, summarizeTelegramMessage } from "../src/channels/telegram/media.js";
import { topicHelpText } from "../src/channels/telegram/commands.js";
import { adminBotCommands, privateBotCommands } from "../src/channels/telegram/menu.js";
import { configureTelegramWebhook } from "../src/channels/telegram/bot.js";
import type { Database, PreparedStatement, SqlValue, StatementResult } from "../src/ports/database.js";

let tempDir: string;
let handle: DbHandle;

const noopDbHealthCheck = () => true;
const stubMetrics = () => ({
  messages: { inbound_total: 0, outbound_total: 0, internal_total: 0 },
  deliveries: { pending: 0, sent: 0, failed: 0, permanent_failure: 0 },
  conversations: { open: 0, closed: 0 },
  ai_drafts: { pending: 0, ready: 0, failed: 0 },
  uptime_seconds: 0,
  timestamp: new Date().toISOString(),
});
const stubOpsOverview = () => ({
  messages: { inboundTotal: 0, outboundTotal: 0, internalTotal: 0 },
  deliveries: { pending: 0, sent: 0, failed: 0, permanentFailure: 0 },
  conversations: { open: 0, closed: 0 },
  aiDrafts: { pending: 0, ready: 0, failed: 0, sent: 0, discarded: 0 },
  uptimeSeconds: 0,
});
const stubListConversations = () => ({ items: [], total: 0 });
const stubListFailedDeliveries = () => ({ items: [], total: 0 });
const stubScheduleRetry = async () => {};
const stubListAuditLogs = () => ({ items: [], total: 0 });
const stubSearchMessages = () => ({ items: [], total: 0 });

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "inboxbridge-"));
  handle = createDb(`file:${join(tempDir, "test.sqlite")}`);
  await migrate(handle.client);
});

afterEach(async () => {
  handle.client.close();
  await rm(tempDir, { recursive: true, force: true });
});

describe("configuration", () => {
  it("parses required Telegram and runtime settings", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_ADMIN_USER_IDS: "1, 2",
    });

    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1, 2]);
    assert.equal(config.DATABASE_URL, "file:./data/inboxbridge.sqlite");
    assert.equal(config.DEFAULT_CONVERSATION_RETENTION_DAYS, 30);
    assert.equal(config.CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES, 60);
  });

  it("supports never as the default conversation retention policy", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_ADMIN_USER_IDS: "1",
      DEFAULT_CONVERSATION_RETENTION_DAYS: "never",
    });

    assert.equal(config.DEFAULT_CONVERSATION_RETENTION_DAYS, null);
  });

  it("loads database-only config without Telegram credentials", () => {
    const config = loadDatabaseConfig({});
    assert.equal(config.DATABASE_URL, "file:./data/inboxbridge.sqlite");
    assert.equal(config.WEB_CONSOLE_PORT, 3000);
  });

  it("loads runtime config from saved settings while allowing env overrides", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({
      TELEGRAM_BOT_TOKEN: "from-db",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
      AI_DRAFTS_ENABLED: "false",
    });

    const config = loadConfigFromSources(await settings.all(), { TELEGRAM_BOT_TOKEN: "from-env" });

    assert.equal(config.TELEGRAM_BOT_TOKEN, "from-env");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1]);
    assert.equal(config.AI_DRAFTS_ENABLED, false);
  });

  it("loads saved settings through an async settings API", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ TELEGRAM_BOT_TOKEN: "from-db" });

    const stored = settings.all();

    assert.equal(stored instanceof Promise, true);
    assert.equal((await stored).TELEGRAM_BOT_TOKEN, "from-db");
  });

  it("loads runtime config from a platform-neutral config map", () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1,2",
      AI_DRAFTS_ENABLED: "false",
    });

    assert.equal(config.TELEGRAM_BOT_TOKEN, "token");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1, 2]);
    assert.equal(config.AI_DRAFTS_ENABLED, false);
  });

  it("does not let repository .env values override saved runtime settings", async () => {
    const previousCwd = process.cwd();
    const envKeys = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_MANAGEMENT_CHAT_ID", "TELEGRAM_ADMIN_USER_IDS"];
    const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    await writeFile(
      join(tempDir, ".env"),
      [
        "TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_MANAGEMENT_CHAT_ID=-2002",
        "TELEGRAM_ADMIN_USER_IDS=2",
      ].join("\n"),
    );

    try {
      process.chdir(tempDir);
      for (const key of envKeys) delete process.env[key];
      const config = loadConfigFromSources({
        TELEGRAM_BOT_TOKEN: "from-db",
        TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
        TELEGRAM_ADMIN_USER_IDS: "1",
      });

      assert.equal(config.TELEGRAM_BOT_TOKEN, "from-db");
      assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
      assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1]);
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.chdir(previousCwd);
    }
  });

  it("reports missing runtime settings for web console setup", () => {
    const issues = configIssues({}, {});

    assert.ok(issues.some((issue) => issue.includes("TELEGRAM_BOT_TOKEN")));
    assert.ok(issues.some((issue) => issue.includes("TELEGRAM_MANAGEMENT_CHAT_ID")));
  });

  it("loads values from .env without overriding shell env", async () => {
    const envPath = join(tempDir, ".env");
    await writeFile(
      envPath,
      [
        "TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_MANAGEMENT_CHAT_ID=-1001",
        "TELEGRAM_ADMIN_USER_IDS=1,2",
        "DATABASE_URL=file:./file.sqlite",
      ].join("\n"),
    );

    const loaded = loadEnv({ TELEGRAM_BOT_TOKEN: "from-shell" }, envPath);
    const config = loadConfig(loaded);
    assert.equal(config.TELEGRAM_BOT_TOKEN, "from-shell");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1, 2]);
  });
});

describe("storage migrations", () => {
  it("runs migration statements and adds only missing columns through the database port", async () => {
    const execs: string[] = [];
    const columns = new Map<string, Set<string>>([
      ["conversations", new Set(["id", "retention_days"])],
    ]);
    const db: Database = {
      prepare(sql: string): PreparedStatement {
        return {
          async run(..._params: SqlValue[]): Promise<StatementResult> {
            return { changes: 0 };
          },
          async get(..._params: SqlValue[]): Promise<unknown> {
            return undefined;
          },
          async all(..._params: SqlValue[]): Promise<unknown[]> {
            const match = sql.match(/^PRAGMA table_info\(([^)]+)\)$/);
            const table = match?.[1] ?? "";
            return [...(columns.get(table) ?? new Set<string>())].map((name) => ({ name }));
          },
        };
      },
      async exec(sql: string): Promise<void> {
        execs.push(sql);
        const match = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) /);
        if (match) {
          const [, table, column] = match;
          if (!columns.has(table)) columns.set(table, new Set());
          columns.get(table)?.add(column);
        }
      },
    };

    await runMigration(db, {
      statements: ["CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY)"],
      columns: [
        { table: "conversations", column: "retention_days", definition: "INTEGER" },
        { table: "conversations", column: "expires_at", definition: "TEXT" },
      ],
      afterColumns: ["CREATE INDEX IF NOT EXISTS conversations_expires_idx ON conversations(expires_at)"],
    });

    assert.deepEqual(execs, [
      "CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY)",
      "ALTER TABLE conversations ADD COLUMN expires_at TEXT",
      "CREATE INDEX IF NOT EXISTS conversations_expires_idx ON conversations(expires_at)",
    ]);
  });
});

describe("D1 database adapter", () => {
  it("maps D1 prepared statements to the database port", async () => {
    const calls: Array<{ sql: string; params: SqlValue[]; method: string }> = [];
    const d1 = {
      prepare(sql: string) {
        return {
          bind(...params: SqlValue[]) {
            return {
              async run() {
                calls.push({ sql, params, method: "run" });
                return { meta: { changes: 2, last_row_id: 42 } };
              },
              async first() {
                calls.push({ sql, params, method: "first" });
                return { id: 42 };
              },
              async all() {
                calls.push({ sql, params, method: "all" });
                return { results: [{ id: 42 }] };
              },
            };
          },
          async run() {
            calls.push({ sql, params: [], method: "run" });
            return { meta: { changes: 1, last_row_id: 7 } };
          },
        };
      },
    };
    const db = new D1DatabaseAdapter(d1);

    await db.exec("CREATE TABLE example (id INTEGER PRIMARY KEY)");
    const statement = db.prepare("SELECT * FROM example WHERE id = ?");
    const result = await statement.run(42);
    const first = await statement.get(42);
    const rows = await statement.all(42);

    assert.deepEqual(result, { changes: 2, lastInsertRowid: 42 });
    assert.deepEqual(first, { id: 42 });
    assert.deepEqual(rows, [{ id: 42 }]);
    assert.deepEqual(calls, [
      { sql: "CREATE TABLE example (id INTEGER PRIMARY KEY)", params: [], method: "run" },
      { sql: "SELECT * FROM example WHERE id = ?", params: [42], method: "run" },
      { sql: "SELECT * FROM example WHERE id = ?", params: [42], method: "first" },
      { sql: "SELECT * FROM example WHERE id = ?", params: [42], method: "all" },
    ]);
  });
});

describe("Workers runtime", () => {
  it("initializes D1 and serves the health check from a Fetch request", async () => {
    const calls: Array<{ sql: string; params: SqlValue[]; method: string }> = [];
    const env: WorkerEnv = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...params: SqlValue[]) {
              return {
                async run() {
                  calls.push({ sql, params, method: "run" });
                  return { meta: { changes: 0 } };
                },
                async first() {
                  calls.push({ sql, params, method: "first" });
                  return { ok: 1 };
                },
                async all() {
                  calls.push({ sql, params, method: "all" });
                  return { results: [] };
                },
              };
            },
            async run() {
              calls.push({ sql, params: [], method: "run" });
              return { meta: { changes: 0 } };
            },
          };
        },
      },
    };

    const response = await handleWorkerFetch(new Request("https://example.com/healthz"), env);
    const body = (await response.json()) as { status: string; database: string };

    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: "ok", database: "reachable" });
    assert.ok(calls.some((call) => call.sql.startsWith("CREATE TABLE IF NOT EXISTS contacts")));
    assert.deepEqual(calls.at(-1), { sql: "SELECT 1", params: [], method: "first" });
  });

  it("maps string Worker env bindings into a config map", () => {
    const env = {
      DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => undefined, all: async () => ({ results: [] }) }), run: async () => ({}) }) },
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1,2",
      RATE_LIMIT_MAX_MESSAGES: "10",
    } as unknown as WorkerEnv;

    const configMap = workerEnvToConfigMap(env);

    assert.deepEqual(configMap, {
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1,2",
      RATE_LIMIT_MAX_MESSAGES: "10",
    });
  });

  it("routes Telegram webhook requests through the injected Worker webhook handler", async () => {
    const requests: Request[] = [];
    const env: WorkerEnv = {
      DB: {
        prepare(sql: string) {
          return {
            bind(..._params: SqlValue[]) {
              return {
                async run() {
                  return { meta: { changes: 0 } };
                },
                async first() {
                  return { sql };
                },
                async all() {
                  return { results: [] };
                },
              };
            },
            async run() {
              return { meta: { changes: 0 } };
            },
          };
        },
      },
    };
    const request = new Request("https://example.com/telegram/webhook", { method: "POST" });

    const response = await handleWorkerFetch(request, env, {
      telegramWebhookHandler: async (received) => {
        requests.push(received);
        return new Response("telegram", { status: 202 });
      },
    });

    assert.equal(response.status, 202);
    assert.deepEqual(requests, [request]);
  });

  it("builds a Telegram webhook handler from Worker configuration", async () => {
    const calls: Array<{ sql: string; params: SqlValue[]; method: string }> = [];
    const created: unknown[] = [];
    const secrets: string[] = [];
    const requests: Request[] = [];
    const env: WorkerEnv = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...params: SqlValue[]) {
              return {
                async run() {
                  calls.push({ sql, params, method: "run" });
                  return { meta: { changes: 0 } };
                },
                async first() {
                  calls.push({ sql, params, method: "first" });
                  return undefined;
                },
                async all() {
                  calls.push({ sql, params, method: "all" });
                  if (sql === "SELECT key, value FROM app_settings") return { results: [] };
                  return { results: [] };
                },
              };
            },
            async run() {
              calls.push({ sql, params: [], method: "run" });
              return { meta: { changes: 0 } };
            },
          };
        },
      },
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
      TELEGRAM_UPDATE_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "https://example.com/telegram/webhook",
      TELEGRAM_WEBHOOK_SECRET: "secret",
    };
    const request = new Request("https://example.com/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
    });

    const response = await handleWorkerFetch(request, env, {
      createTelegramBot: (config) => {
        created.push(config);
        return { token: config.TELEGRAM_BOT_TOKEN } as never;
      },
      createTelegramWebhookHandler: (bot, secret) => {
        created.push(bot);
        secrets.push(secret);
        return async (received) => {
          requests.push(received);
          return new Response("handled", { status: 202 });
        };
      },
    });

    assert.equal(response.status, 202);
    assert.equal(await response.text(), "handled");
    assert.equal(secrets[0], "secret");
    assert.deepEqual(requests, [request]);
    assert.ok(created.length >= 2);
    assert.ok(calls.some((call) => call.sql === "SELECT key, value FROM app_settings"));
  });

  it("runs maintenance jobs from a Worker scheduled event", async () => {
    const calls: Array<{ sql: string; params: SqlValue[]; method: string }> = [];
    const summaries: unknown[] = [];
    const env: WorkerEnv = {
      DB: {
        prepare(sql: string) {
          return {
            bind(...params: SqlValue[]) {
              return {
                async run() {
                  calls.push({ sql, params, method: "run" });
                  return { meta: { changes: 0 } };
                },
                async first() {
                  calls.push({ sql, params, method: "first" });
                  return undefined;
                },
                async all() {
                  calls.push({ sql, params, method: "all" });
                  return { results: [] };
                },
              };
            },
            async run() {
              calls.push({ sql, params: [], method: "run" });
              return { meta: { changes: 0 } };
            },
          };
        },
      },
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
    };

    await handleWorkerScheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() }, env, { waitUntil: () => {} }, {
      logger: {
        child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      } as never,
      createTelegramBot: (config) => ({ api: { token: config.TELEGRAM_BOT_TOKEN } }) as never,
      runMaintenanceJobs: async (input) => {
        summaries.push({ config: input.config.TELEGRAM_BOT_TOKEN, api: input.api });
        return { expiredConversations: 1, expiredMessages: 2 };
      },
    });

    assert.ok(calls.some((call) => call.sql.startsWith("CREATE TABLE IF NOT EXISTS contacts")));
    assert.ok(calls.some((call) => call.sql === "SELECT key, value FROM app_settings"));
    assert.deepEqual(summaries, [{ config: "token", api: { token: "token" } }]);
  });
});

describe("runtime maintenance", () => {
  it("runs conversation expiry and message retention jobs", async () => {
    const events: string[] = [];
    const summary = await runMaintenanceJobs({
      api: {} as never,
      db: handle.db,
      config: loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
        TELEGRAM_ADMIN_USER_IDS: "1",
      }),
      logger: { child: () => ({}) } as never,
      sweepExpiredConversations: async () => {
        events.push("expiry");
        return 1;
      },
      cleanupExpiredMessages: async () => {
        events.push("retention");
        return 2;
      },
    });

    assert.deepEqual(events, ["expiry", "retention"]);
    assert.deepEqual(summary, { expiredConversations: 1, expiredMessages: 2 });
  });
});

describe("Workers Telegram webhook", () => {
  it("forwards valid Telegram webhook requests to the Cloudflare callback", async () => {
    const requests: Request[] = [];
    const handler = createWorkerTelegramWebhookHandler({} as never, "secret", () => async (request: Request) => {
      requests.push(request);
      return new Response("handled", { status: 202 });
    });
    const request = new Request("https://example.com/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "secret" },
    });

    const response = await handler(request);

    assert.equal(response.status, 202);
    assert.equal(await response.text(), "handled");
    assert.deepEqual(requests, [request]);
  });

  it("rejects Telegram webhook requests with an invalid secret", async () => {
    let called = false;
    const handler = createWorkerTelegramWebhookHandler({} as never, "secret", () => async () => {
      called = true;
      return new Response("handled");
    });
    const request = new Request("https://example.com/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
    });

    const response = await handler(request);

    assert.equal(response.status, 403);
    assert.equal(await response.text(), "Forbidden");
    assert.equal(called, false);
  });
});

describe("web console", () => {
  it("handles login and health checks through Fetch requests", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const sessions = new Map<string, never>();
    const options = {
      settings,
      port: 0,
      getStatus: () => ({ bot: "running" as const, issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: async () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    };

    const login = await handleWebConsoleRequest(new Request("https://example.com/login"), options, sessions);
    const health = await handleWebConsoleRequest(new Request("https://example.com/healthz"), options, sessions);
    const body = (await health.json()) as { status: string; bot: string; db: string };

    assert.equal(login.status, 200);
    assert.match(await login.text(), /登录控制台/);
    assert.equal(login.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(health.status, 200);
    assert.deepEqual(body, { status: "ok", bot: "running", db: "reachable" });
  });

  it("serves authenticated Web Console pages through Fetch requests", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const sessions = new Map([["session-id", "password" as const]]);
    const options = {
      settings,
      port: 0,
      getStatus: () => ({ bot: "running" as const, issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: async () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    };

    const overview = await handleWebConsoleRequest(
      new Request("https://example.com/", { headers: { cookie: "inboxbridge_session=session-id" } }),
      options,
      sessions,
    );
    const config = await handleWebConsoleRequest(
      new Request("https://example.com/config", { headers: { cookie: "inboxbridge_session=session-id" } }),
      options,
      sessions,
    );
    const operations = await handleWebConsoleRequest(
      new Request("https://example.com/operations", { headers: { cookie: "inboxbridge_session=session-id" } }),
      options,
      sessions,
    );

    assert.equal(overview.status, 200);
    assert.match(await overview.text(), /控制台概览/);
    assert.equal(config.status, 200);
    assert.match(await config.text(), /配置仪表盘/);
    assert.equal(operations.status, 200);
    assert.match(await operations.text(), /运维仪表盘/);
  });

  it("requires a password before setup-token sessions can save configuration", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const login = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = login.headers.get("set-cookie") ?? "";

      const save = await fetch(`http://127.0.0.1:${port}/config`, {
        method: "POST",
        headers: { cookie },
        body: new URLSearchParams({
          TELEGRAM_BOT_TOKEN: "token",
          TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
          TELEGRAM_ADMIN_USER_IDS: "1",
        }),
        redirect: "manual",
      });

      assert.equal(save.status, 400);
      assert.equal(await settings.get("WEB_CONSOLE_PASSWORD_HASH"), undefined);
      assert.equal(await settings.get("WEB_CONSOLE_SETUP_TOKEN"), "setup-token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects oversized unauthenticated login form bodies", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: `setupToken=${"x".repeat(70 * 1024)}`,
      });

      assert.equal(response.status, 413);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("awaits Telegram webhook errors so they return a handled response", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
      telegramWebhook: async () => {
        throw new Error("webhook failed");
      },
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/telegram/webhook`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
      });

      assert.equal(response.status, 500);
      assert.match(await response.text(), /webhook failed/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects when the web console port cannot be opened", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;

    try {
      await assert.rejects(
        startWebConsole({
          settings: new AppSettingsService(handle.db),
          port,
          getStatus: () => ({ bot: "stopped", issues: [] }),
          onConfigSaved: async () => {},
          dbHealthCheck: noopDbHealthCheck,
          collectMetrics: stubMetrics,
          collectOperationsOverview: stubOpsOverview,
          listConversations: stubListConversations,
          listFailedDeliveries: stubListFailedDeliveries,
          scheduleRetry: stubScheduleRetry,
          listAuditLogs: stubListAuditLogs,
          searchMessages: stubSearchMessages,
        }),
        /EADDRINUSE/,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("exposes /healthz without authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 503);
      const body = (await res.json()) as { status: string; bot: string; db: string };
      assert.equal(body.status, "degraded");
      assert.equal(body.bot, "stopped");
      assert.equal(body.db, "reachable");
    } finally {
      server.close();
    }
  });

  it("returns 200 from /healthz when bot is running and db is reachable", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: () => true,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string };
      assert.equal(body.status, "ok");
    } finally {
      server.close();
    }
  });

  it("redirects /metrics to /login without authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/login");
    } finally {
      server.close();
    }
  });

  it("returns metrics JSON after authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: () => ({
        messages: { inbound_total: 5, outbound_total: 3, internal_total: 1 },
        deliveries: { pending: 0, sent: 3, failed: 1, permanent_failure: 0 },
        conversations: { open: 2, closed: 1 },
        ai_drafts: { pending: 0, ready: 1, failed: 0 },
        uptime_seconds: 42,
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { cookie },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { messages: { inbound_total: number }; conversations: { open: number } };
      assert.equal(body.messages.inbound_total, 5);
      assert.equal(body.conversations.open, 2);
    } finally {
      server.close();
    }
  });

  it("redirects unauthenticated /operations to /login", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/operations`, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/login");
    } finally {
      server.close();
    }
  });

  it("returns operations overview HTML after authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: () => ({
        messages: { inboundTotal: 10, outboundTotal: 5, internalTotal: 2 },
        deliveries: { pending: 1, sent: 5, failed: 2, permanentFailure: 0 },
        conversations: { open: 3, closed: 1 },
        aiDrafts: { pending: 0, ready: 1, failed: 0, sent: 2, discarded: 1 },
        uptimeSeconds: 3600,
      }),
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    try {
      const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
        method: "POST",
        body: new URLSearchParams({ setupToken: "setup-token" }),
        redirect: "manual",
      });
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
      assert.ok(cookie);
      const res = await fetch(`http://127.0.0.1:${port}/operations`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /消息总量/);
      assert.match(html, /投递状态/);
      assert.match(html, /10/);
    } finally {
      server.close();
    }
  });
});

describe("conversation service", () => {
  it("creates and reuses a contact conversation", async () => {
    const service = new ConversationService(handle.db, 30);
    const first = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
      username: "alice",
      displayName: "Alice",
    });
    const second = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
      username: "alice2",
      displayName: "Alice B",
    });

    assert.equal(second.contact.id, first.contact.id);
    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal(second.contact.username, "alice2");
    assert.equal(first.conversation.retentionDays, 30);
    assert.ok(first.conversation.expiresAt);
  });

  it("sets per-conversation retention policies", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });

    const never = await service.setConversationRetention(bundle.conversation.id, null);
    assert.equal(never?.retentionDays, null);
    assert.equal(never?.expiresAt, null);

    const sevenDays = await service.setConversationRetention(bundle.conversation.id, 7);
    assert.equal(sevenDays?.retentionDays, 7);
    assert.ok(sevenDays?.expiresAt);
  });

  it("lists expired conversations with their topics", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });
    await service.saveTopic({
      conversationId: bundle.conversation.id,
      managementChatId: "-1001",
      messageThreadId: 99,
      topicName: "User 0042",
    });
    await service.setConversationRetention(bundle.conversation.id, 1);

    const expired = await service.expiredConversations("2999-01-01T00:00:00.000Z");
    assert.equal(expired.length, 1);
    assert.equal(expired[0].conversation.id, bundle.conversation.id);
    assert.equal(expired[0].topic.messageThreadId, 99);
  });

  it("maps a Telegram topic thread to a conversation", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });
    await service.saveTopic({
      conversationId: bundle.conversation.id,
      managementChatId: "-1001",
      messageThreadId: 99,
      topicName: "User 0042",
    });

    const topic = await service.getTopicByThread("-1001", 99);
    assert.equal(topic?.conversationId, bundle.conversation.id);
  });

  it("blocks and unblocks contacts", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });

    await service.blockContact(bundle.contact.id, "1", "spam");
    assert.equal(await service.isBlocked(bundle.contact.id), true);

    await service.unblockContact(bundle.contact.id);
    assert.equal(await service.isBlocked(bundle.contact.id), false);
  });

  it("cleans expired message content while preserving rows", async () => {
    const service = new ConversationService(handle.db, 1);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });
    await service.createMessage({
      conversationId: bundle.conversation.id,
      contactId: bundle.contact.id,
      direction: "inbound",
      platform: "telegram",
      messageType: "text",
      text: "hello",
      rawPayload: { text: "hello" },
    });

    const cleaned = await new RetentionService(handle.db, 30).cleanupExpired("2999-01-01T00:00:00.000Z");
    const messages = await service.recentMessages(bundle.conversation.id, 10);

    assert.equal(cleaned, 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, null);
    assert.equal(messages[0].rawPayload, null);
  });

  it("deletes conversation data without deleting the contact", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });
    await service.saveTopic({
      conversationId: bundle.conversation.id,
      managementChatId: "-1001",
      messageThreadId: 99,
      topicName: "User 0042",
    });
    await service.addNote(bundle.conversation.id, "1", "note");
    await service.addTag(bundle.conversation.id, "vip");
    await service.createMessage({
      conversationId: bundle.conversation.id,
      contactId: bundle.contact.id,
      direction: "inbound",
      platform: "telegram",
      messageType: "text",
      text: "hello",
    });

    await service.deleteConversationData(bundle.conversation.id);

    assert.equal(await service.getConversation(bundle.conversation.id), undefined);
    assert.equal(await service.getTopicByConversation(bundle.conversation.id), undefined);
    assert.equal((await service.recentMessages(bundle.conversation.id, 10)).length, 0);
    assert.equal((await service.getOrCreateConversation({ platform: "telegram", externalUserId: "42" })).contact.id, bundle.contact.id);
  });

  it("aggregates conversation and message stats", async () => {
    const service = new ConversationService(handle.db, 30);
    const a = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "1", displayName: "A" });
    const b = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "2", displayName: "B" });
    await service.setConversationStatus(b.conversation.id, "closed");
    await service.createMessage({
      conversationId: a.conversation.id,
      contactId: a.contact.id,
      direction: "inbound",
      platform: "telegram",
      messageType: "text",
      text: "hi",
    });
    await service.createMessage({
      conversationId: a.conversation.id,
      contactId: a.contact.id,
      direction: "outbound",
      platform: "telegram",
      messageType: "text",
      text: "hello",
    });

    const convStats = await service.conversationStats();
    assert.equal(convStats.open, 1);
    assert.equal(convStats.closed, 1);

    const msgStats = await service.messageStats();
    assert.equal(msgStats.inbound, 1);
    assert.equal(msgStats.outbound, 1);
  });

  it("lists conversations with pagination and status filter", async () => {
    const service = new ConversationService(handle.db, 30);
    for (let i = 1; i <= 3; i++) {
      const bundle = await service.getOrCreateConversation({
        platform: "telegram",
        externalUserId: String(i),
        displayName: `User${i}`,
      });
      if (i === 3) await service.setConversationStatus(bundle.conversation.id, "closed");
    }

    const all = await service.listConversations({ limit: 50, offset: 0 });
    assert.equal(all.total, 3);
    assert.equal(all.items.length, 3);

    const openOnly = await service.listConversations({ status: "open", limit: 50, offset: 0 });
    assert.equal(openOnly.total, 2);
    assert.equal(openOnly.items.length, 2);
    assert.ok(openOnly.items.every((c) => c.status === "open"));

    const paged = await service.listConversations({ limit: 2, offset: 0 });
    assert.equal(paged.items.length, 2);
  });

  it("lists conversations by assignee", async () => {
    const service = new ConversationService(handle.db, 30);
    const b1 = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "600", displayName: "A" });
    const b2 = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "601", displayName: "B" });
    const b3 = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "602", displayName: "C" });
    await service.assign(b1.conversation.id, "100");
    await service.assign(b2.conversation.id, "100");
    await service.assign(b3.conversation.id, "200");

    const mine = await service.listByAssignee("100", 20);
    assert.equal(mine.length, 2);
    assert.ok(mine.every((c) => c.assignedAdminId === "100"));

    const combined = await service.listConversations({ assignedTo: "100", status: "open", limit: 50, offset: 0 });
    assert.equal(combined.total, 2);

    const empty = await service.listByAssignee("999", 20);
    assert.equal(empty.length, 0);
  });

  it("supports urgent priority with assignee for alert trigger", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "700",
      displayName: "UrgentUser",
    });
    await service.setPriority(bundle.conversation.id, "urgent");
    await service.assign(bundle.conversation.id, "500");

    const conv = await service.getConversation(bundle.conversation.id);
    assert.ok(conv);
    assert.equal(conv!.priority, "urgent");
    assert.equal(conv!.assignedAdminId, "500");
    // Alert condition: priority === "urgent" && assignedAdminId is truthy
    assert.ok(conv!.priority === "urgent" && conv!.assignedAdminId !== null);
  });
});

describe("permissions and rate limits", () => {
  it("allows only configured admins", () => {
    const permissions = new PermissionService([1, 2]);
    assert.equal(permissions.isAdmin(1), true);
    assert.equal(permissions.isAdmin(3), false);
    assert.equal(permissions.isAdmin(undefined), false);
  });

  it("enforces per-key limits within the window", () => {
    const limiter = new RateLimitService(60, 2);
    assert.equal(limiter.check("user", 1000).allowed, true);
    assert.equal(limiter.check("user", 1001).allowed, true);
    assert.equal(limiter.check("user", 1002).allowed, false);
    assert.equal(limiter.check("user", 61_001).allowed, true);
  });
});

describe("telegram helpers", () => {
  it("configures Telegram webhooks with a persistent secret token", async () => {
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const bot = {
      api: {
        setWebhook: async (url: string, options: Record<string, unknown>) => {
          calls.push({ url, options });
        },
      },
    };

    await configureTelegramWebhook(bot as never, loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "webhook",
      TELEGRAM_WEBHOOK_URL: "https://example.com/telegram/webhook",
      TELEGRAM_ADMIN_USER_IDS: "1",
      TELEGRAM_WEBHOOK_SECRET: "secret-token",
    }));

    assert.equal(calls[0].url, "https://example.com/telegram/webhook");
    assert.equal(calls[0].options.secret_token, "secret-token");
  });

  it("builds readable topic names with safe fallbacks", async () => {
    const service = new ConversationService(handle.db, 30);
    const named = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "123456",
      username: "alice",
      displayName: "Alice",
    });
    const fallback = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "987654",
    });

    assert.equal(buildTopicName(named), "Alice | @alice | id3456");
    assert.equal(buildTopicName(fallback), "User 7654");
  });

  it("detects and summarizes Telegram message payloads", () => {
    const text = { text: "hello" };
    const photo = { photo: [{ file_id: "x" }], caption: "look" };

    assert.equal(detectMessageType(text), "text");
    assert.equal(extractText(photo), "look");
    assert.equal(summarizeTelegramMessage(photo), "[photo] look");
  });

  it("documents the topic help command list", () => {
    const help = topicHelpText();
    assert.doesNotMatch(help, /\/menu/);
    assert.match(help, /\/history/);
    assert.match(help, /\/notes/);
    assert.match(help, /\/delete confirm/);
    assert.match(help, /\/reset confirm/);
    assert.match(help, /\/export/);
    assert.match(help, /普通消息会默认转发/);
  });

  it("registers Telegram command menu entries", () => {
    assert.ok(privateBotCommands.some((command) => command.command === "start"));
    assert.ok(!privateBotCommands.some((command) => command.command === "menu"));
    assert.ok(privateBotCommands.some((command) => command.command === "export"));
    assert.ok(privateBotCommands.some((command) => command.command === "help"));
    assert.ok(!adminBotCommands.some((command) => command.command === "menu"));
    assert.ok(adminBotCommands.some((command) => command.command === "history"));
    assert.ok(adminBotCommands.some((command) => command.command === "delete"));
    assert.ok(adminBotCommands.some((command) => command.command === "reset"));
    assert.ok(adminBotCommands.some((command) => command.command === "ai_on"));
    assert.ok(adminBotCommands.some((command) => command.command === "ai_off"));
    assert.ok(adminBotCommands.some((command) => command.command === "help"));
    assert.ok(adminBotCommands.some((command) => command.command === "search"));
    assert.ok(adminBotCommands.some((command) => command.command === "mine"));
    assert.ok(adminBotCommands.some((command) => command.command === "audit"));
    assert.ok(adminBotCommands.every((command) => !command.command.startsWith("/")));
  });

  it("resetConversation clears messages, drafts, notes, tags but keeps conversation", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
      displayName: "Test",
    });
    await service.createMessage({
      conversationId: bundle.conversation.id,
      contactId: bundle.contact.id,
      direction: "inbound",
      platform: "telegram",
      messageType: "text",
      text: "hello",
    });
    await handle.db
      .prepare("INSERT INTO ai_drafts (conversation_id, status, created_at, updated_at) VALUES (?, 'ready', ?, ?)")
      .run(bundle.conversation.id, new Date().toISOString(), new Date().toISOString());
    await handle.db
      .prepare("INSERT INTO admin_notes (conversation_id, admin_user_id, note, created_at) VALUES (?, '1', 'note', ?)")
      .run(bundle.conversation.id, new Date().toISOString());

    await service.resetConversation(bundle.conversation.id);

    assert.ok(await service.getConversation(bundle.conversation.id));
    assert.ok(await service.getContact(bundle.contact.id));
    assert.equal((await service.recentMessages(bundle.conversation.id, 10)).length, 0);
    const draftCount = (await handle.db.prepare("SELECT COUNT(*) AS c FROM ai_drafts WHERE conversation_id = ?").get(bundle.conversation.id)) as { c: number };
    assert.equal(draftCount.c, 0);
    const noteCount = (await handle.db.prepare("SELECT COUNT(*) AS c FROM admin_notes WHERE conversation_id = ?").get(bundle.conversation.id)) as { c: number };
    assert.equal(noteCount.c, 0);
  });

  it("aggregates delivery stats by status", async () => {
    const deliveries = new DeliveryService(handle.db);
    const id1 = await deliveries.createPending(undefined, "telegram-user:1");
    const id2 = await deliveries.createPending(undefined, "telegram-user:2");
    const id3 = await deliveries.createPending(undefined, "telegram-user:3");
    await deliveries.markSent(id1);
    await deliveries.markFailed(id2, "error", 1);
    await deliveries.markPermanentFailure(id3, "fatal");

    const stats = await deliveries.stats();
    assert.equal(stats.pending, 0);
    assert.equal(stats.sent, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.permanentFailure, 1);
  });
});

describe("AI draft lifecycle", () => {
  it("finds the latest ready draft for a conversation", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_ADMIN_USER_IDS: "1",
      OPENAI_COMPATIBLE_BASE_URL: "http://localhost",
      OPENAI_COMPATIBLE_API_KEY: "key",
      OPENAI_COMPATIBLE_MODEL: "test-model",
      AI_DRAFTS_ENABLED: "true",
    });
    const aiDrafts = new AiDraftService(handle.db, conversations, config);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "123",
      displayName: "Test",
    });

    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, draft_text, created_at, updated_at)
         VALUES (?, 'ready', 'old draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(bundle.conversation.id);
    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, draft_text, created_at, updated_at)
         VALUES (?, 'ready', 'new draft', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
      )
      .run(bundle.conversation.id);
    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, draft_text, created_at, updated_at)
         VALUES (?, 'sent', 'sent draft', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')`,
      )
      .run(bundle.conversation.id);

    const draft = await aiDrafts.findReady(bundle.conversation.id);
    assert.ok(draft);
    assert.equal(draft.draftText, "new draft");
  });

  it("marks draft as sent and discarded", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_UPDATE_MODE: "polling",
      TELEGRAM_ADMIN_USER_IDS: "1",
    });
    const aiDrafts = new AiDraftService(handle.db, conversations, config);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "123",
      displayName: "Test",
    });

    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, draft_text, created_at, updated_at)
         VALUES (?, 'ready', 'hello', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(bundle.conversation.id);
    const draft = await aiDrafts.findReady(bundle.conversation.id);
    assert.ok(draft);

    await aiDrafts.markSent(draft.id);
    assert.equal(await aiDrafts.findReady(bundle.conversation.id), undefined);

    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, draft_text, created_at, updated_at)
         VALUES (?, 'ready', 'world', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
      )
      .run(bundle.conversation.id);
    const draft2 = await aiDrafts.findReady(bundle.conversation.id);
    assert.ok(draft2);
    await aiDrafts.markDiscarded(draft2.id);
    assert.equal(await aiDrafts.findReady(bundle.conversation.id), undefined);
  });

  it("recovers stale pending drafts as failed during retention cleanup", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "123",
      displayName: "Test",
    });

    const staleCutoff = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, created_at, updated_at)
         VALUES (?, 'pending', ?, ?)`,
      )
      .run(bundle.conversation.id, staleCutoff, staleCutoff);

    const retention = new RetentionService(handle.db, 30);
    await retention.cleanupExpired();

    const row = (await handle.db
      .prepare("SELECT status, error FROM ai_drafts WHERE conversation_id = ?")
      .get(bundle.conversation.id)) as { status: string; error: string };
    assert.equal(row.status, "failed");
    assert.match(row.error, /timed out/);
  });

  it("hard-deletes terminal drafts past retention period", async () => {
    const conversations = new ConversationService(handle.db, 1);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "123",
      displayName: "Test",
    });

    const oldDate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    await handle.db
      .prepare(
        `INSERT INTO ai_drafts (conversation_id, status, draft_text, created_at, updated_at)
         VALUES (?, 'sent', 'old', ?, ?)`,
      )
      .run(bundle.conversation.id, oldDate, oldDate);

    const retention = new RetentionService(handle.db, 1);
    await retention.cleanupExpired();

    const count = (await handle.db
      .prepare("SELECT COUNT(*) AS cnt FROM ai_drafts WHERE conversation_id = ?")
      .get(bundle.conversation.id)) as { cnt: number };
    assert.equal(count.cnt, 0);
  });

  it("aggregates delivery stats including sent and permanent_failure", async () => {
    const deliveries = new DeliveryService(handle.db);
    const id1 = await deliveries.createPending(undefined, "telegram-user:1");
    const id2 = await deliveries.createPending(undefined, "telegram-user:2");
    await deliveries.markSent(id1);
    await deliveries.markPermanentFailure(id2, "fatal");

    const stats = await deliveries.stats();
    assert.equal(stats.sent, 1);
    assert.equal(stats.permanentFailure, 1);
  });

  it("lists failed deliveries and schedules retry", async () => {
    const deliveries = new DeliveryService(handle.db);
    const id1 = await deliveries.createPending(undefined, "telegram-user:1");
    const id2 = await deliveries.createPending(undefined, "telegram-user:2");
    const id3 = await deliveries.createPending(undefined, "telegram-user:3");
    await deliveries.markFailed(id1, "error", 1);
    await deliveries.markFailed(id2, "error", 2);
    await deliveries.markPermanentFailure(id3, "fatal");

    const list = await deliveries.listFailedDeliveries({ limit: 50, offset: 0 });
    assert.equal(list.total, 3);
    assert.equal(list.items.length, 3);

    await deliveries.scheduleRetry(id1);
    const row = (await handle.db.prepare("SELECT next_retry_at FROM deliveries WHERE id = ?").get(id1)) as { next_retry_at: string };
    assert.ok(row.next_retry_at);

    const beforePf = (await handle.db.prepare("SELECT next_retry_at FROM deliveries WHERE id = ?").get(id3)) as { next_retry_at: string | null };
    assert.equal(beforePf.next_retry_at, null);
  });
});

describe("message search", () => {
  it("searches messages within a conversation", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "444",
      displayName: "SearchUser",
    });
    const convId = bundle.conversation.id;
    await handle.db
      .prepare(
        `INSERT INTO messages (conversation_id, contact_id, direction, platform, message_type, text, created_at)
         VALUES (?, NULL, 'inbound', 'telegram', 'text', ?, ?)`,
      )
      .run(convId, "hello world", "2026-06-29T10:00:00.000Z");
    await handle.db
      .prepare(
        `INSERT INTO messages (conversation_id, contact_id, direction, platform, message_type, text, created_at)
         VALUES (?, NULL, 'inbound', 'telegram', 'text', ?, ?)`,
      )
      .run(convId, "goodbye world", "2026-06-29T11:00:00.000Z");
    await handle.db
      .prepare(
        `INSERT INTO messages (conversation_id, contact_id, direction, platform, message_type, text, created_at)
         VALUES (?, NULL, 'outbound', 'telegram', 'text', ?, ?)`,
      )
      .run(convId, "no match here", "2026-06-29T12:00:00.000Z");

    const results = await conversations.searchMessagesInConversation(convId, "world", 20);
    assert.equal(results.length, 2);
    assert.equal(results[0].text, "goodbye world");
    assert.equal(results[1].text, "hello world");
  });

  it("searches messages globally with pagination", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "555",
      displayName: "GlobalUser",
    });
    for (let i = 0; i < 5; i++) {
      await handle.db
        .prepare(
          `INSERT INTO messages (conversation_id, contact_id, direction, platform, message_type, text, created_at)
           VALUES (?, NULL, 'inbound', 'telegram', 'text', ?, ?)`,
        )
        .run(bundle.conversation.id, `urgent issue ${i}`, `2026-06-29T${10 + i}:00:00.000Z`);
    }

    const result = await conversations.searchMessages({ query: "urgent", limit: 2, offset: 0 });
    assert.equal(result.total, 5);
    assert.equal(result.items.length, 2);
    assert.ok(result.items[0].text?.includes("urgent"));

    const page2 = await conversations.searchMessages({ query: "urgent", limit: 2, offset: 2 });
    assert.equal(page2.items.length, 2);
  });

  it("renders search page behind auth", async () => {
    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: stubListAuditLogs,
      searchMessages: () => ({
        items: [{
          id: 1,
          conversationId: 1,
          direction: "inbound",
          messageType: "text",
          text: "matching text",
          createdAt: "2026-06-29T00:00:00.000Z",
          contactDisplayName: "TestUser",
          topicName: "TestTopic",
        }],
        total: 1,
      }),
    });
    const port = (server.address() as AddressInfo).port;
    const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      body: new URLSearchParams({ setupToken: "setup-token" }),
      redirect: "manual",
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res = await fetch(`http://127.0.0.1:${port}/operations/search?q=matching`, {
      headers: { cookie },
    });
    const html = await res.text();
    server.close();
    assert.ok(html.includes("消息搜索"));
    assert.ok(html.includes("matching text"));
  });
});

describe("audit log", () => {
  it("writes and retrieves audit entries", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const audit = new AuditService(handle.db);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "111",
      displayName: "User1",
    });
    const convId = bundle.conversation.id;

    await audit.log({ adminId: "100", conversationId: convId, action: "close" });
    await audit.log({ adminId: "200", conversationId: convId, action: "assign", detail: "300" });
    await audit.log({ adminId: "100", conversationId: convId, action: "priority", detail: "high" });

    const logs = await audit.listByConversation(convId, 10);
    assert.equal(logs.length, 3);
    assert.equal(logs[0].action, "priority");
    assert.equal(logs[1].action, "assign");
    assert.equal(logs[2].action, "close");
    assert.equal(logs[1].detail, "300");
    assert.equal(logs[2].detail, null);
  });

  it("lists audit logs with filters and pagination", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const audit = new AuditService(handle.db);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "222",
      displayName: "User2",
    });
    const convId = bundle.conversation.id;

    for (let i = 0; i < 5; i++) {
      await audit.log({ adminId: "100", conversationId: convId, action: "note" });
    }
    for (let i = 0; i < 3; i++) {
      await audit.log({ adminId: "200", conversationId: convId, action: "close" });
    }

    const byAdmin = await audit.list({ adminId: "100", limit: 50, offset: 0 });
    assert.equal(byAdmin.total, 5);
    assert.equal(byAdmin.items.length, 5);

    const byAction = await audit.list({ action: "close", limit: 50, offset: 0 });
    assert.equal(byAction.total, 3);

    const paged = await audit.list({ limit: 2, offset: 0 });
    assert.equal(paged.items.length, 2);
    assert.equal(paged.total, 8);
  });

  it("serves audit page behind auth", async () => {
    const server = await startWebConsole({
      settings: new AppSettingsService(handle.db),
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: () => ({ items: [], total: 0 }),
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/operations/audit`);
    assert.equal(res.status, 200);
    const html = await res.text();
    server.close();
    assert.ok(html.includes("登录"));
  });

  it("renders audit logs in web page", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const audit = new AuditService(handle.db);
    const bundle = await conversations.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "333",
      displayName: "User3",
    });
    await audit.log({ adminId: "999", conversationId: bundle.conversation.id, action: "ban", detail: "spam" });

    const settings = new AppSettingsService(handle.db);
    await settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
      collectOperationsOverview: stubOpsOverview,
      listConversations: stubListConversations,
      listFailedDeliveries: stubListFailedDeliveries,
      scheduleRetry: stubScheduleRetry,
      listAuditLogs: () => ({
        items: [{
          id: 1,
          adminId: "999",
          conversationId: bundle.conversation.id,
          action: "ban",
          detail: "spam",
          createdAt: "2026-06-29T00:00:00.000Z",
        }],
        total: 1,
      }),
      searchMessages: stubSearchMessages,
    });
    const port = (server.address() as AddressInfo).port;
    const loginRes = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      body: new URLSearchParams({ setupToken: "setup-token" }),
      redirect: "manual",
    });
    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
    const res2 = await fetch(`http://127.0.0.1:${port}/operations/audit`, {
      headers: { cookie },
    });
    const html = await res2.text();
    server.close();
    assert.ok(html.includes("审计日志"));
    assert.ok(html.includes("ban"));
    assert.ok(html.includes("spam"));
  });
});
