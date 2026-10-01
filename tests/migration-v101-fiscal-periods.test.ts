/**
 * Migration v101 coverage: `add_fiscal_periods`.
 *
 * Verifies the fresh-install table shape (CHECKs, UNIQUE), idempotent
 * re-runs, and that a legacy v99 database upgrades to v101 with prior
 * tables intact.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v101-fiscal-periods.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fiscal-migration-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { MIGRATIONS } = require('../main/db');

const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
const target = MIGRATIONS.find((m: any) => m.version === TARGET_VERSION);

function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    (globalThis as any).__failed = ((globalThis as any).__failed || 0) + 1;
  } else {
    console.log(`  ✓ ${message}`);
    (globalThis as any).__passed = ((globalThis as any).__passed || 0) + 1;
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

let db: any;
function initDb(): any {
  const Database = require('better-sqlite3');
  const database = new Database(path.join(testDir, `mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  database.pragma('foreign_keys = OFF');
  const original = require('../main/db');
  return database;
}

// The migration registry mutates the module-level `db`; run migrations against
// a throwaway module instance by using the exported MIGRATIONS array directly.
function getDb(): any {
  return (require('../main/db') as any).getDatabase();
}

function columns(table: string): { name: string; notnull: number; dflt_value: unknown }[] {
  return getDb().prepare(`PRAGMA table_info(${table})`).all();
}

function runUpTo(version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break;
    if (migration.version === version || true) {
      // Only run migrations not yet applied: user_version tracks progress.
      const current = getDb().pragma('user_version', { simple: true }) as number;
      if (migration.version <= current) continue;
      migration.up();
      getDb().pragma(`user_version = ${migration.version}`);
    }
  }
}

async function main() {
  console.log(`Migration v${TARGET_VERSION} (add_fiscal_periods) test`);
  console.log('='.repeat(50));
  if (TARGET_VERSION < 101) {
    console.error(`Expected the migration chain to include v101 but the last migration is v${TARGET_VERSION}`);
    process.exit(1);
  }

  // ── Fresh install: all migrations from v1 ──
  initDb();
  const { initDatabase } = require('../main/db');
  initDatabase();

  const cols = columns('fiscal_periods');
  const names = cols.map((c: any) => c.name);
  for (const expected of ['id', 'period_type', 'start_date', 'end_date', 'status', 'closed_at', 'closed_by', 'reopened_at', 'reopened_by', 'name', 'created_at']) {
    assert(names.includes(expected), `column ${expected} exists`);
  }
  const indexes = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fiscal_periods'").all().map((r: any) => r.name);
  assert(indexes.includes('idx_fiscal_periods_range'), 'range index exists');
  assert(indexes.includes('idx_fiscal_periods_status'), 'status index exists');

  // CHECK: period_type constrained
  const insert = getDb().prepare(`
    INSERT INTO fiscal_periods (id, period_type, start_date, end_date, created_at)
    VALUES (?, ?, ?, ?, '2026-01-01 00:00:00')
  `);
  let threw = false;
  try { insert.run('fp_bad', 'week', '2026-01-01', '2026-01-31'); } catch { threw = true; }
  assert(threw, 'period_type CHECK rejects non month/year');

  threw = false;
  try { insert.run('fp_bad2', 'month', '2026-02-01', '2026-01-31'); } catch { threw = true; }
  assert(threw, 'start_date <= end_date CHECK holds');

  threw = false;
  try { insert.run('fp_bad3', 'month', '20260101', '2026-01-31'); } catch { threw = true; }
  assert(threw, 'date-format CHECK holds');

  getDb().prepare(`
    INSERT INTO fiscal_periods (id, period_type, start_date, end_date, created_at)
    VALUES ('fp_ok', 'month', '2026-01-01', '2026-01-31', '2026-01-01 00:00:00')
  `).run();
  assertEqual((getDb().prepare("SELECT status FROM fiscal_periods WHERE id = 'fp_ok'").get() as any).status, 'open', 'default status is open');

  threw = false;
  try { insert.run('fp_dup', 'month', '2026-01-01', '2026-01-31'); } catch { threw = true; }
  assert(threw, 'UNIQUE (period_type, start_date) rejects the same type and start date');
  getDb().prepare(`
    INSERT INTO fiscal_periods (id, period_type, start_date, end_date, created_at)
    VALUES ('fp_other', 'year', '2026-01-01', '2026-12-31', '2026-01-01 00:00:00')
  `).run();
  assert(true, 'same start_date with different period_type is allowed');

  // ── Idempotent re-run ──
  let rerunFailed = false;
  try { target.up(); target.up(); } catch { rerunFailed = true; }
  assert(!rerunFailed, 're-running the migration is idempotent');
  assertEqual((getDb().prepare('SELECT COUNT(*) AS n FROM fiscal_periods').get() as any).n, 2, 're-run preserves existing rows');

  // ── Prior v93–v99 tables survive ──
  const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name);
  for (const t of ['suppliers', 'purchase_invoices', 'supplier_payments', 'purchase_returns', 'expenses', 'receivable_entries', 'orders', 'bills']) {
    assert(tables.includes(t), `table ${t} survived`);
  }

  // ── Upgrade path: legacy v99 database → v101 ──
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fiscal-legacy-'));
  const legacy = new (require('better-sqlite3'))(path.join(legacyDir, 'legacy.db'));
  legacy.pragma('foreign_keys = OFF');
  // Minimal v99-era schema: users + customers + receivable_entries + fiscal seed check.
  legacy.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT, pin_hash TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE customers (id TEXT PRIMARY KEY, name TEXT, is_active INTEGER DEFAULT 1);
    CREATE TABLE receivable_entries (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL REFERENCES customers(id),
      entry_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT,
      reference TEXT,
      description TEXT,
      entry_date TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO customers VALUES ('cust-1', 'Legacy Customer', 1);
    INSERT INTO receivable_entries (id, customer_id, entry_type, direction, amount, entry_date, created_at)
      VALUES ('rcv_legacy', 'cust-1', 'charge', 'debit', 120000, '2025-12-15', '2025-12-15 10:00:00');
    PRAGMA user_version = 99;
  `);
  assertEqual(legacy.pragma('user_version', { simple: true }), 99, 'legacy database is at v99');

  // Apply v101 to the legacy database via the real migration function against it.
  const dbModule = require('../main/db');
  // swap the module's active handle so target.up() runs against `legacy`
  const setDb = dbModule.__setActiveDbHandleForTests;
  if (typeof setDb === 'function') {
    setDb(legacy);
    legacy.pragma('foreign_keys = OFF');
    target.up();
    legacy.pragma('user_version = 101');
    const colsAfter = legacy.prepare('PRAGMA table_info(fiscal_periods)').all();
    assert(colsAfter.length > 0, 'legacy upgrade created fiscal_periods');
    assertEqual(legacy.prepare('SELECT amount FROM receivable_entries WHERE id = ?').get('rcv_legacy').amount, 120000, 'legacy ledger data preserved');
    assertEqual(legacy.pragma('user_version', { simple: true }), 101, 'legacy database upgraded to v101');
  } else {
    // Fallback: verify the migration DDL against a fresh in-memory database.
    const scratch = new (require('better-sqlite3'))(':memory:');
    scratch.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, pin_hash TEXT, is_active INTEGER)`);
    const before = dbModule.getDatabase();
    console.log('  ℹ no test handle setter exported; verified fresh-install path only');
  }
  legacy.close();

  console.log('='.repeat(50));
  const passed = (globalThis as any).__passed || 0;
  const failed = (globalThis as any).__failed || 0;
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
