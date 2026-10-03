import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/runtime/config.js";
import { ConversationService } from "../src/domain/conversations.js";
import { DeliveryService } from "../src/domain/deliveries.js";
import { runMaintenanceJobs } from "../src/runtime/maintenance.js";
import { handleWorkerFetch, handleWorkerScheduled, workerEnvToConfigMap } from "../src/runtime/worker.js";
import type { WorkerEnv } from "../src/runtime/worker.js";
import { createWorkerTelegramWebhookHandler } from "../src/channels/telegram/worker-webhook.js";
import type { SqlValue } from "../src/ports/database.js";
import { createTestDatabase, disposeTestDatabase, handle, createD1TestBinding } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

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
        async exec(sql: string) {
          calls.push({ sql, params: [], method: "exec" });
          return { meta: { changes: 0 } };
        },
        async batch() {
          return [];
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

  it("runs migrations once per binding instead of on every request", async () => {
    const statements: string[] = [];
    const env: WorkerEnv = {
      DB: {
        prepare(sql: string) {
          statements.push(sql);
          return {
            bind: () => ({
              run: async () => ({ meta: { changes: 0 } }),
              first: async () => undefined,
              all: async () => ({ results: [] }),
            }),
            run: async () => ({ meta: { changes: 0 } }),
          };
        },
        async exec(sql: string) {
          statements.push(sql);
          return { meta: { changes: 0 } };
        },
        async batch() {
          return [];
        },
      },
    };

    const first = await handleWorkerFetch(new Request("https://example.com/healthz"), env);
    const afterFirst = statements.length;
    const second = await handleWorkerFetch(new Request("https://example.com/healthz"), env);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.ok(statements.slice(0, afterFirst).some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS contacts")));
    // The second request reuses the isolate's migration result and only does its own work.
    assert.deepEqual(statements.slice(afterFirst), ["SELECT 1"]);
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
        async exec() {
          return { meta: { changes: 0 } };
        },
        async batch() {
          return [];
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
        async exec(sql: string) {
          calls.push({ sql, params: [], method: "exec" });
          return { meta: { changes: 0 } };
        },
        async batch() {
          return [];
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
        async exec(sql: string) {
          calls.push({ sql, params: [], method: "exec" });
          return { meta: { changes: 0 } };
        },
        async batch() {
          return [];
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
        return { expiredConversations: 1, expiredMessages: 2, retriedDeliveries: 0 };
      },
    });

    assert.ok(calls.some((call) => call.sql.startsWith("CREATE TABLE IF NOT EXISTS contacts")));
    assert.ok(calls.some((call) => call.sql === "SELECT key, value FROM app_settings"));
    assert.deepEqual(summaries, [{ config: "token", api: { token: "token" } }]);
  });

  it("serves Web Console login from the Worker runtime", async () => {
    const env: WorkerEnv = {
      DB: createD1TestBinding(),
      WEB_CONSOLE_SESSION_SECRET: "session-secret-value",
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
    };

    const response = await handleWorkerFetch(new Request("https://example.com/login"), env);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /登录控制台/);
  });

  it("keeps the Worker Telegram webhook route separate from Web Console routing", async () => {
    const env: WorkerEnv = {
      DB: createD1TestBinding(),
      WEB_CONSOLE_SESSION_SECRET: "session-secret-value",
      TELEGRAM_BOT_TOKEN: "token",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
    };
    const request = new Request("https://example.com/telegram/webhook", { method: "POST" });

    const response = await handleWorkerFetch(request, env, {
      telegramWebhookHandler: async () => new Response("telegram", { status: 202 }),
    });

    assert.equal(response.status, 202);
    assert.equal(await response.text(), "telegram");
  });
});

describe("runtime maintenance", () => {
  it("runs conversation expiry, message retention and delivery retry jobs", async () => {
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
      retryDeliveries: async () => {
        events.push("retry");
        return 3;
      },
    });

    assert.deepEqual(events, ["expiry", "retention", "retry"]);
    assert.deepEqual(summary, { expiredConversations: 1, expiredMessages: 2, retriedDeliveries: 3 });
  });

  it("retries due deliveries through the default maintenance job", async () => {
    const deliveries = new DeliveryService(handle.db);
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({ platform: "telegram", externalUserId: "900" });
    const message = await conversations.createMessage({
      conversationId: bundle.conversation.id,
      direction: "outbound",
      platform: "telegram",
      messageType: "text",
      text: "hello",
      externalMessageId: "55",
    });
    const deliveryId = await deliveries.createPending(message.id, "telegram-user:900");
    await deliveries.markFailed(deliveryId, "network", 1);
    // markFailed schedules the retry for later; pull it forward so it is due now.
    await deliveries.scheduleRetry(deliveryId);

    const copied: number[] = [];
    const summary = await runMaintenanceJobs({
      api: { copyMessage: async () => copied.push(1) } as never,
      db: handle.db,
      config: loadConfig({
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
        TELEGRAM_ADMIN_USER_IDS: "1",
      }),
      logger: { child: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) } as never,
      sweepExpiredConversations: async () => 0,
      cleanupExpiredMessages: async () => 0,
    });

    assert.equal(summary.retriedDeliveries, 1);
    assert.equal(copied.length, 1);
    assert.equal((await deliveries.stats()).sent, 1);
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
