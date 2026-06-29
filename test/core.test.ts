import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configIssues, loadConfig, loadConfigFromSources, loadDatabaseConfig, loadEnv } from "../src/runtime/config.js";
import { startWebConsole } from "../src/runtime/web-console.js";
import { AppSettingsService } from "../src/domain/app-settings.js";
import { ConversationService } from "../src/domain/conversations.js";
import { DeliveryService } from "../src/domain/deliveries.js";
import { PermissionService } from "../src/domain/permissions.js";
import { RateLimitService } from "../src/domain/rate-limit.js";
import { RetentionService } from "../src/domain/retention.js";
import { createDb, type DbHandle } from "../src/storage/client.js";
import { migrate } from "../src/storage/migrations/0001_initial.js";
import { buildTopicName } from "../src/channels/telegram/topics.js";
import { detectMessageType, extractText, summarizeTelegramMessage } from "../src/channels/telegram/media.js";
import { topicHelpText } from "../src/channels/telegram/commands.js";
import { adminBotCommands, privateBotCommands } from "../src/channels/telegram/menu.js";
import { configureTelegramWebhook } from "../src/channels/telegram/bot.js";

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

  it("loads runtime config from saved settings while allowing env overrides", () => {
    const settings = new AppSettingsService(handle.db);
    settings.setMany({
      TELEGRAM_BOT_TOKEN: "from-db",
      TELEGRAM_MANAGEMENT_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_USER_IDS: "1",
      AI_DRAFTS_ENABLED: "false",
    });

    const config = loadConfigFromSources(settings.all(), { TELEGRAM_BOT_TOKEN: "from-env" });

    assert.equal(config.TELEGRAM_BOT_TOKEN, "from-env");
    assert.equal(config.TELEGRAM_MANAGEMENT_CHAT_ID, -1001);
    assert.deepEqual(config.TELEGRAM_ADMIN_USER_IDS, [1]);
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

describe("web console", () => {
  it("requires a password before setup-token sessions can save configuration", async () => {
    const settings = new AppSettingsService(handle.db);
    settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
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
      assert.equal(settings.get("WEB_CONSOLE_PASSWORD_HASH"), undefined);
      assert.equal(settings.get("WEB_CONSOLE_SETUP_TOKEN"), "setup-token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects oversized unauthenticated login form bodies", async () => {
    const settings = new AppSettingsService(handle.db);
    settings.setMany({ WEB_CONSOLE_SETUP_TOKEN: "setup-token" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
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
    settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
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
        }),
        /EADDRINUSE/,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("exposes /healthz without authentication", async () => {
    const settings = new AppSettingsService(handle.db);
    settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: () => true,
      collectMetrics: stubMetrics,
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
    settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "running", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: () => true,
      collectMetrics: stubMetrics,
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
    settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
    const server = await startWebConsole({
      settings,
      port: 0,
      getStatus: () => ({ bot: "stopped", issues: [] }),
      onConfigSaved: async () => {},
      dbHealthCheck: noopDbHealthCheck,
      collectMetrics: stubMetrics,
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
    settings.setMany({ WEB_CONSOLE_PASSWORD_HASH: "bad:hash" });
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

    const cleaned = await new RetentionService(handle.db).cleanupExpired("2999-01-01T00:00:00.000Z");
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

    const convStats = service.conversationStats();
    assert.equal(convStats.open, 1);
    assert.equal(convStats.closed, 1);

    const msgStats = service.messageStats();
    assert.equal(msgStats.inbound, 1);
    assert.equal(msgStats.outbound, 1);
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
    assert.match(help, /\/export/);
    assert.match(help, /普通消息会默认转发/);
  });

  it("registers Telegram command menu entries", () => {
    assert.ok(privateBotCommands.some((command) => command.command === "start"));
    assert.ok(!privateBotCommands.some((command) => command.command === "menu"));
    assert.ok(privateBotCommands.some((command) => command.command === "export"));
    assert.ok(!privateBotCommands.some((command) => command.command === "help"));
    assert.ok(!adminBotCommands.some((command) => command.command === "menu"));
    assert.ok(adminBotCommands.some((command) => command.command === "history"));
    assert.ok(adminBotCommands.some((command) => command.command === "delete"));
    assert.ok(adminBotCommands.every((command) => !command.command.startsWith("/")));
  });

  it("aggregates delivery stats by status", async () => {
    const deliveries = new DeliveryService(handle.db);
    const id1 = await deliveries.createPending(undefined, "telegram-user:1");
    const id2 = await deliveries.createPending(undefined, "telegram-user:2");
    const id3 = await deliveries.createPending(undefined, "telegram-user:3");
    await deliveries.markSent(id1);
    await deliveries.markFailed(id2, "error", 1);
    await deliveries.markPermanentFailure(id3, "fatal");

    const stats = deliveries.stats();
    assert.equal(stats.pending, 0);
    assert.equal(stats.sent, 1);
    assert.equal(stats.failed, 1);
    assert.equal(stats.permanentFailure, 1);
  });
});
