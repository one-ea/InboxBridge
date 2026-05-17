import type { Context } from "grammy";

const mediaKeys = [
  "photo",
  "video",
  "voice",
  "audio",
  "document",
  "sticker",
  "contact",
  "location",
  "poll",
  "animation",
  "video_note",
] as const;

export function detectMessageType(message: Record<string, unknown>): string {
  if (typeof message.text === "string") return "text";
  for (const key of mediaKeys) {
    if (message[key] !== undefined) return key;
  }
  if (message.caption) return "captioned_media";
  return "unsupported";
}

export function extractText(message: Record<string, unknown>): string | undefined {
  if (typeof message.text === "string") return message.text;
  if (typeof message.caption === "string") return message.caption;
  return undefined;
}

export function summarizeTelegramMessage(message: Record<string, unknown>): string {
  const type = detectMessageType(message);
  const text = extractText(message);
  return text ? `[${type}] ${text}` : `[${type}]`;
}

export async function copyTelegramMessage(
  ctx: Context,
  targetChatId: number,
  fromChatId: number,
  messageId: number,
  options: { messageThreadId?: number } = {},
): Promise<number | undefined> {
  const copied = await ctx.api.copyMessage(targetChatId, fromChatId, messageId, {
    message_thread_id: options.messageThreadId,
  });
  return copied.message_id;
}
