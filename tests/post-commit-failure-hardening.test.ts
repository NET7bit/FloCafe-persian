/**
 * P-3.4 — Post-Commit Failure Hardening (RED-first, then GREEN after the fix).
 *
 * Core rule under test: once the main database operation has COMMITTED, a failure in a
 * post-commit side effect (Google Drive restore cleanup, auth-cache refresh, the
 * `foreign_keys` pragma restore, or `releaseDatabaseRestore()`) must NOT be reported as a
 * failed operation. Conversely, a genuine PRE-commit failure must still fail correctly.
 *
 * Target paths (per the P-3.3 closure report):
 *   A. main/routes/database.ts            — import route, `foreign_keys` restore in `finally`
 *   B. main/routes/database-tools.ts      — currency-reset, initialize
 *   C. main/ipc.ts                        — restore-backup (both branches), db-initialize
 *   D. releaseDatabaseRestore() guarding  — all of the above
 *
 * Isolation: temp DB (mkdtemp) + mocked `electron` (app/ipcMain/dialog/safeStorage).
 * Refuses FLO_E2E_DB_PATH. Never touches the real flo.db.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = __dirname.replace(/\\/g, '/').replace(/\/tests$/, '');
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-p34-postcommit-'));

const ipcHandlers = new Map<string, Function>();

if (process.env.FLO_E2E_DB_PATH) {
  throw new Error('Refusing to run with FLO_E2E_DB_PATH set: the test database would escape the temp directory');
}

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      ipcMain: {
        on: () => {},
        handle: (channel: string, handler: Function) => { ipcHandlers.set(channel, handler); },
        removeHandler: (channel: string) => { ipcHandlers.delete(channel); },
      },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true, filePath: '' }),
        showMessageBox: async () => ({ response: 0 }),
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'dpapi',
        encryptString: (value: string) => Buffer.from(`enc(${value})`, 'utf8'),
        decryptString: (buffer: Buffer) => buffer.toString('utf8').slice(4, -1),
      },
      shell: { openExternal: () => Promise.resolve() },
      BrowserWindow: class { static fromWebContents() { return null; } },
    };
  }
  return originalLoad.apply(this, arguments as never);
};

process.env.JWT_SECRET = 'test-secret-p34-postcommit';
delete process.env.GOOGLE_DRIVE_CLIENT_ID;
delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;

const request = require('supertest');
const RealDatabase = require('better-sqlite3');
const {
  initTestDb, seedOwnerUser, assert, assertEqual, getResults, closeDatabase,
  getDatabase, createApp, now,
} = require('./helpers/test-setup');
const { databaseRoutes } = require('../main/routes/database');
const { databaseToolsRoutes } = require('../main/routes/database-tools');
const { registerIpcHandlers } = require('../main/ipc');
const dbModule = require('../main/db');
const { googleDrive } = require('../main/services/google-drive');
const { setMasterPin } = require('../main/services/master-pin');
const { getCurrentSchemaVersion, getDbPath } = dbModule;

const PIN = '1234';
let SCHEMA_VERSION = 0;

function freshRead(sql: string, ...params: unknown[]): any {
  const fileCheck = new RealDatabase(getDbPath(), { readonly: true });
  try { return fileCheck.prepare(sql).get(...params); } finally { fileCheck.close(); }
}
function settingValue(key: string): string | undefined {
  return (freshRead('SELECT value FROM settings WHERE key = ?', key) as { value: string } | undefined)?.value;
}

/** Currency-reset payload that satisfies every guard on the route. */
function currencyResetPayload(target: string): Record<string, unknown> {
  return {
    currency: target,
    current_currency: settingValue('currency') || '',
    confirmation_phrase: `CHANGE TO ${target}`,
    master_pin: PIN,
  };
}
function importPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    overwrite: false,
    data: { version: 1, app: 'FloDesktop', schema_version: String(SCHEMA_VERSION), data: { settings: [], categories: [], products: [], users: [], ...extra } },
  };
}

