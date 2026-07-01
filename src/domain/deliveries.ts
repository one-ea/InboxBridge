import type { Database } from "../ports/database.js";
import type { Delivery } from "../storage/schema.js";
import { nowIso } from "./conversations.js";

export const MAX_DELIVERY_ATTEMPTS = 8;

function deliveryFromRow(row: Record<string, unknown>): Delivery {
  return {
    id: Number(row.id),
    sourceMessageId: row.source_message_id === null ? null : Number(row.source_message_id),
    target: String(row.target),
    status: row.status as Delivery["status"],
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error === null ? null : String(row.last_error),
    nextRetryAt: row.next_retry_at === null ? null : String(row.next_retry_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class DeliveryService {
  constructor(private readonly db: Database) {}

  async createPending(sourceMessageId: number | undefined, target: string): Promise<number> {
    const timestamp = nowIso();
    await this.db
      .prepare(
        `INSERT INTO deliveries (source_message_id, target, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(sourceMessageId ?? null, target, timestamp, timestamp);
    const row = (await this.db.prepare("SELECT last_insert_rowid() AS id").get()) as { id: number };
    return Number(row.id);
  }

  async markSent(deliveryId: number): Promise<void> {
    await this.db
      .prepare("UPDATE deliveries SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), deliveryId);
  }

  async markFailed(deliveryId: number, error: string, attemptCount: number): Promise<void> {
    const retryAt = new Date(Date.now() + Math.min(60_000, 2 ** attemptCount * 1000)).toISOString();
    await this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'failed', attempt_count = ?, last_error = ?, next_retry_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attemptCount, error, retryAt, nowIso(), deliveryId);
  }

  async dueFailed(now = nowIso()): Promise<Delivery[]> {
    const rows = (await this.db
      .prepare("SELECT * FROM deliveries WHERE status = 'failed' AND next_retry_at <= ?")
      .all(now)) as Array<Record<string, unknown>>;
    return rows.map(deliveryFromRow);
  }

  async markPermanentFailure(deliveryId: number, error: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'permanent_failure', last_error = ?, next_retry_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(error, nowIso(), deliveryId);
  }

  async stats(): Promise<{
    pending: number;
    sent: number;
    failed: number;
    permanentFailure: number;
  }> {
    const rows = (await this.db
      .prepare("SELECT status, COUNT(*) AS cnt FROM deliveries GROUP BY status")
      .all()) as Array<{ status: string; cnt: number }>;
    const result = { pending: 0, sent: 0, failed: 0, permanentFailure: 0 };
    for (const row of rows) {
      if (row.status === "pending") result.pending = row.cnt;
      else if (row.status === "sent") result.sent = row.cnt;
      else if (row.status === "failed") result.failed = row.cnt;
      else if (row.status === "permanent_failure") result.permanentFailure = row.cnt;
    }
    return result;
  }

  async listFailedDeliveries(opts: {
    limit: number;
    offset: number;
  }): Promise<{ items: Delivery[]; total: number }> {
    const rows = (await this.db
      .prepare(
        `SELECT * FROM deliveries
         WHERE status IN ('failed', 'permanent_failure')
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
      )
      .all(opts.limit, opts.offset)) as Array<Record<string, unknown>>;
    const countRow = (await this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM deliveries WHERE status IN ('failed', 'permanent_failure')`)
      .get()) as { cnt: number };
    return { items: rows.map(deliveryFromRow), total: countRow.cnt };
  }

  async scheduleRetry(deliveryId: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE deliveries
         SET next_retry_at = ?, updated_at = ?
         WHERE id = ? AND status = 'failed'`,
      )
      .run(nowIso(), nowIso(), deliveryId);
  }
}
