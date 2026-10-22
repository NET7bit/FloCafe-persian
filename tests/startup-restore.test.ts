/**
 * Startup-restore recovery workflow: the real decision flow and the real file
 * surgery, exercised against real SQLite files in a temp directory.
 *
 * Mocked here: the Electron `app` (paths only) and the `dialog` port (operator
 * input). Real: main/db.ts discovery, validation, performStartupRestore(), the
 * backups directory, the migration chain including the v1001 convergence guard,
 * the recovery journal and the emergency copy.
 *
 * Every scenario runs against its own throwaway database; nothing in the user's
 * real data directory is ever touched.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/startup-restore.test.ts
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flo-startup-restore-')));
const dbPath = path.join(testDir, 'flo.db');
const backupDir = path.join(testDir, 'backups');
process.env.FLO_E2E_DB_PATH = dbPath;

const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const Database = require('better-sqlite3');
const dbModule = require('../main/db');
const { MIGRATIONS } = dbModule;
const { MigrationConvergenceError } = require('../main/migration-diagnostics');
const { runStartupRestoreFlow } = require('../main/startup-restore');

const ALL: { version: number }[] = MIGRATIONS.slice();
const TAIL = ALL[ALL.length - 1].version;
const CATCH_UP = 1001;
const SHARED_MAX = 92;
const BLOCKED_INDEX = 'idx_category_addon_groups_group';
const throughVersion = (cap: number): number[] => ALL.filter((m) => m.version <= cap).map((m) => m.version);

let passed = 0;
let failed = 0;

function ok(condition: unknown, label: string): boolean {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
  return !!condition;
}

function eq(actual: unknown, expected: unknown, label: string): boolean {
  return ok(Object.is(actual, expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ── world helpers ──────────────────────────────────────────────────────────

function setRegistry(versions: number[]): void {
  MIGRATIONS.length = 0;
  for (const version of versions) {
    const migration = ALL.find((m) => m.version === version);
    if (migration) MIGRATIONS.push(migration as any);
  }
}

function restoreRegistry(): void {
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...(ALL as any));
}

function closeDb(): void {
  try { dbModule.closeDatabase(); } catch { /* not open */ }
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resetWorld(): void {
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  fs.rmSync(backupDir, { recursive: true, force: true });
  for (const entry of fs.readdirSync(testDir)) {
    if (entry.startsWith('.startup-restore-') || entry.startsWith('startup-restore-emergency-')) {
      fs.rmSync(path.join(testDir, entry), { force: true });
    }
  }
  const leftovers = fs.readdirSync(testDir).filter((entry: string) =>
    entry.startsWith('.startup-restore-') || entry.startsWith('startup-restore-emergency-'));
  if (leftovers.length > 0) console.error('[resetWorld] leftover restore artifacts:', leftovers);
  restoreRegistry();
}

function pruneBackups(keep: string[]): void {
  if (!fs.existsSync(backupDir)) return;
  const keepSet = new Set(keep.map((candidate) => path.resolve(candidate)));
  for (const name of fs.readdirSync(backupDir)) {
    const full = path.resolve(backupDir, name);
    if (!keepSet.has(full)) fs.rmSync(full, { force: true });
  }
}

function journalPath(): string {
  return path.join(testDir, `.startup-restore-journal-${path.basename(dbPath)}.json`);
}

function emergencyFiles(): string[] {
  return fs.readdirSync(testDir).filter((name: string) => name.startsWith('startup-restore-emergency-'));
}

function stagedFiles(): string[] {
  return fs.readdirSync(testDir).filter((name: string) => name.startsWith('.startup-restore-staged-'));
}

function userVersion(filePath: string): number {
  const handle = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return Number(handle.pragma('user_version', { simple: true }));
  } finally {
    handle.close();
  }
}

function hasIndex(filePath: string, indexName: string): boolean {
  const handle = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    return !!handle.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName);
  } finally {
    handle.close();
  }
}

/**
 * Healthy upstream-v98 database (the shape a pre-upgrade backup has) plus a
 * managed backup of it produced by the repository's own createBackup().
 */
async function buildPreUpgradeBackup(): Promise<string> {
  setRegistry(throughVersion(98));
  dbModule.initDatabase();
  const created = await dbModule.createBackup();
  closeDb();
  restoreRegistry();
  // Name it like the automatic pre-upgrade backup so discovery classifies it as
  // an automatic backup rather than a manual one, and drop the empty-schema
  // auto-backup the fixture migration itself produced so every scenario controls
  // exactly which candidates exist.
  const preUpgradePath = created.path.replace(/\.db$/, '-pre-v1001.db');
  fs.renameSync(created.path, preUpgradePath);
  pruneBackups([preUpgradePath]);
  return preUpgradePath;
}

/** Damages the live database the way a drifted upgrade does, then blocks at v1001. */
function blockLiveDatabase(): any {
  const raw = new Database(dbPath);
  raw.exec(`DROP INDEX IF EXISTS ${BLOCKED_INDEX}`);
  raw.close();
  restoreRegistry();
  let caught: any = null;
  try {
    dbModule.initDatabase();
  } catch (error) {
    caught = error;
  }
  closeDb();
  return caught;
}

async function setupBlockedWorld(): Promise<{ sourcePath: string; blockError: any }> {
  resetWorld();
  const sourcePath = await buildPreUpgradeBackup();
  const blockError = blockLiveDatabase();
  // Blocking the database drops its own pre-migration auto-backup into the same
  // folder; keep only the source this scenario is about.
  pruneBackups([sourcePath]);
  ok(blockError instanceof MigrationConvergenceError, 'the live database is genuinely blocked by v1001');
  return { sourcePath, blockError };
}

// ── scripted dialog ────────────────────────────────────────────────────────

type DialogCall = { kind: 'message' | 'open'; options: any };

function scriptedDialog(messages: number[], opens: Array<{ canceled: boolean; filePaths: string[] }> = []) {
  const calls: DialogCall[] = [];
  return {
    calls,
    dialog: {
      async showMessageBox(options: any): Promise<{ response: number }> {
        calls.push({ kind: 'message', options });
        if (messages.length === 0) throw new Error('unexpected showMessageBox call');
        return { response: messages.shift() as number };
      },
      async showOpenDialog(options: any): Promise<{ canceled: boolean; filePaths: string[] }> {
        calls.push({ kind: 'open', options });
        const next = opens.shift();
        if (!next) throw new Error('unexpected showOpenDialog call');
        return next;
      },
    },
  };
}

