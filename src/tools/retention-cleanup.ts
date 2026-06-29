import { loadDatabaseConfig } from "../runtime/config.js";
import { createDb } from "../storage/client.js";
import { migrate } from "../storage/migrations/0001_initial.js";
import { RetentionService } from "../domain/retention.js";

const config = loadDatabaseConfig();
const handle = createDb(config.DATABASE_URL);
await migrate(handle.client);

const cleaned = await new RetentionService(handle.db).cleanupExpired();
handle.client.close();
console.log(`Cleaned ${cleaned} expired message records.`);
