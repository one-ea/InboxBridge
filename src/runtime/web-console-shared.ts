import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppSettingsService } from "../domain/app-settings.js";
import type { WebConsoleSessionKind } from "./web-console-session.js";

// Keys the web console persists in app_settings.
export const passwordHashKey = "WEB_CONSOLE_PASSWORD_HASH";
export const setupTokenKey = "WEB_CONSOLE_SETUP_TOKEN";
export const sessionSecretKey = "WEB_CONSOLE_SESSION_SECRET";
export const sessionCookie = "inboxbridge_session";

export type SessionKind = WebConsoleSessionKind;
export type OperationsTab = "overview" | "conversations" | "deliveries" | "audit" | "search";
export type WebConsoleSessionStore = Map<string, SessionKind>;

export interface ConsoleStatus {
  bot: "running" | "stopped";
  issues: string[];
}

export interface MetricsSnapshot {
  messages: {
    inbound_total: number;
    outbound_total: number;
    internal_total: number;
  };
  deliveries: {
    pending: number;
    sent: number;
    failed: number;
    permanent_failure: number;
  };
  conversations: {
    open: number;
    closed: number;
  };
  ai_drafts: {
    pending: number;
    ready: number;
    failed: number;
  };
  uptime_seconds: number;
  timestamp: string;
}

export interface ConversationListItemView {
  id: number;
  status: "open" | "closed";
  priority: "low" | "normal" | "high" | "urgent";
  assignedAdminId: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  contactDisplayName: string | null;
  contactUsername: string | null;
  topicName: string | null;
  messageThreadId: number | null;
}

export interface DeliveryView {
  id: number;
  sourceMessageId: number | null;
  target: string;
  status: "pending" | "sent" | "failed" | "permanent_failure";
  attemptCount: number;
  lastError: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationsOverview {
  messages: { inboundTotal: number; outboundTotal: number; internalTotal: number };
  deliveries: { pending: number; sent: number; failed: number; permanentFailure: number };
  conversations: { open: number; closed: number };
  aiDrafts: { pending: number; ready: number; failed: number; sent: number; discarded: number };
  uptimeSeconds: number;
}

export interface AuditLogView {
  id: number;
  adminId: string;
  conversationId: number;
  action: string;
  detail: string | null;
  createdAt: string;
}

export interface MessageSearchView {
  id: number;
  conversationId: number;
  direction: string;
  messageType: string;
  text: string | null;
  createdAt: string;
  contactDisplayName: string | null;
  topicName: string | null;
}

export interface WebConsoleOptions {
  settings: AppSettingsService;
  port: number;
  sessionSecret?: string;
  sessionMaxAgeSeconds?: number;
  now?: () => Date;
  getStatus: () => ConsoleStatus | Promise<ConsoleStatus>;
  onConfigSaved: () => Promise<void>;
  telegramWebhook?: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  dbHealthCheck: () => boolean | Promise<boolean>;
  collectMetrics: () => MetricsSnapshot | Promise<MetricsSnapshot>;
  collectOperationsOverview: () => OperationsOverview | Promise<OperationsOverview>;
  listConversations: (opts: { page: number; status?: string; assignedTo?: string; pageSize: number }) => { items: ConversationListItemView[]; total: number } | Promise<{ items: ConversationListItemView[]; total: number }>;
  listFailedDeliveries: (opts: { page: number; pageSize: number }) => { items: DeliveryView[]; total: number } | Promise<{ items: DeliveryView[]; total: number }>;
  scheduleRetry: (deliveryId: number) => Promise<void>;
  listAuditLogs: (opts: { page: number; adminId?: string; action?: string; pageSize: number }) => { items: AuditLogView[]; total: number } | Promise<{ items: AuditLogView[]; total: number }>;
  searchMessages: (opts: { query: string; page: number; pageSize: number }) => { items: MessageSearchView[]; total: number } | Promise<{ items: MessageSearchView[]; total: number }>;
}
