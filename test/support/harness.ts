import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync } from "node:crypto";
import { createDb, type DbHandle } from "../../src/storage/client.js";
import { migrate } from "../../src/storage/migrations/0001_initial.js";
import type { ClosableDatabase, Database, SqlValue } from "../../src/ports/database.js";
import type { WorkerEnv } from "../../src/runtime/worker.js";

let tempDir: string;

export function testTempDir(): string {
  return tempDir;
}

// Stable holder so every test can keep using `handle.db` / `handle.client`, while each
// test still receives a freshly migrated database.
export const handle: DbHandle = {
  client: undefined as unknown as ClosableDatabase,
  db: undefined as unknown as Database,
};

export async function createTestDatabase(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), "inboxbridge-"));
  Object.assign(handle, createDb(`file:${join(tempDir, "test.sqlite")}`));
  await migrate(handle.client);
}

export async function disposeTestDatabase(): Promise<void> {
  handle.client.close();
  await rm(tempDir, { recursive: true, force: true });
}

export const noopDbHealthCheck = () => true;

export const stubMetrics = () => ({
  messages: { inbound_total: 0, outbound_total: 0, internal_total: 0 },
  deliveries: { pending: 0, sent: 0, failed: 0, permanent_failure: 0 },
  conversations: { open: 0, closed: 0 },
  ai_drafts: { pending: 0, ready: 0, failed: 0 },
  uptime_seconds: 0,
  timestamp: new Date().toISOString(),
});

export const stubOpsOverview = () => ({
  messages: { inboundTotal: 0, outboundTotal: 0, internalTotal: 0 },
  deliveries: { pending: 0, sent: 0, failed: 0, permanentFailure: 0 },
  conversations: { open: 0, closed: 0 },
  aiDrafts: { pending: 0, ready: 0, failed: 0, sent: 0, discarded: 0 },
  uptimeSeconds: 0,
});

export const stubListConversations = () => ({ items: [], total: 0 });
export const stubListFailedDeliveries = () => ({ items: [], total: 0 });
export const stubScheduleRetry = async () => {};
export const stubListAuditLogs = () => ({ items: [], total: 0 });
export const stubSearchMessages = () => ({ items: [], total: 0 });

// Mirrors the web console's `salt:scryptHash` scheme so tests can seed a real password.
export function consolePasswordHash(password: string): string {
  const salt = "00112233445566778899aabbccddeeff";
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

export function createD1TestBinding(): WorkerEnv["DB"] {
  return {
    prepare(sql: string) {
      return {
        bind(..._params: SqlValue[]) {
          return {
            async run() {
              return { meta: { changes: 0 } };
            },
            async first() {
              return undefined;
            },
            async all() {
              if (sql === "SELECT key, value FROM app_settings") return { results: [] };
              return { results: [] };
            },
          };
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
    },
    async exec() {
      return { meta: { changes: 0 } };
    },
    async batch() {
      return [];
    },
  };
}

