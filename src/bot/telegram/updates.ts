import type { Bot } from "grammy";
import type { TelegramMessageDeps } from "./messages.js";
import { handleManagementMessage, handlePrivateMessage } from "./messages.js";

export function registerTelegramUpdates(bot: Bot, deps: TelegramMessageDeps): void {
  bot.command("start", async (ctx) => {
    if (ctx.chat.type === "private") {
      await ctx.reply("InboxBridge 已就绪。你在这里发送的消息会进入私密管理收件箱。");
    }
  });

  bot.on("message", async (ctx) => {
    if (ctx.chat.type === "private") {
      await handlePrivateMessage(ctx, deps);
      return;
    }
    await handleManagementMessage(ctx, deps);
  });

  bot.catch((error) => {
    const ctx = error.ctx;
    console.error(`Telegram update ${ctx.update.update_id} failed`, error.error);
  });
}
