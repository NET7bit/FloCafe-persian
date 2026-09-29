/**
 * Migration v95 coverage: `add_supplier_payments`.
 *
 * Verifies the fresh-install schema, idempotent re-runs, and that a legacy v94
 * database upgrades to v95 with the table present and empty.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v95-supplier-payments.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v95-'));

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
  console.log('Migration v95 (add_supplier_payments)');
  console.log('='.repeat(50));

  // ── Fresh install ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `fresh install reaches schema v${TARGET_VERSION}`);

  const expectedColumns = [
    'id', 'supplier_id', 'purchase_invoice_id', 'amount', 'payment_method',
    'reference', 'paid_at', 'created_by', 'notes', 'created_at',
  ];
  const actualColumns = tableColumns(db, 'supplier_payments');
  for (const column of expectedColumns) {
    assert(actualColumns.includes(column), `supplier_payments defines column ${column}`);
  }

  const expectedIndexes = [
    'idx_supplier_payments_supplier',
    'idx_supplier_payments_invoice',
    'idx_supplier_payments_paid_at',
    'idx_supplier_payments_method',
  ];
  const actualIndexes = indexNames(db, 'supplier_payments');
  for (const indexName of expectedIndexes) {
    assert(actualIndexes.includes(indexName), `supplier_payments defines index ${indexName}`);
  }

  assertEqual(
    db.prepare('SELECT COUNT(*) AS n FROM supplier_payments').get().n,
    0,
    'fresh install seeds no supplier payments',
  );

  // amount must be positive (CHECK constraint).
  db.prepare(`
    INSERT INTO suppliers (id, name, is_active, created_at, updated_at)
    VALUES ('s1', 'Probe Supplier', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO supplier_payments (id, supplier_id, amount, payment_method, paid_at)
    VALUES ('sp1', 's1', 100, 'cash', '2026-01-01')
  `).run();
  let zeroRejected = false;
  try {
    db.prepare(`
      INSERT INTO supplier_payments (id, supplier_id, amount, payment_method, paid_at)
      VALUES ('sp2', 's1', 0, 'cash', '2026-01-01')
    `).run();
  } catch {
    zeroRejected = true;
  }
  assert(zeroRejected, 'amount CHECK rejects zero');

  // payment_method is required.
  let methodRejected = false;
  try {
    db.prepare(`
      INSERT INTO supplier_payments (id, supplier_id, amount, payment_method, paid_at)
      VALUES ('sp3', 's1', 1, NULL, '2026-01-01')
    `).run();
  } catch {
    methodRejected = true;
  }
  assert(methodRejected, 'payment_method is NOT NULL');

  // paid_at is required.
  let paidAtRejected = false;
  try {
    db.prepare(`
      INSERT INTO supplier_payments (id, supplier_id, amount, payment_method, paid_at)
      VALUES ('sp4', 's1', 1, 'cash', NULL)
    `).run();
  } catch {
    paidAtRejected = true;
  }
  assert(paidAtRejected, 'paid_at is NOT NULL');

  // Clean probe rows before the idempotency re-run.
  db.prepare('DELETE FROM supplier_payments').run();
  db.prepare('DELETE FROM suppliers').run();

  // ── Idempotency ──
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps the schema version');
  assertEqual(
    indexNames(getDatabase(), 'supplier_payments').filter((name) => name.startsWith('idx_')).length,
    expectedIndexes.length,
    'payment indexes are not duplicated by re-run',
  );

  // ── Legacy v94 database upgrades to v95 ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v95-upgrade-'));
  initDatabase();
  db = getDatabase();

  db.prepare('DROP TABLE supplier_payments').run();
  db.pragma('user_version = 94');
  assertEqual(getCurrentSchemaVersion(), 94, 'rolled back to v94 for the upgrade test');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_payments'").get(), 'supplier_payments removed before upgrade');

  runPendingMigrations();
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_payments'").get(), 'supplier_payments exists after upgrade');
  assertEqual(
    tableColumns(getDatabase(), 'supplier_payments').length,
    expectedColumns.length,
    'upgraded supplier_payments has the expected column count',
  );
  assertEqual(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM supplier_payments').get().n,
    0,
    'upgraded supplier_payments starts empty',
  );
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get(), 'purchase_invoices survives the upgrade');
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppliers'").get(), 'suppliers survives the upgrade');

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
