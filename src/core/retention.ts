import type { Database } from "../db/client.js";
import { nowIso } from "./conversations.js";

export class RetentionService {
  constructor(private readonly db: Database) {}

  async cleanupExpired(now = nowIso()): Promise<number> {
    const result = this.db
      .prepare(
        `UPDATE messages
         SET text = NULL, raw_payload = NULL
         WHERE expires_at IS NOT NULL
           AND expires_at <= ?
           AND (raw_payload IS NOT NULL OR text IS NOT NULL)`,
      )
      .run(now);
    return Number(result.changes);
  }
}
