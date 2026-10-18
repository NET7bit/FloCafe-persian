/**
 * Operator-facing recovery flow for a blocked database upgrade.
 *
 * This only ever *offers* a restore: every dialog defaults to keeping the current
 * database, nothing is restored without an explicit second confirmation, and a
 * declined, cancelled or unavailable restore leaves the database untouched. The
 * actual file surgery lives in `performStartupRestore()` (main/db.ts).
 *
 * The renderer is not available at this point in startup — `initDatabase()`
 * fails before the first window is created — so the flow uses native Electron
 * dialogs. `describeStartupFailure()` cannot be used as-is because it renders an
 * error box; these calls must be interactive, so `showMessageBox`/`showOpenDialog`
 * are injected as a port and can be driven by tests.
 */
import { dialog as electronDialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  describeStartupRestoreCandidate,
  discoverStartupRestoreBackups,
  performStartupRestore,
  validateStartupRestoreCandidate,
  type StartupRestoreCandidate,
  type StartupRestoreRejection,
  type StartupRestoreStep,
} from './db';
import { asMigrationBlockedDiagnostic, describeStartupFailure, type MigrationBlockedDiagnostic } from './startup-failure';

/** 'unchanged' covers no-backup, decline and cancel: nothing was modified. */
export type StartupRestoreOutcome = 'not-offered' | 'unchanged' | 'restored' | 'failed';

