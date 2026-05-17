import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig, loadDatabaseConfig, loadEnv } from "../src/app/config.js";
import { ConversationService } from "../src/core/conversations.js";
import { PermissionService } from "../src/core/permissions.js";
import { RateLimitService } from "../src/core/rate-limit.js";
import { RetentionService } from "../src/core/retention.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrate } from "../src/db/migrations/0001_initial.js";
import { buildTopicName } from "../src/bot/telegram/topics.js";
import { detectMessageType, extractText, summarizeTelegramMessage } from "../src/bot/telegram/media.js";
import { topicHelpText } from "../src/bot/telegram/commands.js";
import { adminBotCommands, privateBotCommands } from "../src/bot/telegram/menu.js";

let tempDir: string;
let handle: DbHandle;

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
  });

  it("loads database-only config without Telegram credentials", () => {
    const config = loadDatabaseConfig({});
    assert.equal(config.DATABASE_URL, "file:./data/inboxbridge.sqlite");
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
    assert.match(help, /\/menu/);
    assert.match(help, /\/history/);
    assert.match(help, /\/notes/);
    assert.match(help, /\/export/);
    assert.match(help, /普通消息会默认转发/);
  });

  it("registers Telegram command menu entries", () => {
    assert.ok(privateBotCommands.some((command) => command.command === "start"));
    assert.ok(privateBotCommands.some((command) => command.command === "menu"));
    assert.ok(privateBotCommands.some((command) => command.command === "export"));
    assert.ok(!privateBotCommands.some((command) => command.command === "help"));
    assert.ok(adminBotCommands.some((command) => command.command === "menu"));
    assert.ok(adminBotCommands.some((command) => command.command === "history"));
    assert.ok(adminBotCommands.every((command) => !command.command.startsWith("/")));
  });
});
