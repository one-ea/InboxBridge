import type { Context } from "grammy";
import type { Logger } from "pino";
import type { AppConfig } from "../../runtime/config.js";
import type { AiDraftService } from "../../domain/ai-drafts.js";
import type { AuditService } from "../../domain/audit.js";
import type { ConversationService } from "../../domain/conversations.js";
import type { DeliveryService } from "../../domain/deliveries.js";
import type { PermissionService } from "../../domain/permissions.js";
import type { RateLimitService } from "../../domain/rate-limit.js";
import { copyTelegramMessage, detectMessageType, extractText } from "./media.js";
import { ensureTelegramTopic } from "./topics.js";
import { handleTopicCommand } from "./commands.js";

export interface TelegramMessageDeps {
  config: AppConfig;
  conversations: ConversationService;
  deliveries: DeliveryService;
  permissions: PermissionService;
  rateLimit: RateLimitService;
  aiDrafts: AiDraftService;
  audit: AuditService;
  logger: Logger;
}

function fullName(user: { first_name?: string; last_name?: string }): string | undefined {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || undefined;
}

function displayName(user: { first_name?: string; last_name?: string; username?: string; id?: number }): string {
  const name = fullName(user);
  const username = user.username ? `@${user.username}` : undefined;
  return [name, username, user.id ? `id=${user.id}` : undefined].filter(Boolean).join(" | ") || "未知用户";
}

function contactInputFromTelegramUser(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}) {
  return {
    platform: "telegram",
    externalUserId: String(user.id),
    username: user.username,
    displayName: fullName(user),
  };
}

const MAX_MESSAGE_LENGTH = 4000;