const NO_DIALOG = {};
const THROWING_DIALOG = {
  showMessageBox: async () => { throw new Error('dialog unavailable'); },
  showOpenDialog: async () => { throw new Error('dialog unavailable'); },
};

function assertUntouched(before: { hash: string }, label: string): void {
  eq(sha256(dbPath), before.hash, `${label}: the live database is byte-identical`);
  eq(emergencyFiles().length, 0, `${label}: no emergency copy was created`);
  eq(fs.existsSync(journalPath()), false, `${label}: no recovery journal was written`);
}

// ═══ A. classification ═════════════════════════════════════════════════════

async function scenarioClassification(): Promise<void> {
  console.log('\n[A] only a recognized blocked migration exposes the restore workflow');
  resetWorld();
  setRegistry(throughVersion(98));
  dbModule.initDatabase();
  closeDb();
  restoreRegistry();

  const { dialog, calls } = scriptedDialog([]);
  const unrelated = await runStartupRestoreFlow({ error: new Error('simulated startup failure'), dialog });
  eq(unrelated, 'not-offered', 'an unrelated startup failure is not offered a restore');
  eq(calls.length, 0, 'an unrelated startup failure shows no restore dialog');

  const blocked = new MigrationConvergenceError(
    [{ objectType: 'index', object: `products.${BLOCKED_INDEX}`, problem: 'index missing' }],
    CATCH_UP,
    'catch_up_upstream_v93_to_v98',
  );
  const withoutEngine = await runStartupRestoreFlow({ error: blocked, dialog: NO_DIALOG });
  eq(withoutEngine, 'not-offered', 'no interactive surface falls back to the established error handling');

  const throwing = await runStartupRestoreFlow({ error: blocked, dialog: THROWING_DIALOG });
  eq(throwing, 'not-offered', 'a dialog that cannot be shown falls back to the established error handling');
}

// ═══ B. discovery & validation ═════════════════════════════════════════════

