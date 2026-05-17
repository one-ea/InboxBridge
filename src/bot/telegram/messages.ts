import type { Context } from "grammy";
import type { AppConfig } from "../../app/config.js";
import type { AiDraftService } from "../../core/ai-drafts.js";
import type { ConversationService } from "../../core/conversations.js";
import type { DeliveryService } from "../../core/deliveries.js";
import type { PermissionService } from "../../core/permissions.js";
import type { RateLimitService } from "../../core/rate-limit.js";
import { copyTelegramMessage, detectMessageType, extractText, summarizeTelegramMessage } from "./media.js";
import { ensureTelegramTopic } from "./topics.js";
import { handleTopicCommand } from "./commands.js";

export interface TelegramMessageDeps {
  config: AppConfig;
  conversations: ConversationService;
  deliveries: DeliveryService;
  permissions: PermissionService;
  rateLimit: RateLimitService;
  aiDrafts: AiDraftService;
}

function fullName(user: { first_name?: string; last_name?: string }): string | undefined {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined;
}

async function copyWithDelivery(input: {
  ctx: Context;
  deliveries: DeliveryService;
  sourceMessageId?: number;
  target: string;
  targetChatId: number;
  fromChatId: number;
  messageId: number;
  messageThreadId?: number;
}): Promise<void> {
  const deliveryId = await input.deliveries.createPending(input.sourceMessageId, input.target);
  let lastError = "unknown delivery failure";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await copyTelegramMessage(input.ctx, input.targetChatId, input.fromChatId, input.messageId, {
        messageThreadId: input.messageThreadId,
      });
      await input.deliveries.markSent(deliveryId);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
      }
    }
  }
  await input.deliveries.markFailed(deliveryId, lastError, 3);
  throw new Error(lastError);
}

export async function handlePrivateMessage(ctx: Context, deps: TelegramMessageDeps): Promise<void> {
  const message = ctx.message;
  const from = ctx.from;
  if (!message || !from || message.chat.type !== "private") return;

  const bundle = await deps.conversations.getOrCreateConversation({
    platform: "telegram",
    externalUserId: String(from.id),
    username: from.username,
    displayName: fullName(from),
  });

  if (await deps.conversations.isBlocked(bundle.contact.id)) {
    await ctx.reply("当前暂不接收你的消息。");
    return;
  }

  const limit = deps.rateLimit.check(`telegram:${from.id}`);
  if (!limit.allowed) {
    await ctx.reply("消息发送过于频繁，请稍后再试。");
    return;
  }

  const rawMessage = message as unknown as Record<string, unknown>;
  const savedMessage = await deps.conversations.createMessage({
    conversationId: bundle.conversation.id,
    contactId: bundle.contact.id,
    direction: "inbound",
    platform: "telegram",
    messageType: detectMessageType(rawMessage),
    text: extractText(rawMessage),
    rawPayload: rawMessage,
    externalMessageId: String(message.message_id),
  });

  const topic = await ensureTelegramTopic({
    api: ctx.api,
    conversations: deps.conversations,
    bundle,
    managementChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
  });

  try {
    await copyWithDelivery({
      ctx,
      deliveries: deps.deliveries,
      sourceMessageId: savedMessage.id,
      target: `telegram-topic:${topic.messageThreadId}`,
      targetChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
      fromChatId: from.id,
      messageId: message.message_id,
      messageThreadId: topic.messageThreadId,
    });
  } catch (error) {
    await ctx.api.sendMessage(
      deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
      `入站消息 ${savedMessage.id} 投递失败：${error instanceof Error ? error.message : String(error)}`,
      { message_thread_id: topic.messageThreadId },
    );
  }

  const draft = await deps.aiDrafts.generate(bundle.conversation.id, savedMessage.id);
  if (draft.status === "ready") {
    await ctx.api.sendMessage(deps.config.TELEGRAM_MANAGEMENT_CHAT_ID, `AI 草稿（不会自动发送）：\n\n${draft.text}`, {
      message_thread_id: topic.messageThreadId,
    });
  } else if (deps.config.AI_DRAFTS_ENABLED) {
    await ctx.api.sendMessage(
      deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
      `AI 草稿不可用：${draft.error ?? draft.status}`,
      { message_thread_id: topic.messageThreadId },
    );
  }
}

export async function handleManagementMessage(ctx: Context, deps: TelegramMessageDeps): Promise<void> {
  const message = ctx.message;
  if (!message || message.chat.id !== deps.config.TELEGRAM_MANAGEMENT_CHAT_ID) return;
  if (ctx.from?.is_bot) return;

  const threadId = message.message_thread_id;
  if (!threadId) return;

  if (!deps.permissions.isAdmin(ctx.from?.id)) {
    await ctx.reply("该 Telegram 用户不在 InboxBridge 代发白名单中。");
    return;
  }

  const topic = await deps.conversations.getTopicByThread(String(deps.config.TELEGRAM_MANAGEMENT_CHAT_ID), threadId);
  if (!topic) return;

  const conversation = await deps.conversations.getConversation(topic.conversationId);
  if (!conversation) return;
  const contact = await deps.conversations.getContact(conversation.contactId);
  if (!contact) return;

  const rawMessage = message as unknown as Record<string, unknown>;
  const text = extractText(rawMessage);
  if (text?.startsWith("/")) {
    const handled = await handleTopicCommand(ctx, deps, { topic, conversation, contact }, text);
    if (!handled) await ctx.reply("未知命令。");
    return;
  }

  if (await deps.conversations.isBlocked(contact.id)) {
    await ctx.reply("该联系人已被封禁，请先使用 /unban 再回复。");
    return;
  }

  const savedMessage = await deps.conversations.createMessage({
    conversationId: conversation.id,
    contactId: contact.id,
    direction: "outbound",
    platform: "telegram",
    messageType: detectMessageType(rawMessage),
    text,
    rawPayload: rawMessage,
    externalMessageId: String(message.message_id),
  });

  try {
    await copyWithDelivery({
      ctx,
      deliveries: deps.deliveries,
      sourceMessageId: savedMessage.id,
      target: `telegram-user:${contact.externalUserId}`,
      targetChatId: Number(contact.externalUserId),
      fromChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
      messageId: message.message_id,
    });
  } catch (error) {
    await ctx.reply(`投递失败，已标记为可重试：${error instanceof Error ? error.message : String(error)}`);
  }
}
