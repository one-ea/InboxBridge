import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/app/config.js";
import { ConversationService } from "../src/core/conversations.js";
import { PermissionService } from "../src/core/permissions.js";
import { RateLimitService } from "../src/core/rate-limit.js";
import { RetentionService } from "../src/core/retention.js";
import { createDb, type DbHandle } from "../src/db/client.js";
import { migrate } from "../src/db/migrations/0001_initial.js";
import { buildTopicName } from "../src/bot/telegram/topics.js";
import { detectMessageType, extractText, summarizeTelegramMessage } from "../src/bot/telegram/media.js";

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

    expect(config.TELEGRAM_ADMIN_USER_IDS).toEqual([1, 2]);
    expect(config.DATABASE_URL).toBe("file:./data/inboxbridge.sqlite");
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

    expect(second.contact.id).toBe(first.contact.id);
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.contact.username).toBe("alice2");
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
    expect(topic?.conversationId).toBe(bundle.conversation.id);
  });

  it("blocks and unblocks contacts", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });

    await service.blockContact(bundle.contact.id, "1", "spam");
    expect(await service.isBlocked(bundle.contact.id)).toBe(true);

    await service.unblockContact(bundle.contact.id);
    expect(await service.isBlocked(bundle.contact.id)).toBe(false);
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

    expect(cleaned).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBeNull();
    expect(messages[0].rawPayload).toBeNull();
  });
});

describe("permissions and rate limits", () => {
  it("allows only configured admins", () => {
    const permissions = new PermissionService([1, 2]);
    expect(permissions.isAdmin(1)).toBe(true);
    expect(permissions.isAdmin(3)).toBe(false);
    expect(permissions.isAdmin(undefined)).toBe(false);
  });

  it("enforces per-key limits within the window", () => {
    const limiter = new RateLimitService(60, 2);
    expect(limiter.check("user", 1000).allowed).toBe(true);
    expect(limiter.check("user", 1001).allowed).toBe(true);
    expect(limiter.check("user", 1002).allowed).toBe(false);
    expect(limiter.check("user", 61_001).allowed).toBe(true);
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

    expect(buildTopicName(named)).toBe("Alice | @alice | id3456");
    expect(buildTopicName(fallback)).toBe("User 7654");
  });

  it("detects and summarizes Telegram message payloads", () => {
    const text = { text: "hello" };
    const photo = { photo: [{ file_id: "x" }], caption: "look" };

    expect(detectMessageType(text)).toBe("text");
    expect(extractText(photo)).toBe("look");
    expect(summarizeTelegramMessage(photo)).toBe("[photo] look");
  });
});
