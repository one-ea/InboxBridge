import type { Database } from "../storage/client.js";
import { nowIso } from "./conversations.js";
import type { Logger } from "pino";

const STALE_PENDING_THRESHOLD_MS = 5 * 60 * 1000;

export class RetentionService {
  constructor(
    private readonly db: Database,
    private readonly retentionDays: number,
    private readonly logger?: Logger,
  ) {}

  async cleanupExpired(now = nowIso()): Promise<number> {
    let cleaned = 0;

    const staleCutoff = new Date(Date.now() - STALE_PENDING_THRESHOLD_MS).toISOString();
    const staleResult = this.db
      .prepare(
        `UPDATE ai_drafts
         SET status = 'failed', error = 'Draft generation timed out (process may have restarted)', updated_at = ?
         WHERE status = 'pending' AND created_at < ?`,
      )
      .run(now, staleCutoff);
    if (staleResult.changes > 0) {
      cleaned += Number(staleResult.changes);
      this.logger?.warn({ count: Number(staleResult.changes) }, "Stale pending AI drafts recovered as failed.");
    }

    if (this.retentionDays > 0) {
      const retentionCutoff = new Date(Date.now() - this.retentionDays * 86400 * 1000).toISOString();

      const deleted = this.db
        .prepare(
          `DELETE FROM ai_drafts
           WHERE status IN ('sent', 'discarded', 'failed') AND created_at < ?`,
        )
        .run(retentionCutoff);
      cleaned += Number(deleted.changes);

      const softCleaned = this.db
        .prepare(
          `UPDATE ai_drafts
           SET draft_text = NULL, error = NULL, updated_at = ?
           WHERE created_at < ? AND (draft_text IS NOT NULL OR error IS NOT NULL)`,
        )
        .run(now, retentionCutoff);
      cleaned += Number(softCleaned.changes);
    }

    const result = this.db
      .prepare(
        `UPDATE messages
         SET text = NULL, raw_payload = NULL
         WHERE expires_at IS NOT NULL
           AND expires_at <= ?
           AND (raw_payload IS NOT NULL OR text IS NOT NULL)`,
      )
      .run(now);
    cleaned += Number(result.changes);

    return cleaned;
  }
}
