import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isBackupFileName, pruneBackups, selectExpiredBackups } from "../src/storage/backup.js";
import { backupDatabase, createDb } from "../src/storage/client.js";
import { D1DatabaseAdapter } from "../src/storage/d1.js";
import { runMigration } from "../src/storage/migrations/runner.js";
import type { Database, PreparedStatement, SqlValue, StatementResult } from "../src/ports/database.js";
import { createTestDatabase, disposeTestDatabase, handle, testTempDir } from "./support/harness.js";

beforeEach(createTestDatabase);
afterEach(disposeTestDatabase);

describe("Node database transactions", () => {
  it("commits on success and rolls back on failure", async () => {
    const insert = (name: string) =>
      handle.db.prepare("INSERT INTO tags (name, created_at) VALUES (?, ?)").run(name, "2026-01-01T00:00:00.000Z");
    const countTags = async (): Promise<number> => {
      const row = (await handle.db.prepare("SELECT COUNT(*) AS cnt FROM tags").get()) as { cnt: number };
      return row.cnt;
    };

    await handle.db.transaction(async () => {
      await insert("kept");
    });
    assert.equal(await countTags(), 1);

    await assert.rejects(
      handle.db.transaction(async () => {
        await insert("discarded");
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(await countTags(), 1);
  });
});

describe("Node database durability settings", () => {
  it("enables WAL and a busy timeout so external tools can share the database file", async () => {
    const journal = (await handle.db.prepare("PRAGMA journal_mode").get()) as { journal_mode: string };
    assert.equal(journal.journal_mode, "wal");

    const busy = (await handle.db.prepare("PRAGMA busy_timeout").get()) as { timeout: number };
    assert.equal(busy.timeout, 5000);
  });
});

describe("database backup", () => {
  it("writes a snapshot that opens as an independent database", async () => {
    await handle.db
      .prepare("INSERT INTO tags (name, created_at) VALUES (?, ?)")
      .run("snapshot", "2026-01-01T00:00:00.000Z");

    const destination = join(testTempDir(), "backup.sqlite");
    await backupDatabase(`file:${join(testTempDir(), "test.sqlite")}`, destination);

    const restored = createDb(`file:${destination}`);
    try {
      const row = (await restored.db.prepare("SELECT COUNT(*) AS cnt FROM tags").get()) as { cnt: number };
      assert.equal(row.cnt, 1);
    } finally {
      restored.client.close();
    }
  });

  it("refuses to back up an in-memory database", async () => {
    await assert.rejects(
      backupDatabase(":memory:", join(testTempDir(), "unreachable.sqlite")),
      /in-memory/,
    );
  });
});

describe("backup retention", () => {
  it("recognises only snapshots written by the tool", () => {
    assert.equal(isBackupFileName("inboxbridge-2026-10-03_21-44-20.sqlite"), true);
    assert.equal(isBackupFileName("inboxbridge.sqlite"), false);
    assert.equal(isBackupFileName("explicit.sqlite"), false);
    assert.equal(isBackupFileName("inboxbridge-2026-10-03_21-44-20.sqlite-wal"), false);
  });

  it("keeps the newest snapshots and returns the older ones", () => {
    const expired = selectExpiredBackups(
      [
        "inboxbridge-2026-01-02_00-00-00.sqlite",
        "inboxbridge-2026-01-04_00-00-00.sqlite",
        "keep-me.txt",
        "inboxbridge-2026-01-01_00-00-00.sqlite",
        "inboxbridge-2026-01-03_00-00-00.sqlite",
      ],
      2,
    );
    assert.deepEqual(expired, [
      "inboxbridge-2026-01-02_00-00-00.sqlite",
      "inboxbridge-2026-01-01_00-00-00.sqlite",
    ]);
  });

  it("rejects a non-positive retention count", () => {
    assert.throws(
      () => selectExpiredBackups(["inboxbridge-2026-01-01_00-00-00.sqlite"], 0),
      /positive integer/,
    );
  });

  it("prunes old snapshots from disk without touching unrelated files", () => {
    const directory = join(testTempDir(), "backups");
    mkdirSync(directory, { recursive: true });
    for (const name of [
      "inboxbridge-2026-01-01_00-00-00.sqlite",
      "inboxbridge-2026-01-02_00-00-00.sqlite",
      "inboxbridge-2026-01-03_00-00-00.sqlite",
      "inboxbridge-2026-01-04_00-00-00.sqlite",
      "keep-me.txt",
    ]) {
      writeFileSync(join(directory, name), "snapshot");
    }

    const result = pruneBackups(directory, 2, join(directory, "inboxbridge-2026-01-04_00-00-00.sqlite"));

    assert.deepEqual(result.removed, [
      "inboxbridge-2026-01-02_00-00-00.sqlite",
      "inboxbridge-2026-01-01_00-00-00.sqlite",
    ]);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(readdirSync(directory).sort(), [
      "inboxbridge-2026-01-03_00-00-00.sqlite",
      "inboxbridge-2026-01-04_00-00-00.sqlite",
      "keep-me.txt",
    ]);
  });

  it("never deletes the snapshot just written, even when the clock says it is the oldest", () => {
    const directory = join(testTempDir(), "protected-backups");
    mkdirSync(directory, { recursive: true });
    for (const name of [
      "inboxbridge-2026-01-01_00-00-00.sqlite",
      "inboxbridge-2026-01-02_00-00-00.sqlite",
      "inboxbridge-2026-01-03_00-00-00.sqlite",
    ]) {
      writeFileSync(join(directory, name), "snapshot");
    }

    const justWritten = join(directory, "inboxbridge-2026-01-01_00-00-00.sqlite");
    const result = pruneBackups(directory, 1, justWritten);

    assert.deepEqual(result.removed, ["inboxbridge-2026-01-02_00-00-00.sqlite"]);
    assert.equal(readdirSync(directory).includes("inboxbridge-2026-01-01_00-00-00.sqlite"), true);
  });
});

describe("storage migrations", () => {
  it("runs migration statements and adds only missing columns through the database port", async () => {
    const execs: string[] = [];
    const columns = new Map<string, Set<string>>([
      ["conversations", new Set(["id", "retention_days"])],
    ]);
    const db: Database = {
      prepare(sql: string): PreparedStatement {
        return {
          async run(..._params: SqlValue[]): Promise<StatementResult> {
            return { changes: 0 };
          },
          async get(..._params: SqlValue[]): Promise<unknown> {
            return undefined;
          },
          async all(..._params: SqlValue[]): Promise<unknown[]> {
            const match = sql.match(/^PRAGMA table_info\(([^)]+)\)$/);
            const table = match?.[1] ?? "";
            return [...(columns.get(table) ?? new Set<string>())].map((name) => ({ name }));
          },
        };
      },
      async exec(sql: string): Promise<void> {
        execs.push(sql);
        const match = sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+) /);
        if (match) {
          const [, table, column] = match;
          if (!columns.has(table)) columns.set(table, new Set());
          columns.get(table)?.add(column);
        }
      },
      transaction: <T>(run: () => Promise<T>) => run(),
    };

    await runMigration(db, {
      statements: ["CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY)"],
      columns: [
        { table: "conversations", column: "retention_days", definition: "INTEGER" },
        { table: "conversations", column: "expires_at", definition: "TEXT" },
      ],
      afterColumns: ["CREATE INDEX IF NOT EXISTS conversations_expires_idx ON conversations(expires_at)"],
    });

    assert.deepEqual(execs, [
      "CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY)",
      "ALTER TABLE conversations ADD COLUMN expires_at TEXT",
      "CREATE INDEX IF NOT EXISTS conversations_expires_idx ON conversations(expires_at)",
    ]);
  });
});

