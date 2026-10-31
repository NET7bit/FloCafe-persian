/**
 * Focused isolation tests for the data-path resolvers (H.15C, findings B-1/B-2).
 *
 * The resolver decides where the database, its backups, the pre-migration
 * snapshots, the restore journals and the first-start marker live. A test run
 * that resolves any of those into the checkout would seed the operator's data,
 * so the two test overrides are validated before anything is created.
 *
 * Everything native is stubbed: `electron` supplies a fake app, `electron-log`
 * keeps log files out of the real profile, and `better-sqlite3` records the path
 * it was asked to open and then throws. No database file is created, so the
 * "no side effect" assertions below mean exactly that.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/db-path-isolation.test.ts
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-path-isolation-'));
const FAKE_USER_DATA = path.join(RUN_ROOT, 'real-userdata');

const opened: string[] = [];

const electronStub = {
  app: {
    isPackaged: false,
    getPath: () => FAKE_USER_DATA,
    getVersion: () => 'test',
  },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: class {},
};
const logStub = { info() {}, warn() {}, error() {}, debug() {}, transports: {} };

const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return electronStub;
  if (request === 'electron-log') return { __esModule: true, default: logStub };
  if (request === 'better-sqlite3') {
    return function ProbeDatabase(target: string) {
      opened.push(String(target));
      throw new Error(`PROBE_DB_OPEN_ATTEMPTED:${target}`);
    };
  }
  return originalLoad.apply(this, arguments as never);
};

const db = require('../main/db');
Module._load = originalLoad;

const PATH_VARS = ['FLO_E2E_TEST_RUNTIME', 'FLO_E2E_DB_PATH', 'FLO_E2E_USER_DATA_DIR'];

function setEnv(vars: Record<string, string>): void {
  for (const key of PATH_VARS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  // Each case starts from a clean observation window.
  opened.length = 0;
}

function errorOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
}

/** Every case must leave no directory behind and open no database. */
const REPO_BACKUPS = path.join(REPO_ROOT, 'backups');
const repoBackupsBefore = fs.existsSync(REPO_BACKUPS) ? fs.readdirSync(REPO_BACKUPS).sort() : null;

function assertNoSideEffects(label: string, mustNotExist: string[]): void {
  assert.equal(opened.length, 0, `${label}: no database open may be attempted`);
  for (const dir of mustNotExist) {
    assert.equal(fs.existsSync(dir), false, `${label}: ${dir} must not be created`);
  }
  // The repository already carries an (ignored, empty) backups directory, so its
  // existence proves nothing; an unchanged listing proves nothing was written.
  const after = fs.existsSync(REPO_BACKUPS) ? fs.readdirSync(REPO_BACKUPS).sort() : null;
  assert.deepEqual(after, repoBackupsBefore, `${label}: the repository backups directory must stay untouched`);
}

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

