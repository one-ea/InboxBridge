import { InputFile, type Context } from "grammy";
import type { AiDraftService } from "../../domain/ai-drafts.js";
import { type ConversationService } from "../../domain/conversations.js";
import { isAiConfigured, type AppConfig } from "../../runtime/config.js";
import type { Contact, Conversation, Message, TelegramTopic } from "../../storage/schema.js";

export interface CommandDeps {
  config: AppConfig;
  conversations: ConversationService;
  aiDrafts: AiDraftService;
}

export interface TopicContext {
  topic: TelegramTopic;
  conversation: Conversation;
  contact: Contact;
}

export function topicHelpText(): string {
  return [
    "InboxBridge 白名单管理员菜单",
    "",
    "查看与定位：",
    "/info - 汇总联系人、会话、Topic 和负责人信息",
    "/profile - 查看联系人资料",
    "/status - 查看会话状态",
    "/expire <天数|never> - 设置当前会话销毁策略，例如 /expire 7 或 /expire never",
    "/expires - 查看当前会话销毁策略",
    "/whoami - 查看你的 Telegram 管理员 ID",
    "/history [数量] - 查看最近消息摘要，默认 10，最多 30",
    "",
    "备注与标签：",
    "/note <内容> - 保存内部备注，不会外发",
    "/notes [数量] - 查看最近内部备注，默认 5，最多 20",
    "/tag <标签> - 添加标签",
    "/untag <标签> - 移除标签",
    "/tags - 列出当前会话标签",
    "",
    "会话处理：",
    "/priority low|normal|high|urgent - 设置优先级",
    "/assign <telegram_user_id> - 分配负责人",
    "/close - 关闭会话；用户再发消息会自动重开",
    "/reopen 或 /open - 重新打开会话",
    "/mute <时长> - 静音提醒，例如 /mute 2h、/mute 1d",
    "",
    "安全与辅助：",
    "/ban [原因] - 封禁联系人，后续消息会被拒收",
    "/unban - 解除封禁",
    "/delete confirm - 删除当前 Topic 并清理数据库会话信息",
    "/draft - 重新生成 AI 回复草稿，不会自动发送",
    "/export - 导出当前会话最近 200 条消息 JSON",
    "",
    "普通消息会默认转发给外部用户。",
  ].join("\n");
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

function parseLimit(value: string, defaultLimit: number, maxLimit: number): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) return defaultLimit;
  return Math.min(parsed, maxLimit);
}

function parseRetentionDays(value: string): number | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (["never", "none", "off", "0"].includes(normalized)) return null;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function retentionText(conversation: Conversation): string {
  if (conversation.retentionDays === null || conversation.expiresAt === null) {
    return "销毁策略：不自动销毁";
  }
  return `销毁策略：${conversation.retentionDays} 天后销毁，到期时间 ${conversation.expiresAt}`;
}

function profileText(input: { conversation: Conversation; contact: Contact; topic: TelegramTopic }): string {
  return [
    `联系人：${input.contact.displayName ?? "未知"}`,
    `平台：${input.contact.platform}`,
    `外部 ID：${input.contact.externalUserId}`,
    `用户名：${input.contact.username ? `@${input.contact.username}` : "-"}`,
    `联系人状态：${input.contact.status}`,
    `会话：#${input.conversation.id} (${input.conversation.status})`,
    `优先级：${input.conversation.priority}`,
    `分配给：${input.conversation.assignedAdminId ?? "-"}`,
    `静音至：${input.conversation.mutedUntil ?? "-"}`,
    retentionText(input.conversation),
    `Topic：${input.topic.topicName} (#${input.topic.messageThreadId})`,
    `最近消息：${input.conversation.lastMessageAt ?? "-"}`,
  ].join("\n");
}

