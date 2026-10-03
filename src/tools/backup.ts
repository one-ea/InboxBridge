import { dirname, join } from "node:path";
import { loadDatabaseConfig } from "../runtime/config.js";
import { defaultBackupFileName, pruneBackups } from "../storage/backup.js";
import { backupDatabase, databasePathFromUrl } from "../storage/client.js";

const options = parseArgs(process.argv.slice(2));
const config = loadDatabaseConfig();
const destination =
  options.destination ??
  join(dirname(databasePathFromUrl(config.DATABASE_URL)), "backups", defaultBackupFileName(new Date()));

await backupDatabase(config.DATABASE_URL, destination);
console.log(`Backup written to ${destination}`);

if (options.keep !== undefined) {
  const { removed, failed } = pruneBackups(dirname(destination), options.keep, destination);
  console.log(
    removed.length > 0
      ? `Retention: removed ${removed.length} old snapshot(s): ${removed.join(", ")}`
      : `Retention: nothing to remove, keeping newest ${options.keep}.`,
  );
  for (const entry of failed) {
    console.warn(`Retention: failed to remove ${entry.name}: ${entry.reason}`);
  }
}

interface BackupOptions {
  destination?: string;
  keep?: number;
}

function parseArgs(argv: string[]): BackupOptions {
  const options: BackupOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--keep" || argument.startsWith("--keep=")) {
      const raw = argument === "--keep" ? argv[index + 1] : argument.slice("--keep=".length);
      if (raw === undefined) throw new Error("--keep requires a value.");
      options.keep = parseKeep(raw);
      if (argument === "--keep") index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    } else {
      options.destination = argument;
    }
  }
  return options;
}

function parseKeep(raw: string): number {
  const keep = Number(raw);
  // 在这里先判定，确保非法参数在写出任何文件之前就失败。
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`--keep must be a positive integer, received: ${raw}`);
  }
  return keep;
}
