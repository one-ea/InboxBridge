import { loadDatabaseConfig } from "../runtime/config.js";
import { createDb } from "../storage/client.js";
import { migrate } from "../storage/migrations/0001_initial.js";

const config = loadDatabaseConfig();
const handle = createDb(config.DATABASE_URL);

await migrate(handle.client);
handle.client.close();
console.log("Database migrations applied.");