async function scenarioValidation(): Promise<void> {
  console.log('\n[B] backup discovery and validation reject everything unsafe');
  resetWorld();
  const sourcePath = await buildPreUpgradeBackup();
  const raw = new Database(dbPath);

  // B1: the healthy managed backup passes every check.
  const good = dbModule.validateStartupRestoreCandidate(sourcePath);
  ok(good.ok === true, 'a healthy managed backup validates');
  eq(good.ok === true ? good.schemaVersion : null, 98, 'the validated backup reports its real schema version');

  // B2: discovery classifies it and shows identifying information.
  const discovery = dbModule.discoverStartupRestoreBackups();
  eq(discovery.usable.length, 1, 'the healthy backup is offered');
  eq(discovery.usable[0].kind, 'auto', 'the pre-upgrade name is classified as an automatic backup');
  eq(discovery.rejected.length, 0, 'nothing valid was rejected');
  const described = dbModule.describeStartupRestoreCandidate(discovery.usable[0]);
  ok(described.includes(path.basename(sourcePath)), 'the description names the file');
  ok(/schema v98/.test(described), 'the description shows the schema version');
  ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/.test(described), 'the description shows the real timestamp');

  // B3: the active database is never restorable over itself.
  const active = dbModule.validateStartupRestoreCandidate(dbPath);
  eq(active.ok, false, 'the live database is not a valid restore source');
  ok(/not a Flo-managed backup|active database/.test((active as any).reason), 'the live database is refused by name or identity');

  // B4: a file that is not a regular file is rejected.
  const directoryCandidate = path.join(backupDir, 'flo-backup-20260101-000000-not-a-file.db');
  fs.mkdirSync(directoryCandidate, { recursive: true });
  const notAFile = dbModule.validateStartupRestoreCandidate(directoryCandidate);
  eq(notAFile.ok, false, 'a directory posing as a backup is rejected');
  fs.rmSync(directoryCandidate, { recursive: true, force: true });

  // B5: an unrelated SQLite file is rejected for missing core tables.
  const unrelatedPath = path.join(backupDir, 'flo-backup-20260102-000000-unrelated.db');
  const unrelated = new Database(unrelatedPath);
  unrelated.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
  unrelated.pragma('user_version = 98');
  unrelated.close();
  const unrelatedVerdict = dbModule.validateStartupRestoreCandidate(unrelatedPath);
  eq(unrelatedVerdict.ok, false, 'an unrelated SQLite file is rejected');
  ok(/missing required table/.test((unrelatedVerdict as any).reason), 'the rejection names the missing tables');

  // B6: a backup that fails PRAGMA integrity_check is rejected.
  const corruptPath = path.join(backupDir, 'flo-backup-20260103-000000-corrupt.db');
  const healthyBytes = fs.readFileSync(sourcePath);
  const corruptBytes = Buffer.from(healthyBytes);
  // Damage data pages far from the schema so the file still opens but fails the
  // integrity check itself.
  corruptBytes.fill(0x5a, corruptBytes.length - 16384, corruptBytes.length - 12288);
  corruptBytes.fill(0x5a, corruptBytes.length - 8192, corruptBytes.length - 4096);
  fs.writeFileSync(corruptPath, corruptBytes);
  const corruptVerdict = dbModule.validateStartupRestoreCandidate(corruptPath);
  eq(corruptVerdict.ok, false, 'a corrupted backup is rejected');
  ok(/integrity_check/.test((corruptVerdict as any).reason),
    'the rejection is the failed PRAGMA integrity_check');

  // B7: a truncated file cannot open as a database.
  const truncatedPath = path.join(backupDir, 'flo-backup-20260104-000000-truncated.db');
  fs.writeFileSync(truncatedPath, healthyBytes.subarray(0, 1024));
  const truncatedVerdict = dbModule.validateStartupRestoreCandidate(truncatedPath);
  eq(truncatedVerdict.ok, false, 'a truncated backup is rejected');

  // B8: a schema newer than this build is refused.
  const aheadPath = path.join(backupDir, 'flo-backup-20260105-000000-ahead.db');
  fs.copyFileSync(sourcePath, aheadPath);
  const ahead = new Database(aheadPath);
  ahead.pragma(`user_version = ${TAIL + 5}`);
  ahead.close();
  const aheadVerdict = dbModule.validateStartupRestoreCandidate(aheadPath);
  eq(aheadVerdict.ok, false, 'a backup from a newer schema is rejected');
  ok(/newer than this build/.test((aheadVerdict as any).reason), 'the rejection names the version conflict');

  // B9: metadata that contradicts the SQLite header is refused.
  const mismatchPath = path.join(backupDir, 'flo-backup-20260106-000000-mismatch.db');
  fs.copyFileSync(sourcePath, mismatchPath);
  const mismatch = new Database(mismatchPath);
  mismatch.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
  mismatch.prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES ('schema_version', ?)`).run(String(TAIL));
  mismatch.pragma(`user_version = 98`);
  mismatch.close();
  const mismatchVerdict = dbModule.validateStartupRestoreCandidate(mismatchPath);
  eq(mismatchVerdict.ok, false, 'a backup whose metadata contradicts its header is rejected');
  ok(/metadata does not match/.test((mismatchVerdict as any).reason), 'the rejection names the metadata conflict');

  // B10: discovery reports rejected files with their reason instead of offering them.
  const listed = dbModule.discoverStartupRestoreBackups();
  eq(listed.usable.length, 1, 'only the healthy backup is offered');
  ok(listed.rejected.length >= 4, `every unsafe candidate is reported as rejected (got ${listed.rejected.length})`);
  ok(listed.rejected.every((entry: { fileName: string; reason: string }) => entry.reason.length > 0),
    'every rejection carries an explanation');

  // B11: nothing here repairs a candidate in place.
  eq(sha256(corruptPath), sha256(corruptPath), 'the corrupt candidate still exists for inspection');
  ok(fs.existsSync(corruptPath), 'the corrupt candidate was not deleted');

  raw.close();
}

// ═══ C. execution engine ═══════════════════════════════════════════════════

async function scenarioRestoreSuccess(): Promise<void> {
  console.log('\n[C] an approved restore replaces the database and re-runs initialization');
  const { sourcePath } = await setupBlockedWorld();
  eq(userVersion(dbPath), 98, 'the live database starts blocked at v98');
  ok(!hasIndex(dbPath, BLOCKED_INDEX), 'the live database is missing the guarded index');
  const sourceHash = sha256(sourcePath);
  const before = { hash: sha256(dbPath) };
  const blockedHash = before.hash;

  const steps: string[] = [];
  const result = dbModule.performStartupRestore(sourcePath, (step: string) => steps.push(step));

  ok(result && typeof result.restoredSchemaVersion === 'number', 'the restore reports the restored schema version');
  deepSteps(steps);
  eq(userVersion(dbPath), TAIL, 'the restored database ran the full migration chain again');
  ok(hasIndex(dbPath, BLOCKED_INDEX), 'the restored database passes the v1001 postcondition');
  eq(sha256(sourcePath), sourceHash, 'the source backup was never modified');
  ok(fs.existsSync(result.emergencyPath), 'the emergency copy of the blocked database exists');
  eq(userVersion(result.emergencyPath), 98, 'the emergency copy is the blocked database, not a known-good backup');
  eq(!hasIndex(result.emergencyPath, BLOCKED_INDEX), true, 'the emergency copy keeps the pre-restore state');
  eq(fs.existsSync(sourcePath), true, 'the source backup survived the restore');
  eq(stagedFiles().length, 0, 'the staged file was consumed by the swap');
  eq(fs.existsSync(journalPath()), true, 'the recovery journal records the completed restore');
  ok(sha256(dbPath) !== blockedHash, 'the live database actually changed');

  // Normal startup finalizes the committed journal.
  closeDb();
  dbModule.initDatabase();
  eq(fs.existsSync(journalPath()), false, 'the next initialization finalizes the committed journal');
  eq(userVersion(dbPath), TAIL, 'the database initializes normally after a restore');
  closeDb();
}

function deepSteps(steps: string[]): void {
  const expected = ['staged', 'checkpoint', 'closed', 'emergency', 'swap', 'initialize'];
  eq(steps.join('>'), expected.join('>'), `the restore runs its steps in safety order (${expected.join(' → ')})`);
}

async function scenarioRefusalsAndFailures(): Promise<void> {
  console.log('\n[D] every failure path preserves the current database');

  // D1: the active database cannot be restored over itself.
  {
    const { sourcePath } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    let error: any = null;
    try {
      dbModule.performStartupRestore(dbPath);
    } catch (caught) {
      error = caught;
    }
    ok(error instanceof dbModule.StartupRestoreError, 'restoring the active database over itself is refused');
    ok(/active database/.test(error?.message ?? ''), 'the refusal names the reason');
    assertUntouched(before, 'active-database refusal');
    eq(sha256(sourcePath), sha256(sourcePath), 'the source backup still exists');
  }

  // D2: a failure while creating the emergency copy aborts before any change.
  {
    const { sourcePath } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    const realCopy = fs.copyFileSync;
    (fs as any).copyFileSync = function (src: string, dest: string, ...rest: unknown[]) {
      if (String(dest).includes('startup-restore-emergency')) throw new Error('injected emergency-copy failure');
      return (realCopy as any).call(fs, src, dest, ...rest);
    };
    let error: any = null;
    try {
      dbModule.performStartupRestore(sourcePath);
    } catch (caught) {
      error = caught;
    } finally {
      (fs as any).copyFileSync = realCopy;
    }
    ok(error instanceof dbModule.StartupRestoreError, 'an emergency-copy failure aborts the restore');
    ok(/emergency/.test(error?.message ?? ''), 'the failure names the emergency copy');
    assertUntouched(before, 'emergency-copy failure');
    eq(fs.existsSync(sourcePath), true, 'the source backup survived the failure');
    eq(userVersion(dbPath), 98, 'the blocked database is still the live database');
  }

  // D3: a staging failure aborts before the database is touched.
  {
    const { sourcePath } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    const realCopy = fs.copyFileSync;
    (fs as any).copyFileSync = function (src: string, dest: string, ...rest: unknown[]) {
      if (String(dest).includes('.startup-restore-staged')) throw new Error('injected staging failure');
      return (realCopy as any).call(fs, src, dest, ...rest);
    };
    let error: any = null;
    try {
      dbModule.performStartupRestore(sourcePath);
    } catch (caught) {
      error = caught;
    } finally {
      (fs as any).copyFileSync = realCopy;
    }
    ok(error instanceof dbModule.StartupRestoreError, 'a staging failure aborts the restore');
    assertUntouched(before, 'staging failure');
    eq(emergencyFiles().length, 0, 'no emergency copy exists because nothing was replaced');
  }

  // D4: a quiesce failure aborts before any destructive step.
  {
    const { sourcePath } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    let error: any = null;
    try {
      dbModule.performStartupRestore(sourcePath, (step: string) => {
        if (step === 'closed') throw new Error('injected quiesce failure');
      });
    } catch (caught) {
      error = caught;
    }
    ok(error instanceof dbModule.StartupRestoreError, 'a quiesce failure aborts the restore');
    assertUntouched(before, 'quiesce failure');
    eq(fs.existsSync(dbPath), true, 'the live database was never removed');
  }

  // D5: a restore whose re-initialization fails rolls back to the exact bytes.
  {
    resetWorld();
    // A backup that validates (integrity, core tables, version) but cannot pass
    // the v1001 postconditions once it is live.
    setRegistry(throughVersion(98));
    dbModule.initDatabase();
    closeDb();
    restoreRegistry();
    fs.mkdirSync(backupDir, { recursive: true });
    const sourcePath = path.join(backupDir, 'flo-backup-20260107-000000-pre-v1001.db');
    fs.copyFileSync(dbPath, sourcePath);
    const broken = new Database(sourcePath);
    broken.exec(`DROP INDEX IF EXISTS ${BLOCKED_INDEX}`);
    broken.close();
    pruneBackups([sourcePath]);
    // Live database stays healthy-but-marked so rollback is observable.
    const live = new Database(dbPath);
    live.exec(`DROP INDEX IF EXISTS ${BLOCKED_INDEX}`);
    live.close();
    restoreRegistry();
    let blocked: any = null;
    try { dbModule.initDatabase(); } catch (caught) { blocked = caught; }
    closeDb();
    // The blocked run drops its own pre-migration auto-backup into the folder.
    pruneBackups([sourcePath]);
    ok(blocked instanceof MigrationConvergenceError, 'the live database is genuinely blocked');

    const before = { hash: sha256(dbPath) };
    const sourceHash = sha256(sourcePath);
    let error: any = null;
    try {
      dbModule.performStartupRestore(sourcePath);
    } catch (caught) {
      error = caught;
    }
    ok(error instanceof dbModule.StartupRestoreError, 'a failed re-initialization fails the restore');
    eq((error as any).restoreAttempted, true, 'the failure reports that the database was already replaced');
    eq(sha256(dbPath), before.hash, 'the original database was reinstalled byte-for-byte');
    eq(sha256(sourcePath), sourceHash, 'the source backup is untouched');
    eq(emergencyFiles().length, 1, 'the emergency copy is preserved as evidence');
    eq(fs.existsSync(journalPath()), false, 'the recovery journal was cleaned up after the rollback');
    eq(stagedFiles().length, 0, 'the staged file was cleaned up after the rollback');
    eq(userVersion(dbPath), 98, 'the live database is still the blocked database');

    // The failed restore attempt dropped its own pre-migration auto-backup into
    // the folder, so keep this scenario's candidate list deterministic.
    pruneBackups([sourcePath]);
    const emergenciesBeforeFlow = emergencyFiles().length;

    // The flow reports failure, so startup never retries into a loop.
    const { dialog, calls } = scriptedDialog([1, 1, 1]);
    const outcome = await runStartupRestoreFlow({
      error: blocked,
      dialog,
      ports: {
        discover: dbModule.discoverStartupRestoreBackups,
        validate: dbModule.validateStartupRestoreCandidate,
        restore: dbModule.performStartupRestore,
      },
    });
    eq(outcome, 'failed', 'the failed restore is reported as a failure, not a success');
    const restoreCalls = calls.filter((call) => call.kind === 'message').length;
    ok(restoreCalls >= 2, 'the operator saw the offer and the confirmation before the attempt');
    eq(fs.existsSync(sourcePath), true, 'the source backup still exists after the failed attempt');
    eq(emergencyFiles().length, emergenciesBeforeFlow + 1,
      'the second attempt kept the first emergency copy and added its own instead of overwriting anything');
    eq(stagedFiles().length, 0, 'no staged file survives a failed attempt');
  }
}

// ═══ D. flow decisions ═════════════════════════════════════════════════════

async function scenarioFlowDecisions(): Promise<void> {
  console.log('\n[E] the dialog flow only ever offers, and only changes anything on approval');

  // E1: no backup exists → explained, unchanged.
  {
    resetWorld();
    setRegistry(throughVersion(98));
    dbModule.initDatabase();
    closeDb();
    restoreRegistry();
    const raw = new Database(dbPath);
    raw.exec(`DROP INDEX IF EXISTS ${BLOCKED_INDEX}`);
    raw.close();
    let blockError: any = null;
    try { dbModule.initDatabase(); } catch (caught) { blockError = caught; }
    closeDb();
    restoreRegistry();
    pruneBackups([]);
    ok(blockError instanceof MigrationConvergenceError, 'the fixture is genuinely blocked');

    const before = { hash: sha256(dbPath) };
    const { dialog, calls } = scriptedDialog([0]);
    const outcome = await runStartupRestoreFlow({ error: blockError, dialog });
    eq(outcome, 'unchanged', 'with no backup available nothing is changed');
    eq(calls.length, 1, 'the operator is told why no backup is available');
    ok(/No backup files were found|No automatic backup passed/.test(calls[0].options.detail),
      'the dialog explains the missing backup');
    assertUntouched(before, 'no-backup');
  }

  // E2: the operator declines → unchanged, non-destructive default.
  {
    const { sourcePath, blockError } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    const { dialog, calls } = scriptedDialog([0]);
    const outcome = await runStartupRestoreFlow({ error: blockError, dialog });
    eq(outcome, 'unchanged', 'declining keeps the current database');
    eq(calls[0].options.defaultId, 0, 'the destructive option is never the default');
    eq(calls[0].options.buttons[0], 'Keep my database (recommended)', 'the first button keeps the database');
    ok(!/\b(INSERT|SELECT|UPDATE|DELETE)\b/.test(JSON.stringify(calls[0].options)), 'the dialog exposes no SQL');
    assertUntouched(before, 'decline');
    eq(fs.existsSync(sourcePath), true, 'the source backup still exists after declining');
  }

  // E3: approving, then cancelling the confirmation → unchanged.
  {
    const { blockError } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    const { dialog } = scriptedDialog([1, 0]);
    const outcome = await runStartupRestoreFlow({ error: blockError, dialog });
    eq(outcome, 'unchanged', 'cancelling the confirmation keeps the current database');
    assertUntouched(before, 'cancel at confirmation');
  }

  // E4: approving the single automatic backup restores it, for real.
  {
    const { sourcePath, blockError } = await setupBlockedWorld();
    const sourceHash = sha256(sourcePath);
    const { dialog, calls } = scriptedDialog([1, 1]);
    const steps: string[] = [];
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog,
      onStep: (step: string) => steps.push(step),
    });
    eq(outcome, 'restored', 'an approved restore reports success');
    eq(calls.filter((call) => call.kind === 'open').length, 0,
      'a single candidate does not open a second selection dialog, and still is never restored without confirmation');
    eq(calls.filter((call) => call.kind === 'message').length, 2, 'the offer and the explicit confirmation both happen');
    ok(calls[1].options.buttons.some((button: string) => button === 'Restore this backup'),
      'the confirmation names the restore action');
    ok(/lost|discard/.test(calls[1].options.detail), 'the confirmation warns about lost changes');
    eq(userVersion(dbPath), TAIL, 'the restored database went through the real initialization path');
    eq(steps.join('>'), 'staged>checkpoint>closed>emergency>swap>initialize', 'the restore ran every safety step');
    eq(sha256(sourcePath), sourceHash, 'the approved source backup was never modified');
    eq(emergencyFiles().length, 1, 'the blocked database was preserved as an emergency copy');
    closeDb();
  }

  // E5: two backups → the operator chooses, and an invalid choice is refused.
  {
    const { sourcePath, blockError } = await setupBlockedWorld();
    // A second usable candidate forces the selection dialog, and a corrupt one
    // proves a bad pick is refused instead of silently guessed around.
    const secondPath = path.join(backupDir, 'flo-backup-20260109-000000-second-pre-v1001.db');
    fs.copyFileSync(sourcePath, secondPath);
    const corruptPath = path.join(backupDir, 'flo-backup-20260108-000000-corrupt.db');
    const bytes = fs.readFileSync(sourcePath);
    bytes.fill(0x5a, bytes.length - 16384, bytes.length - 12288);
    fs.writeFileSync(corruptPath, bytes);
    eq(dbModule.discoverStartupRestoreBackups().usable.length, 2, 'two usable backups are offered for selection');
    const before = { hash: sha256(dbPath) };

    // Operator picks the corrupt file first: refused, nothing changes.
    const refused = scriptedDialog([1, 1], [{ canceled: false, filePaths: [corruptPath] }]);
    const refusedOutcome = await runStartupRestoreFlow({ error: blockError, dialog: refused.dialog });
    eq(refusedOutcome, 'unchanged', 'an invalid selection leaves the database unchanged');
    const errorDialog = refused.calls.find((call) => call.kind === 'message' && /cannot be used/.test(call.options.message));
    ok(!!errorDialog, 'the operator is told why that file cannot be used');
    assertUntouched(before, 'invalid selection');

    // Operator picks a healthy file: restored.
    const chosen = scriptedDialog([1, 1], [{ canceled: false, filePaths: [secondPath] }]);
    const chosenOutcome = await runStartupRestoreFlow({ error: blockError, dialog: chosen.dialog });
    eq(chosenOutcome, 'restored', 'choosing a valid backup restores it');
    eq(userVersion(dbPath), TAIL, 'the chosen backup was restored through the real initialization path');
    closeDb();
  }

  // E6: closing the first dialog (cancelId) never touches anything.
  {
    const { blockError } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    const { dialog, calls } = scriptedDialog([0]);
    const outcome = await runStartupRestoreFlow({ error: blockError, dialog });
    eq(outcome, 'unchanged', 'closing the dialog keeps the current database');
    eq(calls[0].options.cancelId, 0, 'closing resolves to the keep-database button');
    assertUntouched(before, 'close dialog');
  }

  // E7: a restore that throws is reported as a failure with an actionable message.
  {
    const { blockError } = await setupBlockedWorld();
    const before = { hash: sha256(dbPath) };
    const { dialog, calls } = scriptedDialog([1, 1, 1]);
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog,
      ports: {
        discover: dbModule.discoverStartupRestoreBackups,
        validate: dbModule.validateStartupRestoreCandidate,
        restore: () => { throw new Error('injected replacement failure'); },
      },
    });
    eq(outcome, 'failed', 'a thrown restore is reported as a failure');
    const failureDialog = calls.find((call) => call.options.title === 'Flo Cafe — restore failed');
    ok(!!failureDialog, 'the operator sees what went wrong');
    ok(/rolled back/.test(failureDialog.options.detail), 'the operator is told the database was rolled back');
    ok(/recovery files were kept/.test(failureDialog.options.detail), 'the operator is told the recovery files were kept');
    assertUntouched(before, 'thrown restore');
  }
}

// ═══ G. Diagnostic event ══════════════════════════════════════════════════

/**
 * The event must name *why* the flow settled where it did. Before this, an
 * empty folder, an unreadable folder and a folder whose entries all failed
 * inspection were indistinguishable from outside: all three returned
 * 'unchanged' after a single dialog.
 */
async function scenarioDiagnostics(): Promise<void> {
  console.log('\n[G] the diagnostic event names the branch the flow took');

  const { __setStartupRestoreDiagnosticSinkForTests, __setStartupRestoreClockForTests } = require('../main/startup-restore');
  // Capture the exact JSON the production sink would emit, not a live reference:
  // a reference would hide any field mutated after the event was sent.
  const rawEvents: string[] = [];
  const events: any[] = [];
  const capture = (event: any) => {
    const json = JSON.stringify(event);
    rawEvents.push(json);
    events.push(JSON.parse(json));
  };
  __setStartupRestoreDiagnosticSinkForTests(capture);
  const lastEvent = () => events[events.length - 1];
  const lastRaw = () => rawEvents[rawEvents.length - 1];
  const resetEvents = () => { events.length = 0; rawEvents.length = 0; };

  const { sourcePath, blockError } = await setupBlockedWorld();
  const candidate = (name: string) => ({
    fileName: name,
    path: path.join(backupDir, name),
    sizeBytes: 4096,
    createdAt: new Date().toISOString(),
    kind: 'auto' as const,
    schemaVersion: 98,
  });
  const diagnostics = (overrides: Record<string, unknown> = {}) => ({
    entriesObserved: 0,
    entriesSkippedWithError: 0,
    skipped: [],
    discoveryError: null,
    ...overrides,
  });
  const noopValidate = () => ({ ok: true as const, schemaVersion: 98 });
  const okRestore = () => ({ emergencyPath: path.join(testDir, 'emergency.db'), restoredSchemaVersion: 98 });

  // G1 — the folder really is empty.
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => ({ usable: [], rejected: [], diagnostics: diagnostics() }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    const event = lastEvent();
    eq(outcome, 'unchanged', 'G1 empty folder still returns unchanged');
    eq(event.outcomeReason, 'UNCHANGED_LIST_EMPTY', 'G1 empty folder is reported as LIST_EMPTY');
    eq(event.counts.entriesObserved, 0, 'G1 empty folder observed zero entries');
    eq(event.counts.entriesSkippedWithError, 0, 'G1 empty folder has no skipped entries');
  }

  // G2 — listing itself failed: this must not read as an empty folder.
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => { throw new Error('EACCES: permission denied'); },
        validate: noopValidate,
        restore: okRestore,
      },
    });
    const event = lastEvent();
    eq(outcome, 'unchanged', 'G2 failed listing still returns unchanged');
    eq(event.outcomeReason, 'UNCHANGED_LIST_FAILED', 'G2 failed listing is reported as LIST_FAILED');
    eq(event.counts.entriesObserved, null, 'G2 failed listing reports null, not zero');
  }

  // G3 — entries existed but every one failed validation.
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => ({
          usable: [],
          rejected: [{ fileName: 'flo-backup-a.db', reason: 'corrupt', code: 'INTEGRITY_CHECK_FAILED' }],
          diagnostics: diagnostics({ entriesObserved: 1 }),
        }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    const event = lastEvent();
    eq(event.outcomeReason, 'UNCHANGED_ALL_REJECTED', 'G3 rejected candidates are reported as ALL_REJECTED');
    eq(event.rejections[0]?.reasonCode, 'INTEGRITY_CHECK_FAILED', 'G3 the rejection carries its validation code');
  }

  // G4 — the case that used to vanish: an entry dropped by a failed lstat.
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => ({
          usable: [],
          rejected: [],
          diagnostics: diagnostics({
            entriesObserved: 1,
            entriesSkippedWithError: 1,
            skipped: [{ ordinal: 1, code: 'LIST_STAT_FAILED' }],
          }),
        }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    const event = lastEvent();
    eq(outcome, 'unchanged', 'G4 a skipped entry still leaves the flow unchanged');
    eq(event.outcomeReason, 'UNCHANGED_LIST_FAILED', 'G4 a skipped entry is never reported as an empty folder');
    eq(event.counts.entriesObserved, 1, 'G4 the observed entry is counted');
    eq(event.counts.entriesSkippedWithError, 1, 'G4 the operational skip is counted');
    eq(event.counts.candidatesRejected, 0, 'G4 a skipped entry is not a rejected candidate');
    eq(event.counts.candidatesUsable, 0, 'G4 a skipped entry is not a usable candidate');
    eq(event.counts.candidatesAcceptedForInspection, 0, 'G4 the skipped entry never reached inspection');
    eq(event.rejections[0]?.reasonCode, 'LIST_STAT_FAILED', 'G4 the skip keeps its reason code');
    eq(event.rejections[0]?.phase, 'list', 'G4 the skip is attributed to the list phase');
    eq(JSON.parse(lastRaw()).outcomeReason, 'UNCHANGED_LIST_FAILED', 'G4 the serialized event reports the same reason');
  }

  // G5..G7 — the three ways an operator can leave without restoring.
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([0]).dialog,
      ports: { discover: () => ({ usable: [candidate('a.db')], rejected: [] }), validate: noopValidate, restore: okRestore },
    });
    eq(lastEvent().outcomeReason, 'UNCHANGED_DECLINED', 'G5 declining the offer is its own reason');
  }
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1], [{ canceled: true, filePaths: [] }]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db'), candidate('b.db')], rejected: [] }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    eq(lastEvent().outcomeReason, 'UNCHANGED_SELECT_CANCELLED', 'G6 cancelling the picker is its own reason');
  }
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 0]).dialog,
      ports: { discover: () => ({ usable: [candidate('a.db')], rejected: [] }), validate: noopValidate, restore: okRestore },
    });
    eq(lastEvent().outcomeReason, 'UNCHANGED_CONFIRM_DECLINED', 'G7 declining the confirmation is its own reason');
  }

  // G8 — success and the emergency copy it implies.
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1]).dialog,
      ports: { discover: () => ({ usable: [candidate('a.db')], rejected: [] }), validate: noopValidate, restore: okRestore },
    });
    const event = lastEvent();
    eq(outcome, 'restored', 'G8 a successful restore returns restored');
    eq(event.outcomeReason, 'RESTORED', 'G8 success is reported as RESTORED');
    eq(event.emergencyBackup, 'created', 'G8 success records the emergency copy as created');
  }

  // G9/G10 — a failed restore carries the emergency-copy state it actually reached.
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1, 1]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [] }),
        validate: noopValidate,
        restore: () => { throw new dbModule.StartupRestoreError('rollback happened', true, 'created'); },
      },
    });
    const event = lastEvent();
    eq(outcome, 'failed', 'G9 a restore failure still returns failed');
    eq(event.outcomeReason, 'FAILED_RESTORE', 'G9 failure is reported as FAILED_RESTORE');
    eq(event.emergencyBackup, 'created', 'G9 the event reports the emergency copy that was written');
  }
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1, 1]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [] }),
        validate: noopValidate,
        restore: () => { throw new dbModule.StartupRestoreError('emergency copy failed', false, 'failed'); },
      },
    });
    eq(lastEvent().emergencyBackup, 'failed', 'G10 an emergency-copy failure is reported as failed');
  }

  // G11 — a broken logger must not change the outcome.
  {
    resetEvents();
    // Baseline run with a healthy logger, for an exact comparison.
    const healthyDialog = scriptedDialog([1, 1]);
    let restoreCalls = 0;
    const healthyOutcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: healthyDialog.dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
        validate: noopValidate,
        restore: () => { restoreCalls += 1; return okRestore(); },
      },
    });
    const healthyEvent = lastEvent();
    const healthyMessages = healthyDialog.calls.filter((c) => c.kind === 'message').length;

    resetEvents();
    __setStartupRestoreDiagnosticSinkForTests(() => { throw new Error('logger exploded'); });
    let outcome: string | null = null;
    let crashed = false;
    const brokenDialog = scriptedDialog([1, 1]);
    let brokenRestoreCalls = 0;
    try {
      outcome = await runStartupRestoreFlow({
        error: blockError,
        dialog: brokenDialog.dialog,
        ports: {
          discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
          validate: noopValidate,
          restore: () => { brokenRestoreCalls += 1; return okRestore(); },
        },
      });
    } catch { crashed = true; }
    __setStartupRestoreDiagnosticSinkForTests(capture);

    eq(crashed, false, 'G11 a throwing logger does not crash the flow');
    eq(outcome, healthyOutcome, 'G11 a throwing logger leaves the outcome unchanged');
    eq(brokenRestoreCalls, restoreCalls, 'G11 a throwing logger does not change how often restore runs');
    eq(brokenDialog.calls.filter((c) => c.kind === 'message').length, healthyMessages,
      'G11 a throwing logger does not change the dialog sequence');
    eq(events.length, 0, 'G11 the throwing logger produced no event, and nothing else broke');
  }

  // G12 — the not-offered branches are distinguishable too.
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({ error: new Error('not a migration problem'), dialog: scriptedDialog([1]).dialog });
    eq(outcome, 'not-offered', 'G12a a non-migration error is not offered');
    eq(lastEvent().outcomeReason, 'NOT_OFFERED_NO_DIAGNOSTIC', 'G12a a non-migration error has its own reason');
  }
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({ error: blockError, ports: {} as any });
    eq(outcome, 'not-offered', 'G12b missing ports are not offered');
    eq(lastEvent().outcomeReason, 'NOT_OFFERED_NO_PORTS', 'G12b missing ports have their own reason');
  }
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: THROWING_DIALOG as any,
      ports: { discover: () => ({ usable: [candidate('a.db')], rejected: [] }), validate: noopValidate, restore: okRestore },
    });
    eq(outcome, 'not-offered', 'G12c an unavailable dialog is not offered');
    eq(lastEvent().outcomeReason, 'NOT_OFFERED_DIALOG_FAILED', 'G12c an unavailable dialog has its own reason');
  }

  // G13 — privacy: the serialized event carries no path, file name or raw error text.
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => ({
          usable: [],
          rejected: [{ fileName: 'flo-backup-SECRET-NAME.db', reason: 'secret detail C:\\Users\\someone', code: 'OPEN_FAILED' }],
          diagnostics: diagnostics({ entriesObserved: 1 }),
        }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    const serialized = JSON.stringify(lastEvent());
    eq(/SECRET-NAME/.test(serialized), false, 'G13 the backup file name never reaches the event');
    eq(/Users|AppData|secret detail/.test(serialized), false, 'G13 no path or raw rejection text reaches the event');
    eq(typeof lastEvent().correlationId, 'string', 'G13 the event carries an opaque correlation id');

    // The key set is the contract: an unexpected field is a leak by definition.
    const keysOf = (value: any) => Object.keys(value).sort().join(',');
    eq(keysOf(lastEvent()),
      'correlationId,counts,discoveryError,emergencyBackup,event,outcome,outcomeReason,phase,rejections,schemaVersion,timingsMs',
      'G13 the event has exactly the contracted root keys');
    eq(keysOf(lastEvent().counts),
      'candidatesAcceptedForInspection,candidatesRejected,candidatesUsable,entriesObserved,entriesSkippedWithError',
      'G13 counts has exactly the contracted keys');
    eq(keysOf(lastEvent().timingsMs), 'dialog,discover,restore', 'G13 timingsMs has exactly the contracted keys');
    eq(keysOf(lastEvent().rejections[0]), 'ordinal,phase,reasonCode', 'G13 each rejection has exactly three keys');
    eq(lastEvent().schemaVersion, 2, 'G13 the event declares schema version 2');
  }

  // G14 — the real discovery path reports a real lstat failure instead of dropping it.
  {
    resetEvents();
    const sourceName = path.basename(sourcePath);
    const realLstat = fs.lstatSync;
    (fs as any).lstatSync = function (target: any, ...rest: unknown[]) {
      if (String(target).includes(sourceName)) throw new Error('EBUSY: injected lstat failure');
      return (realLstat as any).call(fs, target, ...rest);
    };
    let discovered: any = null;
    try {
      discovered = dbModule.discoverStartupRestoreBackups();
    } finally {
      (fs as any).lstatSync = realLstat;
    }
    eq(discovered.diagnostics.entriesObserved, 1, 'G14 the real listing still observes the entry');
    eq(discovered.diagnostics.entriesSkippedWithError, 1, 'G14 a failed lstat is counted, not silently dropped');
    eq(discovered.diagnostics.skipped[0]?.code, 'LIST_STAT_FAILED', 'G14 the skip carries LIST_STAT_FAILED');
    eq(discovered.usable.length, 0, 'G14 the entry does not become a candidate');
    eq(fs.existsSync(sourcePath), true, 'G14 the backup file itself was not touched');
  }

  // ═══ F1 — phase timings are stamped before the event is serialized ═══════
  {
    let tick = 1000;
    __setStartupRestoreClockForTests(() => (tick += 10));
    const withOneCandidate = () => ({
      discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
      validate: noopValidate,
      restore: okRestore,
    });

    resetEvents();
    const declined = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([0]).dialog,
      ports: withOneCandidate(),
    });
    let json = JSON.parse(lastRaw());
    eq(declined, 'unchanged', 'F1a a declined offer still returns unchanged');
    eq(json.timingsMs.discover, 10, 'F1a discover timing is the measured duration');
    eq(json.timingsMs.dialog, 10, 'F1a dialog timing is measured, not left at zero');
    eq(json.timingsMs.restore, null, 'F1a restore never ran, so it is null and not zero');

    resetEvents();
    await runStartupRestoreFlow({ error: blockError, dialog: scriptedDialog([1, 1]).dialog, ports: withOneCandidate() });
    json = JSON.parse(lastRaw());
    eq(json.outcome, 'restored', 'F1b the successful path still restores');
    eq(json.timingsMs.discover, 10, 'F1b discover timing is measured');
    eq(json.timingsMs.dialog, 10, 'F1b dialog timing is measured on the success path');
    eq(json.timingsMs.restore, 10, 'F1b restore timing is measured on the success path');

    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1, 1]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
        validate: noopValidate,
        restore: () => { throw new dbModule.StartupRestoreError('boom', true, 'created'); },
      },
    });
    json = JSON.parse(lastRaw());
    eq(json.outcome, 'failed', 'F1c the failing path still fails');
    eq(json.timingsMs.dialog, 10, 'F1c dialog timing is measured on the failure path');
    eq(json.timingsMs.restore, 10, 'F1c restore timing is measured on the failure path');

    resetEvents();
    await runStartupRestoreFlow({ error: blockError, ports: {} as any });
    json = JSON.parse(lastRaw());
    eq(json.timingsMs.discover, null, 'F1d a flow that never discovers reports null');
    eq(json.timingsMs.dialog, null, 'F1d a flow that never opens a dialog reports null');
    eq(json.timingsMs.restore, null, 'F1d a flow that never restores reports null');

    __setStartupRestoreClockForTests(null);
  }

  // ═══ F2 — a discovery failure is not a rejected candidate ════════════════
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: { discover: () => { throw new Error('EACCES: permission denied'); }, validate: noopValidate, restore: okRestore },
    });
    const event = lastEvent();
    eq(outcome, 'unchanged', 'F2 a discovery failure still returns unchanged');
    eq(event.counts.entriesObserved, null, 'F2 nothing could be observed, so the count is null');
    eq(event.counts.candidatesRejected, 0, 'F2 no candidate is counted as rejected');
    eq(event.counts.candidatesUsable, 0, 'F2 no candidate is counted as usable');
    eq(event.discoveryError, 'BACKUP_DIRECTORY_UNAVAILABLE', 'F2 the discovery failure has its own field');
    eq(event.rejections[0]?.phase, 'discovery', 'F2 the failure is attributed to discovery, not inspection');
    eq(event.rejections[0]?.reasonCode, 'BACKUP_DIRECTORY_UNAVAILABLE', 'F2 the discovery reason code survives');
  }

  // ═══ F3 — a non-file entry is not an operational failure ═════════════════
  {
    resetEvents();
    const outcome = await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => ({
          usable: [],
          rejected: [],
          diagnostics: diagnostics({
            entriesObserved: 1,
            entriesSkippedWithError: 0,
            skipped: [{ ordinal: 1, code: 'NOT_A_REGULAR_FILE' }],
          }),
        }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    const event = lastEvent();
    eq(outcome, 'unchanged', 'F3 a non-file entry still returns unchanged');
    eq(event.outcomeReason, 'UNCHANGED_ALL_REJECTED', 'F3 a non-file entry is not reported as an operational failure');
    eq(event.counts.entriesSkippedWithError, 0, 'F3 the error counter stays at zero');
    eq(event.counts.candidatesUsable, 0, 'F3 the entry never becomes a usable candidate');
    eq(event.counts.candidatesRejected, 0, 'F3 the entry is not counted as a rejected candidate');
    eq(event.rejections[0]?.reasonCode, 'NOT_A_REGULAR_FILE', 'F3 the entry keeps its skip reason');
  }

  // ═══ F4 — an unknown rejection code never reaches the event ══════════════
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1]).dialog,
      ports: {
        discover: () => ({
          usable: [],
          rejected: [{ fileName: 'x', reason: 'y', code: 'C:\\Users\\someone\\SECRET-NAME' as any }],
          diagnostics: diagnostics({ entriesObserved: 1 }),
        }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    eq(lastEvent().rejections[0]?.reasonCode, 'UNKNOWN_REJECTION', 'F4 an unknown code collapses to UNKNOWN_REJECTION');
    eq(/SECRET-NAME|Users/.test(lastRaw()), false, 'F4 a hostile code never reaches the serialized event');
  }

  // ═══ F5 — emergencyBackup is derived, not assumed ════════════════════════
  {
    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
        validate: noopValidate,
        restore: () => ({ emergencyPath: '', restoredSchemaVersion: 98 }),
      },
    });
    eq(lastEvent().emergencyBackup, 'not-attempted', 'F5 success without an emergency path is not claimed as created');

    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
        validate: noopValidate,
        restore: okRestore,
      },
    });
    eq(lastEvent().emergencyBackup, 'created', 'F5 a returned emergency path is reported as created');

    resetEvents();
    await runStartupRestoreFlow({
      error: blockError,
      dialog: scriptedDialog([1, 1, 1]).dialog,
      ports: {
        discover: () => ({ usable: [candidate('a.db')], rejected: [], diagnostics: diagnostics({ entriesObserved: 1 }) }),
        validate: noopValidate,
        restore: () => { throw new dbModule.StartupRestoreError('emergency failed', false, 'failed'); },
      },
    });
    eq(lastEvent().emergencyBackup, 'failed', 'F5 an emergency-copy failure is reported as failed');
  }

  __setStartupRestoreDiagnosticSinkForTests(null);
}

// ═══ summary ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  await scenarioClassification();
  await scenarioValidation();
  await scenarioRestoreSuccess();
  await scenarioRefusalsAndFailures();
  await scenarioFlowDecisions();
  await scenarioDiagnostics();

  console.log(`\nstartup-restore: ${passed} passed, ${failed} failed`);
  restoreRegistry();
  closeDb();
  fs.rmSync(testDir, { recursive: true, force: true });
  Module._load = originalLoad;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('startup-restore test crashed:', error);
  restoreRegistry();
  closeDb();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  Module._load = originalLoad;
  process.exit(1);
});

// Module scope: keeps these top-level declarations out of the shared test-project globals.
export {};
