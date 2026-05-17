import pino from "pino";
import { loadConfig } from "./config.js";
import { createDb } from "../db/client.js";
import { migrate } from "../db/migrations/0001_initial.js";
import { createTelegramBot, startTelegramBot } from "../bot/telegram/bot.js";
import { sweepExpiredConversations } from "../core/conversation-expiry.js";

const logger = pino({ name: "inboxbridge" });

const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
await migrate(handle.client);

const bot = createTelegramBot(config, handle.db);
let expirySweepTimer: NodeJS.Timeout | undefined;

async function runExpirySweep(): Promise<void> {
  const cleaned = await sweepExpiredConversations({
    api: bot.api,
    db: handle.db,
    messageRetentionDays: config.MESSAGE_RETENTION_DAYS,
    defaultConversationRetentionDays: config.DEFAULT_CONVERSATION_RETENTION_DAYS,
  });
  if (cleaned > 0) {
    logger.info({ cleaned }, "Expired conversations cleaned.");
  }
}

void runExpirySweep().catch((error) => {
  logger.error({ error }, "Conversation expiry sweep failed.");
});

expirySweepTimer = setInterval(
  () => {
    void runExpirySweep().catch((error) => {
      logger.error({ error }, "Conversation expiry sweep failed.");
    });
  },
  config.CONVERSATION_EXPIRY_SWEEP_INTERVAL_MINUTES * 60 * 1000,
);

process.once("SIGINT", async () => {
  logger.info("Stopping InboxBridge after SIGINT.");
  if (expirySweepTimer) clearInterval(expirySweepTimer);
  await bot.stop();
  handle.client.close();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  logger.info("Stopping InboxBridge after SIGTERM.");
  if (expirySweepTimer) clearInterval(expirySweepTimer);
  await bot.stop();
  handle.client.close();
  process.exit(0);
});

logger.info({ mode: config.TELEGRAM_UPDATE_MODE }, "Starting InboxBridge.");
await startTelegramBot(bot, config);
