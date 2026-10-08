/**
 * Local backup retention policy (operational hardening).
 *
 * The retention rule is deliberately conservative and filesystem-only: managed
 * `flo-backup-*.db` files are pruned oldest-first down to the newest `keep`
 * copies, and nothing younger than `minAgeHours` is ever removed so a busy day
 * of manual backups cannot prune the copy an operator just made. Nothing
 * outside the managed naming scheme is ever touched, and a prune failure is
 * reported instead of thrown.
 */

export interface ManagedBackupEntry {
  fileName: string;
  createdAt: string;
}

export const BACKUP_RETENTION_KEEP = 14;
export const BACKUP_RETENTION_MIN_AGE_HOURS = 24;
export const BACKUP_RETENTION_MAX_KEEP = 200;
export const AUTO_BACKUP_INTERVAL_HOURS = 24;

/** Settings keys owned by the local backup scheduler (no schema, plain key/value settings). */
export const AUTO_BACKUP_ENABLED_KEY = 'auto_backup_enabled';
export const AUTO_BACKUP_LAST_AT_KEY = 'auto_backup_last_at';

function clampKeep(keep: number | undefined): number {
  if (!Number.isFinite(keep as number)) return BACKUP_RETENTION_KEEP;
  const value = Math.floor(keep as number);
  if (value < 1) return 1;
  if (value > BACKUP_RETENTION_MAX_KEEP) return BACKUP_RETENTION_MAX_KEEP;
  return value;
}

/**
 * Newest-first selection of managed backups that exceed the retention policy.
 * Entries with an unreadable timestamp are kept (never pruned on bad metadata).
 */
export function selectExpiredBackups<T extends ManagedBackupEntry>(
  entries: readonly T[],
  options: { keep?: number; minAgeHours?: number; now?: number } = {},
): T[] {
  const keep = clampKeep(options.keep);
  const minAgeHours = Number.isFinite(options.minAgeHours as number)
    ? Math.max(0, options.minAgeHours as number)
    : BACKUP_RETENTION_MIN_AGE_HOURS;
  const now = Number.isFinite(options.now as number) ? (options.now as number) : Date.now();
  const minAgeMs = minAgeHours * 60 * 60 * 1000;

  const sorted = [...entries].sort((a, b) => {
    const left = Date.parse(a.createdAt);
    const right = Date.parse(b.createdAt);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return a.fileName.localeCompare(b.fileName);
    return right - left;
  });

  const protectedNames = new Set(sorted.slice(0, keep).map((entry) => entry.fileName));
  return sorted.filter((entry) => {
    if (protectedNames.has(entry.fileName)) return false;
    const created = Date.parse(entry.createdAt);
    if (!Number.isFinite(created)) return false;
    return now - created > minAgeMs;
  });
}

/**
 * True when the next automatic local backup is due. An unreadable or missing
 * stamp means "due", so a corrupted setting can never silently disable backups.
 */
export function isAutoBackupDue(
  lastAt: string | null | undefined,
  now: number = Date.now(),
  intervalHours: number = AUTO_BACKUP_INTERVAL_HOURS,
): boolean {
  if (!lastAt) return true;
  const parsed = Date.parse(lastAt);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed >= Math.max(1, intervalHours) * 60 * 60 * 1000;
}

export function isAutoBackupEnabled(raw: string | null | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'true';
}

export interface BackupMaintenanceDeps {
  listBackups: () => readonly ManagedBackupEntry[];
  deleteBackup: (fileName: string) => void;
  log?: (message: string, detail?: unknown) => void;
}

/**
 * Prunes expired managed backups. Returns what was removed and what failed;
 * never throws, so a hostile backups directory cannot break application start.
 */
export function pruneBackups(
  deps: BackupMaintenanceDeps,
  options: { keep?: number; minAgeHours?: number; now?: number } = {},
): { deleted: string[]; failed: string[] } {
  const log = deps.log ?? (() => {});
  const deleted: string[] = [];
  const failed: string[] = [];
  let expired: readonly ManagedBackupEntry[];
  try {
    expired = selectExpiredBackups(deps.listBackups(), options);
  } catch (error) {
    log('[Backup] Retention scan failed', error);
    return { deleted, failed };
  }
  for (const entry of expired) {
    try {
      deps.deleteBackup(entry.fileName);
      deleted.push(entry.fileName);
    } catch (error) {
      failed.push(entry.fileName);
      log(`[Backup] Could not prune ${entry.fileName}`, error);
    }
  }
  if (deleted.length > 0) log(`[Backup] Retention pruned ${deleted.length} backup(s)`);
  return { deleted, failed };
}
