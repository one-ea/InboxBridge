import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type Database = LibSQLDatabase<typeof schema>;

export interface DbHandle {
  client: Client;
  db: Database;
}

export function createDb(databaseUrl: string): DbHandle {
  ensureFileParent(databaseUrl);
  const client = createClient({ url: databaseUrl });
  return {
    client,
    db: drizzle(client, { schema }),
  };
}

function ensureFileParent(databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:")) return;
  const path = databaseUrl.slice("file:".length);
  if (!path || path === ":memory:") return;
  const parent = dirname(path);
  if (parent === "." || parent === "") return;
  mkdirSync(parent, { recursive: true });
}
