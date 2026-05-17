import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const contacts = sqliteTable(
  "contacts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: text("platform").notNull(),
    externalUserId: text("external_user_id").notNull(),
    username: text("username"),
    displayName: text("display_name"),
    status: text("status", { enum: ["active", "blocked"] }).notNull().default("active"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("contacts_platform_external_uidx").on(table.platform, table.externalUserId)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id").notNull().references(() => contacts.id),
    status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
    assignedAdminId: text("assigned_admin_id"),
    priority: text("priority", { enum: ["low", "normal", "high", "urgent"] }).notNull().default("normal"),
    mutedUntil: text("muted_until"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastMessageAt: text("last_message_at"),
  },
  (table) => [index("conversations_contact_idx").on(table.contactId)],
);

export const telegramTopics = sqliteTable(
  "telegram_topics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id").notNull().references(() => conversations.id),
    managementChatId: text("management_chat_id").notNull(),
    messageThreadId: integer("message_thread_id").notNull(),
    topicName: text("topic_name").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("telegram_topics_conversation_uidx").on(table.conversationId),
    uniqueIndex("telegram_topics_thread_uidx").on(table.managementChatId, table.messageThreadId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id").notNull().references(() => conversations.id),
    contactId: integer("contact_id").references(() => contacts.id),
    direction: text("direction", { enum: ["inbound", "outbound", "internal"] }).notNull(),
    platform: text("platform").notNull(),
    messageType: text("message_type").notNull(),
    text: text("text"),
    rawPayload: text("raw_payload"),
    externalMessageId: text("external_message_id"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
  },
  (table) => [
    index("messages_conversation_idx").on(table.conversationId),
    index("messages_expires_idx").on(table.expiresAt),
  ],
);

export const deliveries = sqliteTable(
  "deliveries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceMessageId: integer("source_message_id").references(() => messages.id),
    target: text("target").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed"] }).notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    nextRetryAt: text("next_retry_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("deliveries_retry_idx").on(table.status, table.nextRetryAt)],
);

export const adminNotes = sqliteTable("admin_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id),
  adminUserId: text("admin_user_id").notNull(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});

export const blocks = sqliteTable(
  "blocks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    contactId: integer("contact_id").notNull().references(() => contacts.id),
    reason: text("reason"),
    createdBy: text("created_by"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("blocks_contact_uidx").on(table.contactId)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("tags_name_uidx").on(table.name)],
);

export const conversationTags = sqliteTable(
  "conversation_tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id").notNull().references(() => conversations.id),
    tagId: integer("tag_id").notNull().references(() => tags.id),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("conversation_tags_uidx").on(table.conversationId, table.tagId)],
);

export const aiDrafts = sqliteTable(
  "ai_drafts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id").notNull().references(() => conversations.id),
    sourceMessageId: integer("source_message_id").references(() => messages.id),
    draftText: text("draft_text"),
    status: text("status", { enum: ["pending", "ready", "failed"] }).notNull().default("pending"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("ai_drafts_conversation_idx").on(table.conversationId)],
);

export const contactRelations = relations(contacts, ({ many }) => ({
  conversations: many(conversations),
}));

export const conversationRelations = relations(conversations, ({ one, many }) => ({
  contact: one(contacts, {
    fields: [conversations.contactId],
    references: [contacts.id],
  }),
  messages: many(messages),
  telegramTopic: one(telegramTopics),
}));

export type Contact = typeof contacts.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type TelegramTopic = typeof telegramTopics.$inferSelect;
