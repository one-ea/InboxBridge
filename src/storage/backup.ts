import { readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

// 只识别本工具生成的快照名（UTC 时间戳，因此按文件名排序等同于按时间排序）。
// 同时接受秒级与毫秒级两种时间戳，避免时间戳精度升级后旧快照无法被回收。
const BACKUP_FILE_PATTERN = /^inboxbridge-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(-\d{3})?\.sqlite$/;

export function defaultBackupFileName(at: Date): string {
  // 精确到毫秒，同一秒内的两次备份不会互相覆盖。
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 23);
  return `inboxbridge-${stamp}.sqlite`;
}

/**
 * 判断文件名是否为本工具生成的快照。保留策略只会删除匹配的文件，
 * 因此备份目录里的其它文件不会被误删。
 */
export function isBackupFileName(name: string): boolean {
  return BACKUP_FILE_PATTERN.test(name);
}

/**
 * 返回应当删除的旧快照：保留最新 keep 份，其余按从新到旧返回。
 */
export function selectExpiredBackups(fileNames: string[], keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`Backup retention keep must be a positive integer, received: ${keep}`);
  }
  const snapshots = fileNames.filter(isBackupFileName).sort().reverse();
  return snapshots.slice(keep);
}

export interface PruneResult {
  removed: string[];
  failed: Array<{ name: string; reason: string }>;
}

/**
 * 删除备份目录中超出保留数量的旧快照。
 *
 * - `protectedPath` 指向刚生成的快照，任何情况下都不会被删除（防止系统时钟回拨导致它被判为最旧）。
 * - 单个文件删除失败只记录在返回值中，不中断备份流程。
 */
export function pruneBackups(backupDirectory: string, keep: number, protectedPath: string): PruneResult {
  const protectedFile = resolve(protectedPath);
  const expired = selectExpiredBackups(readdirSync(backupDirectory), keep).filter(
    (name) => resolve(join(backupDirectory, name)) !== protectedFile,
  );

  const removed: string[] = [];
  const failed: PruneResult["failed"] = [];
  for (const name of expired) {
    try {
      rmSync(join(backupDirectory, name));
      removed.push(name);
    } catch (error) {
      failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { removed, failed };
}
