/**
 * Local backup scheduler (operational hardening).
 *
 * One timer, no queue and no persistent job state: every tick prunes expired
 * managed backups, and — only while the operator opted in through the
 * `auto_backup_enabled` setting — takes at most one local backup per
 * `AUTO_BACKUP_INTERVAL_HOURS`. A failed backup leaves the last-successful
 * stamp untouched, so the next tick retries; the failure is logged and the
 * restaurant keeps operating on the live database (which is never mutated).
 */
import { createBackup, deleteBackup, getSettingValue, listBackups, upsertSettings } from '../db';
import {
  AUTO_BACKUP_LAST_AT_KEY,
  AUTO_BACKUP_ENABLED_KEY,
  AUTO_BACKUP_INTERVAL_HOURS,
  isAutoBackupDue,
  isAutoBackupEnabled,
  pruneBackups,
} from './backup-policy';

const TICK_INTERVAL_MINUTES = 30;

function log(message: string, detail?: unknown): void {
  if (detail === undefined) console.log(`[Backup] ${message}`);
  else console.error(`[Backup] ${message}`, detail);
}

/** The policy module labels its own lines, so the sink stays unprefixed. */
function policyLog(message: string, detail?: unknown): void {
  if (detail === undefined) console.log(message);
  else console.error(message, detail);
}

/** Prunes the backups directory. Safe to call at any time; never throws. */
export function runLocalBackupMaintenance(): { deleted: string[]; failed: string[] } {
  return pruneBackups({ listBackups, deleteBackup, log: policyLog });
}

/**
 * Takes one local backup when the operator enabled the schedule and the last
 * successful one is older than the interval. Returns whether it ran.
 */
export async function runAutoBackupIfDue(now: number = Date.now()): Promise<boolean> {
  let enabled = false;
  try {
    enabled = isAutoBackupEnabled(getSettingValue(AUTO_BACKUP_ENABLED_KEY));
  } catch (error) {
    log('Could not read the auto-backup setting', error);
    return false;
  }
  if (!enabled) return false;

  let lastAt: string | null = null;
  try {
    lastAt = getSettingValue(AUTO_BACKUP_LAST_AT_KEY);
  } catch (error) {
    log('Could not read the last auto-backup stamp', error);
  }
  if (!isAutoBackupDue(lastAt, now, AUTO_BACKUP_INTERVAL_HOURS)) return false;

  try {
    const { path: backupPath, schemaVersion } = await createBackup();
    upsertSettings({ [AUTO_BACKUP_LAST_AT_KEY]: new Date(now).toISOString() });
    log(`Automatic local backup created (schema v${schemaVersion}): ${backupPath}`);
    runLocalBackupMaintenance();
    return true;
  } catch (error) {
    // Disk full, locked file, maintenance conflict: report and retry next tick.
    log('Automatic local backup failed; will retry on the next tick', error);
    return false;
  }
}

/**
 * Starts the scheduler for the lifetime of the process. The timer is unref'd so
 * it never keeps the runtime alive on its own.
 */
export function startLocalBackupScheduler(): () => void {
  const tick = () => {
    try {
      runLocalBackupMaintenance();
    } catch (error) {
      log('Retention pass failed', error);
    }
    void runAutoBackupIfDue();
  };
  tick();
  const timer = setInterval(tick, TICK_INTERVAL_MINUTES * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
