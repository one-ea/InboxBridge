import { createServer } from "node:http";
import { Bot, webhookCallback } from "grammy";
import type { AppConfig } from "../../app/config.js";
import { AiDraftService } from "../../core/ai-drafts.js";
import { ConversationService } from "../../core/conversations.js";
import { DeliveryService } from "../../core/deliveries.js";
import { PermissionService } from "../../core/permissions.js";
import { RateLimitService } from "../../core/rate-limit.js";
import type { Database } from "../../db/client.js";
import { registerTelegramMenu } from "./menu.js";
import { registerTelegramUpdates } from "./updates.js";

export function createTelegramBot(config: AppConfig, db: Database): Bot {
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const conversations = new ConversationService(
    db,
    config.MESSAGE_RETENTION_DAYS,
    config.DEFAULT_CONVERSATION_RETENTION_DAYS,
  );
  const deps = {
    config,
    conversations,
    deliveries: new DeliveryService(db),
    permissions: new PermissionService(config.TELEGRAM_ADMIN_USER_IDS),
    rateLimit: new RateLimitService(config.RATE_LIMIT_WINDOW_SECONDS, config.RATE_LIMIT_MAX_MESSAGES),
    aiDrafts: new AiDraftService(db, conversations, config),
  };
  registerTelegramUpdates(bot, deps);
  return bot;
}

export async function startTelegramBot(bot: Bot, config: AppConfig): Promise<void> {
  await registerTelegramMenu(bot.api, config);

  if (config.TELEGRAM_UPDATE_MODE === "polling") {
    await bot.start({
      allowed_updates: ["message"],
    });
    return;
  }

  const webhookUrl = config.TELEGRAM_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("TELEGRAM_WEBHOOK_URL is required when TELEGRAM_UPDATE_MODE=webhook");
  }
  await bot.api.setWebhook(webhookUrl);
  const server = createServer(webhookCallback(bot, "http"));
  await new Promise<void>((resolve) => {
    server.listen(config.TELEGRAM_WEBHOOK_PORT, resolve);
  });
  console.log(`Webhook server listening on ${config.TELEGRAM_WEBHOOK_PORT}`);
}
