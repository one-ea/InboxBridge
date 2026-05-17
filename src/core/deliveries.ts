import { and, eq, lte } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { deliveries } from "../db/schema.js";
import { nowIso } from "./conversations.js";

export class DeliveryService {
  constructor(private readonly db: Database) {}

  async createPending(sourceMessageId: number | undefined, target: string): Promise<number> {
    const timestamp = nowIso();
    const inserted = await this.db
      .insert(deliveries)
      .values({ sourceMessageId, target, status: "pending", createdAt: timestamp, updatedAt: timestamp })
      .returning({ id: deliveries.id });
    return inserted[0].id;
  }

  async markSent(deliveryId: number): Promise<void> {
    await this.db
      .update(deliveries)
      .set({ status: "sent", lastError: undefined, updatedAt: nowIso() })
      .where(eq(deliveries.id, deliveryId));
  }

  async markFailed(deliveryId: number, error: string, attemptCount: number): Promise<void> {
    const retryAt = new Date(Date.now() + Math.min(60_000, 2 ** attemptCount * 1000)).toISOString();
    await this.db
      .update(deliveries)
      .set({
        status: "failed",
        attemptCount,
        lastError: error,
        nextRetryAt: retryAt,
        updatedAt: nowIso(),
      })
      .where(eq(deliveries.id, deliveryId));
  }

  async dueFailed(now = nowIso()) {
    return this.db.query.deliveries.findMany({
      where: and(eq(deliveries.status, "failed"), lte(deliveries.nextRetryAt, now)),
    });
  }
}
