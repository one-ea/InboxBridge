import type { Api } from "grammy";
import type { BotCommand } from "grammy/types";
import type { AppConfig } from "../../runtime/config.js";

export const privateBotCommands: BotCommand[] = [
  { command: "start", description: "开始使用 InboxBridge" },
  { command: "help", description: "查看使用帮助" },
  { command: "info", description: "汇总联系人、会话、Topic 和负责人信息" },
  { command: "profile", description: "查看联系人资料" },
  { command: "status", description: "查看会话状态" },
  { command: "expire", description: "设置会话销毁策略，例如 /expire 7 或 /expire never" },
  { command: "expires", description: "查看当前会话销毁策略" },
  { command: "whoami", description: "查看你的 Telegram 用户 ID" },
  { command: "history", description: "查看最近消息摘要，例如 /history 20" },
  { command: "search", description: "搜索历史消息，例如 /search 关键词" },
  { command: "note", description: "保存内部备注，不会外发" },
  { command: "notes", description: "查看最近内部备注，例如 /notes 10" },
  { command: "tag", description: "添加标签" },
  { command: "untag", description: "移除标签" },
  { command: "tags", description: "列出当前会话标签" },
  { command: "priority", description: "设置优先级 low/normal/high/urgent" },
  { command: "assign", description: "分配负责人" },
  { command: "mine", description: "查看分配给自己的会话" },
  { command: "close", description: "关闭会话" },
  { command: "open", description: "重新打开会话" },
  { command: "mute", description: "静音提醒，例如 /mute 2h" },
  { command: "ban", description: "封禁联系人" },
  { command: "unban", description: "解除封禁" },
  { command: "delete", description: "删除当前 Topic 并清理数据库，需 /delete confirm" },
  { command: "reset", description: "清空会话消息和草稿，需 /reset confirm" },
  { command: "audit", description: "查看本会话审计记录，例如 /audit 20" },
  { command: "draft", description: "AI 回复草稿：/draft view|send|discard 或 /draft 重新生成" },
  { command: "ai_on", description: "开启当前会话的 AI 草稿" },
  { command: "ai_off", description: "关闭当前会话的 AI 草稿" },
  { command: "export", description: "导出当前会话最近 200 条消息" },
  { command: "id", description: "查看当前聊天和用户 ID" },
];

export const adminBotCommands: BotCommand[] = [
  { command: "help", description: "查看可用命令列表" },
  { command: "info", description: "汇总联系人、会话、Topic 和负责人信息" },
  { command: "profile", description: "查看联系人资料" },
  { command: "status", description: "查看会话状态" },
  { command: "expire", description: "设置会话销毁策略，例如 /expire 7 或 /expire never" },
  { command: "expires", description: "查看当前会话销毁策略" },
  { command: "whoami", description: "查看你的 Telegram 管理员 ID" },
  { command: "history", description: "查看最近消息摘要，例如 /history 20" },
  { command: "search", description: "搜索历史消息，例如 /search 关键词" },
  { command: "note", description: "保存内部备注，不会外发" },
  { command: "notes", description: "查看最近内部备注，例如 /notes 10" },
  { command: "tag", description: "添加标签" },
  { command: "untag", description: "移除标签" },
  { command: "tags", description: "列出当前会话标签" },
  { command: "priority", description: "设置优先级 low/normal/high/urgent" },
  { command: "assign", description: "分配负责人" },
  { command: "mine", description: "查看分配给自己的会话" },
  { command: "close", description: "关闭会话" },
  { command: "open", description: "重新打开会话" },
  { command: "mute", description: "静音提醒，例如 /mute 2h" },
  { command: "ban", description: "封禁联系人" },
  { command: "unban", description: "解除封禁" },
  { command: "delete", description: "删除当前 Topic 并清理数据库，需 /delete confirm" },
  { command: "reset", description: "清空会话消息和草稿，需 /reset confirm" },
  { command: "audit", description: "查看本会话审计记录，例如 /audit 20" },
  { command: "draft", description: "AI 回复草稿：/draft view|send|discard 或 /draft 重新生成" },
  { command: "ai_on", description: "开启当前会话的 AI 草稿" },
  { command: "ai_off", description: "关闭当前会话的 AI 草稿" },
  { command: "export", description: "导出当前会话最近 200 条消息" },
  { command: "id", description: "查看当前聊天、Topic 和用户 ID" },
];

export async function registerTelegramMenu(api: Api, config: AppConfig): Promise<void> {
  await api.setMyCommands(privateBotCommands, {
    scope: { type: "all_private_chats" },
  });

  await api.setMyCommands(adminBotCommands, {
    scope: {
      type: "chat",
      chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID,
    },
  });

  await api.setChatMenuButton({
    menu_button: { type: "commands" },
  });
}
