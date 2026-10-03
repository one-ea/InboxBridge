import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/runtime/config.js";
import { ConversationService } from "../src/domain/conversations.js";
import { DeliveryService } from "../src/domain/deliveries.js";
import { RetentionService } from "../src/domain/retention.js";
import { AiDraftService } from "../src/domain/ai-drafts.js";
import { createTestDatabase, disposeTestDatabase, handle } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

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

  it("supersedes a draft waiting for review when regenerating", async () => {
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
         VALUES (?, 'ready', 'first draft', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      )
      .run(bundle.conversation.id);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "second draft" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await aiDrafts.generate(bundle.conversation.id);
      assert.equal(result.status, "ready");
      assert.equal(result.text, "second draft");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const drafts = (await handle.db
      .prepare("SELECT status FROM ai_drafts WHERE conversation_id = ? ORDER BY id ASC")
      .all(bundle.conversation.id)) as Array<{ status: string }>;
    assert.deepEqual(drafts.map((draft) => draft.status), ["discarded", "ready"]);
    assert.equal((await aiDrafts.findReady(bundle.conversation.id))?.draftText, "second draft");
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

  it("deletes terminal deliveries past the retention period but keeps failed ones", async () => {
    const deliveries = new DeliveryService(handle.db);
    const oldDate = new Date(Date.now() - 2 * 86400 * 1000).toISOString();
    const insertOld = async (status: string): Promise<void> => {
      await handle.db
        .prepare(
          `INSERT INTO deliveries (target, status, attempt_count, created_at, updated_at)
           VALUES ('telegram-user:1', ?, 0, ?, ?)`,
        )
        .run(status, oldDate, oldDate);
    };
    await insertOld("sent");
    await insertOld("failed");
    await insertOld("permanent_failure");
    const freshId = await deliveries.createPending(undefined, "telegram-user:2");
    await deliveries.markSent(freshId);

    await new RetentionService(handle.db, 1).cleanupExpired();

    const count = async (status: string): Promise<number> => {
      const row = (await handle.db
        .prepare("SELECT COUNT(*) AS cnt FROM deliveries WHERE status = ?")
        .get(status)) as { cnt: number };
      return row.cnt;
    };
    assert.equal(await count("sent"), 1); // only the fresh one survives
    assert.equal(await count("failed"), 1);
    assert.equal(await count("permanent_failure"), 1);
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
