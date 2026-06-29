import { loadConfigFromSources, loadDatabaseConfig } from "../runtime/config.js";
import { createDb } from "../storage/client.js";
import { migrate } from "../storage/migrations/0001_initial.js";
import { RetentionService } from "../domain/retention.js";
import { AppSettingsService } from "../domain/app-settings.js";

const config = loadDatabaseConfig();
const handle = createDb(config.DATABASE_URL);
await migrate(handle.client);
const settings = new AppSettingsService(handle.db);
const appConfig = loadConfigFromSources(settings.all());

const cleaned = await new RetentionService(handle.db, appConfig.MESSAGE_RETENTION_DAYS).cleanupExpired();
handle.client.close();
console.log(`Cleaned ${cleaned} expired message records.`);
