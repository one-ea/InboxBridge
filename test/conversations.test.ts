import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { startWebConsole } from "../src/runtime/web-console.js";
import { AppSettingsService } from "../src/domain/app-settings.js";
import { ConversationService } from "../src/domain/conversations.js";
import { RetentionService } from "../src/domain/retention.js";
import { AuditService } from "../src/domain/audit.js";
import { sweepExpiredConversations } from "../src/domain/conversation-expiry.js";
import { migrate } from "../src/storage/migrations/0001_initial.js";
import type { Database, PreparedStatement, SqlValue, StatementResult } from "../src/ports/database.js";
import { createTestDatabase, disposeTestDatabase, handle, noopDbHealthCheck, stubMetrics, stubOpsOverview, stubListConversations, stubListFailedDeliveries, stubScheduleRetry, stubListAuditLogs, stubSearchMessages } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

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
    const audit = new AuditService(handle.db);
    await audit.log({ adminId: "1", conversationId: bundle.conversation.id, action: "note" });
    await audit.log({ adminId: "1", conversationId: bundle.conversation.id, action: "close" });

    await service.deleteConversationData(bundle.conversation.id);

    assert.equal(await service.getConversation(bundle.conversation.id), undefined);
    assert.equal(await service.getTopicByConversation(bundle.conversation.id), undefined);
    assert.equal((await service.recentMessages(bundle.conversation.id, 10)).length, 0);
    assert.equal((await audit.listByConversation(bundle.conversation.id, 10)).length, 0);
    assert.equal((await service.getOrCreateConversation({ platform: "telegram", externalUserId: "42" })).contact.id, bundle.contact.id);
  });

  it("tracks conversation mute state", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({
      platform: "telegram",
      externalUserId: "42",
    });

    assert.equal(service.isMuted(bundle.conversation), false);

    await service.mute(bundle.conversation.id, "2999-01-01T00:00:00.000Z");
    assert.equal(service.isMuted((await service.getConversation(bundle.conversation.id))!), true);

    // A mute window in the past no longer suppresses notifications.
    await service.mute(bundle.conversation.id, "2000-01-01T00:00:00.000Z");
    assert.equal(service.isMuted((await service.getConversation(bundle.conversation.id))!), false);

    await service.mute(bundle.conversation.id, null);
    assert.equal(service.isMuted((await service.getConversation(bundle.conversation.id))!), false);
  });

  it("removes tags that are no longer attached to any conversation", async () => {
    const service = new ConversationService(handle.db, 30);
    const first = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "1" });
    const second = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "2" });
    await service.addTag(first.conversation.id, "vip");
    await service.addTag(second.conversation.id, "vip");

    const countTags = async (): Promise<number> => {
      const row = (await handle.db.prepare("SELECT COUNT(*) AS cnt FROM tags").get()) as { cnt: number };
      return row.cnt;
    };

    await service.removeTag(first.conversation.id, "vip");
    assert.equal(await countTags(), 1);

    await service.removeTag(second.conversation.id, "vip");
    assert.equal(await countTags(), 0);
  });

  it("prunes orphan tags when a conversation is deleted", async () => {
    const service = new ConversationService(handle.db, 30);
    const first = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "1" });
    const second = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "2" });
    await service.addTag(first.conversation.id, "vip");
    await service.addTag(second.conversation.id, "vip");

    const countTags = async (): Promise<number> => {
      const row = (await handle.db.prepare("SELECT COUNT(*) AS cnt FROM tags").get()) as { cnt: number };
      return row.cnt;
    };

    await service.deleteConversationData(first.conversation.id);
    assert.equal(await countTags(), 1);

    await service.deleteConversationData(second.conversation.id);
    assert.equal(await countTags(), 0);
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

