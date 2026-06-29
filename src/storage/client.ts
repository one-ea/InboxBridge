import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

export interface DbHandle {
  client: DatabaseSync;
  db: DatabaseSync;
}

export function createDb(databaseUrl: string): DbHandle {
  const path = databasePathFromUrl(databaseUrl);
  ensureFileParent(path);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  return { client: db, db };
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
