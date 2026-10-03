import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { D1DatabaseAdapter } from "../src/storage/d1.js";
import { runMigration } from "../src/storage/migrations/runner.js";
import type { Database, PreparedStatement, SqlValue, StatementResult } from "../src/ports/database.js";
import { createTestDatabase, disposeTestDatabase, handle } from "./support/harness.js";

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
});
