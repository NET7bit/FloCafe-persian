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
import { randomBytes } from 'crypto';
import log from 'electron-log';
import {
  describeStartupRestoreCandidate,
  discoverStartupRestoreBackups,
  performStartupRestore,
  StartupRestoreError,
  STARTUP_RESTORE_REJECTION_CODES,
  validateStartupRestoreCandidate,
  type StartupRestoreCandidate,
  type StartupRestoreDiscoveryDiagnostics,
  type StartupRestoreRejection,
  type StartupRestoreRejectionCode,
  type StartupRestoreStep,
} from './db';
import { asMigrationBlockedDiagnostic, describeStartupFailure, type MigrationBlockedDiagnostic } from './startup-failure';

/** 'unchanged' covers no-backup, decline and cancel: nothing was modified. */
export type StartupRestoreOutcome = 'not-offered' | 'unchanged' | 'restored' | 'failed';

/**
 * Why the flow settled on its outcome. One value per real branch: the operator
 * declining, an empty folder and an unreadable folder are different stories and
 * must not collapse into a bare 'unchanged'.
 */
export type StartupRestoreReason =
  | 'NOT_OFFERED_NO_DIAGNOSTIC'
  | 'NOT_OFFERED_NO_PORTS'
  | 'NOT_OFFERED_DIALOG_FAILED'
  | 'UNCHANGED_LIST_EMPTY'
  | 'UNCHANGED_LIST_FAILED'
  | 'UNCHANGED_ALL_REJECTED'
  | 'UNCHANGED_DECLINED'
  | 'UNCHANGED_SELECT_CANCELLED'
  | 'UNCHANGED_CONFIRM_DECLINED'
  | 'RESTORED'
  | 'FAILED_RESTORE';

/** Counts are per stage so an empty folder cannot be confused with a failed listing. */
export type StartupRestoreCounts = {
  entriesObserved: number | null;
  candidatesAcceptedForInspection: number;
  candidatesRejected: number;
  entriesSkippedWithError: number;
  candidatesUsable: number;
};

export type StartupRestoreDiagnostic = {
  event: 'StartupRestore';
  schemaVersion: 2;
  correlationId: string;
  phase: 'completed';
  outcome: StartupRestoreOutcome;
  outcomeReason: StartupRestoreReason;
  /** Set only when listing the backups folder failed; null otherwise. */
  discoveryError: 'BACKUP_DIRECTORY_UNAVAILABLE' | null;
  counts: StartupRestoreCounts;
  rejections: Array<{
    ordinal: number;
    phase: 'list' | 'inspect' | 'discovery';
    reasonCode: StartupRestoreRejectionCode;
  }>;
  /** null means the phase never ran; 0 would be indistinguishable from "instant". */
  timingsMs: { discover: number | null; dialog: number | null; restore: number | null };
  emergencyBackup: 'not-attempted' | 'created' | 'failed';
};

type StartupRestoreDiagnosticSink = (event: StartupRestoreDiagnostic) => void;

/**
 * The event is serialized here, not handed to the logger as an object, so the
 * emitted line contains exactly the whitelisted fields and nothing the logger
 * might otherwise pick up from extra arguments.
 */
const defaultDiagnosticSink: StartupRestoreDiagnosticSink = (event) => {
  log.warn(`[StartupRestore] ${JSON.stringify(event)}`);
};

let diagnosticSink: StartupRestoreDiagnosticSink = defaultDiagnosticSink;

/** Test seam: capture events without depending on a log file. Pass null to restore. */
export function __setStartupRestoreDiagnosticSinkForTests(sink: StartupRestoreDiagnosticSink | null): void {
  diagnosticSink = sink ?? defaultDiagnosticSink;
}

let clock: () => number = () => Date.now();

/**
 * Test seam for deterministic phase timings. Pass null to restore the wall clock.
 * Timing is diagnostic only; nothing in the flow branches on it.
 */
export function __setStartupRestoreClockForTests(next: (() => number) | null): void {
  clock = next ?? (() => Date.now());
}

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

const ALLOWED_REJECTION_CODES: ReadonlySet<string> = new Set(STARTUP_RESTORE_REJECTION_CODES);

