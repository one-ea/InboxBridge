import { loadDatabaseConfig } from "../app/config.js";
import { createDb } from "../db/client.js";
import { migrate } from "../db/migrations/0001_initial.js";
import { RetentionService } from "../core/retention.js";

const config = loadDatabaseConfig();
const handle = createDb(config.DATABASE_URL);
await migrate(handle.client);

const cleaned = await new RetentionService(handle.db).cleanupExpired();
handle.client.close();
console.log(`Cleaned ${cleaned} expired message records.`);
