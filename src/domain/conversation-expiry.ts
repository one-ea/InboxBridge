import type { Api } from "grammy";
import type { Logger } from "pino";
import type { Database } from "../storage/client.js";
import { ConversationService } from "./conversations.js";

export async function sweepExpiredConversations(input: {
  api: Api;
  db: Database;
  messageRetentionDays: number;
  defaultConversationRetentionDays: number | null;
  logger: Logger;
}): Promise<number> {
  const conversations = new ConversationService(
    input.db,
    input.messageRetentionDays,
    input.defaultConversationRetentionDays,
  );
  const expired = await conversations.expiredConversations();
  let cleaned = 0;

  for (const item of expired) {
    try {
      // Keep the client and database in sync: delete the Telegram topic first,
      // then remove local data. If Telegram refuses the delete, keep the row so
      // a later sweep can retry instead of silently losing state.
      await input.api.deleteForumTopic(Number(item.topic.managementChatId), item.topic.messageThreadId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("message thread not found")) {
        input.logger.error(
          {
            conversationId: item.conversation.id,
            messageThreadId: item.topic.messageThreadId,
            err: error,
          },
          "Failed to delete expired Telegram topic.",
        );
        continue;
      }
    }

    await conversations.deleteConversationData(item.conversation.id);
    cleaned += 1;
  }

  return cleaned;
}
