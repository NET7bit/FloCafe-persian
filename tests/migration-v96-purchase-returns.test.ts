/**
 * Migration v96 coverage: `add_purchase_returns`.
 *
 * Verifies the fresh-install schema, idempotent re-runs, and that a legacy v95
 * database upgrades to v96 with the tables present and empty.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v96-purchase-returns.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v96-'));

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
  console.log('Migration v96 (add_purchase_returns)');
  console.log('='.repeat(50));

  // ── Fresh install ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `fresh install reaches schema v${TARGET_VERSION}`);

  const expectedReturnColumns = [
    'id', 'return_number', 'purchase_invoice_id', 'supplier_id', 'return_date',
    'subtotal', 'tax_amount', 'total', 'status', 'reason', 'created_by',
    'deleted_by', 'deleted_at', 'deletion_reason', 'notes', 'created_at', 'updated_at',
  ];
  const actualReturnColumns = tableColumns(db, 'purchase_returns');
  for (const column of expectedReturnColumns) {
    assert(actualReturnColumns.includes(column), `purchase_returns defines column ${column}`);
  }

  const expectedReturnIndexes = [
    'idx_purchase_returns_invoice',
    'idx_purchase_returns_supplier',
    'idx_purchase_returns_date',
    'idx_purchase_returns_number',
  ];
  const actualReturnIndexes = indexNames(db, 'purchase_returns');
  for (const indexName of expectedReturnIndexes) {
    assert(actualReturnIndexes.includes(indexName), `purchase_returns defines index ${indexName}`);
  }

  const expectedItemColumns = [
    'id', 'purchase_return_id', 'purchase_invoice_item_id', 'supply_id',
    'quantity', 'unit', 'unit_price', 'tax_amount', 'total', 'created_at',
  ];
  const actualItemColumns = tableColumns(db, 'purchase_return_items');
  for (const column of expectedItemColumns) {
    assert(actualItemColumns.includes(column), `purchase_return_items defines column ${column}`);
  }

  assert(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_return_sequences'").get(),
    'purchase_return_sequences exists',
  );

  assertEqual(
    db.prepare('SELECT COUNT(*) AS n FROM purchase_returns').get().n,
    0,
    'fresh install seeds no purchase returns',
  );

  // quantity must be positive (CHECK constraint).
  db.prepare(`
    INSERT INTO suppliers (id, name, is_active, created_at, updated_at)
    VALUES ('s1', 'Probe Supplier', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date)
    VALUES ('pi1', 'PINV-20260101-0001', 's1', '2026-01-01')
  `).run();
  db.prepare(`
    INSERT INTO purchase_returns (id, return_number, purchase_invoice_id, supplier_id, return_date)
    VALUES ('pr1', 'PRET-20260101-0001', 'pi1', 's1', '2026-01-01')
  `).run();
  let zeroRejected = false;
  try {
    db.prepare(`
      INSERT INTO purchase_return_items (
        id, purchase_return_id, purchase_invoice_item_id, supply_id, quantity, unit
      ) VALUES ('pri0', 'pr1', 'x', 'x', 0, 'kg')
    `).run();
  } catch {
    zeroRejected = true;
  }
  assert(zeroRejected, 'item quantity CHECK rejects zero');

  let statusRejected = false;
  try {
    db.prepare(`
      INSERT INTO purchase_returns (id, return_number, purchase_invoice_id, supplier_id, return_date, status)
      VALUES ('pr2', 'PRET-20260101-0002', 'pi1', 's1', '2026-01-01', 'bogus')
    `).run();
  } catch {
    statusRejected = true;
  }
  assert(statusRejected, 'status CHECK rejects invalid values');

  let orphansRejected = false;
  try {
    db.prepare(`
      INSERT INTO purchase_returns (id, return_number, purchase_invoice_id, supplier_id, return_date)
      VALUES ('pr3', 'PRET-20260101-0003', 'missing-invoice', 's1', '2026-01-01')
    `).run();
  } catch {
    orphansRejected = true;
  }
  assert(orphansRejected, 'return against a missing invoice is rejected');

  // Clean probe rows before the idempotency re-run.
  db.prepare('DELETE FROM purchase_returns').run();
  db.prepare('DELETE FROM purchase_invoices').run();
  db.prepare('DELETE FROM suppliers').run();

  // ── Idempotency ──
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps the schema version');
  assertEqual(
    indexNames(getDatabase(), 'purchase_returns').filter((name) => name.startsWith('idx_')).length,
    expectedReturnIndexes.length,
    'return indexes are not duplicated by re-run',
  );

  // ── Legacy v95 database upgrades to v96 ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v96-upgrade-'));
  initDatabase();
  db = getDatabase();

  db.prepare('DROP TABLE purchase_return_items').run();
  db.prepare('DROP TABLE purchase_returns').run();
  db.prepare('DROP TABLE purchase_return_sequences').run();
  db.pragma('user_version = 95');
  assertEqual(getCurrentSchemaVersion(), 95, 'rolled back to v95 for the upgrade test');
  assert(
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_returns'").get(),
    'purchase_returns removed before upgrade',
  );

  runPendingMigrations();
  assert(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_returns'").get(),
    'purchase_returns exists after upgrade',
  );
  assert(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_return_items'").get(),
    'purchase_return_items exists after upgrade',
  );
  assertEqual(
    tableColumns(getDatabase(), 'purchase_returns').length,
    expectedReturnColumns.length,
    'upgraded purchase_returns has the expected column count',
  );
  assertEqual(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM purchase_returns').get().n,
    0,
    'upgraded purchase_returns starts empty',
  );
  assert(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='supplier_payments'").get(),
    'supplier_payments survives the upgrade',
  );
  assert(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_invoices'").get(),
    'purchase_invoices survives the upgrade',
  );

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
