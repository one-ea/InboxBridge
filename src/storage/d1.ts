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
}

export class D1DatabaseAdapter implements Database {
  constructor(private readonly db: D1DatabaseBinding) {}

  prepare(sql: string): PreparedStatement {
    return new D1StatementAdapter(this.db.prepare(sql));
  }

  async exec(sql: string): Promise<void> {
    await this.db.prepare(sql).run();
  }
}

class D1StatementAdapter implements PreparedStatement {
  constructor(private readonly statement: D1PreparedStatement) {}

  async run(...params: SqlValue[]): Promise<StatementResult> {
    const result = await this.statement.bind(...params).run();
    return {
      changes: result.meta?.changes ?? 0,
      lastInsertRowid: result.meta?.last_row_id,
    };
  }

  async get(...params: SqlValue[]): Promise<unknown> {
    return this.statement.bind(...params).first();
  }

  async all(...params: SqlValue[]): Promise<unknown[]> {
    const result = await this.statement.bind(...params).all();
    return result.results ?? [];
  }
}