describe("conversation expiry sweep", () => {
  const silentLogger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } as never;

  it("cleans expired conversations that already have audit logs", async () => {
    const service = new ConversationService(handle.db, 30);
    const bundle = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "42" });
    await service.saveTopic({
      conversationId: bundle.conversation.id,
      managementChatId: "-1001",
      messageThreadId: 99,
      topicName: "User 0042",
    });
    await new AuditService(handle.db).log({ adminId: "1", conversationId: bundle.conversation.id, action: "close" });
    await handle.db
      .prepare("UPDATE conversations SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", bundle.conversation.id);

    const cleaned = await sweepExpiredConversations({
      api: { deleteForumTopic: async () => {} } as never,
      db: handle.db,
      messageRetentionDays: 30,
      defaultConversationRetentionDays: 30,
      logger: silentLogger,
    });

    assert.equal(cleaned, 1);
    assert.equal(await service.getConversation(bundle.conversation.id), undefined);
  });

  it("keeps sweeping remaining conversations when one fails", async () => {
    const service = new ConversationService(handle.db, 30);
    const failing = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "1" });
    const healthy = await service.getOrCreateConversation({ platform: "telegram", externalUserId: "2" });
    await service.saveTopic({ conversationId: failing.conversation.id, managementChatId: "-1001", messageThreadId: 11, topicName: "Failing" });
    await service.saveTopic({ conversationId: healthy.conversation.id, managementChatId: "-1001", messageThreadId: 22, topicName: "Healthy" });
    await handle.db
      .prepare("UPDATE conversations SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", failing.conversation.id);
    await handle.db
      .prepare("UPDATE conversations SET expires_at = ? WHERE id = ?")
      .run("2000-01-02T00:00:00.000Z", healthy.conversation.id);

    // Fail only the first conversation's own-row delete so the second one still gets swept.
    const failingId = failing.conversation.id;
    const wrappedDb: Database = {
      prepare(sql: string): PreparedStatement {
        const statement = handle.db.prepare(sql);
        if (!sql.startsWith("DELETE FROM conversations")) return statement;
        return {
          async run(...params: SqlValue[]): Promise<StatementResult> {
            if (Number(params[0]) === failingId) throw new Error("delete failed");
            return statement.run(...params);
          },
          get: (...params: SqlValue[]) => statement.get(...params),
          all: (...params: SqlValue[]) => statement.all(...params),
        };
      },
      exec: (sql: string) => handle.db.exec(sql),
    };

    const errors: unknown[] = [];
    const cleaned = await sweepExpiredConversations({
      api: { deleteForumTopic: async () => {} } as never,
      db: wrappedDb,
      messageRetentionDays: 30,
      defaultConversationRetentionDays: 30,
      logger: { error: (context: unknown) => errors.push(context), warn: () => {}, info: () => {}, debug: () => {} } as never,
    });

    assert.equal(cleaned, 1);
    assert.equal(errors.length, 1);
    assert.equal(await service.getConversation(healthy.conversation.id), undefined);
    assert.ok(await service.getConversation(failing.conversation.id));
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

  it("searches CJK substrings and short queries", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({ platform: "telegram", externalUserId: "666" });
    const insert = (text: string) =>
      conversations.createMessage({
        conversationId: bundle.conversation.id,
        direction: "inbound",
        platform: "telegram",
        messageType: "text",
        text,
      });
    await insert("客户反馈需要重置密码");
    await insert("退款申请已受理");
    await insert("unrelated english text");

    const cjk = await conversations.searchMessages({ query: "重置密码", limit: 10, offset: 0 });
    assert.equal(cjk.total, 1);
    assert.equal(cjk.items[0].text, "客户反馈需要重置密码");

    // Two-character queries cannot use the trigram index but must still match.
    const short = await conversations.searchMessages({ query: "退款", limit: 10, offset: 0 });
    assert.equal(short.total, 1);
    assert.equal(short.items[0].text, "退款申请已受理");
  });

  it("keeps search text literal instead of treating it as wildcards", async () => {
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({ platform: "telegram", externalUserId: "667" });
    for (const text of ["progress 100% done", "progress 1000 done"]) {
      await conversations.createMessage({
        conversationId: bundle.conversation.id,
        direction: "inbound",
        platform: "telegram",
        messageType: "text",
        text,
      });
    }

    const result = await conversations.searchMessages({ query: "100%", limit: 10, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].text, "progress 100% done");
  });

  it("drops retention-cleaned messages from the search index", async () => {
    const conversations = new ConversationService(handle.db, 1);
    const bundle = await conversations.getOrCreateConversation({ platform: "telegram", externalUserId: "668" });
    await conversations.createMessage({
      conversationId: bundle.conversation.id,
      direction: "inbound",
      platform: "telegram",
      messageType: "text",
      text: "sensitive keyword value",
    });

    assert.equal((await conversations.searchMessages({ query: "sensitive", limit: 10, offset: 0 })).total, 1);

    await new RetentionService(handle.db, 1).cleanupExpired("2999-01-01T00:00:00.000Z");

    assert.equal((await conversations.searchMessages({ query: "sensitive", limit: 10, offset: 0 })).total, 0);
  });

  it("backfills the search index for databases created before it existed", async () => {
    // Simulate a legacy database: index and triggers absent, message rows already present.
    await handle.db.exec("DROP TRIGGER messages_fts_insert");
    await handle.db.exec("DROP TRIGGER messages_fts_delete");
    await handle.db.exec("DROP TRIGGER messages_fts_update");
    await handle.db.exec("DROP TABLE messages_fts");
    const conversations = new ConversationService(handle.db, 30);
    const bundle = await conversations.getOrCreateConversation({ platform: "telegram", externalUserId: "669" });
    await handle.db
      .prepare(
        `INSERT INTO messages (conversation_id, direction, platform, message_type, text, created_at)
         VALUES (?, 'inbound', 'telegram', 'text', ?, ?)`,
      )
      .run(bundle.conversation.id, "legacy backlog message", "2026-01-01T00:00:00.000Z");

    await migrate(handle.client);

    const result = await conversations.searchMessages({ query: "backlog", limit: 10, offset: 0 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].text, "legacy backlog message");
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
