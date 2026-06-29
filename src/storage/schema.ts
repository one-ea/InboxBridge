export interface Contact {
  id: number;
  platform: string;
  externalUserId: string;
  username: string | null;
  displayName: string | null;
  status: "active" | "blocked";
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: number;
  contactId: number;
  status: "open" | "closed";
  assignedAdminId: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  mutedUntil: string | null;
  retentionDays: number | null;
  expiresAt: string | null;
  aiEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

export interface Message {
  id: number;
  conversationId: number;
  contactId: number | null;
  direction: "inbound" | "outbound" | "internal";
  platform: string;
  messageType: string;
  text: string | null;
  rawPayload: string | null;
  externalMessageId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface TelegramTopic {
  id: number;
  conversationId: number;
  managementChatId: string;
  messageThreadId: number;
  topicName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  id: number;
  sourceMessageId: number | null;
  target: string;
  status: "pending" | "sent" | "failed";
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: number;
  name: string;
  createdAt: string;
}
