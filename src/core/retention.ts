import { and, isNotNull, lte, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { messages } from "../db/schema.js";
import { nowIso } from "./conversations.js";

export class RetentionService {
  constructor(private readonly db: Database) {}

  async cleanupExpired(now = nowIso()): Promise<number> {
    const result = await this.db
      .update(messages)
      .set({ text: null, rawPayload: null })
      .where(and(isNotNull(messages.expiresAt), lte(messages.expiresAt, now), sql`${messages.rawPayload} IS NOT NULL OR ${messages.text} IS NOT NULL`))
      .returning({ id: messages.id });
    return result.length;
  }
}
