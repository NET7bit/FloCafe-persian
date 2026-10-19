/**
 * P-3.8B — focused tests for the limited FK-recovery hardening (P-3.7.3 Option B scope).
 *
 * Covers: non-throwing FK recovery helper, discriminated health state
 * (integrity vs foreignKeys), startup/open read-back verification, health
 * component independence, commit-invariant preservation on the import path,
 * and the /api/health wiring.
 *
 * Isolation: same mkdtemp + mock-electron harness as the P-3.3/P-3.4 tests so
 * the real install database is never touched. better-sqlite3 is wrapped by a
 * flag-controlled subclass so exceptional SQLite states (failing integrity
 * check, failing FK read-back) can be simulated deterministically.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-p38b-fk-'));

const ORIGINAL_JWT_SECRET_ENV = process.env.JWT_SECRET;
process.env.JWT_SECRET = 'test-secret-p38b';

if (process.env.FLO_E2E_DB_PATH) {
  throw new Error('Refusing to run with FLO_E2E_DB_PATH set: the test database would escape the temp directory');
}

// Capture the real better-sqlite3 constructor BEFORE installing the interception
// so the flag-controlled subclass can delegate to it.
const RealDatabase = require('better-sqlite3');

// Flags toggled by individual tests to simulate exceptional SQLite states.
// Both default to false (pure pass-through behavior).
let failIntegrityCheck = false;
let failFkReadback = false;

class PatchedDatabase extends RealDatabase {
  prepare(source: any): any {
    if (failIntegrityCheck && source === 'PRAGMA integrity_check') {
      return { all: () => [{ integrity_check: 'corrupt page 7 (simulated)' }] };
    }
    return super.prepare(source);
  }
  pragma(source: any, options?: any): any {
    if (failFkReadback && typeof source === 'string' && /foreign_keys/i.test(source)) {
      // Writes silently "succeed"; every read reports OFF.
      return source.trim().replace(/\s+/g, '') === 'foreign_keys=ON' ? undefined : 0;
    }
    return super.pragma(source, options);
  }
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
  if (request === 'better-sqlite3') return PatchedDatabase;
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
const { getCurrentSchemaVersion, getDbPath, getDbHealth, recoverForeignKeyEnforcement } = require('../main/db');
const { googleDrive } = require('../main/services/google-drive');

const PROBE_T13 = 'p38b_t13';
const PROBE_T14 = 'p38b_t14';

function settingRowCount(key: string): number {
  return (getDatabase().prepare('SELECT COUNT(*) c FROM settings WHERE key = ?').get(key) as { c: number }).c;
}
function deleteSettings(...keys: string[]): void {
  const stmt = getDatabase().prepare('DELETE FROM settings WHERE key = ?');
  for (const key of keys) stmt.run(key);
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
function diskSettingsRowCount(key: string): number {
  const fileCheck = new RealDatabase(getDbPath(), { readonly: true });
  try {
    return (fileCheck.prepare('SELECT COUNT(*) c FROM settings WHERE key = ?').get(key) as { c: number }).c;
  } finally {
    fileCheck.close();
  }
}

const isFkWrite = (source: any): boolean =>
  typeof source === 'string' && /foreign_keys/i.test(source)
  && source.trim().replace(/\s+/g, '') === 'foreign_keys=ON';
const isFkPragma = (source: any): boolean =>
  typeof source === 'string' && /foreign_keys/i.test(source);

/** Installs a pragma interceptor on the live handle; returns a restore function. */
function interceptPragma(
  handler: (source: any, options: any, original: (source: any, options: any) => any) => any,
): () => void {
  const db = getDatabase() as any;
  const originalPragma = db.pragma.bind(db);
  db.pragma = (source: any, options?: any) => handler(source, options, originalPragma);
  return () => { db.pragma = originalPragma; };
}

