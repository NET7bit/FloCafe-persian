/**
 * Migration v104 coverage: `add_cogs_accounting`.
 *
 * Verifies the frozen cost columns on `supply_movements`, the widened
 * `source_module` CHECK (`cogs` accepted, unknown modules still rejected), the
 * data-preserving rebuild of `journal_entries`, the seeded `5100` account,
 * retained indexes and UNIQUE idempotency, and idempotent re-runs. The full
 * legacy upgrade path is covered by `test:upgrade-path`.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-v104-cogs.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cogs-migration-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { MIGRATIONS } = require('../main/db');
const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
// Locate by name (not version) so the lookup survives migration renumbering.
const target = MIGRATIONS.find((m: any) => m.name === 'add_cogs_accounting');

let passed = 0;
let failed = 0;
function assert(condition: unknown, message: string): void {
  if (!condition) {
    console.error(`  ✗ ${message}`);
    failed++;
  } else {
    console.log(`  ✓ ${message}`);
    passed++;
  }
}
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function getDb(): any {
  return (require('../main/db') as any).getDatabase();
}

async function main() {
  console.log(`Migration v${TARGET_VERSION} (add_cogs_accounting) test`);
  console.log('='.repeat(52));
  assertEqual(!!target, true, 'the add_cogs_accounting migration is registered');
  assertEqual(target.name, 'add_cogs_accounting', 'the migration is named add_cogs_accounting');

  // ── Fresh install: all migrations from v1 ──
  const { initDatabase } = require('../main/db');
  initDatabase();
  const db = getDb();

  // Frozen cost columns exist and are nullable (no backfill of history).
  const movementCols = db.prepare('PRAGMA table_info(supply_movements)').all() as Array<{ name: string; notnull: number }>;
  const columnNames = movementCols.map((c) => c.name);
  assert(columnNames.includes('unit_cost'), 'supply_movements defines unit_cost');
  assert(columnNames.includes('total_cost'), 'supply_movements defines total_cost');
  assertEqual(movementCols.find((c) => c.name === 'unit_cost')!.notnull, 0, 'unit_cost is nullable (pre-migration movements carry no cost)');

  // COGS account seeded.
  const cogsAccount: any = db.prepare("SELECT * FROM accounting_accounts WHERE code = '5100'").get();
  assert(!!cogsAccount, 'account 5100 is seeded');
  assertEqual(cogsAccount.type, 'expense', '5100 is an expense account');
  assertEqual(cogsAccount.normal_side, 'debit', '5100 is a debit-balance account');

  // The rebuilt CHECK accepts cogs.
  db.prepare(`
    INSERT INTO journal_entries (id, entry_date, source_module, source_id, seq, created_at)
    VALUES ('cg1', '2026-01-01', 'cogs', '7', 1, '2026-01-01 00:00:00')
  `).run();
  assert(true, 'source_module CHECK accepts cogs');

  let threw = false;
  try {
    db.prepare(`
      INSERT INTO journal_entries (id, entry_date, source_module, source_id, seq, created_at)
      VALUES ('jx', '2026-01-01', 'production', 'p-1', 1, '2026-01-01 00:00:00')
    `).run();
  } catch { threw = true; }
  assert(threw, 'source_module CHECK still rejects unknown modules');

  // UNIQUE idempotency and NULL coexistence survived the rebuild.
  threw = false;
  try {
    db.prepare(`
      INSERT INTO journal_entries (id, entry_date, source_module, source_id, seq, created_at)
      VALUES ('cg2', '2026-01-01', 'cogs', '7', 1, '2026-01-01 00:00:00')
    `).run();
  } catch { threw = true; }
  assert(threw, 'UNIQUE (source_module, source_id, seq) is retained');
  db.prepare(`
    INSERT INTO journal_entries (id, entry_date, source_module, source_id, seq, created_at)
    VALUES ('m1', '2026-01-05', 'manual', NULL, 1, '2026-01-05 00:00:00')
  `).run();
  db.prepare(`
    INSERT INTO journal_entries (id, entry_date, source_module, source_id, seq, created_at)
    VALUES ('m2', '2026-01-05', 'manual', NULL, 1, '2026-01-05 00:00:00')
  `).run();
  assert(true, 'NULL source_id rows still coexist (manual journals)');

  const journalIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'journal_entries'").all().map((r: any) => r.name);
  for (const name of ['idx_journal_entries_module_source', 'idx_journal_entries_date', 'idx_journal_entries_status', 'idx_journal_entries_reverses', 'idx_journal_entries_created_by']) {
    assert(journalIndexes.includes(name), `index ${name} survived the rebuild`);
  }
  assertEqual(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'rebuild left no foreign-key violations');
  assertEqual(Number(db.pragma('foreign_keys', { simple: true })), 1, 'foreign_keys are ON after the pipeline');

  // ── Idempotent re-run preserves data ──
  const journalsBefore = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n;
  let rerunFailed = false;
  try { target.up(); target.up(); } catch { rerunFailed = true; }
  assert(!rerunFailed, 're-running the migration is idempotent');
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n, journalsBefore, 're-run preserves existing journal rows');
  assertEqual((db.prepare("SELECT COUNT(*) AS n FROM accounting_accounts WHERE code = '5100'").get() as any).n, 1, 're-run does not duplicate account 5100');

  // Pre-migration movements keep NULL cost (no fabricated snapshot).
  db.prepare("INSERT INTO supplies (id, name, base_unit, stock_quantity, is_active, created_at, updated_at) VALUES ('sup-legacy', 'Legacy', 'g', 0, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')").run();
  db.prepare("INSERT INTO users (id, name, password, role, is_active, created_at, updated_at) VALUES ('u-legacy', 'Owner', '', 'owner', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')").run();
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, actor_user_id, reference_type, reference_id, created_at)
    VALUES ('sup-legacy', -5, 'recipe_depletion', 'g', -5, 'u-legacy', 'order_item', '99', '2026-01-01 00:00:00')
  `).run();
  target.up();
  const legacyMovement: any = db.prepare("SELECT unit_cost, total_cost FROM supply_movements WHERE supply_id = 'sup-legacy'").get();
  assertEqual(legacyMovement.unit_cost, null, 're-run never backfills a cost onto a pre-migration movement');
  assertEqual(legacyMovement.total_cost, null, 're-run never backfills a total cost onto a pre-migration movement');

  console.log('='.repeat(52));
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