async function run() {
  try {
    initTestDb();
    SCHEMA_VERSION = getCurrentSchemaVersion();
    const owner = seedOwnerUser(getDatabase());
    setMasterPin(PIN);
    registerIpcHandlers();
    const app = createApp({ '/api/database': databaseRoutes, '/api/db-tools': databaseToolsRoutes });
    assert(getDbPath().startsWith(testDir), 'setup: the test database lives inside the temp directory');

    // Route authorization reads the live users table, so an operation that wipes
    // and re-seeds the database removes the row the suite token points at and
    // every later request would be a 403 instead of a 200. The seeding id is
    // deterministic, so re-seeding keeps the same bearer token valid.
    function reseedOwner(): void {
      seedOwnerUser(getDatabase());
      setMasterPin(PIN);
    }

    const originalComplete = googleDrive.completeDatabaseRestore;
    const originalRelease = googleDrive.releaseDatabaseRestore;
    const originalPragma = RealDatabase.prototype.pragma;

    // ═══════════════════════════════════════════════════════════════════════
    // T1 — Import: exception in the `foreign_keys` restore inside `finally`
    //      AFTER a successful COMMIT must not become HTTP 500.
    // ═══════════════════════════════════════════════════════════════════════
    {
      let stringPragmaCalls = 0;
      RealDatabase.prototype.pragma = function patched(this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string' && /^foreign_keys =/.test(String(args[0]))) {
          stringPragmaCalls += 1;
          if (stringPragmaCalls === 2) {
            throw new Error('INJECTED: foreign_keys restore in finally threw after COMMIT');
          }
        }
        return (originalPragma as (...a: unknown[]) => unknown).apply(this, args);
      };
      try {
        getDatabase().prepare('DELETE FROM settings WHERE key = ?').run('p34_t1');
      reseedOwner();
      const r = await request(app).post('/api/database/import').set(owner.authHeader)
          .send(importPayload({ settings: [{ key: 'p34_t1', value: 'committed', updated_at: new Date().toISOString() }] }));
        assertEqual(r.status, 200, 'T1: a foreign_keys restore failure after COMMIT must NOT become HTTP 500');
        assertEqual(r.body?.success, true, 'T1: the committed import is reported as success');
        assertEqual((freshRead('SELECT COUNT(*) c FROM settings WHERE key = ?', 'p34_t1') as { c: number }).c, 1,
          'T1: the imported row is durable on disk (verified via a fresh connection)');
      } finally {
        RealDatabase.prototype.pragma = originalPragma;
        getDatabase().prepare('DELETE FROM settings WHERE key = ?').run('p34_t1');
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T2 — currency-reset: post-commit cleanup failure must not be a false
    //      "Currency reset failed" (the currency change has already committed).
    // ═══════════════════════════════════════════════════════════════════════
    reseedOwner();
    {
      const current = settingValue('currency') || '';
      const target = current === 'USD' ? 'EUR' : 'USD';
      googleDrive.completeDatabaseRestore = () => { throw new Error('INJECTED: post-commit cleanup failure'); };
      try {
        const r = await request(app).post('/api/db-tools/currency-reset').set(owner.authHeader).send(currencyResetPayload(target));
        assertEqual(r.status, 200, 'T2: a post-commit cleanup failure must not turn a committed currency reset into HTTP 500');
        assertEqual(r.body?.success, true, 'T2: the committed currency reset is reported as success');
        assertEqual(settingValue('currency'), target, 'T2: the currency change is really committed on disk');
        assertEqual(r.body?.cleanupPending, true, 'T2: cleanupPending is surfaced for the failed post-commit cleanup');
      } finally {
        googleDrive.completeDatabaseRestore = originalComplete;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T3 — database-tools `/initialize`: post-commit cleanup failure must not
    //      become a false "Initialize failed".
    // ═══════════════════════════════════════════════════════════════════════
    reseedOwner();
    {
      googleDrive.completeDatabaseRestore = () => { throw new Error('INJECTED: post-commit cleanup failure'); };
      try {
        const before = SCHEMA_VERSION;
        const r = await request(app).post('/api/db-tools/initialize').set(owner.authHeader)
          .send({ confirmation_phrase: 'INITIALIZE', master_pin: PIN });
        assertEqual(r.status, 200, 'T3: a post-commit cleanup failure must not turn a committed initialize into HTTP 500');
        assertEqual(r.body?.success, true, 'T3: the committed initialize is reported as success');
        assert(typeof r.body?.backupPath === 'string' && r.body.backupPath.length > 0, 'T3: the initialize response still carries backupPath');
        assertEqual(r.body?.cleanupPending, true, 'T3: cleanupPending is surfaced for the failed post-commit cleanup');
        assertEqual(getCurrentSchemaVersion() >= before, true, 'T3: the database is really re-initialized (schema present after the reset)');
      } finally {
        googleDrive.completeDatabaseRestore = originalComplete;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T4/T5 — IPC restore-backup, BOTH branches (version mismatch + normal):
    //         a post-commit cleanup failure must not become { success: false }.
    // ═══════════════════════════════════════════════════════════════════════
    async function restoreViaIpc(label: string, versionMismatch: boolean): Promise<any> {
      const { path: backupPath } = await dbModule.createBackup();
      const originalGetVersion = dbModule.getCurrentSchemaVersion;
      if (versionMismatch) dbModule.getCurrentSchemaVersion = () => SCHEMA_VERSION + 100;
      googleDrive.completeDatabaseRestore = () => { throw new Error('INJECTED: post-commit cleanup failure'); };
      try {
        const restore = ipcHandlers.get('restore-backup');
        assert(typeof restore === 'function', `${label}: restore-backup IPC handler is registered`);
        return await restore({ sender: { getURL: () => 'http://localhost:3001/' } }, PIN, backupPath);
      } finally {
        dbModule.getCurrentSchemaVersion = originalGetVersion;
        googleDrive.completeDatabaseRestore = originalComplete;
      }
    }
    {
      const mismatch = await restoreViaIpc('T4', true);
      assertEqual(mismatch?.success, true, 'T4: version-mismatch restore — a post-commit cleanup failure must not report success:false');
      assertEqual(mismatch?.cleanupPending, true, 'T4: version-mismatch restore — cleanupPending is surfaced');
      assert(typeof mismatch?.mode === 'string', 'T4: the restore result still reports its mode');
    }
    {
      const normal = await restoreViaIpc('T5', false);
      assertEqual(normal?.success, true, 'T5: normal restore — a post-commit cleanup failure must not report success:false');
      assertEqual(normal?.cleanupPending, true, 'T5: normal restore — cleanupPending is surfaced');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T6 — IPC db-initialize: post-commit cleanup failure must not become
    //      { success: false }.
    // ═══════════════════════════════════════════════════════════════════════
    {
      googleDrive.completeDatabaseRestore = () => { throw new Error('INJECTED: post-commit cleanup failure'); };
      try {
        const initialize = ipcHandlers.get('db-initialize');
        assert(typeof initialize === 'function', 'T6: db-initialize IPC handler is registered');
        const r = await initialize({ sender: { getURL: () => 'http://localhost:3001/' } }, { pin: PIN, confirmationPhrase: 'INITIALIZE' });
        assertEqual(r?.success, true, 'T6: a post-commit cleanup failure must not report success:false for a committed initialize');
        assertEqual(r?.cleanupPending, true, 'T6: cleanupPending is surfaced');
        assert(typeof r?.backupPath === 'string' && r.backupPath.length > 0, 'T6: the initialize result still carries backupPath');
      } finally {
        googleDrive.completeDatabaseRestore = originalComplete;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T7 — releaseDatabaseRestore() failure must not convert a committed
    //      success into a failure (nor a lost IPC return value).
    // ═══════════════════════════════════════════════════════════════════════
    reseedOwner();
    {
      googleDrive.releaseDatabaseRestore = () => { throw new Error('INJECTED: release failure'); };
      let threw: unknown = null;
      let r: any = null;
      try {
        const initialize = ipcHandlers.get('db-initialize');
        r = await initialize({ sender: { getURL: () => 'http://localhost:3001/' } }, { pin: PIN, confirmationPhrase: 'INITIALIZE' });
      } catch (error) { threw = error; } finally {
        googleDrive.releaseDatabaseRestore = originalRelease;
      }
      assertEqual(threw, null, 'T7: a release failure must not make the db-initialize IPC handler throw/reject');
      assertEqual(r?.success, true, 'T7: a release failure must not turn a committed initialize into success:false');
      assertEqual(r?.cleanupPending, false, 'T7: a release failure is not a cleanup failure (cleanupPending stays false)');
    }
    reseedOwner();
    {
      googleDrive.releaseDatabaseRestore = () => { throw new Error('INJECTED: release failure'); };
      let threw: unknown = null;
      let r: any = null;
      try {
        r = await request(app).post('/api/db-tools/initialize').set(owner.authHeader)
          .send({ confirmation_phrase: 'INITIALIZE', master_pin: PIN });
      } catch (error) { threw = error; } finally {
        googleDrive.releaseDatabaseRestore = originalRelease;
      }
      assertEqual(threw, null, 'T7: a release failure must not break the HTTP initialize request');
      assertEqual(r?.status, 200, 'T7: a release failure after the 200 must not corrupt the HTTP response');
      assertEqual(r?.body?.success, true, 'T7: the committed initialize is still reported as success');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T8 — a genuine PRE-commit failure must still fail correctly (guard
    //      against over-correction).
    // ═══════════════════════════════════════════════════════════════════════
    reseedOwner();
    {
      const before = settingValue('currency') || '';
      const target = before === 'USD' ? 'EUR' : 'USD';
      // Wrong current_currency → the operation is rejected BEFORE any commit.
      const r = await request(app).post('/api/db-tools/currency-reset').set(owner.authHeader)
        .send({ currency: target, current_currency: 'ZZZ', confirmation_phrase: `CHANGE TO ${target}`, master_pin: PIN });
      assert(r.status >= 400, 'T8: a pre-commit rejection still returns an error status');
      assertEqual(r.body?.success, undefined, 'T8: a pre-commit rejection does not report success');
      assertEqual(settingValue('currency') || '', before, 'T8: the currency is unchanged after a pre-commit rejection');
    }
    {
      const r = await request(app).post('/api/database/import').set(owner.authHeader)
        .send(importPayload({ settings: [{ key: 'business_name', value: 'clash', updated_at: new Date().toISOString() }] }));
      assertEqual(r.status, 500, 'T8: a conflicting import still fails with 500');
      assertEqual((freshRead('SELECT COUNT(*) c FROM settings WHERE key = ?', 'business_name') as { c: number }).c >= 1, true,
        'T8: the pre-existing row is intact (rolled back)');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T9 — normal success paths stay successful (no false cleanupPending).
    // ═══════════════════════════════════════════════════════════════════════
    {
      // Earlier sections re-initialized the database, so seed a currency first.
      getDatabase().prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('currency', 'USD', now());
      getDatabase().prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('country', 'US', now());
      const target = 'EUR';
      const r = await request(app).post('/api/db-tools/currency-reset').set(owner.authHeader).send(currencyResetPayload(target));
      assertEqual(r.status, 200, 'T9: a normal currency reset returns 200');
      assertEqual(r.body?.success, true, 'T9: a normal currency reset reports success');
      assertEqual(settingValue('currency'), target, 'T9: the currency change is committed');
      assertEqual(r.body?.cleanupPending, false, 'T9: no cleanup is pending on a clean success');
    }
    {
    reseedOwner();
      getDatabase().prepare('DELETE FROM settings WHERE key = ?').run('p34_t9');
      const r = await request(app).post('/api/database/import').set(owner.authHeader)
        .send(importPayload({ settings: [{ key: 'p34_t9', value: 'ok', updated_at: new Date().toISOString() }] }));
      assertEqual(r.status, 200, 'T9: a normal import returns 200');
      assertEqual(r.body?.success, true, 'T9: a normal import reports success');
      assertEqual(r.body?.cleanupPending, false, 'T9: no cleanup is pending on a clean import');
      getDatabase().prepare('DELETE FROM settings WHERE key = ?').run('p34_t9');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // T10 — cleanupPending contract: the field exists on every success path
    //       that supports it, and a real cleanup-pending result propagates.
    // ═══════════════════════════════════════════════════════════════════════
    reseedOwner();
    {
      googleDrive.completeDatabaseRestore = () => ({ committed: true, cleanupPending: true });
      try {
        const r = await request(app).post('/api/db-tools/initialize').set(owner.authHeader)
          .send({ confirmation_phrase: 'INITIALIZE', master_pin: PIN });
        assertEqual(r.status, 200, 'T10: initialize returns 200');
        assertEqual(r.body?.cleanupPending, true, 'T10: a genuine cleanup-pending result is propagated to the client');
      } finally {
        googleDrive.completeDatabaseRestore = originalComplete;
      }
    }

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} P-3.4 assertion(s) failed`);
    console.log('✅ P-3.4 post-commit failure hardening tests passed');
  } finally {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  console.error(error);
  process.exit(1);
});
