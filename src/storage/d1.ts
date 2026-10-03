import type { Database, PreparedStatement, SqlValue, StatementResult } from "../ports/database.js";

interface D1RunResult {
  meta?: {
    changes?: number;
    last_row_id?: number;
  };
}

interface D1AllResult {
  results?: unknown[];
}

interface D1BoundStatement {
  run(): Promise<D1RunResult>;
  first(): Promise<unknown>;
  all(): Promise<D1AllResult>;
}

interface D1PreparedStatement {
  bind(...params: SqlValue[]): D1BoundStatement;
  run(): Promise<D1RunResult>;
}

export interface D1DatabaseBinding {
  prepare(sql: string): D1PreparedStatement;
  exec(sql: string): Promise<unknown>;
  batch(statements: D1BoundStatement[]): Promise<unknown>;
}

export class D1DatabaseAdapter implements Database {
  private pendingBatch: D1BoundStatement[] | undefined;

  constructor(private readonly db: D1DatabaseBinding) {}

  prepare(sql: string): PreparedStatement {
    return new D1StatementAdapter(this.db.prepare(sql), () => this.pendingBatch);
  }

  // D1Database::exec runs raw SQL that prepare() rejects, including statements whose
  // body contains semicolons such as CREATE TRIGGER.
  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(run: () => Promise<T>): Promise<T> {
    // D1 operates in auto-commit and rejects explicit BEGIN/COMMIT, so atomicity comes
    // from D1Database::batch(): the statements issued by `run` are collected instead of
    // executed, then submitted together. A nested transaction just joins the outer batch
    // because D1 has no savepoints to nest into.
    if (this.pendingBatch) return run();

    const batch: D1BoundStatement[] = [];
    this.pendingBatch = batch;
    try {
      const result = await run();
      this.pendingBatch = undefined;
      if (batch.length > 0) await this.db.batch(batch);
      return result;
    } catch (error) {
      // Nothing ran yet, so the unit rolls back by discarding the collected statements.
      this.pendingBatch = undefined;
      throw error;
    }
  }
}

class D1StatementAdapter implements PreparedStatement {
  constructor(
    private readonly statement: D1PreparedStatement,
    private readonly pendingBatch: () => D1BoundStatement[] | undefined,
  ) {}

  async run(...params: SqlValue[]): Promise<StatementResult> {
    const batch = this.pendingBatch();
    if (batch) {
      batch.push(this.statement.bind(...params));
      // Affected-row counts are only known once the batch completes, so a buffered
      // statement cannot report them.
      return { changes: 0 };
    }

    const result = await this.statement.bind(...params).run();
    return {
      changes: result.meta?.changes ?? 0,
      lastInsertRowid: result.meta?.last_row_id,
    };
  }

  async get(...params: SqlValue[]): Promise<unknown> {
    this.rejectReadInsideTransaction();
    return this.statement.bind(...params).first();
  }

  async all(...params: SqlValue[]): Promise<unknown[]> {
    this.rejectReadInsideTransaction();
    const result = await this.statement.bind(...params).all();
    return result.results ?? [];
  }

  // Reads cannot be served from a batch that has not run yet, and returning stale data
  // would be worse than failing loudly.
  private rejectReadInsideTransaction(): void {
    if (this.pendingBatch()) {
      throw new Error("Reads are not supported inside a D1 transaction; query before calling transaction().");
    }
  }
}
