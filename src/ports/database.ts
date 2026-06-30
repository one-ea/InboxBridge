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
}

export interface ClosableDatabase extends Database {
  close(): void;
}
