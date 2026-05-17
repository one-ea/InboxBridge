import type { DatabaseSync } from "node:sqlite";

const statements = [
  `CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    external_user_id TEXT NOT NULL,
    username TEXT,
    display_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS contacts_platform_external_uidx ON contacts(platform, external_user_id)",
  `CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    status TEXT NOT NULL DEFAULT 'open',
    assigned_admin_id TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    muted_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_message_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS conversations_contact_idx ON conversations(contact_id)",
  `CREATE TABLE IF NOT EXISTS telegram_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    management_chat_id TEXT NOT NULL,
    message_thread_id INTEGER NOT NULL,
    topic_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS telegram_topics_conversation_uidx ON telegram_topics(conversation_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS telegram_topics_thread_uidx ON telegram_topics(management_chat_id, message_thread_id)",
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    contact_id INTEGER REFERENCES contacts(id),
    direction TEXT NOT NULL,
    platform TEXT NOT NULL,
    message_type TEXT NOT NULL,
    text TEXT,
    raw_payload TEXT,
    external_message_id TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id)",
  "CREATE INDEX IF NOT EXISTS messages_expires_idx ON messages(expires_at)",
  `CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_message_id INTEGER REFERENCES messages(id),
    target TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS deliveries_retry_idx ON deliveries(status, next_retry_at)",
  `CREATE TABLE IF NOT EXISTS admin_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    admin_user_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS blocks_contact_uidx ON blocks(contact_id)",
  `CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS tags_name_uidx ON tags(name)",
  `CREATE TABLE IF NOT EXISTS conversation_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    created_at TEXT NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS conversation_tags_uidx ON conversation_tags(conversation_id, tag_id)",
  `CREATE TABLE IF NOT EXISTS ai_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    source_message_id INTEGER REFERENCES messages(id),
    draft_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS ai_drafts_conversation_idx ON ai_drafts(conversation_id)",
];

export async function migrate(client: DatabaseSync): Promise<void> {
  for (const statement of statements) {
    client.exec(statement);
  }
}
