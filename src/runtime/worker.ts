import type { Bot } from "grammy";
import type { Logger } from "pino";
import { createTelegramBot as defaultCreateTelegramBot } from "../channels/telegram/factory.js";
import { createWorkerTelegramWebhookHandler, type WorkerTelegramWebhookHandler } from "../channels/telegram/worker-webhook.js";
import { telegramWebhookSecret } from "../channels/telegram/secrets.js";
import { AppSettingsService } from "../domain/app-settings.js";
import type { Database } from "../ports/database.js";
import { D1DatabaseAdapter, type D1DatabaseBinding } from "../storage/d1.js";
import { migrate } from "../storage/migrations/0001_initial.js";
import { loadConfigFromSources, type AppConfig, type ConfigMap } from "./config.js";
import { runMaintenanceJobs as defaultRunMaintenanceJobs, type MaintenanceJobsInput, type MaintenanceJobSummary } from "./maintenance.js";

export interface WorkerEnv {
  DB: D1DatabaseBinding;
  [key: string]: D1DatabaseBinding | string | undefined;
}

export function workerEnvToConfigMap(env: WorkerEnv): ConfigMap {
  const config: ConfigMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") config[key] = value;
  }
  return config;
}

export interface WorkerRuntimeOptions {
  telegramWebhookHandler?: WorkerTelegramWebhookHandler;
  createTelegramBot?: (config: AppConfig, db: Database, logger: Logger) => Bot;
  createTelegramWebhookHandler?: (bot: Bot, expectedSecret: string) => WorkerTelegramWebhookHandler;
  runMaintenanceJobs?: (input: MaintenanceJobsInput) => Promise<MaintenanceJobSummary>;
  logger?: Logger;
}

export interface WorkerScheduledController {
  cron: string;
  scheduledTime: number;
}

export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleWorkerFetch(request: Request, env: WorkerEnv, options: WorkerRuntimeOptions = {}): Promise<Response> {
  const db = new D1DatabaseAdapter(env.DB);
  await migrate(db);

  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    await db.prepare("SELECT 1").get();
    return json({ status: "ok", database: "reachable" });
  }

  if (url.pathname === "/telegram/webhook") {
    const handler = options.telegramWebhookHandler ?? (await createDefaultTelegramWebhookHandler(db, env, options));
    return handler(request);
  }

  return json({ error: "not_found" }, { status: 404 });
}

export async function handleWorkerScheduled(
  _controller: WorkerScheduledController,
  env: WorkerEnv,
  _ctx: WorkerExecutionContext,
  options: WorkerRuntimeOptions = {},
): Promise<void> {
  const db = new D1DatabaseAdapter(env.DB);
  await migrate(db);
  const settings = new AppSettingsService(db);
  const config = loadConfigFromSources(await settings.all(), workerEnvToConfigMap(env));
  const logger = options.logger ?? createWorkerLogger();
  const bot = (options.createTelegramBot ?? defaultCreateTelegramBot)(config, db, logger);
  const summary = await (options.runMaintenanceJobs ?? defaultRunMaintenanceJobs)({
    api: bot.api,
    db,
    config,
    logger,
  });
  logger.info(summary, "Worker scheduled maintenance completed.");
}

async function createDefaultTelegramWebhookHandler(
  db: Database,
  env: WorkerEnv,
  options: WorkerRuntimeOptions,
): Promise<WorkerTelegramWebhookHandler> {
  const settings = new AppSettingsService(db);
  const config = loadConfigFromSources(await settings.all(), workerEnvToConfigMap(env));
  const logger = options.logger ?? createWorkerLogger();
  const bot = (options.createTelegramBot ?? defaultCreateTelegramBot)(config, db, logger);
  return (options.createTelegramWebhookHandler ?? createWorkerTelegramWebhookHandler)(bot, await telegramWebhookSecret(config));
}

function createWorkerLogger(): Logger {
  const logger = {
    child: () => logger,
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  return logger as unknown as Logger;
}

function json(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
}

export default {
  fetch: handleWorkerFetch,
  scheduled(controller: WorkerScheduledController, env: WorkerEnv, ctx: WorkerExecutionContext) {
    ctx.waitUntil(handleWorkerScheduled(controller, env, ctx));
  },
};
