import { InputFile, type Context } from "grammy";
import type { AiDraftService } from "../../core/ai-drafts.js";
import { addDaysIso, type ConversationService } from "../../core/conversations.js";
import type { Contact, Conversation, TelegramTopic } from "../../db/schema.js";

export interface CommandDeps {
  conversations: ConversationService;
  aiDrafts: AiDraftService;
}

export interface TopicContext {
  topic: TelegramTopic;
  conversation: Conversation;
  contact: Contact;
}

function splitCommand(text: string): { command: string; args: string } {
  const [rawCommand = "", ...rest] = text.trim().split(/\s+/);
  const command = rawCommand.replace(/^\/+/, "").split("@")[0].toLowerCase();
  return { command, args: rest.join(" ").trim() };
}

function parseDuration(value: string): string | undefined {
  const match = value.trim().match(/^(\d+)(m|h|d)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const date = new Date();
  if (unit === "m") date.setUTCMinutes(date.getUTCMinutes() + amount);
  if (unit === "h") date.setUTCHours(date.getUTCHours() + amount);
  if (unit === "d") date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString();
}

export async function handleTopicCommand(
  ctx: Context,
  deps: CommandDeps,
  topicContext: TopicContext,
  text: string,
): Promise<boolean> {
  const { command, args } = splitCommand(text);
  const adminId = String(ctx.from?.id ?? "unknown");
  const { conversation, contact } = topicContext;

  switch (command) {
    case "profile": {
      await ctx.reply(
        [
          `联系人：${contact.displayName ?? "未知"}`,
          `平台：${contact.platform}`,
          `外部 ID：${contact.externalUserId}`,
          `用户名：${contact.username ? `@${contact.username}` : "-"}`,
          `状态：${contact.status}`,
          `会话：#${conversation.id} (${conversation.status})`,
          `优先级：${conversation.priority}`,
          `分配给：${conversation.assignedAdminId ?? "-"}`,
        ].join("\n"),
      );
      return true;
    }
    case "status": {
      await ctx.reply(`会话 #${conversation.id}：${conversation.status}，优先级=${conversation.priority}`);
      return true;
    }
    case "note": {
      if (!args) {
        await ctx.reply("用法：/note <内容>");
        return true;
      }
      await deps.conversations.addNote(conversation.id, adminId, args);
      await ctx.reply("内部备注已保存。");
      return true;
    }
    case "tag": {
      if (!args) {
        await ctx.reply("用法：/tag <标签>");
        return true;
      }
      await deps.conversations.addTag(conversation.id, args);
      await ctx.reply(`标签已添加：${args}`);
      return true;
    }
    case "untag": {
      if (!args) {
        await ctx.reply("用法：/untag <标签>");
        return true;
      }
      await deps.conversations.removeTag(conversation.id, args);
      await ctx.reply(`标签已移除：${args}`);
      return true;
    }
    case "priority": {
      if (!["low", "normal", "high", "urgent"].includes(args)) {
        await ctx.reply("用法：/priority low|normal|high|urgent");
        return true;
      }
      await deps.conversations.setPriority(conversation.id, args as "low" | "normal" | "high" | "urgent");
      await ctx.reply(`优先级已设置为 ${args}。`);
      return true;
    }
    case "assign": {
      if (!args) {
        await ctx.reply("用法：/assign <telegram_user_id>");
        return true;
      }
      await deps.conversations.assign(conversation.id, args);
      await ctx.reply(`已分配给 ${args}。`);
      return true;
    }
    case "ban": {
      await deps.conversations.blockContact(contact.id, adminId, args || undefined);
      await ctx.reply("联系人已封禁，后续消息会被拒收。");
      return true;
    }
    case "unban": {
      await deps.conversations.unblockContact(contact.id);
      await ctx.reply("联系人已解除封禁。");
      return true;
    }
    case "close": {
      await deps.conversations.setConversationStatus(conversation.id, "closed");
      await ctx.reply("会话已关闭。");
      return true;
    }
    case "reopen": {
      await deps.conversations.setConversationStatus(conversation.id, "open");
      await ctx.reply("会话已重新打开。");
      return true;
    }
    case "mute": {
      const mutedUntil = parseDuration(args);
      if (!mutedUntil) {
        await ctx.reply("用法：/mute <时长>，例如 /mute 2h");
        return true;
      }
      await deps.conversations.mute(conversation.id, mutedUntil);
      await ctx.reply(`已静音至 ${mutedUntil}。`);
      return true;
    }
    case "draft": {
      const result = await deps.aiDrafts.generate(conversation.id);
      if (result.status === "ready") {
        await ctx.reply(`AI 草稿（不会自动发送）：\n\n${result.text}`);
      } else {
        await ctx.reply(`AI 草稿不可用：${result.error ?? result.status}`);
      }
      return true;
    }
    case "export": {
      const recent = await deps.conversations.recentMessages(conversation.id, 200);
      const payload = {
        conversation,
        contact,
        exportedAt: new Date().toISOString(),
        messages: recent.reverse(),
      };
      await ctx.replyWithDocument(new InputFile(Buffer.from(JSON.stringify(payload, null, 2)), `conversation-${conversation.id}.json`));
      return true;
    }
    case "ai_on":
    case "ai_off": {
      await ctx.reply("当前版本尚未实现按会话开关 AI。");
      return true;
    }
    default:
      return false;
  }
}
