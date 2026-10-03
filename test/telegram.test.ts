import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/runtime/config.js";
import { ConversationService } from "../src/domain/conversations.js";
import { DeliveryService } from "../src/domain/deliveries.js";
import { PermissionService } from "../src/domain/permissions.js";
import { RateLimitService } from "../src/domain/rate-limit.js";
import { buildTopicName } from "../src/channels/telegram/topics.js";
import { detectMessageType, extractText, summarizeTelegramMessage } from "../src/channels/telegram/media.js";
import { topicHelpText } from "../src/channels/telegram/commands.js";
import { adminBotCommands, privateBotCommands } from "../src/channels/telegram/menu.js";
import { configureTelegramWebhook } from "../src/channels/telegram/bot.js";
import { createTestDatabase, disposeTestDatabase, handle } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

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

  it("prunes expired buckets once the map grows past its cap", () => {
    const limiter = new RateLimitService(60, 5, 2);
    limiter.check("a", 1_000);
    limiter.check("b", 1_000);
    limiter.check("c", 1_000);
    assert.equal(limiter.bucketCount, 3);

    // The map is over its cap and the earlier buckets are expired, so the next call
    // sweeps them out instead of growing forever.
    limiter.check("d", 200_000);
    assert.equal(limiter.bucketCount, 1);
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
