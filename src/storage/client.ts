import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { backup, DatabaseSync, type StatementSync } from "node:sqlite";
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
  // 长期运行的进程会与外部工具（migrate / retention:cleanup / 备份）共用同一个库文件。
  // WAL 让读写可以并发，busy_timeout 让偶发的写锁冲突排队等待而不是立刻抛 SQLITE_BUSY。
  // 内存库上这两条 PRAGMA 是无副作用的空操作。
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA busy_timeout = 5000");
  return { client: db, db };
}

/**
 * 用 SQLite 在线备份 API 生成一致性快照。源库正被其它进程写入时也可以安全执行。
 */
export async function backupDatabase(databaseUrl: string, destination: string): Promise<void> {
  const sourcePath = databasePathFromUrl(databaseUrl);
  if (sourcePath === ":memory:") {
    throw new Error("Cannot back up an in-memory database; point DATABASE_URL at a file.");
  }
  ensureFileParent(destination);
  const source = new DatabaseSync(sourcePath);
  try {
    await backup(source, destination);
  } finally {
    source.close();
  }
}

class NodeSqliteDatabase implements ClosableDatabase {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): PreparedStatement {
    return new NodeSqliteStatement(this.db.prepare(sql));
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(run: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN");
    try {
      const result = await run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

export function databasePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) return databaseUrl;
  return databaseUrl.slice("file:".length);
}

function ensureFileParent(path: string): void {
  if (!path || path === ":memory:") return;
  const parent = dirname(path);
  if (parent === "." || parent === "") return;
  mkdirSync(parent, { recursive: true });
}
