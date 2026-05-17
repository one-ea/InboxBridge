import { loadConfig } from "../app/config.js";

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  is_forum?: boolean;
}

interface TelegramChatMember {
  status: string;
  can_manage_topics?: boolean;
  can_delete_messages?: boolean;
  can_restrict_members?: boolean;
}

const config = loadConfig();

async function callTelegram<T>(method: string, payload?: Record<string, unknown>): Promise<TelegramResponse<T>> {
  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  return (await response.json()) as TelegramResponse<T>;
}

function printResult<T>(label: string, response: TelegramResponse<T>): T | undefined {
  if (response.ok) {
    console.log(`OK ${label}`);
    return response.result;
  }

  console.error(`FAIL ${label}: ${response.error_code ?? "?"} ${response.description ?? "unknown error"}`);
  return undefined;
}

const me = printResult<TelegramUser>("bot token", await callTelegram<TelegramUser>("getMe"));
if (me) {
  console.log(`Bot: ${me.first_name}${me.username ? ` (@${me.username})` : ""}, id=${me.id}`);
}

const chat = printResult<TelegramChat>(
  `management chat ${config.TELEGRAM_MANAGEMENT_CHAT_ID}`,
  await callTelegram<TelegramChat>("getChat", { chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID }),
);
if (chat) {
  console.log(`Chat: ${chat.title ?? "(no title)"}, id=${chat.id}, type=${chat.type}, is_forum=${chat.is_forum ?? false}`);
}

if (me && chat) {
  const member = printResult<TelegramChatMember>(
    "bot membership",
    await callTelegram<TelegramChatMember>("getChatMember", {
      chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID,
      user_id: me.id,
    }),
  );
  if (member) {
    console.log(
      [
        `Bot status: ${member.status}`,
        `can_manage_topics=${member.can_manage_topics ?? false}`,
        `can_delete_messages=${member.can_delete_messages ?? false}`,
        `can_restrict_members=${member.can_restrict_members ?? false}`,
      ].join(", "),
    );
  }
}

if (chat && chat.type !== "supergroup") {
  console.error("管理群必须是 supergroup。普通 group 需要先升级，Forum Topics 才能使用。");
}

if (chat && !chat.is_forum) {
  console.error("管理群未启用 Forum Topics。请在 Telegram 群设置中开启 Topics。");
}