export type StartupRestoreDialogPort = {
  showMessageBox(options: {
    type?: 'warning' | 'info' | 'error';
    title?: string;
    message: string;
    detail?: string;
    buttons: string[];
    defaultId?: number;
    cancelId?: number;
    noLink?: boolean;
  }): Promise<{ response: number }>;
  showOpenDialog(options: {
    title?: string;
    defaultPath?: string;
    properties?: Array<'openFile'>;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
};

export type StartupRestorePorts = {
  discover(): { usable: StartupRestoreCandidate[]; rejected: StartupRestoreRejection[] };
  validate(candidatePath: string): { ok: true; schemaVersion: number } | { ok: false; reason: string };
  restore(sourcePath: string, onStep?: (step: StartupRestoreStep) => void): { emergencyPath: string; restoredSchemaVersion: number };
};

const MAX_LISTED_BACKUPS = 3;
const KEEP_DATABASE_LABEL = 'Keep my database (recommended)';

function defaultPorts(): StartupRestorePorts {
  return {
    discover: discoverStartupRestoreBackups,
    validate: validateStartupRestoreCandidate,
    restore: performStartupRestore,
  };
}

function clip(text: string, limit = 200): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function availabilityDetail(
  usable: StartupRestoreCandidate[],
  rejected: StartupRestoreRejection[],
): string {
  if (usable.length === 0) {
    const reasons: string[] = [];
    if (rejected.length === 0) {
      reasons.push('No backup files were found in the backups folder.');
    } else {
      reasons.push('No automatic backup passed the required checks:');
      for (const entry of rejected.slice(0, MAX_LISTED_BACKUPS)) {
        reasons.push(`  • ${entry.fileName}: ${clip(entry.reason)}`);
      }
      if (rejected.length > MAX_LISTED_BACKUPS) reasons.push(`  …and ${rejected.length - MAX_LISTED_BACKUPS} more`);
    }
    reasons.push('', 'Flo Cafe will now close without changing your database.');
    return reasons.join('\n');
  }
  const lines = [`${usable.length} automatic backup passed the required checks:`];
  for (const candidate of usable.slice(0, MAX_LISTED_BACKUPS)) {
    lines.push(`  • ${describeStartupRestoreCandidate(candidate).replace(/\n/g, '\n    ')}`);
  }
  if (usable.length > MAX_LISTED_BACKUPS) lines.push(`  …and ${usable.length - MAX_LISTED_BACKUPS} more`);
  lines.push(
    '',
    'Restoring replaces the current database with the backup shown.',
    'Any sales, settings or other changes made after that backup was created will be lost.',
    'Nothing is changed unless you choose to restore.',
  );
  return lines.join('\n');
}

async function confirmRestore(
  dialog: StartupRestoreDialogPort,
  headline: string,
  candidate: StartupRestoreCandidate,
): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: 'Flo Cafe — confirm database restore',
    message: `Restore ${candidate.fileName}?`,
    detail: [
      describeStartupRestoreCandidate(candidate),
      '',
      'This replaces the current database with the backup shown above.',
      'Any changes made after this backup was created will be lost.',
      'The current database is copied to a recovery file before anything changes.',
    ].join('\n'),
    buttons: ['Cancel and keep my database', 'Restore this backup'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function selectBackup(
  dialog: StartupRestoreDialogPort,
  ports: StartupRestorePorts,
  usable: StartupRestoreCandidate[],
): Promise<StartupRestoreCandidate | null> {
  if (usable.length === 1) return usable[0];

  const backupsDir = path.dirname(usable[0].path);
  const picked = await dialog.showOpenDialog({
    title: 'Choose a backup to restore',
    defaultPath: backupsDir,
    properties: ['openFile'],
    filters: [{ name: 'Flo database backup', extensions: ['db'] }],
  });
  if (picked.canceled || !picked.filePaths || picked.filePaths.length === 0) return null;

  const candidatePath = picked.filePaths[0];
  const verdict = ports.validate(candidatePath);
  if (verdict.ok === false) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Flo Cafe — backup unavailable',
      message: 'That file cannot be used as a restore source.',
      detail: [clip(verdict.reason), '', 'Your database has not been changed.'].join('\n'),
      buttons: ['OK'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return null;
  }

  let sizeBytes = 0;
  let createdAt = new Date().toISOString();
  try {
    const stat = fs.statSync(candidatePath);
    sizeBytes = stat.size;
    createdAt = stat.mtime.toISOString();
  } catch { /* validation already proved the file is readable */ }

  return {
    fileName: path.basename(candidatePath),
    path: candidatePath,
    sizeBytes,
    createdAt,
    kind: 'manual',
    schemaVersion: verdict.schemaVersion,
  };
}

/**
 * Offers the restore for a recognized blocked migration. Any other startup
 * failure returns 'not-offered' without touching the screen, so unrelated
 * failures keep their existing behavior exactly.
 */
export async function runStartupRestoreFlow(options: {
  error: unknown;
  dialog?: StartupRestoreDialogPort;
  ports?: StartupRestorePorts;
  onStep?: (step: StartupRestoreStep) => void;
}): Promise<StartupRestoreOutcome> {
  const blocked: MigrationBlockedDiagnostic | null = asMigrationBlockedDiagnostic(options.error);
  if (!blocked) return 'not-offered';

  const dialog = options.dialog ?? (electronDialog as unknown as StartupRestoreDialogPort);
  const ports = options.ports ?? defaultPorts();

  // Without an interactive surface (headless run, mocked Electron) there is no
  // way to ask the operator, and without the restore engine there is nothing to
  // offer: fall back to the established generic startup-failure handling.
  if (typeof dialog?.showMessageBox !== 'function'
    || typeof ports.discover !== 'function'
    || typeof ports.validate !== 'function'
    || typeof ports.restore !== 'function') {
    return 'not-offered';
  }

  let usable: StartupRestoreCandidate[] = [];
  let rejected: StartupRestoreRejection[] = [];
  try {
    const discovered = ports.discover();
    usable = discovered.usable;
    rejected = discovered.rejected;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rejected = [{ fileName: 'backups folder', reason: clip(reason) }];
    usable = [];
  }

  const blockedBody = describeStartupFailure(blocked).body;
  let selected: StartupRestoreCandidate | null = null;
  try {
    const offer = await dialog.showMessageBox({
      type: 'warning',
      title: 'Flo Cafe — database upgrade blocked',
      message: 'The database upgrade was stopped to protect your data.',
      detail: [blockedBody, '', availabilityDetail(usable, rejected)].join('\n'),
      buttons: usable.length === 0
        ? ['OK']
        : [KEEP_DATABASE_LABEL, 'Restore a backup…'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });

    // Declining, closing the dialog, or having no usable backup must change nothing.
    if (usable.length === 0) return 'unchanged';
    if (offer.response !== 1) return 'unchanged';

    selected = await selectBackup(dialog, ports, usable);
    if (!selected) return 'unchanged';

    if (!(await confirmRestore(dialog, 'Flo Cafe — confirm database restore', selected))) {
      return 'unchanged';
    }
  } catch (error) {
    // The operator could not be asked (dialog rejected or became unavailable):
    // change nothing and fall back to the established failure handling.
    console.warn('[StartupRestore] The restore dialog could not be shown:', error);
    return 'not-offered';
  }
  if (!selected) return 'unchanged';

  try {
    ports.restore(selected.path, options.onStep);
    return 'restored';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Flo Cafe — restore failed',
        message: 'The backup was not restored.',
        detail: [
          clip(reason, 400),
          '',
          'Your database was rolled back to its previous state.',
          'The recovery files were kept so nothing is lost.',
          '',
          'Flo Cafe will now close.',
        ].join('\n'),
        buttons: ['OK'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    } catch (dialogError) {
      // Nothing was shown, so let the caller's generic path explain the failure.
      console.warn('[StartupRestore] The failure dialog could not be shown:', dialogError);
      return 'not-offered';
    }
    return 'failed';
  }
}