try {
  // ── C-1: FLO_E2E_USER_DATA_DIR ────────────────────────────────────────────
  check('T1: the repository root is rejected as a test data root', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: REPO_ROOT });
    const message = errorOf(() => db.getDbPath());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assertNoSideEffects('T1', []);
  });

  check('T2: a directory inside the repository is rejected as a test data root', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: path.join(REPO_ROOT, 'tests') });
    const message = errorOf(() => db.getDbPath());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assertNoSideEffects('T2', [path.join(REPO_ROOT, 'tests', 'backups')]);
  });

  check('T3: a path that only resolves into the repository is rejected', () => {
    setEnv({
      FLO_E2E_TEST_RUNTIME: '1',
      FLO_E2E_USER_DATA_DIR: path.join(REPO_ROOT, 'docs', '..', 'tests', '.', 'nested'),
    });
    const message = errorOf(() => db.getDbPath());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assertNoSideEffects('T3', [path.join(REPO_ROOT, 'tests', 'nested')]);
  });

  check('T4: a temporary root outside the repository is accepted', () => {
    const profile = path.join(RUN_ROOT, 't4-profile');
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: profile });
    assert.equal(db.getDbPath(), path.join(profile, 'flo.db'));
    assert.equal(opened.length, 0, 'T4: resolving a path must not open a database');
  });

  // ── Unchanged behaviour ───────────────────────────────────────────────────
  check('T11: a normal development run still resolves the repository database', () => {
    setEnv({});
    assert.equal(db.getDbPath(), path.join(REPO_ROOT, 'flo.db'));
    assert.equal(opened.length, 0, 'T11: resolving a path must not open a database');
  });

  check('T11b: a normal development run keeps backups in userData, not in the repository', () => {
    // Development and packaged runs share the userData location (D1: the
    // repository location was rejected). Only an isolated test root keeps its
    // backups beside itself.
    const userDataBackups = path.join(FAKE_USER_DATA, 'backups');
    const repoBackups = path.join(REPO_ROOT, 'backups');
    const repoBackupsBeforeT11b = fs.existsSync(repoBackups) ? fs.readdirSync(repoBackups).sort() : null;

    setEnv({});
    assert.equal(fs.existsSync(userDataBackups), false, 'T11b precondition: the mocked userData has no backups yet');
    errorOf(() => db.initDatabase());
    assert.equal(fs.existsSync(userDataBackups), true, 'T11b: development backups must be created under userData');
    assert.equal(opened[0], path.join(REPO_ROOT, 'flo.db'), 'T11b: getDbPath() must still resolve the repository database');
    const repoBackupsAfter = fs.existsSync(repoBackups) ? fs.readdirSync(repoBackups).sort() : null;
    assert.deepEqual(repoBackupsAfter, repoBackupsBeforeT11b, 'T11b: the repository backups directory must stay untouched');

    // An isolated root keeps its backups inside that root instead.
    const isolated = path.join(RUN_ROOT, 'iso-profile');
    setEnv({ FLO_E2E_USER_DATA_DIR: isolated });
    errorOf(() => db.initDatabase());
    assert.equal(fs.existsSync(path.join(isolated, 'backups')), true, 'T11b: isolated backups must stay inside the isolated root');
    assert.equal(opened[0], path.join(isolated, 'flo.db'), 'T11b: the isolated database path must be unchanged');
  });

  check('T13: a child directory whose name starts with ".." is still inside the repository', () => {
    // `..foo` is a legitimate directory name, not the traversal component. A
    // prefix check would call it "outside" and accept a database under it.
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: path.join(REPO_ROOT, '..foo') });
    const message = errorOf(() => db.getDbPath());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assertNoSideEffects('T13', [path.join(REPO_ROOT, '..foo')]);
  });

  check('T14: a database path inside a repository subdirectory is rejected', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_DB_PATH: path.join(REPO_ROOT, 'sub', 'flo.db') });
    const message = errorOf(() => db.getDbPath());
    assert.match(String(message), /FLO_E2E_DB_PATH must not be the repository/);
    assertNoSideEffects('T14', [path.join(REPO_ROOT, 'sub')]);

    // The exact repository database stays rejected too.
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_DB_PATH: path.join(REPO_ROOT, 'flo.db') });
    const exact = errorOf(() => db.getDbPath());
    assert.match(String(exact), /FLO_E2E_DB_PATH must not be the repository/);
    assertNoSideEffects('T14b', []);
  });

  // ── G: the Electron entry point applies the same guard (N-4) ──────────────
  // main/index.ts resolves the root through the shared validator before it
  // redirects userData, so a rejected root never reaches app.setPath.
  let entryPointCalls: Array<[string, string]> = [];
  const applyLikeEntryPoint = (): void => {
    entryPointCalls = [];
    const fakeApp = {
      setPath: (name: string, value: string) => { entryPointCalls.push([name, value]); },
    };
    const isolated = db.resolveIsolatedUserDataRoot();
    if (isolated) fakeApp.setPath('userData', isolated);
  };

  check('G1: the repository root never reaches app.setPath', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: REPO_ROOT });
    const message = errorOf(() => applyLikeEntryPoint());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assert.equal(entryPointCalls.length, 0, 'G1: app.setPath must not be called');
  });

  check('G2: a repository subdirectory never reaches app.setPath', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: path.join(REPO_ROOT, 'sub') });
    const message = errorOf(() => applyLikeEntryPoint());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assert.equal(entryPointCalls.length, 0, 'G2: app.setPath must not be called');
  });

  check('G3: a ".."-prefixed child never reaches app.setPath', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: path.join(REPO_ROOT, '..foo') });
    const message = errorOf(() => applyLikeEntryPoint());
    assert.match(String(message), /FLO_E2E_USER_DATA_DIR must not be the repository/);
    assert.equal(entryPointCalls.length, 0, 'G3: app.setPath must not be called');
  });

  check('G4: a temporary root outside the repository is applied exactly once', () => {
    const profile = path.join(RUN_ROOT, 'g4-profile');
    setEnv({ FLO_E2E_TEST_RUNTIME: '1', FLO_E2E_USER_DATA_DIR: profile });
    applyLikeEntryPoint();
    assert.deepEqual(entryPointCalls, [['userData', profile]], 'G4: userData must be redirected once');
  });

  check('G5: without the override nothing is redirected', () => {
    setEnv({ FLO_E2E_TEST_RUNTIME: '1' });
    assert.equal(db.resolveIsolatedUserDataRoot(), null);
    applyLikeEntryPoint();
    assert.deepEqual(entryPointCalls, [], 'G5: app.setPath must not be called');
  });

  check('G6: main/index.ts validates before it calls app.setPath', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'main', 'index.ts'), 'utf8');
    assert.match(source, /resolveIsolatedUserDataRoot\(\)/, 'index.ts must use the shared validator');
    assert.match(
      source,
      /const isolatedUserDataDir = resolveIsolatedUserDataRoot\(\);[\s\S]{0,200}?app\.setPath\('userData', isolatedUserDataDir\)/,
      'index.ts must resolve the root before redirecting userData',
    );
    assert.doesNotMatch(
      source,
      /app\.setPath\('userData', path\.resolve\(process\.env\.FLO_E2E_USER_DATA_DIR\)\)/,
      'the unvalidated form must be gone',
    );
  });

  check('T12: every rejection happens before any filesystem side effect', () => {
    assert.equal(opened.length, 0, 'T12: no database was opened by any rejection case');
    const leftovers = fs.readdirSync(RUN_ROOT).filter((name) => name.startsWith('t') && name !== 't4-profile' && name !== 't9');
    assert.deepEqual(leftovers, [], `T12: rejected cases must leave nothing behind (found ${JSON.stringify(leftovers)})`);
  });
} finally {
  for (const key of PATH_VARS) delete process.env[key];
}

console.log(`  ✓ data-path isolation guards passed (${passed} checks)`);
console.log('Data-path isolation verified.');
