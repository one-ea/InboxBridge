import pino from "pino";
import { loadConfig } from "./config.js";
import { createDb } from "../db/client.js";
import { migrate } from "../db/migrations/0001_initial.js";
import { createTelegramBot, startTelegramBot } from "../bot/telegram/bot.js";

const logger = pino({ name: "inboxbridge" });

const config = loadConfig();
const handle = createDb(config.DATABASE_URL);
await migrate(handle.client);

const bot = createTelegramBot(config, handle.db);

process.once("SIGINT", async () => {
  logger.info("Stopping InboxBridge after SIGINT.");
  await bot.stop();
  handle.client.close();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  logger.info("Stopping InboxBridge after SIGTERM.");
  await bot.stop();
  handle.client.close();
  process.exit(0);
});

logger.info({ mode: config.TELEGRAM_UPDATE_MODE }, "Starting InboxBridge.");
await startTelegramBot(bot, config);
