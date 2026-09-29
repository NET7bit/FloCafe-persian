/**
 * Migration v98 coverage: `add_expenses`.
 *
 * Verifies the fresh-install schema, idempotent re-runs, and that a legacy v97
 * database upgrades to v98 with the table present and empty.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v98-expenses.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v98-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => activeTestDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, getCurrentSchemaVersion, MIGRATIONS, closeDatabase } = require('../main/db');
const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

let passed = 0;
let failed = 0;
let total = 0;

function assert(condition: boolean, message: string) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  total++;
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function tableColumns(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((col) => col.name);
}

function indexNames(db: any, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((idx) => idx.name);
}

function runPendingMigrations() {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    if (migration.version > TARGET_VERSION) break;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

async function main() {
  console.log('Migration v98 (add_expenses)');
  console.log('='.repeat(50));

  // ── Fresh install ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `fresh install reaches schema v${TARGET_VERSION}`);

  const expectedColumns = [
    'id', 'category', 'description', 'amount', 'payment_method',
    'expense_date', 'created_by', 'notes', 'created_at',
  ];
  const actualColumns = tableColumns(db, 'expenses');
  for (const column of expectedColumns) {
    assert(actualColumns.includes(column), `expenses defines column ${column}`);
  }

  const expectedIndexes = [
    'idx_expenses_date',
    'idx_expenses_category',
    'idx_expenses_method',
    'idx_expenses_created_by',
  ];
  const actualIndexes = indexNames(db, 'expenses');
  for (const indexName of expectedIndexes) {
    assert(actualIndexes.includes(indexName), `expenses defines index ${indexName}`);
  }

  assertEqual(
    db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n,
    0,
    'fresh install seeds no expenses',
  );

  // amount must be positive (CHECK constraint). created_by is a nullable FK,
  // so probe rows do not need a user.
  db.prepare(`
    INSERT INTO expenses (id, category, amount, payment_method, expense_date)
    VALUES ('e1', 'Rent', 100, 'cash', '2026-01-01')
  `).run();
  let zeroRejected = false;
  try {
    db.prepare(`
      INSERT INTO expenses (id, category, amount, payment_method, expense_date)
      VALUES ('e2', 'Rent', 0, 'cash', '2026-01-01')
    `).run();
  } catch {
    zeroRejected = true;
  }
  assert(zeroRejected, 'amount CHECK rejects zero');

  let categoryRejected = false;
  try {
    db.prepare(`
      INSERT INTO expenses (id, category, amount, payment_method, expense_date)
      VALUES ('e3', NULL, 1, 'cash', '2026-01-01')
    `).run();
  } catch {
    categoryRejected = true;
  }
  assert(categoryRejected, 'category is NOT NULL');

  // Clean probe rows before the idempotency re-run.
  db.prepare('DELETE FROM expenses').run();

  // ── Idempotency ──
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps the schema version');
  assertEqual(
    indexNames(getDatabase(), 'expenses').filter((name) => name.startsWith('idx_')).length,
    expectedIndexes.length,
    'expense indexes are not duplicated by re-run',
  );

  // ── Legacy v97 database upgrades to v98 ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v98-upgrade-'));
  initDatabase();
  db = getDatabase();

  db.prepare('DROP TABLE expenses').run();
  db.pragma('user_version = 97');
  assertEqual(getCurrentSchemaVersion(), 97, 'rolled back to v97 for the upgrade test');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'").get(), 'expenses removed before upgrade');

  runPendingMigrations();
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'").get(), 'expenses exists after upgrade');
  assertEqual(
    tableColumns(getDatabase(), 'expenses').length,
    expectedColumns.length,
    'upgraded expenses has the expected column count',
  );
  assertEqual(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM expenses').get().n,
    0,
    'upgraded expenses starts empty',
  );
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_returns'").get(), 'purchase_returns survives the upgrade');
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_payments'").get(), 'supplier_payments survives the upgrade');

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
