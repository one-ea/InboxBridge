import pino from "pino";
import { configIssues, loadConfigFromSources, loadDatabaseConfig } from "./config.js";
import { createDb } from "../db/client.js";
import { migrate } from "../db/migrations/0001_initial.js";
import {
  createTelegramBot,
  createTelegramWebhookHandler,
  prepareTelegramBot,
  startTelegramBot,
  startTelegramPolling,
} from "../bot/telegram/bot.js";
import { sweepExpiredConversations } from "../core/conversation-expiry.js";
import { AppSettingsService } from "../core/app-settings.js";
import { ensureSetupToken, startWebConsole } from "./web-console.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const logger = pino({ name: "inboxbridge" });

const databaseConfig = loadDatabaseConfig();
const handle = createDb(databaseConfig.DATABASE_URL);
await migrate(handle.client);
const settings = new AppSettingsService(handle.db);
const setupToken = ensureSetupToken(settings);
if (setupToken) {
  logger.info({ setupToken }, "Open the web console and use this setup token to finish InboxBridge configuration.");
}

let expirySweepTimer: NodeJS.Timeout | undefined;
let activeBot: ReturnType<typeof createTelegramBot> | undefined;
let pollingBot = false;
let telegramWebhook: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;
let lastRuntimeError: string | undefined;
let restartQueue = Promise.resolve();

async function runExpirySweep(): Promise<void> {
  if (!activeBot) return;
  const config = loadConfigFromSources(settings.all());
  const cleaned = await sweepExpiredConversations({
    api: activeBot.api,
    db: handle.db,
    messageRetentionDays: config.MESSAGE_RETENTION_DAYS,
    defaultConversationRetentionDays: config.DEFAULT_CONVERSATION_RETENTION_DAYS,
  });
  if (cleaned > 0) {
    logger.info({ cleaned }, "Expired conversations cleaned.");
  }
}

async function restartRuntime(): Promise<void> {
  const run = restartQueue.then(restartRuntimeUnlocked, restartRuntimeUnlocked);
  restartQueue = run.catch(() => {});
  return run;
}

async function restartRuntimeUnlocked(): Promise<void> {
  await stopRuntime();
  const issues = configIssues(settings.all());
  if (issues.length > 0) {
    lastRuntimeError = issues.join("; ");
    logger.warn({ issues }, "InboxBridge bot is waiting for complete configuration.");
    return;
  }

  const config = loadConfigFromSources(settings.all());
  const bot = createTelegramBot(config, handle.db);
  activeBot = bot;
  pollingBot = config.TELEGRAM_UPDATE_MODE === "polling";
  telegramWebhook = pollingBot ? undefined : createTelegramWebhookHandler(bot, config);
  lastRuntimeError = undefined;

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

  try {
    if (pollingBot) {
      await prepareTelegramBot(bot, config);
      if (activeBot !== bot) return;
      void startTelegramPolling(bot).catch((error) => {
        lastRuntimeError = error instanceof Error ? error.message : String(error);
        if (activeBot === bot) {
          void stopRuntime();
        }
        logger.error({ error }, "Telegram bot stopped with an error.");
      });
    } else {
      await startTelegramBot(bot, config);
    }
  } catch (error) {
    if (activeBot === bot) {
      lastRuntimeError = error instanceof Error ? error.message : String(error);
      await stopRuntime();
    }
    logger.error({ error }, "Telegram bot runtime failed to start.");
    return;
  }

  logger.info({ mode: config.TELEGRAM_UPDATE_MODE }, "InboxBridge bot runtime started.");
}

async function stopRuntime(): Promise<void> {
  if (expirySweepTimer) clearInterval(expirySweepTimer);
  expirySweepTimer = undefined;
  telegramWebhook = undefined;
  if (activeBot && pollingBot) {
    try {
      await activeBot.stop();
    } catch (error) {
      logger.warn({ error }, "Telegram bot was already stopped.");
    }
  }
  activeBot = undefined;
  pollingBot = false;
}

process.once("SIGINT", async () => {
  logger.info("Stopping InboxBridge after SIGINT.");
  await stopRuntime();
  handle.client.close();
  process.exit(0);
});

process.once("SIGTERM", async () => {
  logger.info("Stopping InboxBridge after SIGTERM.");
  await stopRuntime();
  handle.client.close();
  process.exit(0);
});

await startWebConsole({
  settings,
  port: databaseConfig.WEB_CONSOLE_PORT,
  getStatus: () => ({
    bot: activeBot ? "running" : "stopped",
    issues: lastRuntimeError ? [lastRuntimeError] : configIssues(settings.all()),
  }),
  onConfigSaved: restartRuntime,
  telegramWebhook: (req, res) => {
    if (telegramWebhook) {
      return telegramWebhook(req, res);
    }
    res.statusCode = 503;
    res.end("Telegram webhook is not configured.");
    return Promise.resolve();
  },
});
logger.info({ port: databaseConfig.WEB_CONSOLE_PORT }, "InboxBridge web console started.");
await restartRuntime();
