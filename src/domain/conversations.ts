import type { Database } from "../storage/client.js";
import type { Contact, Conversation, Message, Tag, TelegramTopic } from "../storage/schema.js";

export interface ContactInput {
  platform: string;
  externalUserId: string;
  username?: string;
  displayName?: string;
}

export interface ConversationBundle {
  contact: Contact;
  conversation: Conversation;
}

export interface AdminNote {
  id: number;
  conversationId: number;
  adminUserId: string;
  note: string;
  createdAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(days: number, from = new Date()): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function contactFromRow(row: Record<string, unknown>): Contact {
  return {
    id: Number(row.id),
    platform: String(row.platform),
    externalUserId: String(row.external_user_id),
    username: row.username === null ? null : String(row.username),
    displayName: row.display_name === null ? null : String(row.display_name),
    status: row.status as Contact["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function conversationFromRow(row: Record<string, unknown>): Conversation {
  return {
    id: Number(row.id),
    contactId: Number(row.contact_id),
    status: row.status as Conversation["status"],
    assignedAdminId: row.assigned_admin_id === null ? null : String(row.assigned_admin_id),
    priority: row.priority as Conversation["priority"],
    mutedUntil: row.muted_until === null ? null : String(row.muted_until),
    retentionDays: row.retention_days === null ? null : Number(row.retention_days),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
    aiEnabled: row.ai_enabled === undefined ? true : Boolean(row.ai_enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastMessageAt: row.last_message_at === null ? null : String(row.last_message_at),
  };
}

function messageFromRow(row: Record<string, unknown>): Message {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    contactId: row.contact_id === null ? null : Number(row.contact_id),
    direction: row.direction as Message["direction"],
    platform: String(row.platform),
    messageType: String(row.message_type),
    text: row.text === null ? null : String(row.text),
    rawPayload: row.raw_payload === null ? null : String(row.raw_payload),
    externalMessageId: row.external_message_id === null ? null : String(row.external_message_id),
    createdAt: String(row.created_at),
    expiresAt: row.expires_at === null ? null : String(row.expires_at),
  };
}

function topicFromRow(row: Record<string, unknown>): TelegramTopic {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    managementChatId: String(row.management_chat_id),
    messageThreadId: Number(row.message_thread_id),
    topicName: String(row.topic_name),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function tagFromRow(row: Record<string, unknown>): Tag {
  return {
    id: Number(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
  };
}

function noteFromRow(row: Record<string, unknown>): AdminNote {
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    adminUserId: String(row.admin_user_id),
    note: String(row.note),
    createdAt: String(row.created_at),
  };
}

export class ConversationService {
  constructor(
    private readonly db: Database,
    private readonly retentionDays: number,
    private readonly defaultConversationRetentionDays: number | null = 30,
  ) {}

  async getOrCreateConversation(input: ContactInput): Promise<ConversationBundle> {
    const timestamp = nowIso();
    let contact = this.findContact(input.platform, input.externalUserId);

    if (!contact) {
      this.db
        .prepare(
          `INSERT INTO contacts (platform, external_user_id, username, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.platform, input.externalUserId, input.username ?? null, input.displayName ?? null, timestamp, timestamp);
      contact = this.findContact(input.platform, input.externalUserId);
    } else {
      this.db
        .prepare("UPDATE contacts SET username = ?, display_name = ?, updated_at = ? WHERE id = ?")
        .run(input.username ?? contact.username, input.displayName ?? contact.displayName, timestamp, contact.id);
      contact = this.getContactSync(contact.id);
    }

    if (!contact) throw new Error("Failed to create or load contact.");

    let conversation = this.findLatestConversation(contact.id);
    if (!conversation) {
      const expiresAt = this.defaultConversationRetentionDays === null ? null : addDaysIso(this.defaultConversationRetentionDays);
      this.db
        .prepare(
          `INSERT INTO conversations (
            contact_id, retention_days, expires_at, created_at, updated_at, last_message_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(contact.id, this.defaultConversationRetentionDays, expiresAt, timestamp, timestamp, timestamp);
      conversation = this.findLatestConversation(contact.id);
    }

    if (!conversation) throw new Error("Failed to create or load conversation.");
    return { contact, conversation };
  }

  async isBlocked(contactId: number): Promise<boolean> {
    const row = this.db.prepare("SELECT id FROM blocks WHERE contact_id = ?").get(contactId);
    return Boolean(row);
  }

  async blockContact(contactId: number, createdBy: string, reason?: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO blocks (contact_id, reason, created_by, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(contact_id) DO UPDATE SET reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(contactId, reason ?? null, createdBy, nowIso());
    this.db.prepare("UPDATE contacts SET status = 'blocked', updated_at = ? WHERE id = ?").run(nowIso(), contactId);
  }

  async unblockContact(contactId: number): Promise<void> {
    this.db.prepare("DELETE FROM blocks WHERE contact_id = ?").run(contactId);
    this.db.prepare("UPDATE contacts SET status = 'active', updated_at = ? WHERE id = ?").run(nowIso(), contactId);
  }

  async setConversationStatus(conversationId: number, status: "open" | "closed"): Promise<void> {
    this.db.prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), conversationId);
  }

  async setPriority(conversationId: number, priority: "low" | "normal" | "high" | "urgent"): Promise<void> {
    this.db.prepare("UPDATE conversations SET priority = ?, updated_at = ? WHERE id = ?").run(priority, nowIso(), conversationId);
  }

  async assign(conversationId: number, adminUserId: string): Promise<void> {
    this.db
      .prepare("UPDATE conversations SET assigned_admin_id = ?, updated_at = ? WHERE id = ?")
      .run(adminUserId, nowIso(), conversationId);
  }

  async mute(conversationId: number, mutedUntil: string): Promise<void> {
    this.db
      .prepare("UPDATE conversations SET muted_until = ?, updated_at = ? WHERE id = ?")
      .run(mutedUntil, nowIso(), conversationId);
  }

  async setConversationRetention(conversationId: number, days: number | null): Promise<Conversation | undefined> {
    const expiresAt = days === null ? null : addDaysIso(days);
    this.db
      .prepare("UPDATE conversations SET retention_days = ?, expires_at = ?, updated_at = ? WHERE id = ?")
      .run(days, expiresAt, nowIso(), conversationId);
    return this.getConversation(conversationId);
  }

  async setAiEnabled(conversationId: number, enabled: boolean): Promise<void> {
    this.db
      .prepare("UPDATE conversations SET ai_enabled = ?, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, nowIso(), conversationId);
  }

  async getAiEnabled(conversationId: number): Promise<boolean> {
    const row = this.db
      .prepare("SELECT ai_enabled FROM conversations WHERE id = ?")
      .get(conversationId) as { ai_enabled?: number } | undefined;
    return row?.ai_enabled === undefined ? true : Boolean(row.ai_enabled);
  }

  async addNote(conversationId: number, adminUserId: string, note: string): Promise<void> {
    this.db
      .prepare("INSERT INTO admin_notes (conversation_id, admin_user_id, note, created_at) VALUES (?, ?, ?, ?)")
      .run(conversationId, adminUserId, note, nowIso());
  }

  async addTag(conversationId: number, name: string): Promise<void> {
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) return;
    this.db
      .prepare("INSERT INTO tags (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
      .run(cleanName, nowIso());
    const tag = this.findTag(cleanName);
    if (!tag) return;
    this.db
      .prepare(
        `INSERT INTO conversation_tags (conversation_id, tag_id, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id, tag_id) DO NOTHING`,
      )
      .run(conversationId, tag.id, nowIso());
  }

  async removeTag(conversationId: number, name: string): Promise<void> {
    const tag = this.findTag(name.trim().toLowerCase());
    if (!tag) return;
    this.db.prepare("DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?").run(conversationId, tag.id);
  }

  async listTags(conversationId: number): Promise<Tag[]> {
    const rows = this.db
      .prepare(
        `SELECT tags.*
         FROM tags
         INNER JOIN conversation_tags ON conversation_tags.tag_id = tags.id
         WHERE conversation_tags.conversation_id = ?
         ORDER BY tags.name ASC`,
      )
      .all(conversationId) as Array<Record<string, unknown>>;
    return rows.map(tagFromRow);
  }

  async recentNotes(conversationId: number, limit: number): Promise<AdminNote[]> {
    const rows = this.db
      .prepare("SELECT * FROM admin_notes WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.map(noteFromRow);
  }

  async deleteConversationData(conversationId: number): Promise<void> {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `DELETE FROM deliveries
           WHERE source_message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`,
        )
        .run(conversationId);
      this.db.prepare("DELETE FROM ai_drafts WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM conversation_tags WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM admin_notes WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM telegram_topics WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async expiredConversations(now = nowIso()): Promise<Array<{ conversation: Conversation; topic: TelegramTopic }>> {
    const rows = this.db
      .prepare(
        `SELECT
           conversations.id AS c_id,
           conversations.contact_id AS c_contact_id,
           conversations.status AS c_status,
           conversations.assigned_admin_id AS c_assigned_admin_id,
           conversations.priority AS c_priority,
           conversations.muted_until AS c_muted_until,
           conversations.retention_days AS c_retention_days,
           conversations.expires_at AS c_expires_at,
           conversations.created_at AS c_created_at,
           conversations.updated_at AS c_updated_at,
           conversations.last_message_at AS c_last_message_at,
           telegram_topics.id AS t_id,
           telegram_topics.conversation_id AS t_conversation_id,
           telegram_topics.management_chat_id AS t_management_chat_id,
           telegram_topics.message_thread_id AS t_message_thread_id,
           telegram_topics.topic_name AS t_topic_name,
           telegram_topics.created_at AS t_created_at,
           telegram_topics.updated_at AS t_updated_at
         FROM conversations
         INNER JOIN telegram_topics ON telegram_topics.conversation_id = conversations.id
         WHERE conversations.expires_at IS NOT NULL AND conversations.expires_at <= ?
         ORDER BY conversations.expires_at ASC`,
      )
      .all(now) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      conversation: conversationFromRow({
        id: row.c_id,
        contact_id: row.c_contact_id,
        status: row.c_status,
        assigned_admin_id: row.c_assigned_admin_id,
        priority: row.c_priority,
        muted_until: row.c_muted_until,
        retention_days: row.c_retention_days,
        expires_at: row.c_expires_at,
        created_at: row.c_created_at,
        updated_at: row.c_updated_at,
        last_message_at: row.c_last_message_at,
      }),
      topic: topicFromRow({
        id: row.t_id,
        conversation_id: row.t_conversation_id,
        management_chat_id: row.t_management_chat_id,
        message_thread_id: row.t_message_thread_id,
        topic_name: row.t_topic_name,
        created_at: row.t_created_at,
        updated_at: row.t_updated_at,
      }),
    }));
  }

  async createMessage(input: {
    conversationId: number;
    contactId?: number;
    direction: "inbound" | "outbound" | "internal";
    platform: string;
    messageType: string;
    text?: string;
    rawPayload?: unknown;
    externalMessageId?: string;
  }): Promise<Message> {
    const timestamp = nowIso();
    const expiresAt = input.direction === "internal" ? null : addDaysIso(this.retentionDays);
    this.db
      .prepare(
        `INSERT INTO messages (
          conversation_id, contact_id, direction, platform, message_type, text, raw_payload,
          external_message_id, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.contactId ?? null,
        input.direction,
        input.platform,
        input.messageType,
        input.text ?? null,
        input.rawPayload === undefined ? null : JSON.stringify(input.rawPayload),
        input.externalMessageId ?? null,
        timestamp,
        expiresAt,
      );
    this.db
      .prepare("UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?")
      .run(timestamp, timestamp, input.conversationId);
    const row = this.db.prepare("SELECT * FROM messages WHERE id = last_insert_rowid()").get() as Record<string, unknown>;
    return messageFromRow(row);
  }

  async getTopicByThread(managementChatId: string, messageThreadId: number): Promise<TelegramTopic | undefined> {
    const row = this.db
      .prepare("SELECT * FROM telegram_topics WHERE management_chat_id = ? AND message_thread_id = ?")
      .get(managementChatId, messageThreadId) as Record<string, unknown> | undefined;
    return row ? topicFromRow(row) : undefined;
  }

  async getTopicByConversation(conversationId: number): Promise<TelegramTopic | undefined> {
    const row = this.db
      .prepare("SELECT * FROM telegram_topics WHERE conversation_id = ?")
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? topicFromRow(row) : undefined;
  }

  async saveTopic(input: {
    conversationId: number;
    managementChatId: string;
    messageThreadId: number;
    topicName: string;
  }): Promise<TelegramTopic> {
    const timestamp = nowIso();
    this.db
      .prepare(
        `INSERT INTO telegram_topics (conversation_id, management_chat_id, message_thread_id, topic_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           management_chat_id = excluded.management_chat_id,
           message_thread_id = excluded.message_thread_id,
           topic_name = excluded.topic_name,
           updated_at = excluded.updated_at`,
      )
      .run(input.conversationId, input.managementChatId, input.messageThreadId, input.topicName, timestamp, timestamp);
    const topic = await this.getTopicByConversation(input.conversationId);
    if (!topic) throw new Error("Failed to save Telegram topic.");
    return topic;
  }

  async getConversation(conversationId: number): Promise<Conversation | undefined> {
    return this.getConversationSync(conversationId);
  }

  async getContact(contactId: number): Promise<Contact | undefined> {
    return this.getContactSync(contactId);
  }

  async recentMessages(conversationId: number, limit: number): Promise<Message[]> {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(conversationId, limit) as Array<Record<string, unknown>>;
    return rows.map(messageFromRow);
  }

  async getMessage(messageId: number): Promise<Message | undefined> {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as Record<string, unknown> | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  private findContact(platform: string, externalUserId: string): Contact | undefined {
    const row = this.db
      .prepare("SELECT * FROM contacts WHERE platform = ? AND external_user_id = ?")
      .get(platform, externalUserId) as Record<string, unknown> | undefined;
    return row ? contactFromRow(row) : undefined;
  }

  private getContactSync(contactId: number): Contact | undefined {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId) as Record<string, unknown> | undefined;
    return row ? contactFromRow(row) : undefined;
  }

  private findLatestConversation(contactId: number): Conversation | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(contactId) as Record<string, unknown> | undefined;
    return row ? conversationFromRow(row) : undefined;
  }

  private getConversationSync(conversationId: number): Conversation | undefined {
    const row = this.db
      .prepare("SELECT * FROM conversations WHERE id = ?")
      .get(conversationId) as Record<string, unknown> | undefined;
    return row ? conversationFromRow(row) : undefined;
  }

  private findTag(name: string): Tag | undefined {
    const row = this.db.prepare("SELECT * FROM tags WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    return row ? tagFromRow(row) : undefined;
  }

  conversationStats(): { open: number; closed: number } {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS cnt FROM conversations GROUP BY status")
      .all() as Array<{ status: string; cnt: number }>;
    const result = { open: 0, closed: 0 };
    for (const row of rows) {
      if (row.status === "open") result.open = row.cnt;
      else if (row.status === "closed") result.closed = row.cnt;
    }
    return result;
  }

  messageStats(): { inbound: number; outbound: number; internal: number } {
    const rows = this.db
      .prepare("SELECT direction, COUNT(*) AS cnt FROM messages GROUP BY direction")
      .all() as Array<{ direction: string; cnt: number }>;
    const result = { inbound: 0, outbound: 0, internal: 0 };
    for (const row of rows) {
      if (row.direction === "inbound") result.inbound = row.cnt;
      else if (row.direction === "outbound") result.outbound = row.cnt;
      else if (row.direction === "internal") result.internal = row.cnt;
    }
    return result;
  }
}
