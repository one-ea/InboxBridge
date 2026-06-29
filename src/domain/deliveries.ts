import type { Database } from "../storage/client.js";
import type { Delivery } from "../storage/schema.js";
import { nowIso } from "./conversations.js";

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
    this.db
      .prepare(
        `INSERT INTO deliveries (source_message_id, target, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`,
      )
      .run(sourceMessageId ?? null, target, timestamp, timestamp);
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    return Number(row.id);
  }

  async markSent(deliveryId: number): Promise<void> {
    this.db
      .prepare("UPDATE deliveries SET status = 'sent', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(nowIso(), deliveryId);
  }

  async markFailed(deliveryId: number, error: string, attemptCount: number): Promise<void> {
    const retryAt = new Date(Date.now() + Math.min(60_000, 2 ** attemptCount * 1000)).toISOString();
    this.db
      .prepare(
        `UPDATE deliveries
         SET status = 'failed', attempt_count = ?, last_error = ?, next_retry_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(attemptCount, error, retryAt, nowIso(), deliveryId);
  }

  async dueFailed(now = nowIso()): Promise<Delivery[]> {
    const rows = this.db
      .prepare("SELECT * FROM deliveries WHERE status = 'failed' AND next_retry_at <= ?")
      .all(now) as Array<Record<string, unknown>>;
    return rows.map(deliveryFromRow);
  }
}
