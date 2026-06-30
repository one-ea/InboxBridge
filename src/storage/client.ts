import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { ClosableDatabase, Database, PreparedStatement, SqlValue, StatementResult } from "../ports/database.js";

export interface DbHandle {
  client: ClosableDatabase;
  db: Database;
}

export function createDb(databaseUrl: string): DbHandle {
  const path = databasePathFromUrl(databaseUrl);
  ensureFileParent(path);
  const sqlite = new DatabaseSync(path);
  const db = new NodeSqliteDatabase(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  return { client: db, db };
}

class NodeSqliteDatabase implements ClosableDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): PreparedStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

class NodeSqliteStatement implements PreparedStatement {
  constructor(private readonly statement: StatementSync) {}

  async run(...params: SqlValue[]): Promise<StatementResult> {
    return this.statement.run(...params);
  }

  async get(...params: SqlValue[]): Promise<unknown> {
    return this.statement.get(...params);
  }

  async all(...params: SqlValue[]): Promise<unknown[]> {
    return this.statement.all(...params);
  }
}

function databasePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) return databaseUrl;
  return databaseUrl.slice("file:".length);
}

function ensureFileParent(path: string): void {
  if (!path || path === ":memory:") return;
  const parent = dirname(path);
  if (parent === "." || parent === "") return;
  mkdirSync(parent, { recursive: true });
}
