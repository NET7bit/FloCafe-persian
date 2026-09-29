/**
 * Migration v94 coverage: `add_purchase_invoices`.
 *
 * Verifies the fresh-install schema, idempotent re-runs, and that a legacy v93
 * database upgrades to v94 with the purchase tables present and empty.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v94-purchase-invoices.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v94-'));

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
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

async function main() {
  console.log('Migration v94 (add_purchase_invoices)');
  console.log('='.repeat(50));

  // ── Fresh install reaches v94 with the purchase tables ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `fresh install reaches schema v${TARGET_VERSION}`);

  const expectedInvoiceColumns = [
    'id', 'invoice_number', 'supplier_id', 'invoice_date', 'due_date',
    'subtotal', 'discount_amount', 'tax_amount', 'total', 'paid_amount', 'balance',
    'status', 'notes', 'created_by', 'created_at', 'updated_at',
  ];
  const actualInvoiceColumns = tableColumns(db, 'purchase_invoices');
  for (const column of expectedInvoiceColumns) {
    assert(actualInvoiceColumns.includes(column), `purchase_invoices defines column ${column}`);
  }

  const expectedItemColumns = [
    'id', 'purchase_invoice_id', 'supply_id', 'quantity', 'unit', 'unit_price',
    'discount_amount', 'tax_amount', 'total', 'created_at',
  ];
  const actualItemColumns = tableColumns(db, 'purchase_invoice_items');
  for (const column of expectedItemColumns) {
    assert(actualItemColumns.includes(column), `purchase_invoice_items defines column ${column}`);
  }

  const expectedInvoiceIndexes = [
    'idx_purchase_invoices_supplier',
    'idx_purchase_invoices_status',
    'idx_purchase_invoices_date',
    'idx_purchase_invoices_number',
  ];
  const actualInvoiceIndexes = indexNames(db, 'purchase_invoices');
  for (const indexName of expectedInvoiceIndexes) {
    assert(actualInvoiceIndexes.includes(indexName), `purchase_invoices defines index ${indexName}`);
  }

  const expectedItemIndexes = [
    'idx_purchase_invoice_items_invoice',
    'idx_purchase_invoice_items_supply',
  ];
  const actualItemIndexes = indexNames(db, 'purchase_invoice_items');
  for (const indexName of expectedItemIndexes) {
    assert(actualItemIndexes.includes(indexName), `purchase_invoice_items defines index ${indexName}`);
  }

  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_invoice_sequences'").get(), 'purchase_invoice_sequences table exists');
  assertEqual(
    db.prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get().n,
    0,
    'fresh install seeds no purchase invoices',
  );

  // Seed a real supplier so the constraint probes below satisfy foreign keys.
  db.prepare(`
    INSERT INTO suppliers (id, name, code, is_active, created_at, updated_at)
    VALUES ('s1', 'Schema Probe Supplier', 'PROBE', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();

  // invoice_number uniqueness is enforced.
  db.prepare(`
    INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, status)
    VALUES ('pi1', 'PINV-DUP-0001', 's1', '2026-01-01', 'draft')
  `).run();
  let duplicateFailed = false;
  try {
    db.prepare(`
      INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, status)
      VALUES ('pi2', 'PINV-DUP-0001', 's1', '2026-01-01', 'draft')
    `).run();
  } catch {
    duplicateFailed = true;
  }
  assert(duplicateFailed, 'invoice_number is unique');

  // status CHECK constraint rejects unknown values.
  let badStatusFailed = false;
  try {
    db.prepare(`
      INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, status)
      VALUES ('pi3', 'PINV-DUP-0002', 's1', '2026-01-01', 'unknown')
    `).run();
  } catch {
    badStatusFailed = true;
  }
  assert(badStatusFailed, 'status CHECK rejects unknown values');

  // posted rows keep the balance they were created with.
  db.prepare(`
    INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, status, total, balance)
    VALUES ('pi4', 'PINV-DUP-0003', 's1', '2026-01-01', 'posted', 100, 100)
  `).run();
  assertEqual(
    db.prepare("SELECT balance FROM purchase_invoices WHERE id = 'pi4'").get().balance,
    100,
    'posted invoice stores its balance',
  );

  // Clear probe rows so the idempotency re-run below starts from a clean table.
  db.prepare('DELETE FROM purchase_invoices').run();
  db.prepare('DELETE FROM suppliers').run();

  // Migration DDL is idempotent.
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps the schema version');
  assertEqual(
    indexNames(getDatabase(), 'purchase_invoices').filter((name) => name.startsWith('idx_')).length,
    expectedInvoiceIndexes.length,
    'invoice indexes are not duplicated by re-run',
  );

  // ── Legacy v93 database upgrades to v94 ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v94-upgrade-'));
  initDatabase();
  db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `second fresh install reaches schema v${TARGET_VERSION}`);

  // Roll back to v93, as an install that predates purchase invoices would be.
  db.prepare('DROP TABLE purchase_invoices').run();
  db.prepare('DROP TABLE purchase_invoice_items').run();
  db.prepare('DROP TABLE purchase_invoice_sequences').run();
  db.pragma('user_version = 93');
  assertEqual(getCurrentSchemaVersion(), 93, 'rolled back to v93 for the upgrade test');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get(), 'purchase_invoices removed before upgrade');

  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `legacy v93 database upgrades to v${TARGET_VERSION}`);
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get(), 'purchase_invoices exists after upgrade');
  assertEqual(
    tableColumns(getDatabase(), 'purchase_invoices').length,
    expectedInvoiceColumns.length,
    'upgraded purchase_invoices has the expected column count',
  );
  assertEqual(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM purchase_invoices').get().n,
    0,
    'upgraded purchase_invoices starts empty',
  );
  // Existing suppliers and supplies survive the upgrade untouched.
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppliers'").get(), 'suppliers table survives the upgrade');
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplies'").get(), 'supplies table survives the upgrade');

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
