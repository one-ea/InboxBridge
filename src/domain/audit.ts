import type { DatabaseSync } from "node:sqlite";

export interface AuditLogEntry {
  id: number;
  adminId: string;
  conversationId: number;
  action: string;
  detail: string | null;
  createdAt: string;
}

export interface AuditListOptions {
  conversationId?: number;
  adminId?: string;
  action?: string;
  limit: number;
  offset: number;
}

export interface AuditLogInput {
  adminId: string;
  conversationId: number;
  action: string;
  detail?: string;
}

function auditEntryFromRow(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: Number(row.id),
    adminId: String(row.admin_id),
    conversationId: Number(row.conversation_id),
    action: String(row.action),
    detail: row.detail === null ? null : String(row.detail),
    createdAt: String(row.created_at),
  };
}

export class AuditService {
  constructor(private db: DatabaseSync) {}

  log(input: AuditLogInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO audit_logs (admin_id, conversation_id, action, detail, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.adminId,
          input.conversationId,
          input.action,
          input.detail ?? null,
          new Date().toISOString(),
        );
    } catch {
      // Audit logging must never break the main command flow.
    }
  }

  list(opts: AuditListOptions): { items: AuditLogEntry[]; total: number } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (opts.conversationId !== undefined) {
      conditions.push("conversation_id = ?");
      params.push(opts.conversationId);
    }
    if (opts.adminId) {
      conditions.push("admin_id = ?");
      params.push(opts.adminId);
    }
    if (opts.action) {
      conditions.push("action = ?");
      params.push(opts.action);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT id, admin_id, conversation_id, action, detail, created_at
         FROM audit_logs ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit, opts.offset) as Array<Record<string, unknown>>;
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM audit_logs ${where}`)
      .get(...params) as { cnt: number };
    return { items: rows.map(auditEntryFromRow), total: countRow.cnt };
  }

  listByConversation(conversationId: number, limit: number): AuditLogEntry[] {
    return this.list({ conversationId, limit, offset: 0 }).items;
  }
}
