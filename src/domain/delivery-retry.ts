import type { Logger } from "pino";
import type { Bot } from "grammy";
import type { AppConfig } from "../runtime/config.js";
import type { DeliveryService } from "./deliveries.js";
import { MAX_DELIVERY_ATTEMPTS } from "./deliveries.js";
import type { ConversationService } from "./conversations.js";

export interface DeliveryRetryDeps {
  deliveries: DeliveryService;
  conversations: ConversationService;
  api: Bot["api"];
  logger: Logger;
  config: AppConfig;
}

export function startDeliveryRetryWorker(deps: DeliveryRetryDeps): () => void {
  const intervalMs = Math.max(5, deps.config.DELIVERY_RETRY_INTERVAL_SECONDS) * 1000;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let due: Awaited<ReturnType<DeliveryService["dueFailed"]>>;
    try {
      due = await deps.deliveries.dueFailed();
    } catch (error) {
      deps.logger.error({ error }, "Delivery retry worker failed to query due deliveries.");
      return;
    }

    if (due.length === 0) {
      deps.logger.debug("Delivery retry sweep found nothing to retry.");
      return;
    }

    deps.logger.info({ count: due.length }, "Delivery retry sweep processing due deliveries.");

    for (const delivery of due) {
      if (stopped) break;
      try {
        await retryDelivery(deps, delivery);
      } catch (error) {
        deps.logger.error({ error, deliveryId: delivery.id }, "Delivery retry worker hit an unexpected error.");
      }
    }
  };

  void tick().catch((error) => {
    deps.logger.error({ error }, "Delivery retry worker initial sweep failed.");
  });

  const timer = setInterval(() => {
    void tick().catch((error) => {
      deps.logger.error({ error }, "Delivery retry worker sweep failed.");
    });
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function retryDelivery(deps: DeliveryRetryDeps, delivery: DeliveryLike): Promise<void> {
  if (delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    await markPermanentFailure(deps, delivery, `Max attempts (${MAX_DELIVERY_ATTEMPTS}) reached`);
    return;
  }

  if (!delivery.sourceMessageId) {
    await markPermanentFailure(deps, delivery, "No source message linked to delivery");
    return;
  }

  const message = await deps.conversations.getMessage(delivery.sourceMessageId);
  if (!message) {
    await markPermanentFailure(deps, delivery, "Source message no longer exists");
    return;
  }

  if (message.text === null && message.rawPayload === null) {
    await markPermanentFailure(deps, delivery, "Source message content has been cleaned by retention");
    return;
  }

  if (!message.externalMessageId) {
    await markPermanentFailure(deps, delivery, "Source message has no external_message_id");
    return;
  }

  const target = parseDeliveryTarget(delivery.target, deps.config.TELEGRAM_MANAGEMENT_CHAT_ID);
  if (!target) {
    await markPermanentFailure(deps, delivery, `Unparseable delivery target: ${delivery.target}`);
    return;
  }

  const fromChatId = target.fromChatId ?? deps.config.TELEGRAM_MANAGEMENT_CHAT_ID;

  try {
    if (target.threadId !== undefined) {
      await deps.api.copyMessage(target.chatId, fromChatId, Number(message.externalMessageId), {
        message_thread_id: target.threadId,
      });
    } else {
      await deps.api.copyMessage(target.chatId, fromChatId, Number(message.externalMessageId));
    }
    await deps.deliveries.markSent(delivery.id);
    deps.logger.info({ deliveryId: delivery.id, attemptCount: delivery.attemptCount }, "Delivery retry succeeded.");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const nextAttempt = delivery.attemptCount + 1;
    if (nextAttempt >= MAX_DELIVERY_ATTEMPTS) {
      await markPermanentFailure(deps, delivery, errorMessage);
    } else {
      await deps.deliveries.markFailed(delivery.id, errorMessage, nextAttempt);
      deps.logger.warn(
        { deliveryId: delivery.id, attemptCount: nextAttempt, error: errorMessage },
        "Delivery retry failed, will retry later.",
      );
    }
  }
}

async function markPermanentFailure(deps: DeliveryRetryDeps, delivery: DeliveryLike, reason: string): Promise<void> {
  await deps.deliveries.markPermanentFailure(delivery.id, reason);
  deps.logger.error({ deliveryId: delivery.id, reason }, "Delivery permanently failed.");

  try {
    const target = parseDeliveryTarget(delivery.target, deps.config.TELEGRAM_MANAGEMENT_CHAT_ID);
    if (!target) return;

    const message = delivery.sourceMessageId
      ? await deps.conversations.getMessage(delivery.sourceMessageId)
      : undefined;
    const preview = message?.text ? truncate(message.text, 80) : "(内容不可用)";

    const notice = `投递永久失败\n原因：${reason}\n原始消息：${preview}`;
    if (target.threadId !== undefined) {
      await deps.api.sendMessage(target.chatId, notice, { message_thread_id: target.threadId });
    } else {
      await deps.api.sendMessage(target.chatId, notice);
    }
  } catch (error) {
    deps.logger.warn({ error, deliveryId: delivery.id }, "Failed to send permanent failure notice to Topic.");
  }
}

interface ParsedTarget {
  chatId: number;
  threadId?: number;
  fromChatId?: number;
}

function parseDeliveryTarget(target: string, managementChatId: number): ParsedTarget | undefined {
  if (target.startsWith("telegram-user:")) {
    const userId = Number(target.slice("telegram-user:".length));
    return Number.isNaN(userId) ? undefined : { chatId: userId, fromChatId: managementChatId };
  }
  if (target.startsWith("telegram-topic:")) {
    const threadId = Number(target.slice("telegram-topic:".length));
    return Number.isNaN(threadId) ? undefined : { chatId: managementChatId, threadId, fromChatId: managementChatId };
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

interface DeliveryLike {
  id: number;
  sourceMessageId: number | null;
  target: string;
  attemptCount: number;
}
