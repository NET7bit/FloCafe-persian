/**
 * P-3.1 — Characterization tests for Import/Restore atomicity.
 *
 * These tests RECORD the current behaviour of the existing implementation; they
 * do not change any production code. They are the executable evidence behind the
 * P-3 audit (C:/Users/CofeRoyal/FloCafe-persian-audit/p3-import-restore-atomicity-audit-2026-10-14.md).
 *
 * Invariants under test:
 *   AT-1  an import that fails after a successful row write leaves NO partial rows
 *         (the route wraps every DB write in BEGIN IMMEDIATE … COMMIT/ROLLBACK).
 *   AT-2  a successful import commits every expected row (verified by re-reading
 *         the database, never from the HTTP response alone).
 *   AT-3  a failed import leaves the live `cloud_api_key` envelope byte-identical
 *         AND rolls back a fresh row written earlier in the same payload
 *         (the failed-import rollback gap that T-11/T-12 do not cover).
 *   AT-4  a failed import never leaves an injected plaintext cloud key behind.
 *   AT-6  a genuine in-transaction foreign-key violation rolls the import back.
 *   AT-7  a restore with an invalid source reports failure and changes nothing.
 *
 * Isolation: the electron `app` mock reports isPackaged:true and getPath() ->
 * a mkdtemp directory, so getDbPath() resolves inside the temp dir and the real
 * install database is never opened. The only network target is none — these
 * tests use supertest against the in-process Express app, no external calls.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-p31-atomic-'));

// Pin the JWT secret before the auth module is first used (see the shared test
// harness: createApp sets process.env.JWT_SECRET only when it is absent, while
// the secret is generated and cached during initTestDb()).
const ORIGINAL_JWT_SECRET_ENV = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-import-restore-atomicity';

// The isolated test database must stay inside the temp directory.
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
const { getCurrentSchemaVersion, getDbPath, restoreBackup } = require('../main/db');
const { decryptSecret, isEncryptedSettingValue } = require('../main/services/secure-settings');
const { cloudSync } = require('../main/services/cloud-sync');

const CLOUD_KEY = 'cloud_api_key';
const PROBE_A = 'p31_probe_a';
const PROBE_B1 = 'p31_probe_b1';
const PROBE_B2 = 'p31_probe_b2';
const PROBE_FK = 'p31_probe_fk';
const PROBE_AT3 = 'p31_probe_at3';
const IMPORTED_KEY = 'p31-injected-plaintext-key';
const LIVE_SECRET = 'p31-live-install-secret';

function settingValue(key: string): string | undefined {
  const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function settingRowCount(key: string): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM settings WHERE key = ?').get(key) as { c: number }).c;
}

function allSettingValues(): string[] {
  return (getDatabase().prepare('SELECT value FROM settings').all() as { value: string }[]).map((row) => String(row.value));
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

/** Runs an import while capturing console output so the failure reason can be asserted without printing it. */
async function postImport(app: unknown, authHeader: Record<string, string>, payload: unknown) {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  try {
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    const response = await request(app).post('/api/database/import').set(authHeader).send(payload);
    return { response, logs };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function run() {
  try {
    initTestDb();
    const owner = seedOwnerUser(getDatabase());
    const app = createApp({ '/api/database': databaseRoutes });

  console.log('P-3.1 Import/Restore atomicity characterization tests');
  console.log('='.repeat(60));
  assert(getDbPath().startsWith(testDir), 'setup: the test database lives inside the temp directory');

  const businessBefore = settingValue('business_name');
  assert(typeof businessBefore === 'string', 'setup: business_name exists in the seeded database');

  // ── AT-1 control: the same fixture WITHOUT the conflicting row succeeds ──
  // Proves the probe row is insertable and the import loop really reaches it,
  // so the failure in AT-1b can only come from the second row.
  deleteSettings(PROBE_A);
  const control = await postImport(app, owner.authHeader, importPayload({ settings: [importRow(PROBE_A, 'control-value')] }));
  assertEqual(control.response.status, 200, 'AT-1 control: the import without a conflict succeeds');
  assertEqual(control.response.body?.success, true, 'AT-1 control: the import reports success');
  assertEqual(settingValue(PROBE_A), 'control-value', 'AT-1 control: the probe row was really written (fixture is insertable)');
  deleteSettings(PROBE_A);

  // ── AT-1: failure on the second row must roll back the first row ────────
  const failing = await postImport(app, owner.authHeader, importPayload({
    settings: [
      importRow(PROBE_A, 'must-be-rolled-back'),
      importRow('business_name', 'clashing-value'),
    ],
  }));
  assertEqual(failing.response.status, 500, 'AT-1: a mid-import constraint failure returns the route error contract (500)');
  assert(failing.response.body?.success !== true, 'AT-1: the failed import never reports success');
  assert(
    failing.logs.some((line) => line.includes('UNIQUE constraint failed: settings.key')),
    'AT-1: the failure really came from the duplicate settings key (second row), not from pre-loop validation',
  );
  assertEqual(settingRowCount(PROBE_A), 0, 'AT-1: the row written before the failure was rolled back');
  assertEqual(settingValue('business_name'), businessBefore, 'AT-1: the pre-existing row kept its original value');
  assertEqual(settingRowCount('business_name'), 1, 'AT-1: no duplicate/partial row was left behind');
  assert(typeof settingValue('business_name') === 'string', 'AT-1: the database is still queryable after the failure');
  assert(!allSettingValues().some((value) => value.includes('must-be-rolled-back')), 'AT-1: the rolled-back value appears nowhere in settings');

  // ── AT-2: a successful import commits every expected row ────────────────
  deleteSettings(PROBE_B1, PROBE_B2);
  const success = await postImport(app, owner.authHeader, importPayload({
    settings: [importRow(PROBE_B1, 'committed-b1'), importRow(PROBE_B2, 'committed-b2')],
  }));
  assertEqual(success.response.status, 200, 'AT-2: the valid import returns 200');
  assertEqual(success.response.body?.success, true, 'AT-2: the valid import reports success');
  assertEqual(settingRowCount(PROBE_B1), 1, 'AT-2: the first expected row exists (re-read from the database)');
  assertEqual(settingRowCount(PROBE_B2), 1, 'AT-2: the second expected row exists (re-read from the database)');
  assertEqual(settingValue(PROBE_B1), 'committed-b1', 'AT-2: the first committed value matches the payload');
  assertEqual(settingValue(PROBE_B2), 'committed-b2', 'AT-2: the second committed value matches the payload');
  assertEqual(success.response.body?.placeholderUsersCreated, 0, 'AT-2: the import response reports no placeholder users for this payload');

  // ── AT-3: a failed import preserves the live cloud key envelope ─────────
  // The first row of the payload is a fresh, writable row, so the transaction
  // really does write something before the live cloud key row collides and the
  // import aborts — making the rollback observable, not just the preservation.
  setSettings({ [CLOUD_KEY]: LIVE_SECRET });
  cloudSync.reload();
  const liveCell = settingValue(CLOUD_KEY) ?? '';
  assert(isEncryptedSettingValue(liveCell), 'AT-3: the live cloud key is stored as a flosec1 envelope before the failing import');
  deleteSettings(PROBE_AT3);
  const failingWithKey = await postImport(app, owner.authHeader, importPayload({
    settings: [
      importRow(PROBE_AT3, 'at3-must-be-rolled-back'),
      importRow(CLOUD_KEY, IMPORTED_KEY),
      importRow('business_name', 'clashing-value-2'),
    ],
  }));
  assertEqual(failingWithKey.response.status, 500, 'AT-3: the failing import returns the route error contract');
  assertEqual(settingRowCount(PROBE_AT3), 0, 'AT-3: the row written before the key collision was rolled back');
  assert(settingValue(CLOUD_KEY) === liveCell, 'AT-3: the live envelope is preserved byte-for-byte after the rollback');
  assert(decryptSecret(settingValue(CLOUD_KEY) ?? '') === LIVE_SECRET, 'AT-3: the live key still decrypts to the live secret');
  assert(!(settingValue(CLOUD_KEY) ?? '').includes(LIVE_SECRET), 'AT-3: the live secret is never stored in plaintext');
  assert(!allSettingValues().some((value) => value.includes(IMPORTED_KEY)), 'AT-3: the injected value was rolled back with the transaction');
  assert(!allSettingValues().some((value) => value.includes('at3-must-be-rolled-back')), 'AT-3: the pre-collision value appears nowhere in settings');

  // ── AT-4: a failed import leaves no injected key when none existed ──────
  deleteSettings(CLOUD_KEY);
  assertEqual(settingRowCount(CLOUD_KEY), 0, 'AT-4: no cloud key row exists before the failing import');
  const failingNoKey = await postImport(app, owner.authHeader, importPayload({
    settings: [
      importRow(CLOUD_KEY, IMPORTED_KEY),
      importRow('business_name', 'clashing-value-3'),
    ],
  }));
  assertEqual(failingNoKey.response.status, 500, 'AT-4: the failing import returns the route error contract');
  assertEqual(settingRowCount(CLOUD_KEY), 0, 'AT-4: the injected key row was rolled back');
  assert(!allSettingValues().some((value) => value.includes(IMPORTED_KEY)), 'AT-4: the injected value appears nowhere in settings');
  assertEqual(cloudSync.getStatus().cloud_api_key_state, 'empty', 'AT-4: the cloud key state stays empty');

  // ── AT-6: a real in-transaction foreign-key violation rolls back ────────
  // supply_movements.supply_id references supplies(id); the row passes the
  // route's pre-transaction validation (FK enforcement is disabled during the
  // import) and is only rejected by the in-transaction FK check.
  deleteSettings(PROBE_FK);
  const fkViolation = await postImport(app, owner.authHeader, importPayload({
    settings: [importRow(PROBE_FK, 'must-be-rolled-back-fk')],
    supply_movements: [{
      id: 990001,
      supply_id: 'p31-missing-supply',
      quantity_delta: 1,
      movement_type: 'adjustment',
      unit: 'each',
      stock_after: 1,
      actor_user_id: owner.userId,
      created_at: new Date().toISOString(),
    }],
  }));
  assertEqual(fkViolation.response.status, 500, 'AT-6: the FK-violating import returns the route error contract');
  assert(
    fkViolation.logs.some((line) => line.includes('foreign-key violation')),
    'AT-6: the failure really came from the in-transaction foreign-key check',
  );
  assertEqual(settingRowCount(PROBE_FK), 0, 'AT-6: the settings row written before the FK failure was rolled back');
  assertEqual(settingRowCount('supply_movements'), 0, 'AT-6: the FK-violating row was not committed');
  // Confirm the rollback in the database FILE, not only through the in-process
  // handle: a fresh read-only connection must not see the row either.
  {
    const RealDatabase = require('better-sqlite3');
    const fileCheck = new RealDatabase(getDbPath(), { readonly: true });
    try {
      const onDisk = (fileCheck.prepare('SELECT COUNT(*) c FROM supply_movements').get() as { c: number }).c;
      assertEqual(onDisk, 0, 'AT-6: a fresh connection to the database file also sees no FK-violating row');
    } finally {
      fileCheck.close();
    }
  }
  assertEqual(settingValue('business_name'), businessBefore, 'AT-6: pre-existing data is unchanged after the rollback');

  // ── AT-7: an invalid restore source reports failure and changes nothing ─
  const schemaBefore = getCurrentSchemaVersion();
  const restoreResult = restoreBackup(path.join(testDir, 'does-not-exist.db'), false);
  assert(restoreResult.success === false, 'AT-7: restoring a missing source reports failure');
  assert(typeof restoreResult.error === 'string' && restoreResult.error.length > 0, 'AT-7: the failure carries an error description');
  assertEqual(getCurrentSchemaVersion(), schemaBefore, 'AT-7: the schema version is unchanged');
  assertEqual(settingValue('business_name'), businessBefore, 'AT-7: live data is unchanged');
  assert(typeof settingValue('business_name') === 'string', 'AT-7: the database is still queryable');

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} P-3.1 assertions failed`);
    console.log('✅ P-3.1 Import/Restore atomicity characterization tests passed');
  } finally {
    try { cloudSync.stop(); } catch { }
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
