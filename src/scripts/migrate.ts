import { loadDatabaseConfig } from "../app/config.js";
import { createDb } from "../db/client.js";
import { migrate } from "../db/migrations/0001_initial.js";

const config = loadDatabaseConfig();
const handle = createDb(config.DATABASE_URL);

await migrate(handle.client);
handle.client.close();
console.log("Database migrations applied.");
