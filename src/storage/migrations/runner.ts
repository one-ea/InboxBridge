import type { Database } from "../../ports/database.js";

export interface MigrationColumn {
  table: string;
  column: string;
  definition: string;
}

export interface MigrationDefinition {
  statements: string[];
  columns?: MigrationColumn[];
  afterColumns?: string[];
}

export async function runMigration(client: Database, migration: MigrationDefinition): Promise<void> {
  for (const statement of migration.statements) {
    await client.exec(statement);
  }

  for (const column of migration.columns ?? []) {
    await addColumnIfMissing(client, column.table, column.column, column.definition);
  }

  for (const statement of migration.afterColumns ?? []) {
    await client.exec(statement);
  }
}

async function addColumnIfMissing(client: Database, table: string, column: string, definition: string): Promise<void> {
  const rows = (await client.prepare(`PRAGMA table_info(${table})`).all()) as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    await client.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