function truncateText(text: string, max = MAX_MESSAGE_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

function fallbackText(input: {
  rawMessage: Record<string, unknown>;
  prefix: string;
  copyError?: string;
}): string {
  const type = detectMessageType(input.rawMessage);
  const text = extractText(input.rawMessage);
  const body = text?.trim() || `[${type}] 暂无法复制该类型的原始消息，请在 Telegram 中查看原消息记录。`;
  return truncateText([input.prefix, body, input.copyError ? `复制失败原因：${input.copyError}` : undefined].filter(Boolean).join("\n\n"));
}

function isMessageThreadNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("message thread not found");
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
  fallbackText?: string;
  allowGeneralChatFallback?: boolean;
}): Promise<void> {
  const deliveryId = await input.deliveries.createPending(input.sourceMessageId, input.target);
  let lastError = "unknown delivery failure";

  // Prefer Telegram-native copying so media, captions, and formatting survive.
  // If Telegram refuses a copy, fall back to a readable text summary below.
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

  if (input.messageThreadId && isMessageThreadNotFound(lastError)) {
    // A missing thread means our stored Topic mapping is stale. Let the caller
    // rebuild the conversation/topic instead of hiding the issue as a fallback.
    await input.deliveries.markFailed(deliveryId, lastError, 3);
    throw new Error(lastError);
  }

  if (input.fallbackText) {
    const text = input.fallbackText.replace("{{copyError}}", lastError);
    try {
      await input.ctx.api.sendMessage(input.targetChatId, text, {
        message_thread_id: input.messageThreadId,
      });
      await input.deliveries.markSent(deliveryId);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (input.allowGeneralChatFallback && input.messageThreadId) {
      try {
        await input.ctx.api.sendMessage(
          input.targetChatId,
          [`Topic 投递失败，已降级发送到管理群主消息区。`, text].join("\n\n"),
        );
        await input.deliveries.markSent(deliveryId);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
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

  const contactInput = contactInputFromTelegramUser(from);
  const bundle = await deps.conversations.getOrCreateConversation(contactInput);

  if (await deps.conversations.isBlocked(bundle.contact.id)) {
    await ctx.reply("当前暂不接收你的消息。");
    return;
  }

  const limit = deps.rateLimit.check(`telegram:${from.id}`);
  if (!limit.allowed) {
    await ctx.reply("消息发送过于频繁，请稍后再试。");
    return;
  }

  const wasClosed = bundle.conversation.status === "closed";
  if (wasClosed) {
    await deps.conversations.setConversationStatus(bundle.conversation.id, "open");
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

  let topic;
  try {
    topic = await ensureTelegramTopic({
      api: ctx.api,
      conversations: deps.conversations,
      bundle,
      managementChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
    });
  } catch (error) {
    await ctx.reply("消息已收到，但管理收件箱暂时不可用。请稍后再试。");
    throw error;
  }

  if (wasClosed) {
    try {
      await ctx.api.sendMessage(
        deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
        "会话已自动重开（用户发送了新消息）。",
        { message_thread_id: topic.messageThreadId },
      );
    } catch {
      // 通知失败不影响主流程
    }
  }

  try {
    await copyWithDelivery({
      ctx,
      deliveries: deps.deliveries,
      sourceMessageId: savedMessage.id,
      target: `telegram-topic:${topic.messageThreadId}`,
      targetChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
      fromChatId: message.chat.id,
      messageId: message.message_id,
      messageThreadId: topic.messageThreadId,
      fallbackText: fallbackText({
        rawMessage,
        prefix: `来自 ${displayName(from)} 的消息：`,
        copyError: "{{copyError}}",
      }),
      allowGeneralChatFallback: true,
    });
  } catch (error) {
    if (isMessageThreadNotFound(error)) {
      try {
        // The admin may have deleted the Topic directly in Telegram. In that
        // case, clear the stale conversation data and create a fresh Topic for
        // the incoming message.
        await deps.conversations.deleteConversationData(bundle.conversation.id);
        const recreatedBundle = await deps.conversations.getOrCreateConversation(contactInput);
        const recreatedMessage = await deps.conversations.createMessage({
          conversationId: recreatedBundle.conversation.id,
          contactId: recreatedBundle.contact.id,
          direction: "inbound",
          platform: "telegram",
          messageType: detectMessageType(rawMessage),
          text: extractText(rawMessage),
          rawPayload: rawMessage,
          externalMessageId: String(message.message_id),
        });
        const recreatedTopic = await ensureTelegramTopic({
          api: ctx.api,
          conversations: deps.conversations,
          bundle: recreatedBundle,
          managementChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
        });
        topic = recreatedTopic;
        await copyWithDelivery({
          ctx,
          deliveries: deps.deliveries,
          sourceMessageId: recreatedMessage.id,
          target: `telegram-topic:${recreatedTopic.messageThreadId}`,
          targetChatId: deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
          fromChatId: message.chat.id,
          messageId: message.message_id,
          messageThreadId: recreatedTopic.messageThreadId,
          fallbackText: fallbackText({
            rawMessage,
            prefix: `来自 ${displayName(from)} 的消息：`,
            copyError: "{{copyError}}",
          }),
          allowGeneralChatFallback: true,
        });
        await ctx.api.sendMessage(
          deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
          `原 Topic 已失效，InboxBridge 已清理旧会话并自动重建新 Topic。`,
          { message_thread_id: recreatedTopic.messageThreadId },
        );
        return;
      } catch (retryError) {
        deps.logger.error(
          {
            messageId: savedMessage.id,
            conversationId: bundle.conversation.id,
            contactId: bundle.contact.id,
            previousTopicThreadId: topic.messageThreadId,
            err: retryError,
          },
          "Inbound delivery retry after topic recreation failed.",
        );
      }
    }

    deps.logger.error(
      {
        messageId: savedMessage.id,
        conversationId: bundle.conversation.id,
        contactId: bundle.contact.id,
        topicThreadId: topic.messageThreadId,
        err: error,
      },
      "Inbound delivery to management chat failed.",
    );
    await ctx.reply("消息已保存，但转发到管理群失败。请稍后再试。");
    try {
      await ctx.api.sendMessage(
        deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
        `入站消息 ${savedMessage.id} 投递失败：${error instanceof Error ? error.message : String(error)}`,
        { message_thread_id: topic.messageThreadId },
      );
    } catch {
      // If the management chat itself is unavailable, keep the original error visible in bot.catch.
    }
  }

  if (bundle.conversation.priority === "urgent" && bundle.conversation.assignedAdminId) {
    try {
      await ctx.api.sendMessage(
        deps.config.TELEGRAM_MANAGEMENT_CHAT_ID,
        `紧急消息提醒：负责人 ${bundle.conversation.assignedAdminId} 请关注本会话。`,
        { message_thread_id: topic.messageThreadId },
      );
    } catch {
      // 提醒失败不影响主流程
    }
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
    if (!handled) await ctx.reply("未知命令。发送 /help 查看可用命令列表。");
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
      fromChatId: message.chat.id,
      messageId: message.message_id,
      fallbackText: fallbackText({
        rawMessage,
        prefix: "管理员回复：",
        copyError: "{{copyError}}",
      }),
    });
  } catch (error) {
    await ctx.reply(`投递失败，已标记为可重试：${error instanceof Error ? error.message : String(error)}`);
  }
}
