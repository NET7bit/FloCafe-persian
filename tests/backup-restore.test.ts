import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isAutoBackupDue,
  isAutoBackupEnabled,
  pruneBackups,
  selectExpiredBackups,
  type ManagedBackupEntry,
} from '../main/services/backup-policy';

type Database = InstanceType<typeof DatabaseSync>;

const testDir = path.join(os.tmpdir(), 'flo-backup-test');

function cleanup() {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  fs.mkdirSync(testDir, { recursive: true });
}

function createTestDb(version: number = 8): void {
  const dbPath = path.join(testDir, `test-v${version}.db`);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
  if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO settings VALUES ('schema_version', '${version}');
    
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      old_field TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  db.exec(`INSERT INTO products VALUES ('p1', 'Test Product', 100.00, 'old value', datetime('now'))`);
  db.exec(`INSERT INTO categories VALUES ('c1', 'Test Category', datetime('now'))`);
  db.close();
}

function createCurrentSchemaDb(): Database {
  const dbPath = path.join(testDir, 'current.db');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
  if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = DELETE');
  
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO settings VALUES ('schema_version', '8');
    
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      cost REAL DEFAULT 0,
      new_field TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      total REAL DEFAULT 0
    );
    
    CREATE TABLE _flo_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  
  return db;
}

function getColumns(db: Database, table: string): string[] {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.map(c => c.name);
}

function getTables(db: Database): string[] {
  const tables = db.prepare(`
    SELECT name FROM sqlite_master WHERE type='table' 
    AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_flo_meta'
  `).all() as { name: string }[];
  return tables.map(t => t.name);
}

