/**
 * P-3.3 — TDD characterization + hardening tests for Y-1 / Y-2 on the import route.
 *
 * Y-1: a post-commit side effect (googleDrive.completeDatabaseRestore() cleanup)
 *      must NOT turn a successfully committed import into an HTTP 500. The data is
 *      durable; the client must receive 200 + success + cleanupPending instead.
 * Y-2: a failed (rolled-back) import must preserve the pre-import safety backup
 *      file on disk (never auto-deleted), and must never delete/modify other
 *      (Restore/Reset) backups.
 *
 * Isolation: same mkdtemp + mock-electron harness as the P-3.1 atomicity tests so
 * the real install database is never touched.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-p33-y1y2-'));

const ORIGINAL_JWT_SECRET_ENV = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-p33-y1y2';

if (process.env.FLO_E2E_DB_PATH) {
  throw new Error('Refusing to run with FLO_E2E_DB_PATH set: the test database would escape the temp directory');
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'dpapi',
        encryptString: (value: string) => Buffer.from(`enc(${value})`, 'utf8'),
        decryptString: (buffer: Buffer) => buffer.toString('utf8').slice(4, -1),
      },
    };
  }
  return originalLoad.apply(this, arguments as never);
};

const request = require('supertest');
const {
  initTestDb,
  seedOwnerUser,
  assert,
  assertEqual,
  getResults,
  closeDatabase,
  getDatabase,
  createApp,
  now,
} = require('./helpers/test-setup');
const { databaseRoutes } = require('../main/routes/database');
const { getCurrentSchemaVersion, getDbPath } = require('../main/db');
const { googleDrive } = require('../main/services/google-drive');

const PROBE_OK = 'p33_ok';
const PROBE_A = 'p33_a';
const PROBE_B = 'p33_b';
const PROBE_C = 'p33_c';
const PROBE_FK = 'p33_fk';

function settingValue(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}
function settingRowCount(key: string): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM settings WHERE key = ?').get(key) as { c: number }).c;
}
function deleteSettings(...keys: string[]): void {
  const stmt = getDatabase().prepare('DELETE FROM settings WHERE key = ?');
  for (const key of keys) stmt.run(key);
}
function setSettings(entries: Record<string, string>): void {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, value] of Object.entries(entries)) stmt.run(key, value, now());
}
function importRow(key: string, value: string): Record<string, string> {
  return { key, value, updated_at: new Date().toISOString() };
}
function importPayload(data: Record<string, unknown>): Record<string, unknown> {
  return {
    overwrite: false,
    data: {
      version: 1,
      app: 'FloDesktop',
      schema_version: String(getCurrentSchemaVersion()),
      data: { settings: [], categories: [], products: [], users: [], ...data },
    },
  };
}
async function postImport(app: unknown, authHeader: Record<string, string>, payload: unknown) {
  const response = await request(app).post('/api/database/import').set(authHeader).send(payload);
  return { response };
}
function listBackupFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (/flo-backup-.*\.db$/.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
function diskSettingsRowCount(key: string): number {
  const RealDatabase = require('better-sqlite3');
  const fileCheck = new RealDatabase(getDbPath(), { readonly: true });
  try {
    return (fileCheck.prepare('SELECT COUNT(*) c FROM settings WHERE key = ?').get(key) as { c: number }).c;
  } finally {
    fileCheck.close();
  }
}

async function run() {
  try {
    initTestDb();
    const owner = seedOwnerUser(getDatabase());
    const app = createApp({ '/api/database': databaseRoutes });
    assert(getDbPath().startsWith(testDir), 'setup: the test database lives inside the temp directory');

    const originalComplete = googleDrive.completeDatabaseRestore;

    // ── T-Y1-3: successful import, no post-commit error → 200 + cleanupPending=false ──
    deleteSettings(PROBE_OK);
    const ok = await postImport(app, owner.authHeader, importPayload({ settings: [importRow(PROBE_OK, 'committed-ok')] }));
    assertEqual(ok.response.status, 200, 'T-Y1-3: a valid import returns 200');
    assertEqual(ok.response.body?.success, true, 'T-Y1-3: a valid import reports success');
    assertEqual(settingRowCount(PROBE_OK), 1, 'T-Y1-3: the imported row is really committed (re-read from the DB handle)');
    assertEqual(ok.response.body?.cleanupPending, false, 'T-Y1-3: no cleanup pending on a clean success');
    const backupDir = path.dirname(ok.response.body?.backup as string);
    assert(typeof backupDir === 'string' && backupDir.length > 0, 'T-Y1-3: backup path returned so the backup dir is known');
    assert(fs.existsSync(ok.response.body?.backup), 'T-Y2-2: a successful import keeps its safety backup on disk and returns it in the response');
    assert(fs.statSync(ok.response.body?.backup).size > 0, 'T-Y2-2: the safety backup file is non-empty');
    deleteSettings(PROBE_OK);

    // ── T-Y2-3: a validation failure (400) before the safety backup is taken creates no backup ──
    // Spec matrix T-Y2-3: a 400 that rejects the payload before the pre-BEGIN backup
    // line runs must leave the backup directory untouched.
    const before400 = listBackupFiles(testDir);
    const badFormat = await postImport(app, owner.authHeader, { data: null, overwrite: false });
    assertEqual(badFormat.response.status, 400, 'T-Y2-3: an invalid import payload is rejected with 400');
    const after400 = listBackupFiles(testDir);
    assertEqual(after400.length, before400.length, 'T-Y2-3: a pre-backup 400 validation failure creates no orphan safety backup');
    assertEqual(after400.slice().sort().join('|'), before400.slice().sort().join('|'), 'T-Y2-3: the backup directory is unchanged after the 400');

    // ── T-Y1-2: completeDatabaseRestore reports cleanupPending=true (non-throw) ──
    googleDrive.completeDatabaseRestore = () => ({ committed: true, cleanupPending: true });
    try {
      deleteSettings(PROBE_A);
      const pending = await postImport(app, owner.authHeader, importPayload({ settings: [importRow(PROBE_A, 'committed-a')] }));
      assertEqual(pending.response.status, 200, 'T-Y1-2: an import with cleanupPending=true still returns 200');
      assertEqual(pending.response.body?.success, true, 'T-Y1-2: the import reports success despite pending cleanup');
      assertEqual(settingRowCount(PROBE_A), 1, 'T-Y1-2: the row is committed');
      assertEqual(pending.response.body?.cleanupPending, true, 'T-Y1-2: cleanupPending is propagated to the response');
    } finally {
      googleDrive.completeDatabaseRestore = originalComplete;
    }
    deleteSettings(PROBE_A);

    // ── T-Y1-1: completeDatabaseRestore THROWS AFTER a successful commit (Y-1 defect) ──
    // Data is durable; the route must NOT report HTTP 500.
    googleDrive.completeDatabaseRestore = () => { throw new Error('injected post-commit cleanup failure'); };
    try {
      deleteSettings(PROBE_B);
      const thrown = await postImport(app, owner.authHeader, importPayload({ settings: [importRow(PROBE_B, 'committed-b')] }));
      assertEqual(thrown.response.status, 200, 'T-Y1-1: a post-commit cleanup failure must NOT become HTTP 500 (data is committed)');
      assertEqual(thrown.response.body?.success, true, 'T-Y1-1: the committed import is reported as success');
      assertEqual(settingRowCount(PROBE_B), 1, 'T-Y1-1: the imported row is still present via the in-process handle');
      assertEqual(thrown.response.body?.cleanupPending, true, 'T-Y1-1: cleanupPending=true signals follow-up cleanup is required');
      // Confirm durability via a fresh connection to the database FILE (not just the handle).
      assertEqual(diskSettingsRowCount(PROBE_B), 1, 'T-Y1-1: a fresh connection to the DB file also sees the committed row');
    } finally {
      googleDrive.completeDatabaseRestore = originalComplete;
    }
    deleteSettings(PROBE_B);

    // ── T-Y1-5: releaseDatabaseRestore() throwing AFTER the 200 must not corrupt the response ──
    // releaseDatabaseRestore() (google-drive.ts:1161) calls getDatabaseReplacementJournal()
    // OUTSIDE its own try/catch — the same throwing path as completeDatabaseRestore().
    // It runs in the route's `finally`, i.e. after res.json(200) has already been sent.
    // A throw there rejects asyncHandler → Express tries a second response on sent headers
    // (ERR_HTTP_HEADERS_SENT), which can truncate the in-flight 200 body. The data is
    // committed and the client must still receive the complete 200 success payload.
    const originalRelease = googleDrive.releaseDatabaseRestore;
    googleDrive.releaseDatabaseRestore = () => { throw new Error('injected post-response release failure'); };
    try {
      deleteSettings(PROBE_C);
      const released = await postImport(app, owner.authHeader, importPayload({ settings: [importRow(PROBE_C, 'committed-c')] }));
      assertEqual(released.response.status, 200, 'T-Y1-5: a post-response release failure must not turn the 200 into an error');
      assertEqual(released.response.body?.success, true, 'T-Y1-5: the committed import is still reported as success');
      assertEqual(released.response.body?.cleanupPending, false, 'T-Y1-5: cleanupPending reflects the (successful) cleanup, not the release failure');
      assertEqual(settingRowCount(PROBE_C), 1, 'T-Y1-5: the row is committed');
      assertEqual(diskSettingsRowCount(PROBE_C), 1, 'T-Y1-5: a fresh connection to the DB file also sees the committed row');
    } finally {
      googleDrive.releaseDatabaseRestore = originalRelease;
    }
    deleteSettings(PROBE_C);

    // ── T-Y1-4: a pre-commit failure must NOT invoke post-commit cleanup ──
    let completeCalls = 0;
    googleDrive.completeDatabaseRestore = (...args: unknown[]) => {
      completeCalls += 1;
      return originalComplete.apply(googleDrive, args as never);
    };
    try {
      deleteSettings(PROBE_FK);
      const failing = await postImport(app, owner.authHeader, importPayload({
        settings: [importRow(PROBE_FK, 'must-rollback')],
        supply_movements: [{
          id: 990002,
          supply_id: 'p33-missing-supply',
          quantity_delta: 1,
          movement_type: 'adjustment',
          unit: 'each',
          stock_after: 1,
          actor_user_id: owner.userId,
          created_at: new Date().toISOString(),
        }],
      }));
      assertEqual(failing.response.status, 500, 'T-Y1-4: a mid-import FK failure returns the route error contract (500)');
      assertEqual(settingRowCount(PROBE_FK), 0, 'T-Y1-4: the pre-failure row was rolled back');
      assertEqual(completeCalls, 0, 'T-Y1-4: post-commit cleanup is never called when the transaction did not commit');
    } finally {
      googleDrive.completeDatabaseRestore = originalComplete;
    }
    deleteSettings(PROBE_FK);

    // ── T-Y2-1: a failed import leaves the safety backup file on disk ──
    const before = listBackupFiles(testDir);
    deleteSettings(PROBE_A);
    const failed = await postImport(app, owner.authHeader, importPayload({
      settings: [importRow(PROBE_A, 'must-rollback-2'), importRow('business_name', 'clash')],
    }));
    assertEqual(failed.response.status, 500, 'T-Y2-1: the conflicting import fails');
    const after = listBackupFiles(testDir);
    const newBackups = after.filter((p) => !before.includes(p));
    assertEqual(newBackups.length, 1, 'T-Y2-1: exactly one safety backup was created during the failed import');
    assert(fs.existsSync(newBackups[0]), 'T-Y2-1: the safety backup still exists after the rollback (not deleted)');
    assert(fs.statSync(newBackups[0]).size > 0, 'T-Y2-1: the preserved safety backup is non-empty');
    deleteSettings(PROBE_A);

    // ── T-Y2-4: a pre-existing Restore/Reset recovery backup is untouched by a failed import ──
    // Faithful to the real naming scheme (db.ts:1396 `flo-reset-recovery-<hex>.db`,
    // journal regex db.ts:563/637 `flo-(restore|reset)-recovery-*.json`). These files are
    // required to recover from filesystem corruption, so no import path may delete or
    // modify them (D-2 Option B: never touch Restore/Reset backups).
    const recoveryHex = 'a1b2c3d4e5f60718';
    const sentinelDb = path.join(backupDir, `flo-restore-recovery-${recoveryHex}.db`);
    const sentinelJournal = path.join(backupDir, `flo-restore-recovery-${recoveryHex}.json`);
    const sentinelDbContent = 'SENTINEL-RESTORE-RECOVERY-DB-DO-NOT-TOUCH';
    const sentinelJournalContent = JSON.stringify({ phase: 'prepared', jobId: recoveryHex });
    fs.writeFileSync(sentinelDb, sentinelDbContent);
    fs.writeFileSync(sentinelJournal, sentinelJournalContent);
    try {
      const reFail = await postImport(app, owner.authHeader, importPayload({
        settings: [importRow(PROBE_A, 'must-rollback-3'), importRow('business_name', 'clash2')],
      }));
      assertEqual(reFail.response.status, 500, 'T-Y2-4: the import fails');
      assert(fs.existsSync(sentinelDb), 'T-Y2-4: the pre-existing Restore/Reset recovery .db still exists after a failed import');
      assert(fs.existsSync(sentinelJournal), 'T-Y2-4: the pre-existing Restore/Reset recovery .json journal still exists');
      assertEqual(fs.readFileSync(sentinelDb, 'utf8'), sentinelDbContent, 'T-Y2-4: the recovery .db content is byte-identical (never modified by the import path)');
      assertEqual(fs.readFileSync(sentinelJournal, 'utf8'), sentinelJournalContent, 'T-Y2-4: the recovery .json journal content is byte-identical');
    } finally {
      try { fs.unlinkSync(sentinelDb); } catch { }
      try { fs.unlinkSync(sentinelJournal); } catch { }
    }

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} P-3.3 assertions failed`);
    console.log('✅ P-3.3 Y-1/Y-2 import hardening tests passed');
  } finally {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  if (ORIGINAL_JWT_SECRET_ENV === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL_JWT_SECRET_ENV;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
