import type { Bot } from "grammy";
import { topicHelpText } from "./commands.js";
import type { TelegramMessageDeps } from "./messages.js";
import { handleManagementMessage, handlePrivateMessage } from "./messages.js";

export function registerTelegramUpdates(bot: Bot, deps: TelegramMessageDeps): void {
  bot.command("start", async (ctx) => {
    if (ctx.chat.type === "private") {
      await ctx.reply("InboxBridge 已就绪。你在这里发送的消息会进入私密管理收件箱。");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      ctx.chat.type === "private"
        ? "直接发送消息即可进入私密管理收件箱。管理员会通过 bot 回复你。"
        : topicHelpText(),
    );
  });

  bot.command("id", async (ctx) => {
    await ctx.reply(
      [
        `chat_id=${ctx.chat.id}`,
        `chat_type=${ctx.chat.type}`,
        `message_thread_id=${ctx.message?.message_thread_id ?? "-"}`,
        `from_id=${ctx.from?.id ?? "-"}`,
      ].join("\n"),
    );
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
