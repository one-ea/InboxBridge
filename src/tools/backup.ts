import { dirname, join } from "node:path";
import { loadDatabaseConfig } from "../runtime/config.js";
import { backupDatabase, databasePathFromUrl } from "../storage/client.js";

const config = loadDatabaseConfig();
const destination =
  process.argv[2] ??
  join(dirname(databasePathFromUrl(config.DATABASE_URL)), "backups", defaultFileName(new Date()));

await backupDatabase(config.DATABASE_URL, destination);
console.log(`Backup written to ${destination}`);

function defaultFileName(at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `inboxbridge-${stamp}.sqlite`;
}
