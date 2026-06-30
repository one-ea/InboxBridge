import { webhookCallback, type Bot } from "grammy";

export type WorkerTelegramWebhookHandler = (request: Request) => Promise<Response>;
export type WorkerWebhookCallbackFactory = (bot: Bot, adapter: "cloudflare-mod") => WorkerTelegramWebhookHandler;

export function createWorkerTelegramWebhookHandler(
  bot: Bot,
  expectedSecret: string,
  callbackFactory: WorkerWebhookCallbackFactory = webhookCallback as WorkerWebhookCallbackFactory,
): WorkerTelegramWebhookHandler {
  const callback = callbackFactory(bot, "cloudflare-mod");
  return async (request) => {
    if (request.headers.get("x-telegram-bot-api-secret-token") !== expectedSecret) {
      return new Response("Forbidden", { status: 403 });
    }
    return callback(request);
  };
}
