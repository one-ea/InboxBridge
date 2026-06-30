import type { AppConfig } from "../../runtime/config.js";

export async function telegramWebhookSecret(config: AppConfig): Promise<string> {
  if (config.TELEGRAM_WEBHOOK_SECRET) return config.TELEGRAM_WEBHOOK_SECRET;
  const data = new TextEncoder().encode(config.TELEGRAM_BOT_TOKEN);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
