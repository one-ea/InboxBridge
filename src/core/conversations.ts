import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  adminNotes,
  blocks,
  contacts,
  conversationTags,
  conversations,
  messages,
  tags,
  telegramTopics,
  type Contact,
  type Conversation,
  type Message,
  type TelegramTopic,
} from "../db/schema.js";

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

export function nowIso(): string {
  return new Date().toISOString();
}

export function addDaysIso(days: number, from = new Date()): string {
  const date = new Date(from);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export class ConversationService {
  constructor(
    private readonly db: Database,
    private readonly retentionDays: number,
  ) {}

  async getOrCreateConversation(input: ContactInput): Promise<ConversationBundle> {
    const timestamp = nowIso();
    let contact = await this.db.query.contacts.findFirst({
      where: and(eq(contacts.platform, input.platform), eq(contacts.externalUserId, input.externalUserId)),
    });

    if (!contact) {
      const inserted = await this.db
        .insert(contacts)
        .values({
          platform: input.platform,
          externalUserId: input.externalUserId,
          username: input.username,
          displayName: input.displayName,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .returning();
      contact = inserted[0];
    } else {
      const updated = await this.db
        .update(contacts)
        .set({
          username: input.username ?? contact.username,
          displayName: input.displayName ?? contact.displayName,
          updatedAt: timestamp,
        })
        .where(eq(contacts.id, contact.id))
        .returning();
      contact = updated[0];
    }

    let conversation = await this.db.query.conversations.findFirst({
      where: eq(conversations.contactId, contact.id),
      orderBy: [desc(conversations.createdAt)],
    });

    if (!conversation) {
      const inserted = await this.db
        .insert(conversations)
        .values({
          contactId: contact.id,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastMessageAt: timestamp,
        })
        .returning();
      conversation = inserted[0];
    }

    return { contact, conversation };
  }

  async isBlocked(contactId: number): Promise<boolean> {
    const block = await this.db.query.blocks.findFirst({ where: eq(blocks.contactId, contactId) });
    return Boolean(block);
  }

  async blockContact(contactId: number, createdBy: string, reason?: string): Promise<void> {
    await this.db
      .insert(blocks)
      .values({ contactId, createdBy, reason, createdAt: nowIso() })
      .onConflictDoUpdate({
        target: blocks.contactId,
        set: { reason, createdBy, createdAt: nowIso() },
      });
    await this.db.update(contacts).set({ status: "blocked", updatedAt: nowIso() }).where(eq(contacts.id, contactId));
  }

  async unblockContact(contactId: number): Promise<void> {
    await this.db.delete(blocks).where(eq(blocks.contactId, contactId));
    await this.db.update(contacts).set({ status: "active", updatedAt: nowIso() }).where(eq(contacts.id, contactId));
  }

  async setConversationStatus(conversationId: number, status: "open" | "closed"): Promise<void> {
    await this.db.update(conversations).set({ status, updatedAt: nowIso() }).where(eq(conversations.id, conversationId));
  }

  async setPriority(conversationId: number, priority: "low" | "normal" | "high" | "urgent"): Promise<void> {
    await this.db.update(conversations).set({ priority, updatedAt: nowIso() }).where(eq(conversations.id, conversationId));
  }

  async assign(conversationId: number, adminUserId: string): Promise<void> {
    await this.db
      .update(conversations)
      .set({ assignedAdminId: adminUserId, updatedAt: nowIso() })
      .where(eq(conversations.id, conversationId));
  }

  async mute(conversationId: number, mutedUntil: string): Promise<void> {
    await this.db.update(conversations).set({ mutedUntil, updatedAt: nowIso() }).where(eq(conversations.id, conversationId));
  }

  async addNote(conversationId: number, adminUserId: string, note: string): Promise<void> {
    await this.db.insert(adminNotes).values({ conversationId, adminUserId, note, createdAt: nowIso() });
  }

  async addTag(conversationId: number, name: string): Promise<void> {
    const cleanName = name.trim().toLowerCase();
    if (!cleanName) return;
    await this.db
      .insert(tags)
      .values({ name: cleanName, createdAt: nowIso() })
      .onConflictDoNothing({ target: tags.name });
    const tag = await this.db.query.tags.findFirst({ where: eq(tags.name, cleanName) });
    if (!tag) return;
    await this.db
      .insert(conversationTags)
      .values({ conversationId, tagId: tag.id, createdAt: nowIso() })
      .onConflictDoNothing({ target: [conversationTags.conversationId, conversationTags.tagId] });
  }

  async removeTag(conversationId: number, name: string): Promise<void> {
    const tag = await this.db.query.tags.findFirst({ where: eq(tags.name, name.trim().toLowerCase()) });
    if (!tag) return;
    await this.db
      .delete(conversationTags)
      .where(and(eq(conversationTags.conversationId, conversationId), eq(conversationTags.tagId, tag.id)));
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
    const inserted = await this.db
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        contactId: input.contactId,
        direction: input.direction,
        platform: input.platform,
        messageType: input.messageType,
        text: input.text,
        rawPayload: input.rawPayload === undefined ? undefined : JSON.stringify(input.rawPayload),
        externalMessageId: input.externalMessageId,
        createdAt: timestamp,
        expiresAt: input.direction === "internal" ? undefined : addDaysIso(this.retentionDays),
      })
      .returning();
    await this.db
      .update(conversations)
      .set({ lastMessageAt: timestamp, updatedAt: timestamp })
      .where(eq(conversations.id, input.conversationId));
    return inserted[0];
  }

  async getTopicByThread(managementChatId: string, messageThreadId: number): Promise<TelegramTopic | undefined> {
    return this.db.query.telegramTopics.findFirst({
      where: and(
        eq(telegramTopics.managementChatId, managementChatId),
        eq(telegramTopics.messageThreadId, messageThreadId),
      ),
    });
  }

  async getTopicByConversation(conversationId: number): Promise<TelegramTopic | undefined> {
    return this.db.query.telegramTopics.findFirst({ where: eq(telegramTopics.conversationId, conversationId) });
  }

  async saveTopic(input: {
    conversationId: number;
    managementChatId: string;
    messageThreadId: number;
    topicName: string;
  }): Promise<TelegramTopic> {
    const timestamp = nowIso();
    const inserted = await this.db
      .insert(telegramTopics)
      .values({ ...input, createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: telegramTopics.conversationId,
        set: {
          managementChatId: input.managementChatId,
          messageThreadId: input.messageThreadId,
          topicName: input.topicName,
          updatedAt: timestamp,
        },
      })
      .returning();
    return inserted[0];
  }

  async getConversation(conversationId: number): Promise<Conversation | undefined> {
    return this.db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  }

  async getContact(contactId: number): Promise<Contact | undefined> {
    return this.db.query.contacts.findFirst({ where: eq(contacts.id, contactId) });
  }

  async recentMessages(conversationId: number, limit: number): Promise<Message[]> {
    return this.db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: [desc(messages.createdAt)],
      limit,
    });
  }
}
