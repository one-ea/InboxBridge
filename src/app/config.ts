import { z } from "zod";

const booleanFromString = z
  .string()
  .optional()
  .transform((value) => value === "true");

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_MANAGEMENT_CHAT_ID: z.coerce.number().int(),
  TELEGRAM_UPDATE_MODE: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  TELEGRAM_WEBHOOK_PORT: z.coerce.number().int().positive().default(3000),
  TELEGRAM_ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number(part)),
    )
    .pipe(z.array(z.number().int())),
  DATABASE_URL: z.string().default("file:./data/inboxbridge.sqlite"),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_MESSAGES: z.coerce.number().int().positive().default(20),
  OPENAI_COMPATIBLE_BASE_URL: z.string().url().optional().or(z.literal("")),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional().or(z.literal("")),
  OPENAI_COMPATIBLE_MODEL: z.string().optional().or(z.literal("")),
  AI_DRAFTS_ENABLED: booleanFromString.default(true),
  AI_DRAFT_CONTEXT_LIMIT: z.coerce.number().int().positive().default(20),
});

const databaseEnvSchema = z.object({
  DATABASE_URL: z.string().default("file:./data/inboxbridge.sqlite"),
});

export type AppConfig = z.infer<typeof envSchema>;
export type DatabaseConfig = z.infer<typeof databaseEnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (parsed.TELEGRAM_UPDATE_MODE === "webhook" && !parsed.TELEGRAM_WEBHOOK_URL) {
    throw new Error("TELEGRAM_WEBHOOK_URL is required when TELEGRAM_UPDATE_MODE=webhook");
  }
  if (parsed.TELEGRAM_ADMIN_USER_IDS.length === 0) {
    throw new Error("TELEGRAM_ADMIN_USER_IDS must contain at least one Telegram user ID");
  }
  return parsed;
}

export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  return databaseEnvSchema.parse(env);
}

export function isAiConfigured(config: AppConfig): boolean {
  return Boolean(
    config.AI_DRAFTS_ENABLED &&
      config.OPENAI_COMPATIBLE_BASE_URL &&
      config.OPENAI_COMPATIBLE_API_KEY &&
      config.OPENAI_COMPATIBLE_MODEL,
  );
}
