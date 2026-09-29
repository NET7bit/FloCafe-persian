/**
 * Migration v99 coverage: `add_receivables`.
 *
 * Verifies the fresh-install schema, CHECK constraints, idempotent re-runs,
 * and that a legacy v98 database upgrades to v99 with the table present and
 * empty.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v99-receivables.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v99-'));

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

function seedCustomer(db: any): void {
  db.prepare(`
    INSERT INTO customers (id, name, is_active, created_at, updated_at)
    VALUES ('c1', 'Probe Customer', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
}

async function main() {
  console.log('Migration v99 (add_receivables)');
  console.log('='.repeat(50));

  // ── Fresh install ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, `fresh install reaches schema v${TARGET_VERSION}`);

  const expectedColumns = [
    'id', 'customer_id', 'entry_type', 'direction', 'amount', 'payment_method',
    'reference', 'description', 'entry_date', 'created_by', 'notes', 'created_at',
  ];
  const actualColumns = tableColumns(db, 'receivable_entries');
  for (const column of expectedColumns) {
    assert(actualColumns.includes(column), `receivable_entries defines column ${column}`);
  }

  const expectedIndexes = [
    'idx_receivable_entries_customer',
    'idx_receivable_entries_date',
    'idx_receivable_entries_type',
    'idx_receivable_entries_created_by',
  ];
  const actualIndexes = indexNames(db, 'receivable_entries');
  for (const indexName of expectedIndexes) {
    assert(actualIndexes.includes(indexName), `receivable_entries defines index ${indexName}`);
  }

  assertEqual(db.prepare('SELECT COUNT(*) AS n FROM receivable_entries').get().n, 0, 'fresh install seeds no entries');

  // ── CHECK constraints ──
  seedCustomer(db);
  const insertEntry = (id: string, overrides: Record<string, any> = {}) => {
    const row = {
      id,
      customer_id: 'c1',
      entry_type: 'charge',
      direction: 'debit',
      amount: 100,
      payment_method: null,
      entry_date: '2026-01-01',
      ...overrides,
    };
    return db.prepare(`
      INSERT INTO receivable_entries (
        id, customer_id, entry_type, direction, amount, payment_method, entry_date
      ) VALUES (@id, @customer_id, @entry_type, @direction, @amount, @payment_method, @entry_date)
    `).run(row);
  };

  insertEntry('re1');
  let rejected = false;
  try { insertEntry('re2', { entry_type: 'bogus' }); } catch { rejected = true; }
  assert(rejected, 'entry_type CHECK rejects invalid values');

  rejected = false;
  try { insertEntry('re3', { direction: 'sideways' }); } catch { rejected = true; }
  assert(rejected, 'direction CHECK rejects invalid values');

  rejected = false;
  try { insertEntry('re4', { amount: 0 }); } catch { rejected = true; }
  assert(rejected, 'amount CHECK rejects zero');

  rejected = false;
  try { insertEntry('re5', { direction: 'credit' }); } catch { rejected = true; }
  assert(rejected, 'charge must be a debit');

  rejected = false;
  try { insertEntry('re6', { entry_type: 'settlement', direction: 'credit', payment_method: 'cash' }); } catch { rejected = true; }
  assert(!rejected, 'settlement with a payment method is valid');

  rejected = false;
  try { insertEntry('re7', { entry_type: 'settlement', direction: 'credit', payment_method: null }); } catch { rejected = true; }
  assert(rejected, 'settlement without a payment method is rejected');

  rejected = false;
  try { insertEntry('re8', { customer_id: 'missing' }); } catch { rejected = true; }
  assert(rejected, 'entry against a missing customer is rejected');

  // Clean probe rows before the idempotency re-run.
  db.prepare('DELETE FROM receivable_entries').run();
  db.prepare('DELETE FROM customers').run();

  // ── Idempotency ──
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps the schema version');
  assertEqual(
    indexNames(getDatabase(), 'receivable_entries').filter((name) => name.startsWith('idx_')).length,
    expectedIndexes.length,
    'receivable indexes are not duplicated by re-run',
  );

  // ── Legacy v98 database upgrades to v99 ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v99-upgrade-'));
  initDatabase();
  db = getDatabase();

  db.prepare('DROP TABLE receivable_entries').run();
  db.pragma('user_version = 98');
  assertEqual(getCurrentSchemaVersion(), 98, 'rolled back to v98 for the upgrade test');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='receivable_entries'").get(), 'receivable_entries removed before upgrade');

  runPendingMigrations();
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='receivable_entries'").get(), 'receivable_entries exists after upgrade');
  assertEqual(
    tableColumns(getDatabase(), 'receivable_entries').length,
    expectedColumns.length,
    'upgraded receivable_entries has the expected column count',
  );
  assertEqual(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM receivable_entries').get().n,
    0,
    'upgraded receivable_entries starts empty',
  );
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'").get(), 'expenses survives the upgrade');
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='purchase_returns'").get(), 'purchase_returns survives the upgrade');

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
