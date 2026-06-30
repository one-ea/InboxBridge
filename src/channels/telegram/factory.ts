import { Bot } from "grammy";
import type { Logger } from "pino";
import { AiDraftService } from "../../domain/ai-drafts.js";
import { AuditService } from "../../domain/audit.js";
import { ConversationService } from "../../domain/conversations.js";
import { DeliveryService } from "../../domain/deliveries.js";
import { PermissionService } from "../../domain/permissions.js";
import { RateLimitService } from "../../domain/rate-limit.js";
import type { Database } from "../../ports/database.js";
import type { AppConfig } from "../../runtime/config.js";
import { registerTelegramUpdates } from "./updates.js";

export function createTelegramBot(config: AppConfig, db: Database, logger: Logger): Bot {
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
    audit: new AuditService(db),
    logger: logger.child({ module: "telegram.messages" }),
  };
  registerTelegramUpdates(bot, deps);
  return bot;
}
