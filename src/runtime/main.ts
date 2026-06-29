import pino from "pino";
import { configIssues, loadConfigFromSources, loadDatabaseConfig } from "./config.js";
import { createDb } from "../storage/client.js";
import { migrate } from "../storage/migrations/0001_initial.js";
import {
  createTelegramBot,
  createTelegramWebhookHandler,
  prepareTelegramBot,
  startTelegramBot,
  startTelegramPolling,
} from "../channels/telegram/bot.js";
import { sweepExpiredConversations } from "../domain/conversation-expiry.js";
import { RetentionService } from "../domain/retention.js";
import { startDeliveryRetryWorker } from "../domain/delivery-retry.js";
import { DeliveryService } from "../domain/deliveries.js";
import { ConversationService } from "../domain/conversations.js";
import { AiDraftService } from "../domain/ai-drafts.js";
import { AppSettingsService } from "../domain/app-settings.js";
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
let messageRetentionTimer: NodeJS.Timeout | undefined;
let deliveryRetryStop: (() => void) | undefined;
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
    logger: logger.child({ module: "conversation-expiry" }),
  });
  if (cleaned > 0) {
    logger.info({ cleaned }, "Expired conversations cleaned.");
  }
}

async function runMessageRetentionSweep(): Promise<void> {
  const config = loadConfigFromSources(settings.all());
  const retention = new RetentionService(handle.db, config.MESSAGE_RETENTION_DAYS, logger.child({ module: "retention" }));
  const cleaned = await retention.cleanupExpired();
  if (cleaned > 0) {
    logger.info({ cleaned }, "Message retention sweep cleaned expired message content.");
  } else {
    logger.debug("Message retention sweep found nothing to clean.");
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
  const bot = createTelegramBot(config, handle.db, logger);
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

  void runMessageRetentionSweep().catch((error) => {
    logger.error({ error }, "Message retention sweep failed.");
  });
  messageRetentionTimer = setInterval(
    () => {
      void runMessageRetentionSweep().catch((error) => {
        logger.error({ error }, "Message retention sweep failed.");
      });
    },
    config.MESSAGE_RETENTION_SWEEP_INTERVAL_MINUTES * 60 * 1000,
  );

  deliveryRetryStop = startDeliveryRetryWorker({
    deliveries: new DeliveryService(handle.db),
    conversations: new ConversationService(
      handle.db,
      config.MESSAGE_RETENTION_DAYS,
      config.DEFAULT_CONVERSATION_RETENTION_DAYS,
    ),
    api: bot.api,
    logger,
    config,
  });

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
  if (messageRetentionTimer) clearInterval(messageRetentionTimer);
  messageRetentionTimer = undefined;
  deliveryRetryStop?.();
  deliveryRetryStop = undefined;
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

const rejectionWindow = new Map<string, { count: number; firstAt: number }>();
const REJECTION_DEDUP_WINDOW_MS = 60_000;
const REJECTION_DEDUP_THRESHOLD = 5;

process.on("unhandledRejection", (reason) => {
  const key = reason instanceof Error ? reason.message : String(reason);
  const now = Date.now();
  const entry = rejectionWindow.get(key);
  if (entry) {
    entry.count += 1;
    if (entry.count > REJECTION_DEDUP_THRESHOLD && now - entry.firstAt < REJECTION_DEDUP_WINDOW_MS) {
      return;
    }
    if (entry.count === REJECTION_DEDUP_THRESHOLD) {
      logger.warn({ key, count: entry.count }, "Unhandled rejection repeated; suppressing further logs for 60s.");
    } else {
      logger.error({ reason }, "Unhandled promise rejection.");
    }
  } else {
    rejectionWindow.set(key, { count: 1, firstAt: now });
    logger.error({ reason }, "Unhandled promise rejection.");
  }
  for (const [k, v] of rejectionWindow) {
    if (now - v.firstAt >= REJECTION_DEDUP_WINDOW_MS) rejectionWindow.delete(k);
  }
});

let shuttingDown = false;

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception; initiating controlled shutdown.");
  if (shuttingDown) return;
  shuttingDown = true;
  void stopRuntime()
    .catch((err) => {
      logger.error({ error: err }, "Error during uncaughtException shutdown.");
    })
    .finally(() => {
      handle.client.close();
      process.exit(1);
    });
  setTimeout(() => {
    logger.warn("Graceful shutdown timed out after 10s; forcing exit.");
    handle.client.close();
    process.exit(1);
  }, 10_000).unref();
});

function gracefulShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down InboxBridge.");
  let exited = false;
  const forceExit = () => {
    if (exited) return;
    exited = true;
    logger.warn("Graceful shutdown timed out after 10s; forcing exit.");
    handle.client.close();
    process.exit(1);
  };
  const timer = setTimeout(forceExit, 10_000);
  timer.unref();
  void stopRuntime()
    .catch((error) => {
      logger.error({ error }, "Error during graceful shutdown.");
    })
    .finally(() => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      handle.client.close();
      process.exit(0);
    });
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

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
  dbHealthCheck: () => {
    handle.db.prepare("SELECT 1").get();
    return true;
  },
  collectMetrics: () => {
    const conversations = new ConversationService(
      handle.db,
      Number(loadConfigFromSources(settings.all()).MESSAGE_RETENTION_DAYS) || 30,
      loadConfigFromSources(settings.all()).DEFAULT_CONVERSATION_RETENTION_DAYS ?? 30,
    );
    const deliveries = new DeliveryService(handle.db);
    const aiDrafts = new AiDraftService(handle.db, conversations, loadConfigFromSources(settings.all()));
    const msgStats = conversations.messageStats();
    const convStats = conversations.conversationStats();
    const delStats = deliveries.stats();
    const draftStats = aiDrafts.stats();
    return {
      messages: {
        inbound_total: msgStats.inbound,
        outbound_total: msgStats.outbound,
        internal_total: msgStats.internal,
      },
      deliveries: {
        pending: delStats.pending,
        sent: delStats.sent,
        failed: delStats.failed,
        permanent_failure: delStats.permanentFailure,
      },
      conversations: {
        open: convStats.open,
        closed: convStats.closed,
      },
      ai_drafts: {
        pending: draftStats.pending,
        ready: draftStats.ready,
        failed: draftStats.failed,
      },
      uptime_seconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  },
  collectOperationsOverview: () => {
    const config = loadConfigFromSources(settings.all());
    const conversations = new ConversationService(
      handle.db,
      config.MESSAGE_RETENTION_DAYS,
      config.DEFAULT_CONVERSATION_RETENTION_DAYS,
    );
    const deliveries = new DeliveryService(handle.db);
    const aiDrafts = new AiDraftService(handle.db, conversations, config);
    const msgStats = conversations.messageStats();
    const convStats = conversations.conversationStats();
    const delStats = deliveries.stats();
    const draftStats = aiDrafts.stats();
    return {
      messages: { inboundTotal: msgStats.inbound, outboundTotal: msgStats.outbound, internalTotal: msgStats.internal },
      deliveries: { pending: delStats.pending, sent: delStats.sent, failed: delStats.failed, permanentFailure: delStats.permanentFailure },
      conversations: { open: convStats.open, closed: convStats.closed },
      aiDrafts: { pending: draftStats.pending, ready: draftStats.ready, failed: draftStats.failed, sent: draftStats.sent, discarded: draftStats.discarded },
      uptimeSeconds: Math.round(process.uptime()),
    };
  },
  listConversations: (opts) => {
    const conversations = new ConversationService(
      handle.db,
      loadConfigFromSources(settings.all()).MESSAGE_RETENTION_DAYS,
      loadConfigFromSources(settings.all()).DEFAULT_CONVERSATION_RETENTION_DAYS,
    );
    const result = conversations.listConversations({
      status: opts.status === "open" || opts.status === "closed" ? opts.status : undefined,
      limit: opts.pageSize,
      offset: (opts.page - 1) * opts.pageSize,
    });
    return {
      items: result.items.map((c) => ({
        id: c.id,
        status: c.status,
        priority: c.priority,
        assignedAdminId: c.assignedAdminId,
        createdAt: c.createdAt,
        lastMessageAt: c.lastMessageAt,
        contactDisplayName: c.contactDisplayName,
        contactUsername: c.contactUsername,
        topicName: c.topicName,
        messageThreadId: c.messageThreadId,
      })),
      total: result.total,
    };
  },
  listFailedDeliveries: (opts) => {
    const deliveries = new DeliveryService(handle.db);
    const result = deliveries.listFailedDeliveries({
      limit: opts.pageSize,
      offset: (opts.page - 1) * opts.pageSize,
    });
    return {
      items: result.items.map((d) => ({
        id: d.id,
        sourceMessageId: d.sourceMessageId,
        target: d.target,
        status: d.status,
        attemptCount: d.attemptCount,
        lastError: d.lastError,
        nextRetryAt: d.nextRetryAt,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
      total: result.total,
    };
  },
  scheduleRetry: async (deliveryId: number) => {
    const deliveries = new DeliveryService(handle.db);
    deliveries.scheduleRetry(deliveryId);
  },
});
logger.info({ port: databaseConfig.WEB_CONSOLE_PORT }, "InboxBridge web console started.");
await restartRuntime();