/**
 * A port is a structural contract, so its `code` is only trustworthy at runtime
 * after an allowlist check. Anything unrecognised collapses to a fixed code:
 * arbitrary text must never reach the event.
 */
function toRejectionCode(value: unknown): StartupRestoreRejectionCode {
  return typeof value === 'string' && ALLOWED_REJECTION_CODES.has(value)
    ? (value as StartupRestoreRejectionCode)
    : 'UNKNOWN_REJECTION';
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
  // Diagnostic state. Nothing below reads it to decide what to do: it is
  // reported once, when the flow settles on an outcome.
  const correlationId = randomBytes(4).toString('hex');
  const counts: StartupRestoreCounts = {
    entriesObserved: null,
    candidatesAcceptedForInspection: 0,
    candidatesRejected: 0,
    entriesSkippedWithError: 0,
    candidatesUsable: 0,
  };
  const timingsMs: { discover: number | null; dialog: number | null; restore: number | null } = {
    discover: null,
    dialog: null,
    restore: null,
  };
  let discoveryError: 'BACKUP_DIRECTORY_UNAVAILABLE' | null = null;
  let listSkips: Array<{ ordinal: number; code: StartupRestoreRejectionCode }> = [];
  let emergencyBackup: 'not-attempted' | 'created' | 'failed' = 'not-attempted';
  let usable: StartupRestoreCandidate[] = [];
  let rejected: StartupRestoreRejection[] = [];
  let dialogStartedAt = 0;
  let restoreStartedAt = 0;

  const finish = (
    outcome: StartupRestoreOutcome,
    outcomeReason: StartupRestoreReason,
  ): StartupRestoreOutcome => {
    try {
      // A discovery failure is its own field: nothing was inspected, so it is
      // not a rejected candidate and does not belong to the inspect phase.
      const discoveryRejections = rejected.filter((entry) => entry.code === 'BACKUP_DIRECTORY_UNAVAILABLE');
      const validationRejections = rejected.filter((entry) => entry.code !== 'BACKUP_DIRECTORY_UNAVAILABLE');
      diagnosticSink({
        event: 'StartupRestore',
        schemaVersion: 2,
        correlationId,
        phase: 'completed',
        outcome,
        outcomeReason,
        discoveryError,
        counts: {
          ...counts,
          candidatesRejected: validationRejections.length,
          candidatesUsable: usable.length,
        },
        rejections: [
          ...listSkips.map((skip) => ({ ordinal: skip.ordinal, phase: 'list' as const, reasonCode: skip.code })),
          ...validationRejections.map((entry, index) => ({
            ordinal: index + 1,
            phase: 'inspect' as const,
            reasonCode: toRejectionCode(entry.code),
          })),
          ...discoveryRejections.map((entry, index) => ({
            ordinal: index + 1,
            phase: 'discovery' as const,
            reasonCode: toRejectionCode(entry.code),
          })),
        ],
        timingsMs: { ...timingsMs },
        emergencyBackup,
      });
    } catch {
      // A diagnostic failure must never change what the operator sees.
    }
    return outcome;
  };

  // Phase timings are stamped before the event is built. Setting them in a
  // `finally` would run after the sink had already serialized the event.
  const finishDialog = (
    outcome: StartupRestoreOutcome,
    outcomeReason: StartupRestoreReason,
  ): StartupRestoreOutcome => {
    timingsMs.dialog = clock() - dialogStartedAt;
    return finish(outcome, outcomeReason);
  };
  const finishRestore = (
    outcome: StartupRestoreOutcome,
    outcomeReason: StartupRestoreReason,
  ): StartupRestoreOutcome => {
    timingsMs.restore = clock() - restoreStartedAt;
    return finish(outcome, outcomeReason);
  };

  const blocked: MigrationBlockedDiagnostic | null = asMigrationBlockedDiagnostic(options.error);
  if (!blocked) return finish('not-offered', 'NOT_OFFERED_NO_DIAGNOSTIC');

  const dialog = options.dialog ?? (electronDialog as unknown as StartupRestoreDialogPort);
  const ports = options.ports ?? defaultPorts();

  // Without an interactive surface (headless run, mocked Electron) there is no
  // way to ask the operator, and without the restore engine there is nothing to
  // offer: fall back to the established generic startup-failure handling.
  if (typeof dialog?.showMessageBox !== 'function'
    || typeof ports.discover !== 'function'
    || typeof ports.validate !== 'function'
    || typeof ports.restore !== 'function') {
    return finish('not-offered', 'NOT_OFFERED_NO_PORTS');
  }

  const discoverStartedAt = clock();
  try {
    const discovered = ports.discover();
    usable = discovered.usable;
    rejected = discovered.rejected;
    const diagnostics = (discovered as { diagnostics?: StartupRestoreDiscoveryDiagnostics }).diagnostics;
    if (diagnostics) {
      counts.entriesObserved = diagnostics.entriesObserved;
      counts.entriesSkippedWithError = diagnostics.entriesSkippedWithError;
      counts.candidatesAcceptedForInspection = Math.max(
        0,
        (diagnostics.entriesObserved ?? 0) - diagnostics.skipped.length,
      );
      discoveryError = diagnostics.discoveryError;
      listSkips = diagnostics.skipped;
    } else {
      // A port that does not report diagnostics: the best available count is
      // what it returned, and "empty" cannot be claimed from it.
      counts.entriesObserved = usable.length + rejected.length;
      counts.candidatesAcceptedForInspection = counts.entriesObserved;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    rejected = [{ fileName: 'backups folder', reason: clip(reason), code: 'BACKUP_DIRECTORY_UNAVAILABLE' }];
    usable = [];
    discoveryError = 'BACKUP_DIRECTORY_UNAVAILABLE';
  } finally {
    timingsMs.discover = clock() - discoverStartedAt;
  }

  const blockedBody = describeStartupFailure(blocked).body;
  let selected: StartupRestoreCandidate | null = null;
  dialogStartedAt = clock();
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
    if (usable.length === 0) {
      // "The folder really is empty" and "listing or inspection failed" used to
      // look identical here; the event now tells them apart.
      if (discoveryError) return finishDialog('unchanged', 'UNCHANGED_LIST_FAILED');
      if (counts.entriesObserved === 0) return finishDialog('unchanged', 'UNCHANGED_LIST_EMPTY');
      // A skip is only a failure when an operational call actually threw; an
      // entry that is merely not a regular file is a rejection, not an error.
      if (counts.entriesSkippedWithError > 0) return finishDialog('unchanged', 'UNCHANGED_LIST_FAILED');
      return finishDialog('unchanged', 'UNCHANGED_ALL_REJECTED');
    }
    if (offer.response !== 1) return finishDialog('unchanged', 'UNCHANGED_DECLINED');

    selected = await selectBackup(dialog, ports, usable);
    if (!selected) return finishDialog('unchanged', 'UNCHANGED_SELECT_CANCELLED');

    if (!(await confirmRestore(dialog, 'Flo Cafe — confirm database restore', selected))) {
      return finishDialog('unchanged', 'UNCHANGED_CONFIRM_DECLINED');
    }
  } catch (error) {
    // The operator could not be asked (dialog rejected or became unavailable):
    // change nothing and fall back to the established failure handling.
    console.warn('[StartupRestore] The restore dialog could not be shown:', error);
    return finishDialog('not-offered', 'NOT_OFFERED_DIALOG_FAILED');
  }
  if (!selected) return finishDialog('unchanged', 'UNCHANGED_SELECT_CANCELLED');
  // The dialog phase also ends on the paths that continue to the restore; the
  // early returns above stamped it themselves.
  timingsMs.dialog = clock() - dialogStartedAt;

  restoreStartedAt = clock();
  try {
    const result = ports.restore(selected.path, options.onStep);
    // Derived from what the restore actually returned, not assumed from success.
    emergencyBackup = result?.emergencyPath ? 'created' : 'not-attempted';
    return finishRestore('restored', 'RESTORED');
  } catch (error) {
    // The restore error carries whether the emergency copy was written, failed,
    // or was never reached; anything else cannot claim a state.
    emergencyBackup = error instanceof StartupRestoreError ? error.emergency : 'not-attempted';
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
      return finishRestore('not-offered', 'NOT_OFFERED_DIALOG_FAILED');
    }
    return finishRestore('failed', 'FAILED_RESTORE');
  }
}
