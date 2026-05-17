export type MessageDirection = "inbound" | "outbound" | "internal";

export interface NormalizedMessage {
  platform: string;
  externalUserId: string;
  externalMessageId: string;
  messageType: string;
  text?: string;
  rawPayload: unknown;
  createdAt: string;
}

export interface SendMessageInput {
  targetExternalUserId: string;
  messageType: string;
  text?: string;
  rawPayload?: unknown;
}

export interface SendMessageResult {
  externalMessageId?: string;
  status: "sent" | "failed";
  error?: string;
}

export interface Connector {
  platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  normalizeIncoming(raw: unknown): Promise<NormalizedMessage>;
}