function addMetaToBackup(backupPath: string, schemaVersion: number) {
  const db = new DatabaseSync(backupPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS _flo_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  db.prepare(`INSERT OR REPLACE INTO _flo_meta VALUES ('schema_version', '${schemaVersion}')`).run();
  db.prepare(`INSERT OR REPLACE INTO _flo_meta VALUES ('backup_created_at', '${new Date().toISOString()}')`).run();
  db.prepare(`INSERT OR REPLACE INTO _flo_meta VALUES ('app_version', '${schemaVersion}')`).run();
  db.close();
}

function getSchemaVersionFromBackup(backupPath: string): number {
  const db = new DatabaseSync(backupPath, { open: true, readOnly: true });
  try {
    try {
      const meta = db.prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
      return meta ? parseInt(meta.value, 10) : 0;
    } catch {
      return 0;
    }
  } finally {
    db.close();
  }
}

// NOTE: This is a simplified reimplementation of the production dataOnlyRestore logic.
// The production function (main/db.ts) is NOT exported (private) and uses better-sqlite3,
// while this test uses node:sqlite (built-in). Both test the same concept: handling schema
// mismatches between backup and current database. To test the production function directly,
// it would need to be exported and this test migrated to use better-sqlite3.
function dataOnlyRestore(backupPath: string, targetDb: Database): { success: boolean; tablesRestored: number; error?: string } {
  if (fs.existsSync(backupPath + '-wal')) fs.unlinkSync(backupPath + '-wal');
  if (fs.existsSync(backupPath + '-shm')) fs.unlinkSync(backupPath + '-shm');

  let backupDb: Database | null = null;
  try {
    backupDb = new DatabaseSync(backupPath, { open: true, readOnly: true });
    const backupTables = getTables(backupDb);
    const backupData: Record<string, any[]> = {};
    
    for (const t of backupTables) {
      backupData[t] = backupDb.prepare(`SELECT * FROM ${t}`).all();
    }
    backupDb.close();
    backupDb = null;
    
    const currentTables = getTables(targetDb);
    const commonTables = backupTables.filter(t => currentTables.includes(t));
    
    let tablesRestored = 0;
    
    targetDb.exec('BEGIN IMMEDIATE');
    
    for (const tableName of commonTables) {
      const rows = backupData[tableName] || [];
      if (rows.length === 0) continue;
      
      const backupCols = Object.keys(rows[0]);
      const currentCols = getColumns(targetDb, tableName);
      const commonCols = backupCols.filter(c => currentCols.includes(c));
      
      if (commonCols.length === 0) continue;
      
      targetDb.exec(`DELETE FROM ${tableName}`);
      
      const colList = commonCols.join(', ');
      const placeholders = commonCols.map(() => '?').join(', ');
      const insertStmt = targetDb.prepare(`INSERT INTO ${tableName} (${colList}) VALUES (${placeholders})`);
      
      for (const row of rows) {
        insertStmt.run(...commonCols.map(col => row[col]));
      }
      
      console.log(`   Restored ${tableName}: ${rows.length} rows`);
      tablesRestored++;
    }
    
    targetDb.exec('COMMIT');
    return { success: true, tablesRestored };
  } catch (error: any) {
    targetDb.exec('ROLLBACK');
    return { success: false, tablesRestored: 0, error: error.message };
  } finally {
    if (backupDb) backupDb.close();
  }
}

// ── Assertion Helpers ────────────────────────────────────────────────────────

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

// ── Tests ───────────────────────────────────────────────────────────────────

console.log('🧪 FloDesktop Backup/Restore Tests\n');
console.log('='.repeat(50));

cleanup();

console.log('\n📁 Test 1: Backup contains schema version metadata');
createTestDb(8);
const backupPath = path.join(testDir, 'backup-with-meta.db');
fs.copyFileSync(path.join(testDir, 'test-v8.db'), backupPath);
addMetaToBackup(backupPath, 8);

const extractedVersion = getSchemaVersionFromBackup(backupPath);
assertEqual(extractedVersion, 8, 'schema version in backup is 8');

console.log('\n📁 Test 2: Data-only restore with schema mismatch');
const currentDb = createCurrentSchemaDb();

const result = dataOnlyRestore(backupPath, currentDb);
assertEqual(result.success, true, 'data-only restore returns success');
assert(result.tablesRestored > 0, `at least 1 table restored (got ${result.tablesRestored})`);

const restoredProducts = currentDb.prepare(`SELECT * FROM products WHERE id = 'p1'`).get() as any;
assert(restoredProducts !== undefined, 'restored product exists');
if (restoredProducts) {
  assertEqual(restoredProducts.name, 'Test Product', 'product name preserved');
  assertEqual(restoredProducts.price, 100.00, 'product price preserved (₹100)');
  assert(restoredProducts.old_field === undefined || restoredProducts.old_field === null,
    "old_field not present or null (new schema doesn't have it)");
  assert(restoredProducts.new_field === null,
    'new_field is NULL (old backup had no such column)');
}

console.log('\n📁 Test 3: Version detection on old backup');
createTestDb(5);
const oldBackup = path.join(testDir, 'old-backup.db');
fs.copyFileSync(path.join(testDir, 'test-v5.db'), oldBackup);
addMetaToBackup(oldBackup, 5);

const oldVersion = getSchemaVersionFromBackup(oldBackup);
assertEqual(oldVersion, 5, 'old backup detected as version 5');

console.log('\n📁 Test 4: Invalid backup detection');
const invalidBackup = path.join(testDir, 'invalid-backup.db');
const invalidDb = new DatabaseSync(invalidBackup);
invalidDb.exec(`CREATE TABLE products (id TEXT)`);
invalidDb.close();

const invalidVersion = getSchemaVersionFromBackup(invalidBackup);
assertEqual(invalidVersion, 0, 'invalid backup (no _flo_meta) returns version 0');

console.log('\n📁 Test 5: local backup retention and schedule policy');

const policyNow = Date.UTC(2026, 9, 8, 12, 0, 0);
const aged = (count: number, baseAgeHours: number, prefix = 'flo-backup') => Array.from({ length: count }, (_, index) => ({
  fileName: `${prefix}-${index}.db`,
  createdAt: new Date(policyNow - (baseAgeHours + index) * 3600_000).toISOString(),
}));

const agedEntries = aged(20, 48);
const expiredEntries = selectExpiredBackups(agedEntries, { keep: 14, minAgeHours: 24, now: policyNow });
assertEqual(expiredEntries.length, 6, 'retention selects only what exceeds the newest 14 copies');
assertEqual(expiredEntries.some((entry) => agedEntries.slice(0, 14).includes(entry)), false, 'the newest 14 backups are never selected for pruning');

const freshEntries = Array.from({ length: 30 }, (_, index) => ({
  fileName: `fresh-${index}.db`,
  createdAt: new Date(policyNow - index * 60_000).toISOString(),
}));
assertEqual(selectExpiredBackups(freshEntries, { keep: 5, minAgeHours: 24, now: policyNow }).length, 0, 'nothing younger than the minimum age is pruned');
assertEqual(selectExpiredBackups(freshEntries, { keep: 5, minAgeHours: 0, now: policyNow }).length, 25, 'with no age floor the policy still keeps the newest 5');
assertEqual(selectExpiredBackups(agedEntries, { keep: 0, minAgeHours: 24, now: policyNow }).length, 19, 'keep is clamped to at least one backup');
assertEqual(selectExpiredBackups(agedEntries, { keep: 500, minAgeHours: 24, now: policyNow }).length, 0, 'keep is clamped to the policy maximum');

const unreadable = [...aged(16, 48), { fileName: 'flo-backup-bad.db', createdAt: 'not-a-date' }];
assertEqual(selectExpiredBackups(unreadable, { keep: 14, minAgeHours: 24, now: policyNow }).some((entry) => entry.fileName === 'flo-backup-bad.db'), false, 'a backup with unreadable metadata is never pruned');

assertEqual(isAutoBackupEnabled('true'), true, 'the schedule is on only when the operator opts in');
assertEqual(isAutoBackupEnabled(' TRUE '), true, 'the opt-in setting is read case-insensitively');
assertEqual(isAutoBackupEnabled('false'), false, 'an explicit off value keeps the schedule off');
assertEqual(isAutoBackupEnabled(null), false, 'an absent setting keeps the schedule off');
assertEqual(isAutoBackupDue(null, policyNow), true, 'a missing stamp means the first automatic backup is due');
assertEqual(isAutoBackupDue('not-a-date', policyNow), true, 'an unreadable stamp can never silently disable backups');
assertEqual(isAutoBackupDue(new Date(policyNow - 3600_000).toISOString(), policyNow), false, 'a fresh stamp is not due inside the interval');
assertEqual(isAutoBackupDue(new Date(policyNow - 25 * 3600_000).toISOString(), policyNow), true, 'a stamp older than the interval is due');

const prunedNames: string[] = [];
const pruneResult = pruneBackups({
  listBackups: () => aged(17, 48),
  deleteBackup: (fileName: string) => {
    if (fileName.endsWith('15.db')) throw new Error('file is locked');
    prunedNames.push(fileName);
  },
}, { keep: 14, minAgeHours: 24, now: policyNow });
assertEqual(pruneResult.deleted.length, 2, 'prune removes every expired backup it can');
assertEqual(pruneResult.failed.length, 1, 'a locked backup is reported instead of aborting the prune');
assertEqual(prunedNames.length, 2, 'only successfully deleted backups are reported as deleted');
const scanFailure = pruneBackups({
  listBackups: (): readonly ManagedBackupEntry[] => { throw new Error('backups directory unavailable'); },
  deleteBackup: () => { throw new Error('deleteBackup must not run when the scan fails'); },
});
assertEqual(scanFailure.deleted.length, 0, 'a failing retention scan never throws');
assertEqual(scanFailure.failed.length, 0, 'a failing retention scan reports no deletions');

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(50));
console.log(`${passed}/${total} passed, ${failed} failed`);

currentDb.close();
cleanup();

process.exit(failed === 0 ? 0 : 1);