function messagePreview(message: Message): string {
  const text = message.text?.replace(/\s+/g, " ").trim();
  const preview = text ? (text.length > 80 ? `${text.slice(0, 77)}...` : text) : `[${message.messageType}]`;
  return `${message.createdAt} ${message.direction}/${message.messageType}: ${preview}`;
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
    case "menu":
    case "commands":
    case "help": {
      await ctx.reply(topicHelpText());
      return true;
    }
    case "info": {
      const tags = await deps.conversations.listTags(conversation.id);
      await ctx.reply(
        [
          profileText({ conversation, contact, topic: topicContext.topic }),
          `标签：${tags.length > 0 ? tags.map((tag) => tag.name).join(", ") : "-"}`,
          `AI 草稿：${conversation.aiEnabled ? "开启" : "关闭"}`,
        ].join("\n"),
      );
      return true;
    }
    case "profile": {
      await ctx.reply(profileText({ conversation, contact, topic: topicContext.topic }));
      return true;
    }
    case "status": {
      await ctx.reply(
        [
          `会话 #${conversation.id}`,
          `状态：${conversation.status}`,
          `优先级：${conversation.priority}`,
          `分配给：${conversation.assignedAdminId ?? "-"}`,
          `静音至：${conversation.mutedUntil ?? "-"}`,
          retentionText(conversation),
          `AI 草稿：${conversation.aiEnabled ? "开启" : "关闭"}`,
          `最近消息：${conversation.lastMessageAt ?? "-"}`,
        ].join("\n"),
      );
      return true;
    }
    case "expire":
    case "ttl": {
      const days = parseRetentionDays(args);
      if (days === undefined) {
        await ctx.reply("用法：/expire <天数|never>，例如 /expire 7、/expire 30、/expire never");
        return true;
      }
      const updated = await deps.conversations.setConversationRetention(conversation.id, days);
      await ctx.reply(updated ? retentionText(updated) : "会话不存在，无法设置销毁策略。");
      return true;
    }
    case "expires": {
      await ctx.reply(retentionText(conversation));
      return true;
    }
    case "whoami": {
      await ctx.reply(`你的 Telegram user_id：${adminId}`);
      return true;
    }
    case "history": {
      const limit = parseLimit(args, 10, 30);
      const recent = await deps.conversations.recentMessages(conversation.id, limit);
      if (recent.length === 0) {
        await ctx.reply("暂无消息记录。");
        return true;
      }
      await ctx.reply([`最近 ${recent.length} 条消息：`, ...recent.reverse().map(messagePreview)].join("\n"));
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
    case "notes": {
      const limit = parseLimit(args, 5, 20);
      const notes = await deps.conversations.recentNotes(conversation.id, limit);
      if (notes.length === 0) {
        await ctx.reply("暂无内部备注。");
        return true;
      }
      await ctx.reply(
        [
          `最近 ${notes.length} 条内部备注：`,
          ...notes.reverse().map((note) => `${note.createdAt} admin=${note.adminUserId}: ${note.note}`),
        ].join("\n"),
      );
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
    case "tags": {
      const tags = await deps.conversations.listTags(conversation.id);
      await ctx.reply(tags.length > 0 ? `当前标签：${tags.map((tag) => tag.name).join(", ")}` : "当前会话暂无标签。");
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
    case "delete": {
      if (args !== "confirm") {
        await ctx.reply("危险操作：删除当前会话 Topic 并清理数据库会话信息。确认请发送 /delete confirm");
        return true;
      }
      await ctx.api.deleteForumTopic(Number(topicContext.topic.managementChatId), topicContext.topic.messageThreadId);
      await deps.conversations.deleteConversationData(conversation.id);
      return true;
    }
    case "close": {
      await deps.conversations.setConversationStatus(conversation.id, "closed");
      await ctx.reply("会话已关闭。");
      return true;
    }
    case "open":
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
      } else if (result.error?.includes("disabled for this conversation")) {
        await ctx.reply("该会话已关闭 AI 草稿，使用 /ai_on 开启。");
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
    case "ai_on": {
      await deps.conversations.setAiEnabled(conversation.id, true);
      const globalEnabled = isAiConfigured(deps.config);
      const hint = globalEnabled ? "" : "\n\n提示：全局 AI 未开启，需先在控制台启用 AI_DRAFTS_ENABLED。";
      await ctx.reply(`已对该会话开启 AI 草稿。${hint}`);
      return true;
    }
    case "ai_off": {
      await deps.conversations.setAiEnabled(conversation.id, false);
      await ctx.reply("已对该会话关闭 AI 草稿。该会话不再自动生成回复草稿。");
      return true;
    }
    default:
      return false;
  }
}
