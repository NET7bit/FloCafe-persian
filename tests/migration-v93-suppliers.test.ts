/**
 * Migration v93 coverage: `add_suppliers`.
 *
 * Verifies the fresh-install table/index shape, that the migration is safe to
 * re-run on an already-migrated database (idempotent DDL), and that a legacy
 * v92 database reaches v93 with the suppliers table present and empty.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v93-suppliers.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

let activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v93-'));

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
  console.log('Migration v93 (add_suppliers)');
  console.log('='.repeat(50));

  // ── Fresh install reaches v93 with the suppliers table ──
  initDatabase();
  let db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 'fresh install reaches schema v93');
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppliers'").get(), 'suppliers table exists');

  const expectedColumns = [
    'id', 'name', 'code', 'phone', 'mobile', 'national_id', 'economic_code',
    'address', 'notes', 'is_active', 'deleted_at', 'created_at', 'updated_at',
  ];
  const actualColumns = tableColumns(db, 'suppliers');
  for (const column of expectedColumns) {
    assert(actualColumns.includes(column), `suppliers table defines column ${column}`);
  }

  const expectedIndexes = [
    'idx_suppliers_name', 'idx_suppliers_mobile', 'idx_suppliers_national_id', 'idx_suppliers_active',
  ];
  const actualIndexes = indexNames(db, 'suppliers');
  for (const indexName of expectedIndexes) {
    assert(actualIndexes.includes(indexName), `suppliers table defines index ${indexName}`);
  }

  assert(
    actualIndexes.includes('idx_suppliers_code_unique'),
    'suppliers table defines the scoped code-uniqueness index',
  );

  assertEqual(
    db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n,
    0,
    'fresh install seeds no suppliers',
  );

  // Column invariants
  const codeRow = db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get('idx_suppliers_name') as any;
  assert(codeRow.sql.toLowerCase().includes('collate nocase'), 'name index is case-insensitive');

  // Code uniqueness is enforced for live rows only.
  db.prepare('INSERT INTO suppliers (id, name, code) VALUES (?, ?, ?)').run('s1', 'One', 'DUP-CODE');
  let duplicateFailed = false;
  try {
    db.prepare('INSERT INTO suppliers (id, name, code) VALUES (?, ?, ?)').run('s2', 'Two', 'DUP-CODE');
  } catch {
    duplicateFailed = true;
  }
  assert(duplicateFailed, 'code is unique among live suppliers');
  // A soft-deleted supplier's code can be reused by a live row.
  db.prepare("UPDATE suppliers SET deleted_at = ? WHERE id = ?").run('2026-01-01 00:00:00', 's1');
  db.prepare('INSERT INTO suppliers (id, name, code) VALUES (?, ?, ?)').run('s5', 'Five', 'DUP-CODE');
  // NULL codes do not collide (multiple suppliers may omit code).
  db.prepare('INSERT INTO suppliers (id, name, code) VALUES (?, ?, ?)').run('s3', 'Three', null);
  db.prepare('INSERT INTO suppliers (id, name, code) VALUES (?, ?, ?)').run('s4', 'Four', null);
  assertEqual(
    db.prepare('SELECT COUNT(*) AS n FROM suppliers').get().n,
    4,
    'multiple suppliers may have a NULL code',
  );

  // Migration DDL is idempotent: re-running v93.up() is a no-op.
  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 're-running migrations keeps schema at v93');
  // SQLite auto-indexes for the PK and the UNIQUE code constraint are excluded;
  // only the four explicitly created indexes should be present.
  const namedIndexes = indexNames(getDatabase(), 'suppliers').filter((name) => name.startsWith('idx_'));
  assertEqual(namedIndexes.length, expectedIndexes.length + 1, 'supplier indexes are not duplicated by re-run');

  // ── Legacy v92 database upgrades to v93 ──
  closeDatabase();
  activeTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-migration-v93-upgrade-'));
  initDatabase();
  db = getDatabase();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 'second fresh install reaches schema v93');

  // Roll back to v92, as an install that predates suppliers would be.
  db.prepare('DROP TABLE suppliers').run();
  for (const indexName of expectedIndexes) {
    db.prepare(`DROP INDEX IF EXISTS ${indexName}`).run();
  }
  db.pragma('user_version = 92');
  assertEqual(getCurrentSchemaVersion(), 92, 'rolled back to v92 for the upgrade test');
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppliers'").get(), 'suppliers table removed before upgrade');

  runPendingMigrations();
  assertEqual(getCurrentSchemaVersion(), TARGET_VERSION, 'legacy v92 database upgrades to v93');
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suppliers'").get(), 'suppliers table exists after upgrade');
  assertEqual(
    tableColumns(getDatabase(), 'suppliers').length,
    expectedColumns.length,
    'upgraded suppliers table has the expected column count',
  );
  assertEqual(
    getDatabase().prepare('SELECT COUNT(*) AS n FROM suppliers').get().n,
    0,
    'upgraded suppliers table starts empty',
  );

  console.log('='.repeat(50));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
