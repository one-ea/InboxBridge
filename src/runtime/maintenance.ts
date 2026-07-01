import type { Bot } from "grammy";
import type { Logger } from "pino";
import { sweepExpiredConversations as defaultSweepExpiredConversations } from "../domain/conversation-expiry.js";
import { RetentionService } from "../domain/retention.js";
import type { Database } from "../ports/database.js";
import type { AppConfig } from "./config.js";

export interface MaintenanceJobInput {
  api: Bot["api"];
  db: Database;
  config: AppConfig;
  logger: Logger;
}

export interface MaintenanceJobsInput extends MaintenanceJobInput {
  sweepExpiredConversations?: (input: MaintenanceJobInput) => Promise<number>;
  cleanupExpiredMessages?: (input: MaintenanceJobInput) => Promise<number>;
}

export interface MaintenanceJobSummary {
  expiredConversations: number;
  expiredMessages: number;
}

export async function runConversationExpiryJob(input: MaintenanceJobInput): Promise<number> {
  return defaultSweepExpiredConversations({
    api: input.api,
    db: input.db,
    messageRetentionDays: input.config.MESSAGE_RETENTION_DAYS,
    defaultConversationRetentionDays: input.config.DEFAULT_CONVERSATION_RETENTION_DAYS,
    logger: input.logger.child({ module: "conversation-expiry" }),
  });
}

export async function runMessageRetentionJob(input: MaintenanceJobInput): Promise<number> {
  return new RetentionService(
    input.db,
    input.config.MESSAGE_RETENTION_DAYS,
    input.logger.child({ module: "retention" }),
  ).cleanupExpired();
}

export async function runMaintenanceJobs(input: MaintenanceJobsInput): Promise<MaintenanceJobSummary> {
  const expiredConversations = await (input.sweepExpiredConversations ?? runConversationExpiryJob)(input);
  const expiredMessages = await (input.cleanupExpiredMessages ?? runMessageRetentionJob)(input);
  return { expiredConversations, expiredMessages };
}
