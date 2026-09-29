/**
 * Migration v97 coverage: `add_supply_cost_price`.
 *
 * Verifies the fresh-install column, the weighted-average backfill from posted
 * purchase history, idempotent re-runs, and that a legacy v96 database
 * upgrades to v97 with the column present.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v97-supply-cost-price.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v97-'));

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

function seedPurchaseHistory(db: any) {
  db.prepare(`
    INSERT INTO suppliers (id, name, is_active, created_at, updated_at)
    VALUES ('s1', 'Supplier', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO supplies (id, name, base_unit, stock_quantity, is_active, created_at, updated_at)
    VALUES ('sup-a', 'Sugar', 'kg', 0, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, status)
    VALUES ('pi1', 'PINV-2026-01-01-0001', 's1', '2026-01-01', 'posted')
  `).run();
  db.prepare(`
    INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, status)
    VALUES ('pi2', 'PINV-2026-01-02-0001', 's1', '2026-01-02', 'draft')
  `).run();
  // Posted: 3 kg @ 2000 → contributes 6000 / 3 = 2000 per kg
  db.prepare(`
    INSERT INTO purchase_invoice_items (
      id, purchase_invoice_id, supply_id, quantity, unit, unit_price, total
    ) VALUES ('pii1', 'pi1', 'sup-a', 3, 'kg', 2000, 6000)
  `).run();
  // Draft: must be ignored by the backfill.
  db.prepare(`
    INSERT INTO purchase_invoice_items (
      id, purchase_invoice_id, supply_id, quantity, unit, unit_price, total
    ) VALUES ('pii2', 'pi2', 'sup-a', 10, 'kg', 9000, 90000)
  `).run();
}

async function main() {
  console.log('Migration v97 (add_supply_cost_price)');
  console.log('='.repeat(50));

  // ── Fresh install ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `fresh install reaches schema v${TARGET_VERSION}`);

  const costColumn = (db.prepare('PRAGMA table_info(supplies)').all() as Array<{ name: string }>)
    .find((col) => col.name === 'cost_price');
  assert(costColumn !== undefined, 'supplies defines cost_price');
  assertEqual(costColumn?.dflt_value, '0', 'cost_price defaults to 0');

  // ── Backfill on a legacy-style v96 database ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v97-upgrade-'));
  initDatabase();
  db = getDatabase();

  db.prepare('ALTER TABLE supplies DROP COLUMN cost_price').run();
  db.pragma('user_version = 96');
  assertEqual(getCurrentSchemaVersion(), 96, 'rolled back to v96 for the upgrade test');
  seedPurchaseHistory(db);

  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 'upgrade reaches the target version');
  assert(
    (tableColumns(db, 'supplies') as string[]).includes('cost_price'),
    'cost_price exists after upgrade',
  );
  assertEqual(
    Number(db.prepare("SELECT cost_price FROM supplies WHERE id = 'sup-a'").get().cost_price),
    2000,
    'backfill averages posted purchase history only',
  );

  // A supply without purchase history keeps 0.
  db.prepare(`
    INSERT INTO supplies (id, name, base_unit, stock_quantity, is_active, created_at, updated_at)
    VALUES ('sup-b', 'Rice', 'kg', 0, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
  assertEqual(
    Number(db.prepare("SELECT cost_price FROM supplies WHERE id = 'sup-b'").get().cost_price),
    0,
    'supply without purchase history backfills to 0',
  );

  // Clean probe rows before the idempotency re-run.
  db.prepare('DELETE FROM purchase_invoice_items').run();
  db.prepare('DELETE FROM purchase_invoices').run();
  db.prepare('DELETE FROM supplies').run();
  db.prepare('DELETE FROM suppliers').run();

  // ── Idempotency ──
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps the schema version');
  const costColumns = (tableColumns(db, 'supplies') as string[]).filter((name) => name === 'cost_price');
  assertEqual(costColumns.length, 1, 'cost_price is not duplicated by re-run');

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
