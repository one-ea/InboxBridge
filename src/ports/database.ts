export type SqlValue = string | number | bigint | null | Uint8Array;

export interface StatementResult {
  changes: number | bigint;
  lastInsertRowid?: number | bigint;
}

export interface PreparedStatement {
  run(...params: SqlValue[]): Promise<StatementResult>;
  get(...params: SqlValue[]): Promise<unknown>;
  all(...params: SqlValue[]): Promise<unknown[]>;
}

export interface Database {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): Promise<void>;
  // Runs `run` as a single unit of work. Cloudflare D1 is auto-commit only and rejects
  // explicit BEGIN/COMMIT, so its implementation awaits `run` without opening a
  // transaction: the call sites behave identically and only atomicity differs.
  transaction<T>(run: () => Promise<T>): Promise<T>;
}

export interface ClosableDatabase extends Database {
  close(): void;
}
