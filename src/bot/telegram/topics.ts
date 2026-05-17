import type { Api } from "grammy";
import type { ConversationService, ConversationBundle } from "../../core/conversations.js";

export function buildTopicName(bundle: ConversationBundle): string {
  const display = bundle.contact.displayName?.trim();
  const username = bundle.contact.username?.trim();
  const suffix = bundle.contact.externalUserId.slice(-4);
  if (display || username) {
    return [display, username ? `@${username}` : undefined, `id${suffix}`].filter(Boolean).join(" | ");
  }
  return `User ${suffix}`;
}

export async function ensureTelegramTopic(input: {
  api: Api;
  conversations: ConversationService;
  bundle: ConversationBundle;
  managementChatId: number;
  forceCreate?: boolean;
}) {
  const existing = await input.conversations.getTopicByConversation(input.bundle.conversation.id);
  if (existing && !input.forceCreate) return existing;

  const topicName = buildTopicName(input.bundle);
  const created = await input.api.createForumTopic(input.managementChatId, topicName);
  return input.conversations.saveTopic({
    conversationId: input.bundle.conversation.id,
    managementChatId: String(input.managementChatId),
    messageThreadId: created.message_thread_id,
    topicName,
  });
}
