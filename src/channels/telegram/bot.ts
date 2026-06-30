import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { webhookCallback, type Bot } from "grammy";
import type { AppConfig } from "../../runtime/config.js";
import { registerTelegramMenu } from "./menu.js";
export { createTelegramBot } from "./factory.js";

export async function startTelegramBot(bot: Bot, config: AppConfig): Promise<void> {
  await prepareTelegramBot(bot, config);

  if (config.TELEGRAM_UPDATE_MODE === "polling") {
    await startTelegramPolling(bot);
    return;
  }

  await configureTelegramWebhook(bot, config);
}

export async function prepareTelegramBot(bot: Bot, config: AppConfig): Promise<void> {
  await registerTelegramMenu(bot.api, config);
}

export async function startTelegramPolling(bot: Bot): Promise<void> {
  await bot.start({
    allowed_updates: ["message"],
  });
}

export async function configureTelegramWebhook(bot: Bot, config: AppConfig): Promise<void> {
  const webhookUrl = config.TELEGRAM_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("TELEGRAM_WEBHOOK_URL is required when TELEGRAM_UPDATE_MODE=webhook");
  }
  await bot.api.setWebhook(webhookUrl, { secret_token: telegramWebhookSecret(config) });
}

export type TelegramWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createTelegramWebhookHandler(bot: Bot, config: AppConfig): TelegramWebhookHandler {
  const expectedSecret = telegramWebhookSecret(config);
  const callback = webhookCallback(bot, "http") as TelegramWebhookHandler;
  return async (req, res) => {
    if (!hasValidWebhookSecret(req, expectedSecret)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    await callback(req, res);
  };
}

function telegramWebhookSecret(config: AppConfig): string {
  return config.TELEGRAM_WEBHOOK_SECRET || createHash("sha256").update(config.TELEGRAM_BOT_TOKEN).digest("hex");
}

function hasValidWebhookSecret(req: IncomingMessage, expectedSecret: string): boolean {
  const header = req.headers["x-telegram-bot-api-secret-token"];
  const actualSecret = Array.isArray(header) ? header[0] : header;
  if (!actualSecret) return false;
  const actual = Buffer.from(actualSecret);
  const expected = Buffer.from(expectedSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