async function run() {
  try {
    initTestDb();
    const owner = seedOwnerUser(getDatabase());
    const app = createApp({ '/api/database': databaseRoutes });
    assert(getDbPath().startsWith(testDir), 'setup: the test database lives inside the temp directory');

    // ── T1: FK already ON → read-back confirms healthy ──────────────────────
    {
      const health = getDbHealth();
      assertEqual(health.ok, true, 'T1: a fresh open with verified FK reports healthy');
      assertEqual(health.foreignKeys, 'ok', 'T1: FK component is ok after the startup read-back');
      assertEqual(health.error, undefined, 'T1: no error message on a healthy database');
    }

    // ── T2: FK OFF → recovery succeeds with exactly ONE re-enable attempt ───
    {
      const db = getDatabase() as any;
      const originalPragma = db.pragma.bind(db);
      let fkWriteAttempts = 0;
      db.pragma = (source: any, options?: any) => {
        if (isFkWrite(source)) fkWriteAttempts += 1;
        return originalPragma(source, options);
      };
      try {
        originalPragma('foreign_keys = OFF');
        assertEqual(Number(originalPragma('foreign_keys', { simple: true })), 0, 'T2: setup — FK really is OFF');
        recoverForeignKeyEnforcement();
        assertEqual(getDbHealth().foreignKeys, 'ok', 'T2: recovery re-enables FK and records ok');
        assertEqual(fkWriteAttempts, 1, 'T2: exactly one immediate re-enable attempt');
        assertEqual(Number(originalPragma('foreign_keys', { simple: true })), 1, 'T2: FK is really ON after recovery');
      } finally {
        db.pragma = originalPragma;
      }
    }

    // ── T3: re-enable does not throw but read-back is still OFF → degraded ──
    {
      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) return isFkWrite(source) ? undefined : 0;
        return original(source, options);
      });
      try {
        recoverForeignKeyEnforcement();
        assertEqual(getDbHealth().foreignKeys, 'error', 'T3: read-back still 0 after re-enable records error');
        assertEqual(getDbHealth().ok, false, 'T3: degraded FK health reports unhealthy');
      } finally {
        restore();
      }
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T3: cleanup — real read-back confirms ok after restoring pragma');
    }

    // ── T4: closed connection (open === false branch) ───────────────────────
    {
      // Close the handle directly (bypassing closeDatabase, which would null
      // the singleton): getDatabase() still returns the handle, but its `open`
      // flag is false — exactly the closed-connection branch of the helper.
      const db = getDatabase() as any;
      db.close();
      let threw = false;
      try {
        recoverForeignKeyEnforcement();
      } catch {
        threw = true;
      }
      assertEqual(threw, false, 'T4: helper does not throw on a closed connection');
      assertEqual(getDbHealth().foreignKeys, 'unknown', 'T4: closed connection records unknown');
      initTestDb(); // re-open the singleton (assigns a fresh handle)
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T4: cleanup — reopen verifies FK ok');
    }

    // ── T5: getDatabase() throws (singleton closed) ─────────────────────────
    {
      closeDatabase();
      let threw = false;
      try {
        recoverForeignKeyEnforcement();
      } catch {
        threw = true;
      }
      assertEqual(threw, false, 'T5: helper does not throw when getDatabase() throws');
      assertEqual(getDbHealth().foreignKeys, 'unknown', 'T5: getDatabase() failure records unknown in the health state');
      initTestDb();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T5: cleanup — reopen verifies FK ok');
    }

    // ── T6: initial read-back throws ────────────────────────────────────────
    {
      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) throw new Error('simulated read failure');
        return original(source, options);
      });
      let threw = false;
      try {
        recoverForeignKeyEnforcement();
      } catch {
        threw = true;
      }
      assertEqual(threw, false, 'T6: helper does not throw when the initial read-back throws');
      assertEqual(getDbHealth().foreignKeys, 'unknown', 'T6: initial read-back failure records unknown');
      restore();
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T6: cleanup — real read-back confirms ok');
    }

    // ── T7: re-enable attempt throws ────────────────────────────────────────
    {
      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) {
          if (isFkWrite(source)) throw new Error('simulated re-enable failure');
          return 0;
        }
        return original(source, options);
      });
      let threw = false;
      try {
        recoverForeignKeyEnforcement();
      } catch {
        threw = true;
      }
      assertEqual(threw, false, 'T7: helper does not throw when the re-enable attempt throws');
      assertEqual(getDbHealth().foreignKeys, 'unknown', 'T7: re-enable failure records unknown');
      restore();
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T7: cleanup — real read-back confirms ok');
    }

    // ── T8: verification read-back throws ───────────────────────────────────
    {
      let fkCalls = 0;
      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) {
          fkCalls += 1;
          if (fkCalls === 1) return 0;         // initial read: OFF
          if (fkCalls === 2) return undefined; // re-enable write: silent
          throw new Error('simulated verification read failure');
        }
        return original(source, options);
      });
      let threw = false;
      try {
        recoverForeignKeyEnforcement();
      } catch {
        threw = true;
      }
      assertEqual(threw, false, 'T8: helper does not throw when the verification read-back throws');
      assertEqual(getDbHealth().foreignKeys, 'unknown', 'T8: verification read-back failure records unknown');
      restore();
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T8: cleanup — real read-back confirms ok');
    }

    // ── T9: integrity error remains after successful FK recovery ────────────
    {
      failIntegrityCheck = true;
      failFkReadback = true;
      closeDatabase();
      initTestDb();
      const setupHealth = getDbHealth();
      assertEqual(setupHealth.foreignKeys, 'error', 'T9: setup — FK read-back failure recorded at open');
      assert(setupHealth.ok === false && typeof setupHealth.error === 'string', 'T9: setup — integrity failure recorded');
      failFkReadback = false;
      recoverForeignKeyEnforcement();
      const afterRecovery = getDbHealth();
      assertEqual(afterRecovery.foreignKeys, 'ok', 'T9: FK recovery succeeds');
      assertEqual(afterRecovery.ok, false, 'T9: health is still unhealthy while integrity is broken');
      assertEqual(afterRecovery.error, 'Database integrity error: corrupt page 7 (simulated)', 'T9: integrity error survives FK recovery');
      failIntegrityCheck = false;
    }

    // ── T10: FK uncertainty remains after successful integrity verification ──
    {
      failFkReadback = true;
      failIntegrityCheck = false;
      closeDatabase();
      initTestDb();
      const health = getDbHealth();
      assertEqual(health.foreignKeys, 'error', 'T10: FK uncertainty recorded despite a successful integrity check');
      assertEqual(health.ok, false, 'T10: health is unhealthy while FK is uncertain');
      assertEqual(health.error, 'Foreign-key enforcement is not active on the database connection', 'T10: FK error message surfaces');
      failFkReadback = false;
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T10: cleanup — FK recovers to ok');
    }

    // ── T11: opening does not clear FK state before read-back verification ───
    {
      failFkReadback = true;
      closeDatabase();
      initTestDb();
      // The open sequence's `foreign_keys = ON` statement "succeeded" silently
      // (simulated), but without a confirming read-back the state must not be ok.
      assertEqual(getDbHealth().foreignKeys, 'error', 'T11: open does not mark FK healthy without read-back verification');
      failFkReadback = false;
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T11: cleanup — verified read-back marks ok');
    }

    // ── T12: successful open/read-back clears only FK uncertainty ───────────
    {
      // (a) integrity error + FK error present simultaneously
      failIntegrityCheck = true;
      failFkReadback = true;
      closeDatabase();
      initTestDb();
      const setupA = getDbHealth();
      assertEqual(setupA.foreignKeys, 'error', 'T12a: setup — FK error present');
      assert(
        setupA.ok === false
          && typeof setupA.error === 'string'
          && setupA.error.startsWith('Database integrity error'),
        'T12a: setup — integrity error present',
      );
      // (b) successful FK recovery must not clear the integrity error
      failFkReadback = false;
      recoverForeignKeyEnforcement();
      const afterB = getDbHealth();
      assertEqual(afterB.foreignKeys, 'ok', 'T12b: FK recovery succeeds');
      assertEqual(afterB.error, 'Database integrity error: corrupt page 7 (simulated)', 'T12b: FK recovery does not clear the integrity error');
      // (c) successful open (integrity passes, FK read-back passes) clears both
      failIntegrityCheck = false;
      closeDatabase();
      initTestDb();
      const afterC = getDbHealth();
      assertEqual(afterC.ok, true, 'T12c: successful open reports healthy');
      assertEqual(afterC.foreignKeys, 'ok', 'T12c: FK uncertainty cleared by a successful read-back');
      assertEqual(afterC.error, undefined, 'T12c: integrity error cleared by a successful integrity check');
      failIntegrityCheck = false;
      failFkReadback = false;
    }

    // ── T13: post-commit recovery failure keeps a committed import successful ─
    {
      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) return isFkWrite(source) ? undefined : 0;
        return original(source, options);
      });
      try {
        deleteSettings(PROBE_T13);
        const res = await postImport(app, owner.authHeader, importPayload({ settings: [importRow(PROBE_T13, 'committed-t13')] }));
        assertEqual(res.response.status, 200, 'T13: a committed import still returns 200 when FK recovery fails');
        assertEqual(res.response.body?.success, true, 'T13: the committed import still reports success');
        assertEqual(settingRowCount(PROBE_T13), 1, 'T13: the imported row is really committed');
        assertEqual(diskSettingsRowCount(PROBE_T13), 1, 'T13: a fresh connection to the DB file also sees the committed row');
        assertEqual(getDbHealth().foreignKeys, 'error', 'T13: FK degradation is recorded without affecting the commit outcome');
        deleteSettings(PROBE_T13);
      } finally {
        restore();
        recoverForeignKeyEnforcement();
        assertEqual(getDbHealth().foreignKeys, 'ok', 'T13: cleanup — FK recovers to ok after restoring pragma');
      }
    }

    // ── T14: pre-commit transaction failure retains existing semantics ───────
    {
      let completeCalls = 0;
      const originalComplete = googleDrive.completeDatabaseRestore;
      googleDrive.completeDatabaseRestore = (...args: unknown[]) => {
        completeCalls += 1;
        return originalComplete.apply(googleDrive, args as never);
      };
      try {
        deleteSettings(PROBE_T14);
        const failing = await postImport(app, owner.authHeader, importPayload({
          settings: [importRow(PROBE_T14, 'must-rollback')],
          supply_movements: [{
            id: 990002,
            supply_id: 'p38b-missing-supply',
            quantity_delta: 1,
            movement_type: 'adjustment',
            unit: 'each',
            stock_after: 1,
            actor_user_id: owner.userId,
            created_at: new Date().toISOString(),
          }],
        }));
        assertEqual(failing.response.status, 500, 'T14: an import that would introduce an FK violation keeps the existing 500 contract');
        assertEqual(settingRowCount(PROBE_T14), 0, 'T14: the pre-commit failure rolled back the imported row');
        assertEqual(completeCalls, 0, 'T14: post-commit cleanup is never invoked on a pre-commit failure');
        assertEqual(getDbHealth().foreignKeys, 'ok', 'T14: FK recovery still verified after the failed import');
      } finally {
        googleDrive.completeDatabaseRestore = originalComplete;
        deleteSettings(PROBE_T14);
      }
    }

    // ── T15: logging failure does not escape the helper ──────────────────────
    {
      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) throw new Error('simulated failure');
        return original(source, options);
      });
      const originalConsoleError = console.error;
      console.error = () => { throw new Error('logging itself is broken'); };
      let threw = false;
      try {
        recoverForeignKeyEnforcement();
      } catch {
        threw = true;
      } finally {
        console.error = originalConsoleError;
        restore();
      }
      assertEqual(threw, false, 'T15: a throwing console.error cannot escape the helper');
      assertEqual(getDbHealth().foreignKeys, 'unknown', 'T15: failure state is still recorded when logging throws');
      recoverForeignKeyEnforcement();
      assertEqual(getDbHealth().foreignKeys, 'ok', 'T15: cleanup — FK recovers to ok');
    }

    // ── T16: no timed retry, BusyWait, sleep, or recovery loop ───────────────
    {
      const source = fs.readFileSync(path.join(__dirname, '..', 'main', 'db.ts'), 'utf8');
      const start = source.indexOf('export function recoverForeignKeyEnforcement');
      assert(start >= 0, 'T16: the recovery helper exists in main/db.ts');
      const nextExport = source.indexOf('\nexport function', start + 10);
      const helperSource = source.slice(start, nextExport === -1 ? undefined : nextExport);
      const banned = ['setTimeout', 'setInterval', 'await', 'while (', 'for (', 'sleep', 'Promise'];
      const found = banned.filter((token) => helperSource.includes(token));
      assertEqual(found.length, 0, `T16: helper contains no retry/wait constructs (found: ${found.join(', ') || 'none'})`);
    }

    // ── T17: HTTP health response exposes the FK component and degraded status ─
    {
      const healthy = getDbHealth();
      assertEqual(healthy.ok, true, 'T17: healthy FK reports ok');
      assertEqual(healthy.foreignKeys, 'ok', 'T17: FK component exposed as ok');

      const restore = interceptPragma((source, options, original) => {
        if (isFkPragma(source)) return 0;
        return original(source, options);
      });
      try {
        recoverForeignKeyEnforcement();
        const degraded = getDbHealth();
        assertEqual(degraded.ok, false, 'T17: degraded FK health reports unhealthy (503 semantics)');
        assertEqual(degraded.foreignKeys, 'error', 'T17: FK component exposed as error');
        assert(typeof degraded.error === 'string' && degraded.error.length > 0, 'T17: degraded health carries an error message');
      } finally {
        restore();
        recoverForeignKeyEnforcement();
      }

      const serverSource = fs.readFileSync(path.join(__dirname, '..', 'main', 'server.ts'), 'utf8');
      const healthIdx = serverSource.indexOf("app.get('/api/health'");
      assert(healthIdx >= 0, 'T17: the /api/health handler exists in server.ts');
      const healthHandler = serverSource.slice(healthIdx, healthIdx + 700);
      assert(healthHandler.includes('foreignKeys'), 'T17: the /api/health response includes the foreignKeys component');
      assert(healthHandler.includes('db.ok ? 200 : 503'), 'T17: the health status semantics are preserved');
    }

    // ── T18: real HTTP /api/health returns 503 with the FK component when degraded ──
    // Closes P-3.8C F02: drives the REAL endpoint over REAL HTTP on an
    // ephemeral port (PORT=0), with FK state degraded through the real
    // recoverForeignKeyEnforcement() helper — no response mocking.
    {
      const { startServer, stopServer, getServerPort } = require('../main/server');
      const originalPort = process.env.PORT;
      process.env.PORT = '0'; // ephemeral port — never the shared 3001
      await startServer();
      const baseUrl = `http://127.0.0.1:${getServerPort()}`;
      try {
        // Healthy baseline through the real endpoint.
        const healthyRes = await fetch(`${baseUrl}/api/health`);
        const healthyBody = (await healthyRes.json()) as any;
        assertEqual(healthyRes.status, 200, 'T18: healthy FK → real HTTP 200 from /api/health');
        assertEqual(healthyBody.foreignKeys, 'ok', 'T18: healthy response body exposes foreignKeys ok');

        // Scenario 1: foreignKeys = 'error' — re-enable attempted, read-back still 0.
        const restoreError = interceptPragma((source, options, original) => {
          if (isFkPragma(source)) return isFkWrite(source) ? undefined : 0;
          return original(source, options);
        });
        try {
          recoverForeignKeyEnforcement();
          const res = await fetch(`${baseUrl}/api/health`);
          const body = (await res.json()) as any;
          assertEqual(res.status, 503, 'T18: FK error → real HTTP 503 from /api/health');
          assertEqual(body.foreignKeys, 'error', 'T18: error response body exposes foreignKeys error');
          assertEqual(body.status, 'error', 'T18: error response keeps the status contract');
          assertEqual(body.service, 'Flo Local API', 'T18: error response keeps the service field');
          assert(typeof body.db === 'string' && body.db.length > 0, 'T18: error response carries an error message in db');
        } finally {
          restoreError();
          recoverForeignKeyEnforcement();
        }

        // Scenario 2: foreignKeys = 'unknown' — the recovery path itself throws.
        const restoreUnknown = interceptPragma((source, options, original) => {
          if (isFkPragma(source)) throw new Error('simulated failure');
          return original(source, options);
        });
        try {
          recoverForeignKeyEnforcement();
          const res = await fetch(`${baseUrl}/api/health`);
          const body = (await res.json()) as any;
          assertEqual(res.status, 503, 'T18: FK unknown → real HTTP 503 from /api/health');
          assertEqual(body.foreignKeys, 'unknown', 'T18: unknown response body exposes foreignKeys unknown');
          assertEqual(body.status, 'error', 'T18: unknown response keeps the status contract');
        } finally {
          restoreUnknown();
          recoverForeignKeyEnforcement();
        }

        // After recovery the endpoint is healthy again.
        const restoredRes = await fetch(`${baseUrl}/api/health`);
        assertEqual(restoredRes.status, 200, 'T18: recovered FK → real HTTP 200 again');
      } finally {
        await stopServer();
        if (originalPort === undefined) delete process.env.PORT;
        else process.env.PORT = originalPort;
      }
    }

    const results = getResults();
    if (results.failed > 0) throw new Error(`${results.failed} P-3.8B assertions failed`);
    console.log(`✅ P-3.8B FK recovery hardening tests passed (${results.passed}/${results.total} assertions)`);
  } finally {
    failIntegrityCheck = false;
    failFkReadback = false;
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