describe("D1 database adapter", () => {
  it("maps D1 prepared statements to the database port", async () => {
    const calls: Array<{ sql: string; params: SqlValue[]; method: string }> = [];
    const d1 = {
      prepare(sql: string) {
        return {
          bind(...params: SqlValue[]) {
            return {
              async run() {
                calls.push({ sql, params, method: "run" });
                return { meta: { changes: 2, last_row_id: 42 } };
              },
              async first() {
                calls.push({ sql, params, method: "first" });
                return { id: 42 };
              },
              async all() {
                calls.push({ sql, params, method: "all" });
                return { results: [{ id: 42 }] };
              },
            };
          },
          async run() {
            calls.push({ sql, params: [], method: "run" });
            return { meta: { changes: 1, last_row_id: 7 } };
          },
        };
      },
      async exec(sql: string) {
        calls.push({ sql, params: [], method: "exec" });
        return { count: 1 };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        for (const statement of statements) await statement.run();
        return [];
      },
    };
    const db = new D1DatabaseAdapter(d1);

    // Raw SQL (including trigger bodies) goes through D1Database::exec, not prepare().
    await db.exec("CREATE TRIGGER example_trigger AFTER INSERT ON example BEGIN SELECT 1; END");
    const statement = db.prepare("SELECT * FROM example WHERE id = ?");
    const result = await statement.run(42);
    const first = await statement.get(42);
    const rows = await statement.all(42);
    const value = await db.transaction(async () => "done");

    assert.deepEqual(result, { changes: 2, lastInsertRowid: 42 });
    assert.deepEqual(first, { id: 42 });
    assert.deepEqual(rows, [{ id: 42 }]);
    assert.equal(value, "done");
    assert.deepEqual(calls, [
      { sql: "CREATE TRIGGER example_trigger AFTER INSERT ON example BEGIN SELECT 1; END", params: [], method: "exec" },
      { sql: "SELECT * FROM example WHERE id = ?", params: [42], method: "run" },
      { sql: "SELECT * FROM example WHERE id = ?", params: [42], method: "first" },
      { sql: "SELECT * FROM example WHERE id = ?", params: [42], method: "all" },
    ]);
  });

  it("submits a D1 transaction as a single atomic batch", async () => {
    const batches: string[][] = [];
    const executed: string[] = [];
    const d1 = {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async run() {
                executed.push(sql);
                return { meta: { changes: 1 } };
              },
              async first() {
                return undefined;
              },
              async all() {
                return { results: [] };
              },
            };
          },
          async run() {
            executed.push(sql);
            return { meta: { changes: 1 } };
          },
        };
      },
      async exec() {
        return { count: 0 };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        batches.push(statements.map(() => "buffered"));
        for (const statement of statements) await statement.run();
        return [];
      },
    };
    const db = new D1DatabaseAdapter(d1);
    // Prepared before the transaction on purpose: it must still join the batch.
    const statement = db.prepare("UPDATE example SET value = ? WHERE id = ?");

    await db.transaction(async () => {
      await statement.run("a", 1);
      await statement.run("b", 2);
      // A nested transaction joins the outer batch instead of opening its own.
      await db.transaction(async () => {
        await statement.run("c", 3);
      });
    });

    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 3);
    assert.equal(executed.length, 3);
  });

  it("discards a failed D1 transaction without executing anything", async () => {
    const batches: number[] = [];
    const d1 = {
      prepare() {
        return {
          bind: () => ({
            run: async () => ({ meta: { changes: 1 } }),
            first: async () => undefined,
            all: async () => ({ results: [] }),
          }),
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      async exec() {
        return { count: 0 };
      },
      async batch(statements: Array<{ run(): Promise<unknown> }>) {
        batches.push(statements.length);
        return [];
      },
    };
    const db = new D1DatabaseAdapter(d1);
    const statement = db.prepare("UPDATE example SET value = ? WHERE id = ?");

    await assert.rejects(
      db.transaction(async () => {
        await statement.run("a", 1);
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(batches, []);

    // Reads cannot be served from a batch that has not run yet.
    await assert.rejects(
      db.transaction(async () => {
        await statement.get(1);
      }),
      /Reads are not supported inside a D1 transaction/,
    );
  });
});
