import { loadConfigFromSources, loadDatabaseConfig } from "../runtime/config.js";
import { AppSettingsService } from "../domain/app-settings.js";
import { createDb } from "../storage/client.js";
import { migrate } from "../storage/migrations/0001_initial.js";

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

const databaseConfig = loadDatabaseConfig();
const handle = createDb(databaseConfig.DATABASE_URL);
try {
  await migrate(handle.client);
  const config = loadConfigFromSources(await new AppSettingsService(handle.db).all());
  const sendTest = process.env.TELEGRAM_CHECK_SEND_TEST === "true";
  const topicTest = process.env.TELEGRAM_CHECK_TOPIC_TEST === "true";

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

if (sendTest) {
  printResult(
    "sendMessage to management chat",
    await callTelegram("sendMessage", {
      chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID,
      text: "InboxBridge 发送权限测试：如果看到这条消息，bot 可以向管理群发送普通消息。",
    }),
  );
}

if (topicTest) {
  const created = printResult<{ message_thread_id: number }>(
    "createForumTopic permission",
    await callTelegram<{ message_thread_id: number }>("createForumTopic", {
      chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID,
      name: `InboxBridge 权限测试 ${Date.now()}`,
    }),
  );

  if (created) {
    printResult(
      "sendMessage to test topic",
      await callTelegram("sendMessage", {
        chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID,
        message_thread_id: created.message_thread_id,
        text: "InboxBridge Topic 发送权限测试。",
      }),
    );
    printResult(
      "delete test topic",
      await callTelegram("deleteForumTopic", {
        chat_id: config.TELEGRAM_MANAGEMENT_CHAT_ID,
        message_thread_id: created.message_thread_id,
      }),
    );
  }
}

} finally {
  handle.client.close();
}
