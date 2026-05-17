import type { Bot } from "grammy";
import type { Connector, NormalizedMessage, SendMessageInput, SendMessageResult } from "./connector.js";

export class TelegramConnector implements Connector {
  platform = "telegram";

  constructor(private readonly bot: Bot) {}

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    try {
      const sent = await this.bot.api.sendMessage(Number(input.targetExternalUserId), input.text ?? `[${input.messageType}]`);
      return { status: "sent", externalMessageId: String(sent.message_id) };
    } catch (error) {
      return { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  async normalizeIncoming(raw: unknown): Promise<NormalizedMessage> {
    const message = raw as {
      message_id?: number;
      from?: { id?: number };
      text?: string;
      date?: number;
    };
    if (!message.from?.id || !message.message_id) {
      throw new Error("Invalid Telegram message payload.");
    }
    return {
      platform: "telegram",
      externalUserId: String(message.from.id),
      externalMessageId: String(message.message_id),
      messageType: message.text ? "text" : "unsupported",
      text: message.text,
      rawPayload: raw,
      createdAt: message.date ? new Date(message.date * 1000).toISOString() : new Date().toISOString(),
    };
  }
}
