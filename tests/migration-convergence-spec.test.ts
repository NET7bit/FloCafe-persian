/**
 * Convergence contract for the upstream v93-v98 catch-up and the fork renumbering.
 *
 * This fork reassigned version numbers 93-98, so every database in its lineage
 * was missing the six object groups those upstream migrations create. The fix
 * restores upstream v93-v98, adds catch-up migration v1001, and moves the fork
 * migrations to 1002-1012. This test proves, against the real migration chain:
 *   - a fresh install and every legacy starting state converge to the tail;
 *   - the whatsapp_messages rebuild preserves rows across all columns;
 *   - the legacy-fork re-run never loses representative financial data;
 *   - the registry gate refuses an invalid registry and a newer database;
 *   - an ambiguous whatsapp state stops the migration instead of guessing;
 *   - a leftover whatsapp_messages_v95 that still holds rows is never dropped.
 *
 * Fixtures are built by capping the *real* MIGRATIONS array (the same technique
 * as scripts/generate-upgrade-fixture.ts), never by lowering user_version on a
 * complete schema. The "legacy fork" fixtures apply the shared v1-v92 chain
 * plus the fork migrations 1002-1012 while withholding upstream v93-v98 and the
 * v1001 catch-up -- exactly the shape the pre-renumber fork registry produced --
 * then report the old fork number via user_version.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/migration-convergence-spec.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-convergence-'));
const dbPath = path.join(testDir, 'flo.db');
// Bypasses the packaged missing-database guard so the test can rebuild flo.db
// repeatedly in one process.
process.env.FLO_E2E_DB_PATH = dbPath;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const Database = require('better-sqlite3');
const dbModule = require('../main/db');
const { MIGRATIONS, SchemaVersionMismatchError } = dbModule;

const ALL: { version: number; name: string }[] = MIGRATIONS.slice();
const TAIL = ALL[ALL.length - 1].version;
const CATCH_UP = 1001;
// Each migration commits in its own transaction, so when the catch-up fails the
// recorded version is the last migration that actually completed.
const LAST_BEFORE_CATCH_UP = ALL.filter((m) => m.version < CATCH_UP).map((m) => m.version).pop() as number;
const SHARED_MAX = 92;
// Old fork number -> new fork number (see docs/ migration renumbering table).
const FORK_NEW: Record<number, number> = { 93: 1002, 95: 1004, 98: 1007, 99: 1008, 104: 1012 };
const UPSTREAM_TABLES = [
  'role_permission_overrides',
  'user_permission_overrides',
  'authorization_audit_log',
  'local_diagnostics',
  'category_addon_groups',
];

let passed = 0;
let failed = 0;

function ok(condition: unknown, label: string): boolean {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
  return !!condition;
}

function eq(actual: unknown, expected: unknown, label: string): boolean {
  return ok(Object.is(actual, expected), `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function deepEq(actual: unknown, expected: unknown, label: string): boolean {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    console.error(`    actual:   ${JSON.stringify(actual).slice(0, 400)}`);
    console.error(`    expected: ${JSON.stringify(expected).slice(0, 400)}`);
  }
  return ok(same, label);
}

// ── registry capping (real chain, real DDL) ─────────────────────────────────

function setRegistry(versions: number[]): void {
  MIGRATIONS.length = 0;
  for (const version of versions) {
    const migration = ALL.find((m) => m.version === version);
    if (migration) MIGRATIONS.push(migration as any);
  }
}

function restoreRegistry(): void {
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...(ALL as any));
}

const sharedVersions = (): number[] => ALL.filter((m) => m.version <= SHARED_MAX).map((m) => m.version);
const throughVersion = (cap: number): number[] => ALL.filter((m) => m.version <= cap).map((m) => m.version);
// shared v1-v92 + fork migrations 1002..newVersion, withholding upstream v93-v98 and v1001.
const legacyForkVersions = (newVersion: number): number[] =>
  ALL.filter((m) => m.version <= SHARED_MAX || (m.version >= 1002 && m.version <= newVersion)).map((m) => m.version);

function resetFile(): void {
  try { dbModule.closeDatabase(); } catch { /* not open */ }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
}

function open(): any {
  dbModule.initDatabase();
  return dbModule.getDatabase();
}

function close(): void {
  try { dbModule.closeDatabase(); } catch { /* already closed */ }
}

const uv = (db: any): number => Number(db.pragma('user_version', { simple: true }));
const fkViolations = (db: any): number => db.prepare('PRAGMA foreign_key_check').all().length;

function tableExists(db: any, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

function hasColumn(db: any, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

/** kind exists in both whatsapp shapes; only the stored CHECK token distinguishes them. */
function acceptsZReport(db: any): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_messages'").get() as { sql: string } | undefined;
  return row?.sql?.includes("'z_report'") ?? false;
}

// The two historical whatsapp_messages shapes; only the kind CHECK differs.
const WHATSAPP_OLD_DDL = `CREATE TABLE whatsapp_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id INTEGER REFERENCES bills(id),
  customer_id TEXT REFERENCES customers(id),
  phone_e164 TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  kind TEXT NOT NULL DEFAULT 'manual_reply' CHECK (kind IN ('bill_receipt','manual_reply','auto_followup')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','seen','typing','sent','delivered','read','failed')),
  body TEXT NOT NULL,
  external_message_id TEXT,
  error TEXT,
  queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
  seen_at TEXT,
  typing_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  read_at TEXT,
  failed_at TEXT,
  created_by_user_id TEXT
)`;
const WHATSAPP_WIDENED_DDL = WHATSAPP_OLD_DDL.replace("'auto_followup'))", "'auto_followup','z_report'))");

function insertWhatsappRow(db: any, table: string, phone: string, body: string): void {
  db.prepare(`INSERT INTO ${table} (phone_e164, direction, kind, status, body) VALUES (?, 'outbound', 'manual_reply', 'queued', ?)`).run(phone, body);
}

function missingUpstreamGroups(db: any): string[] {
  const missing: string[] = [];
  for (const table of UPSTREAM_TABLES) if (!tableExists(db, table)) missing.push(table);
  if (!hasColumn(db, 'orders', 'delivery_address')) missing.push('orders.delivery_address');
  if (!acceptsZReport(db)) missing.push("whatsapp_messages 'z_report'");
  return missing;
}

function assertConverged(db: any, label: string): void {
  eq(uv(db), TAIL, `${label}: reaches the registry tail`);
  const missing = missingUpstreamGroups(db);
  ok(missing.length === 0, `${label}: all six upstream groups exist${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
  eq(fkViolations(db), 0, `${label}: no foreign-key violations`);
}

// ── scenarios ───────────────────────────────────────────────────────────────

function scenarioFreshInstall(): void {
  console.log('\n[1] fresh install → tail');
  resetFile();
  restoreRegistry();
  const db = open();
  eq(uv(db), TAIL, 'fresh install reaches the registry tail');
  assertConverged(db, 'fresh install');
  close();
}

function scenarioUpstreamV92(): void {
  console.log('\n[2] upstream v92 fixture → tail');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  eq(uv(fixture), SHARED_MAX, 'the capped chain stops at v92');
  for (const table of UPSTREAM_TABLES) ok(!tableExists(fixture, table), `v92 fixture lacks ${table}`);
  ok(!acceptsZReport(fixture), "v92 fixture rejects 'z_report' (pre-v96 CHECK)");
  eq(fkViolations(fixture), 0, 'v92 fixture is foreign-key clean');
  close();

  restoreRegistry();
  assertConverged(open(), 'v92 → tail');
  close();
}

function scenarioUpstreamV98(): void {
  console.log('\n[3] upstream v98 fixture → tail');
  resetFile();
  setRegistry(throughVersion(98));
  const fixture = open();
  eq(uv(fixture), 98, 'the capped chain stops at v98');
  ok(missingUpstreamGroups(fixture).length === 0, 'the v98 fixture already carries all six upstream groups');
  ok(acceptsZReport(fixture), "the v98 fixture accepts 'z_report'");
  close();

  restoreRegistry();
  assertConverged(open(), 'v98 → tail');
  close();
}

function scenarioLegacyForkLineages(): void {
  console.log('\n[4] legacy fork lineages → tail (missing upstream objects)');
  for (const oldVersion of Object.keys(FORK_NEW).map(Number)) {
    resetFile();
    setRegistry(legacyForkVersions(FORK_NEW[oldVersion]));
    const fixture = open();
    fixture.pragma(`user_version = ${oldVersion}`);
    eq(uv(fixture), oldVersion, `legacy fork reports v${oldVersion}`);
    ok(!tableExists(fixture, 'role_permission_overrides'), `legacy fork v${oldVersion} lacks the upstream permission tables`);
    ok(!acceptsZReport(fixture), `legacy fork v${oldVersion} rejects 'z_report'`);
    close();

    restoreRegistry();
    assertConverged(open(), `legacy fork v${oldVersion} → tail`);
    ok(acceptsZReport(dbModule.getDatabase()), `legacy fork v${oldVersion} → tail accepts 'z_report'`);
    close();
  }
}

function snapshot(db: any): Record<string, unknown> {
  const rows = (sql: string) => db.prepare(sql).all();
  return {
    suppliers: rows('SELECT id, name, code FROM suppliers ORDER BY id'),
    purchase_invoices: rows('SELECT id, invoice_number, total, balance, status FROM purchase_invoices ORDER BY id'),
    purchase_invoice_items: rows('SELECT id, quantity, unit, unit_price, total FROM purchase_invoice_items ORDER BY id'),
    supplier_payments: rows('SELECT id, amount, payment_method FROM supplier_payments ORDER BY id'),
    purchase_returns: rows('SELECT id, return_number, total, status FROM purchase_returns ORDER BY id'),
    expenses: rows('SELECT id, category, amount FROM expenses ORDER BY id'),
    receivable_entries: rows('SELECT id, entry_type, direction, amount FROM receivable_entries ORDER BY id'),
    fiscal_periods: rows('SELECT id, period_type, status FROM fiscal_periods ORDER BY id'),
    supplies: rows('SELECT id, cost_price, stock_quantity FROM supplies ORDER BY id'),
    supply_movements: rows('SELECT id, supply_id, quantity_delta, stock_after FROM supply_movements ORDER BY id'),
    journal_entries: rows('SELECT id, source_module, source_id, seq FROM journal_entries ORDER BY id'),
    journal_entry_lines: rows('SELECT id, journal_id, account_id, direction, amount FROM journal_entry_lines ORDER BY id'),
    orders: rows('SELECT order_number, customer_id, total, status FROM orders WHERE order_number = \'ORD-CONV-1\''),
    whatsapp_messages: rows('SELECT id, phone_e164, direction, kind, status, body, created_by_user_id FROM whatsapp_messages ORDER BY id'),
  };
}

const journalBalance = (db: any): number =>
  (db.prepare(`SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS balance FROM journal_entry_lines`).get() as any).balance;

function seedRepresentativeData(db: any): void {
  db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run('cust-conv', 'Convergence Customer');
  db.prepare('INSERT INTO users (id, name, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('user-conv', 'Convergence User', '', 'owner', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
  db.prepare('INSERT INTO suppliers (id, name, code) VALUES (?, ?, ?)').run('supp-conv', 'Convergence Supplier', 'SUP-CONV');
  db.prepare('INSERT INTO supplies (id, name, base_unit, stock_quantity, is_active, created_at, updated_at, cost_price) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
    .run('sup-conv', 'Convergence Supply', 'g', 1000, '2026-01-01 00:00:00', '2026-01-01 00:00:00', 0.02);
  db.prepare('INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, total, balance, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('pi-conv', 'PI-CONV', 'supp-conv', '2026-01-02', 20, 10, 'partially_paid', '2026-01-02 00:00:00', '2026-01-02 00:00:00');
  db.prepare('INSERT INTO purchase_invoice_items (id, purchase_invoice_id, supply_id, quantity, unit, unit_price, total) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('pii-conv', 'pi-conv', 'sup-conv', 1000, 'g', 0.02, 20);
  db.prepare('INSERT INTO supplier_payments (id, supplier_id, purchase_invoice_id, amount, payment_method, paid_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('spay-conv', 'supp-conv', 'pi-conv', 10, 'cash', '2026-01-03 00:00:00');
  db.prepare('INSERT INTO purchase_returns (id, return_number, purchase_invoice_id, supplier_id, return_date, total, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('pret-conv', 'PR-CONV', 'pi-conv', 'supp-conv', '2026-01-04', 5, 'completed');
  db.prepare('INSERT INTO expenses (id, category, amount, payment_method, expense_date) VALUES (?, ?, ?, ?, ?)')
    .run('exp-conv', 'supplies', 7.5, 'cash', '2026-01-05');
  db.prepare('INSERT INTO receivable_entries (id, customer_id, entry_type, direction, amount, entry_date) VALUES (?, ?, ?, ?, ?, ?)')
    .run('rec-conv', 'cust-conv', 'charge', 'debit', 12, '2026-01-06');
  db.prepare('INSERT INTO fiscal_periods (id, period_type, start_date, end_date, status, name) VALUES (?, ?, ?, ?, ?, ?)')
    .run('fp-conv', 'month', '2026-01-01', '2026-01-31', 'open', 'January 2026');
  db.prepare('INSERT INTO journal_entries (id, entry_date, source_module, source_id, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('je-conv', '2026-01-02', 'purchases', 'pi-conv', 1, '2026-01-02 00:00:00');
  db.prepare('INSERT INTO journal_entry_lines (id, journal_id, account_id, direction, amount) VALUES (?, ?, ?, ?, ?)')
    .run('jel-conv-1', 'je-conv', 'acct_1200', 'debit', 20);
  db.prepare('INSERT INTO journal_entry_lines (id, journal_id, account_id, direction, amount) VALUES (?, ?, ?, ?, ?)')
    .run('jel-conv-2', 'je-conv', 'acct_2000', 'credit', 20);
  db.prepare('INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, actor_user_id, reference_type, reference_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('sup-conv', 1000, 'receive', 'g', 1000, 'user-conv', 'purchase_invoice', 'pi-conv', '2026-01-02 00:00:00');
  db.prepare('INSERT INTO orders (order_number, customer_id, user_id, subtotal, total, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run('ORD-CONV-1', 'cust-conv', 'user-conv', 10, 10, 'completed');
  db.prepare('INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('+10000000001', 'outbound', 'bill_receipt', 'sent', 'receipt body', 'user-conv');
  db.prepare('INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body) VALUES (?, ?, ?, ?, ?)')
    .run('+10000000002', 'inbound', 'manual_reply', 'read', 'reply body');
}

function scenarioFinancialPreservation(): void {
  console.log('\n[5] legacy fork v104 with representative data → tail (data preserved, re-run safe)');
  resetFile();
  setRegistry(legacyForkVersions(1012));
  const fixture = open();
  fixture.pragma('user_version = 104');
  seedRepresentativeData(fixture);
  const before = snapshot(fixture);
  const balanceBefore = journalBalance(fixture);
  eq(balanceBefore, 0, 'the seeded ledger starts balanced');
  eq((before.whatsapp_messages as any[]).length, 2, 'two whatsapp rows were seeded');
  close();

  restoreRegistry();
  const migrated = open();
  assertConverged(migrated, 'legacy fork v104 → tail');
  eq(uv(migrated), TAIL, 'the migrated database sits at the tail');
  deepEq(snapshot(migrated), before, 'every representative financial/inventory/whatsapp row survives the renumber re-run');
  eq(journalBalance(migrated), balanceBefore, 'journal entries stay balanced across the re-run');
  eq((migrated.prepare("SELECT COUNT(*) AS n FROM accounting_accounts WHERE code = '5100'").get() as any).n, 1, 'the cogs account is not duplicated by the re-run');
  eq((migrated.prepare("SELECT cost_price FROM supplies WHERE id = 'sup-conv'").get() as any).cost_price, 0.02, 'the maintained cost_price is not clobbered by the v1006 re-run');
  ok(acceptsZReport(migrated), "the migrated whatsapp table accepts 'z_report'");
  close();

  // ── Re-opening an already-migrated database must be a no-op ──
  console.log('\n[6] re-run of the upgrade path is a no-op at the tail');
  const reopened = open();
  eq(uv(reopened), TAIL, 're-opening keeps the schema at the tail');
  deepEq(snapshot(reopened), before, 're-opening preserves every representative row');
  close();
}

function scenarioVersionAboveTail(): void {
  console.log('\n[7] a database newer than this build is refused');
  resetFile();
  restoreRegistry();
  const db = open();
  db.pragma(`user_version = ${TAIL + 1}`);
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof SchemaVersionMismatchError, `a version above the tail raises SchemaVersionMismatchError (${error?.name})`);
  close();
}

function scenarioLeftoverTempTable(): void {
  console.log('\n[8] leftover temp table from a crashed rebuild is recovered');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  fixture.prepare("INSERT INTO whatsapp_messages (phone_e164, direction, kind, status, body) VALUES ('+19990000000', 'outbound', 'manual_reply', 'queued', 'keep me')").run();
  // Crash between RENAME and CREATE leaves the main table missing.
  fixture.exec('ALTER TABLE whatsapp_messages RENAME TO whatsapp_messages_v95');
  fixture.pragma('user_version = 95');
  close();

  restoreRegistry();
  const migrated = open();
  assertConverged(migrated, 'crashed rebuild → tail');
  ok(tableExists(migrated, 'whatsapp_messages'), 'whatsapp_messages is restored from the leftover temp');
  ok(!tableExists(migrated, 'whatsapp_messages_v95'), 'the leftover temp table is gone');
  const row = migrated.prepare("SELECT kind, status, body FROM whatsapp_messages WHERE phone_e164 = '+19990000000'").get() as any;
  eq(row?.body, 'keep me', 'the stranded row survives recovery');
  eq(row?.kind, 'manual_reply', 'the stranded row keeps its kind');
  close();
}

function scenarioAmbiguousRebuildStops(): void {
  console.log('\n[9] an ambiguous whatsapp rebuild state stops instead of guessing');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  // main table without 'kind' AND a leftover temp: undecidable, must refuse.
  fixture.exec(`
    DROP TABLE whatsapp_messages;
    CREATE TABLE whatsapp_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_e164 TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE whatsapp_messages_v95 (id INTEGER PRIMARY KEY AUTOINCREMENT, phone_e164 TEXT NOT NULL, body TEXT NOT NULL);
    INSERT INTO whatsapp_messages (phone_e164, body) VALUES ('+1', 'ambiguous');
  `);
  fixture.pragma('user_version = 95');
  close();

  restoreRegistry();
  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error && /ambiguous/i.test(error.message), 'the migration refuses an ambiguous whatsapp state');
  close();

  const raw = new Database(dbPath, { readonly: true });
  const versionAfterFailure = Number(raw.pragma('user_version', { simple: true }));
  const rowSurvived = !!raw.prepare("SELECT 1 FROM whatsapp_messages WHERE phone_e164 = '+1'").get();
  raw.close();
  eq(versionAfterFailure, 95, 'the failed migration did not advance the schema version');
  ok(rowSurvived, 'the preserved row is still present after the refused migration');
}

// A — both whatsapp tables exist and hold distinct rows: the leftover must not
// be dropped, and nothing may be lost or advanced.
function scenarioBothTablesWithData(): void {
  console.log('\n[11] both whatsapp tables hold distinct data → stop and preserve');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  insertWhatsappRow(fixture, 'whatsapp_messages', '+19900000001', 'leftover-row');
  fixture.exec('ALTER TABLE whatsapp_messages RENAME TO whatsapp_messages_v95');
  fixture.exec(WHATSAPP_OLD_DDL);
  insertWhatsappRow(fixture, 'whatsapp_messages', '+19900000002', 'main-row');
  fixture.pragma('user_version = 95');
  const versionBefore = uv(fixture);
  close();

  restoreRegistry();
  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'the migration stops when both tables hold distinct rows');
  ok(/whatsapp_messages_v95/.test(error?.message ?? ''), 'the diagnostic names the conflicting leftover table');
  eq(error?.code, 'MIGRATION_CONVERGENCE_BLOCKED', 'the whatsapp conflict also reports the structured blocked code');
  ok(error?.problems?.some((p: any) => p.object === 'whatsapp_messages_v95' && typeof p.objectType === 'string'),
    'the whatsapp conflict reports the conflicting table as a structured problem');
  ok(/Blocked upgrade: v96/.test(require('../main/startup-failure').describeStartupFailure(error).body),
    'the startup dialog names the owning migration for the whatsapp conflict');

  const raw = new Database(dbPath, { readonly: true });
  ok(tableExists(raw, 'whatsapp_messages'), 'the main table is preserved');
  ok(tableExists(raw, 'whatsapp_messages_v95'), 'the leftover table is preserved');
  eq((raw.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages_v95 WHERE body = 'leftover-row'").get() as any).n, 1, 'the leftover row is preserved untouched');
  eq((raw.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE body = 'main-row'").get() as any).n, 1, 'the main row is preserved untouched');
  eq(Number(raw.pragma('user_version', { simple: true })), versionBefore, 'the failed migration did not advance the schema version');
  raw.close();
  close();
}

// B — main may already be complete, but a non-empty leftover still blocks.
function scenarioCompleteMainWithLeftoverData(): void {
  console.log('\n[12] complete main + leftover with data → stop and preserve');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  insertWhatsappRow(fixture, 'whatsapp_messages', '+19900000003', 'leftover-row');
  fixture.exec('ALTER TABLE whatsapp_messages RENAME TO whatsapp_messages_v95');
  fixture.exec(WHATSAPP_WIDENED_DDL);
  insertWhatsappRow(fixture, 'whatsapp_messages', '+19900000004', 'main-row');
  fixture.pragma('user_version = 95');
  ok(acceptsZReport(fixture), 'the main table already accepts z_report');
  const versionBefore = uv(fixture);
  close();

  restoreRegistry();
  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'a complete main does not license dropping a non-empty leftover');
  const raw = new Database(dbPath, { readonly: true });
  ok(tableExists(raw, 'whatsapp_messages_v95'), 'the non-empty leftover is preserved');
  eq((raw.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages_v95 WHERE body = 'leftover-row'").get() as any).n, 1, 'the leftover row is preserved');
  eq(Number(raw.pragma('user_version', { simple: true })), versionBefore, 'the schema version is unchanged');
  raw.close();
  close();
}

// C1 — a provably empty leftover is dropped, then the old-shape main is rebuilt.
function scenarioEmptyLeftoverWithOldMain(): void {
  console.log('\n[13] empty leftover + old-shape main → drop leftover, rebuild main');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  fixture.exec('ALTER TABLE whatsapp_messages RENAME TO whatsapp_messages_v95');
  fixture.exec('DELETE FROM whatsapp_messages_v95');
  fixture.exec(WHATSAPP_OLD_DDL);
  insertWhatsappRow(fixture, 'whatsapp_messages', '+19900000006', 'main-row');
  fixture.pragma('user_version = 95');
  close();

  restoreRegistry();
  const migrated = open();
  assertConverged(migrated, 'empty leftover + old main → tail');
  ok(!tableExists(migrated, 'whatsapp_messages_v95'), 'the empty leftover is removed');
  ok(acceptsZReport(migrated), "the rebuilt main table accepts 'z_report'");
  eq((migrated.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE body = 'main-row'").get() as any).n, 1, 'the main row survives the rebuild');
  close();
}

// C2 — a provably empty leftover is dropped without rebuilding a complete main.
function scenarioEmptyLeftoverWithCompleteMain(): void {
  console.log('\n[14] empty leftover + complete main → drop leftover, no rebuild');
  resetFile();
  setRegistry(sharedVersions());
  const fixture = open();
  fixture.exec('ALTER TABLE whatsapp_messages RENAME TO whatsapp_messages_v95');
  fixture.exec('DELETE FROM whatsapp_messages_v95');
  fixture.exec(WHATSAPP_WIDENED_DDL);
  insertWhatsappRow(fixture, 'whatsapp_messages', '+19900000007', 'main-row');
  fixture.pragma('user_version = 95');
  close();

  restoreRegistry();
  const migrated = open();
  assertConverged(migrated, 'empty leftover + complete main → tail');
  ok(!tableExists(migrated, 'whatsapp_messages_v95'), 'the empty leftover is removed');
  ok(acceptsZReport(migrated), "z_report stays accepted");
  eq((migrated.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE body = 'main-row'").get() as any).n, 1, 'the main row is untouched');
  close();
}

// [15] A v93 table that exists but is structurally incomplete must stop the
// catch-up, not be reported as converged. Data and version stay untouched.
function scenarioV93ColumnDriftStops(): void {
  console.log('\n[15] v93 table missing a required column → stop, data preserved');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec(`
    ALTER TABLE role_permission_overrides RENAME TO rpo_old;
    CREATE TABLE role_permission_overrides (
      role TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (role, permission_id)
    );
    DROP TABLE rpo_old;
  `);
  db.prepare('INSERT INTO role_permission_overrides (role, permission_id, updated_by) VALUES (?, ?, ?)').run('manager', 'perm-x', 'owner-x');
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'an incomplete v93 table stops the catch-up');
  ok(/role_permission_overrides/.test(error?.message ?? ''), 'the diagnostic names the offending table');
  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP && versionAfter === LAST_BEFORE_CATCH_UP, `the failed catch-up rolled back and never committed past the catch-up (v${versionAfter})`);
  eq((check.prepare("SELECT COUNT(*) AS n FROM role_permission_overrides WHERE permission_id = 'perm-x'").get() as any).n, 1, 'the drifted table and its row survive untouched');
  ok(!(check.prepare('PRAGMA table_info(role_permission_overrides)').all() as any[]).some((c) => c.name === 'effect'), 'the drift is not silently repaired');
  close();
}

// [16] A missing required index must be detected, not ignored.
function scenarioV93IndexDriftStops(): void {
  console.log('\n[16] v93 required index missing → stop');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec('DROP INDEX idx_role_permission_overrides_role');
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'a missing v93 index stops the catch-up');
  ok(/index/.test(error?.message ?? ''), 'the diagnostic mentions the missing index');
  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP && versionAfter === LAST_BEFORE_CATCH_UP, `the catch-up did not commit (v${versionAfter} < ${CATCH_UP})`);
  const indexes = (check.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='role_permission_overrides'").all() as any[]).map((r) => r.name);
  ok(!indexes.includes('idx_role_permission_overrides_role'), 'the index was not silently recreated');
  close();
}

// [22] A v93 table that keeps every column, key and index but loses its declared
// CHECK must be reported as drift, not accepted as converged.
function scenarioV93CheckDriftStops(): void {
  console.log('\n[22] v93 table missing its effect CHECK → stop, data preserved');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec(`
    ALTER TABLE role_permission_overrides RENAME TO rpo_old2;
    CREATE TABLE role_permission_overrides (
      role TEXT NOT NULL,
      permission_id TEXT NOT NULL,
      effect TEXT NOT NULL,
      updated_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (role, permission_id)
    );
    DROP TABLE rpo_old2;
    CREATE INDEX idx_role_permission_overrides_role ON role_permission_overrides(role);
  `);
  db.prepare('INSERT INTO users (id, name, password, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run('owner-y', 'Owner Y', '', 'owner', '2026-01-01 00:00:00', '2026-01-01 00:00:00');
  db.prepare('INSERT INTO role_permission_overrides (role, permission_id, effect, updated_by) VALUES (?, ?, ?, ?)')
    .run('manager', 'perm-check', 'allow', 'owner-y');
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'a v93 table missing its CHECK constraint stops the catch-up');
  ok(/CHECK/i.test(error?.message ?? ''), 'the diagnostic mentions the missing CHECK');
  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP && versionAfter === LAST_BEFORE_CATCH_UP, `the catch-up did not commit (v${versionAfter} < ${CATCH_UP})`);
  eq((check.prepare("SELECT COUNT(*) AS n FROM role_permission_overrides WHERE permission_id = 'perm-check'").get() as any).n, 1, 'the drifted row survives untouched');
  ok(!(check.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'role_permission_overrides'").get() as any).sql.includes("effect IN ('allow', 'deny')"), 'the missing CHECK is not silently repaired by a rebuild');
  close();
}

// [17] The v95 diagnostics table must be structurally validated too.
function scenarioV95ColumnDriftStops(): void {
  console.log('\n[17] v95 local_diagnostics missing a column → stop, data preserved');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec(`
    ALTER TABLE local_diagnostics RENAME TO ld_old;
    CREATE TABLE local_diagnostics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_code TEXT NOT NULL,
      severity TEXT NOT NULL,
      error_class TEXT NOT NULL,
      signature TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    DROP TABLE ld_old;
  `);
  db.prepare("INSERT INTO local_diagnostics (event_code, severity, error_class, signature, occurred_at) VALUES ('E1', 'info', 'X', 'sig-1', '2026-01-01 00:00:00')").run();
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'an incomplete v95 table stops the catch-up');
  ok(/local_diagnostics/.test(error?.message ?? ''), 'the diagnostic names local_diagnostics');
  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP && versionAfter === LAST_BEFORE_CATCH_UP, `the catch-up did not commit (v${versionAfter} < ${CATCH_UP})`);
  eq((check.prepare("SELECT COUNT(*) AS n FROM local_diagnostics WHERE signature = 'sig-1'").get() as any).n, 1, 'the diagnostics row survives untouched');
  close();
}

// [18] v98 table present with the right columns and indexes but missing both
// declared foreign keys must stop, and its rows must not be deleted.
function scenarioV98ForeignKeyDriftStops(): void {
  console.log('\n[18] v98 table missing both foreign keys → stop, data preserved');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec(`
    ALTER TABLE category_addon_groups RENAME TO cag_old;
    CREATE TABLE category_addon_groups (
      category_id TEXT NOT NULL,
      addon_group_id TEXT NOT NULL,
      PRIMARY KEY (category_id, addon_group_id)
    );
    INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES ('cat-x', 'ag-x');
    DROP TABLE cag_old;
    CREATE INDEX idx_category_addon_groups_category ON category_addon_groups(category_id);
    CREATE INDEX idx_category_addon_groups_group ON category_addon_groups(addon_group_id);
  `);
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'a v98 table missing its foreign keys stops the catch-up');
  ok(/foreign key/i.test(error?.message ?? ''), 'the diagnostic mentions the missing foreign keys');
  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP && versionAfter === LAST_BEFORE_CATCH_UP, `the catch-up did not commit (v${versionAfter} < ${CATCH_UP})`);
  eq((check.prepare("SELECT COUNT(*) AS n FROM category_addon_groups WHERE category_id = 'cat-x'").get() as any).n, 1, 'the existing row is not deleted');
  close();
}

// [19] A v98 table missing its two indexes must be detected.
function scenarioV98IndexDriftStops(): void {
  console.log('\n[19] v98 required indexes missing → stop');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec('DROP INDEX idx_category_addon_groups_category; DROP INDEX idx_category_addon_groups_group;');
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'a v98 table missing its indexes stops the catch-up');
  ok(/category_addon_groups/.test(error?.message ?? ''), 'the diagnostic names category_addon_groups');
  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP && versionAfter === LAST_BEFORE_CATCH_UP, `the catch-up did not commit (v${versionAfter} < ${CATCH_UP})`);
  close();
}

// [20] Required settings are created if absent, while a user-edited value is
// never overwritten (INSERT OR IGNORE semantics), and the catch-up still converges.
function scenarioSettingsPresenceAndUserValue(): void {
  console.log('\n[20] required settings created, user-edited values preserved');
  resetFile();
  restoreRegistry();
  const db = open();
  db.prepare("UPDATE settings SET value = 'false' WHERE key = 'bill_delivery_show_customer_phone_always'").run();
  db.prepare("UPDATE settings SET value = 'true' WHERE key = 'require_kitchen_delivered_before_settlement'").run();
  db.prepare("DELETE FROM settings WHERE key = 'diagnostics_transmission_enabled'").run();
  db.pragma('user_version = 95');
  close();

  const migrated = open();
  assertConverged(migrated, 'settings → tail');
  const value = (key: string) => (migrated.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any)?.value;
  eq(value('bill_delivery_show_customer_phone_always'), 'false', 'a user-edited setting value is not reset to its default');
  eq(value('require_kitchen_delivered_before_settlement'), 'true', 'a user-edited setting value is preserved');
  eq((migrated.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'diagnostics_transmission_enabled'").get() as any).n, 1, 'a missing required setting is created by the catch-up');
  close();
}

// [21] Unified rollback: on a legacy fork database that lacks every upstream
// object, pre-corrupt one v98 table so the catch-up creates the other groups and
// then fails its postcondition. Everything the catch-up created in that single
// transaction must roll back, leaving the database exactly as it started.
function scenarioUnifiedCatchUpRollback(): void {
  console.log('\n[21] failed catch-up rolls back every change it made in the same transaction');
  resetFile();
  setRegistry(legacyForkVersions(1012));
  const fixture = open();
  fixture.exec(`
    CREATE TABLE category_addon_groups (
      category_id TEXT NOT NULL,
      addon_group_id TEXT NOT NULL,
      PRIMARY KEY (category_id, addon_group_id)
    );
    INSERT INTO category_addon_groups (category_id, addon_group_id) VALUES ('cat-rb', 'ag-rb');
    CREATE INDEX idx_category_addon_groups_category ON category_addon_groups(category_id);
    CREATE INDEX idx_category_addon_groups_group ON category_addon_groups(addon_group_id);
  `);
  fixture.pragma('user_version = 104');
  ok(!tableExists(fixture, 'role_permission_overrides'), 'setup: the permission tables are absent before the catch-up');
  ok(!hasColumn(fixture, 'orders', 'delivery_address'), 'setup: orders.delivery_address is absent before the catch-up');
  close();

  restoreRegistry();
  let error: any = null;
  try { open(); } catch (err) { error = err; }
  ok(error instanceof Error, 'the catch-up fails on the corrupt v98 table');

  const check = dbModule.getDatabase();
  const versionAfter = Number(check.pragma('user_version', { simple: true }));
  ok(versionAfter < CATCH_UP, `the catch-up did not commit (v${versionAfter} < ${CATCH_UP})`);
  ok(!tableExists(check, 'role_permission_overrides'), 'role_permission_overrides created by the catch-up was rolled back');
  ok(!tableExists(check, 'user_permission_overrides'), 'user_permission_overrides created by the catch-up was rolled back');
  ok(!tableExists(check, 'authorization_audit_log'), 'authorization_audit_log created by the catch-up was rolled back');
  ok(!tableExists(check, 'local_diagnostics'), 'local_diagnostics created by the catch-up was rolled back');
  ok(!hasColumn(check, 'orders', 'delivery_address'), 'orders.delivery_address added by the catch-up was rolled back');
  eq((check.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'bill_delivery_show_customer_phone_always'").get() as any).n, 0, 'settings written by the catch-up were rolled back');
  eq((check.prepare("SELECT COUNT(*) AS n FROM category_addon_groups WHERE category_id = 'cat-rb'").get() as any).n, 1, 'the pre-existing (corrupt) table and its row are untouched');
  close();
}

// [23] A genuine convergence failure must arrive as a structured, actionable
// blocked diagnostic: the startup dialog names the migration, the affected
// objects and the safe next step, without leaking data or repair SQL.
function scenarioBlockedDiagnosticIsActionable(): void {
  console.log('\n[23] a real convergence failure reports a structured blocked diagnostic');
  resetFile();
  restoreRegistry();
  const db = open();
  db.exec('DROP INDEX idx_category_addon_groups_group');
  db.pragma('user_version = 95');
  close();

  let error: any = null;
  try { open(); } catch (err) { error = err; }

  const diagnostics = require('../main/migration-diagnostics');
  const startupFailure = require('../main/startup-failure');

  ok(error instanceof diagnostics.MigrationConvergenceError, 'the failure is a MigrationConvergenceError');
  eq(error?.code, 'MIGRATION_CONVERGENCE_BLOCKED', 'the failure carries a stable code');
  eq(error?.migrationVersion, CATCH_UP, 'the failure names the blocked catch-up migration');
  eq(error?.migrationName, 'catch_up_upstream_v93_to_v98', 'the failure names the blocked migration');
  ok(Array.isArray(error?.problems) && error.problems.length > 0, 'the failure carries structured problems');
  const firstProblem = error.problems[0];
  ok(typeof firstProblem?.objectType === 'string' && typeof firstProblem?.object === 'string' && typeof firstProblem?.problem === 'string',
    'each problem carries an object type, an object and a concise reason');
  ok(error.problems.some((p: any) => p.objectType === 'index' && p.object === 'category_addon_groups.idx_category_addon_groups_group'),
    'the affected index is reported by name and type');

  const diagnostic = error.toDiagnostic();
  eq(diagnostic.code, 'MIGRATION_CONVERGENCE_BLOCKED', 'toDiagnostic reports the same code');
  ok(typeof diagnostic.guidance === 'string' && diagnostic.guidance.length > 0, 'toDiagnostic carries operator guidance');
  deepEq(JSON.parse(JSON.stringify(diagnostic)), diagnostic, 'the diagnostic survives a JSON round-trip');

  const dialog = startupFailure.describeStartupFailure(error);
  ok(/v1001/.test(dialog.body), 'the startup dialog names the blocked migration version');
  ok(/category_addon_groups\.idx_category_addon_groups_group/.test(dialog.body), 'the startup dialog names the affected object');
  ok(/index missing/.test(dialog.body), 'the startup dialog states why the object failed');
  ok(/Keep the automatic pre-upgrade backup/.test(dialog.body), 'the startup dialog states the safe next step');
  ok(!/\b(INSERT|SELECT|UPDATE|DELETE)\b/.test(dialog.body), 'the startup dialog exposes no SQL');
  ok(!/DROP|ALTER|CREATE TABLE/.test(dialog.body), 'the startup dialog offers no automatic repair');
  ok(dialog.body.length < 2000, 'the startup dialog stays readable');

  const telemetry = startupFailure.startupFailureTelemetryFields(error);
  eq(telemetry.error_code, 'MIGRATION_CONVERGENCE_BLOCKED', 'telemetry carries the stable code');
  eq(telemetry.migration_version, CATCH_UP, 'telemetry carries the migration version');
  eq(telemetry.migration_name, 'catch_up_upstream_v93_to_v98', 'telemetry carries the migration name');
  eq(telemetry.blocked_object_count, error.problems.length, 'telemetry carries the problem count');
  ok(!JSON.stringify(telemetry).includes('Keep the automatic'), 'telemetry omits the operator guidance prose');

  // Unrelated failures keep their established behavior and add no blocked fields.
  const generic = startupFailure.describeStartupFailure(new Error('simulated unrelated failure'));
  eq(generic.title, 'Initialization Error', 'unrelated failures keep the original dialog title');
  eq(generic.body, 'Failed to start Flo: Error: simulated unrelated failure', 'unrelated failures keep the original dialog body');
  deepEq(startupFailure.startupFailureTelemetryFields(new Error('x')), {}, 'unrelated failures add no blocked-migration fields');
  eq(startupFailure.asMigrationBlockedDiagnostic(new Error('x')), null, 'an unrelated error is not mistaken for a blocked migration');

  // A code with no problems is not a usable diagnostic and must not be reported
  // as a blocked migration with an empty explanation.
  const malformed = Object.assign(new Error('bad'), { code: 'MIGRATION_CONVERGENCE_BLOCKED', problems: [] });
  eq(startupFailure.asMigrationBlockedDiagnostic(malformed), null, 'a code without problems is not treated as a blocked migration');

  const raw = new Database(dbPath, { readonly: true });
  eq(Number(raw.pragma('user_version', { simple: true })), LAST_BEFORE_CATCH_UP, 'the blocked migration did not advance the schema version');
  eq((raw.prepare('SELECT COUNT(*) AS n FROM category_addon_groups').get() as any).n, 0, 'the drifted table is untouched after the block');
  raw.close();
  close();
}

function scenarioRegistryGate(): void {
  console.log('\n[10] the registry gate rejects an invalid registry');
  resetFile();
  MIGRATIONS.length = 0;
  MIGRATIONS.push(ALL[0] as any, ALL[0] as any); // duplicate v1

  let error: any = null;
  try { dbModule.initDatabase(); } catch (err) { error = err; }
  ok(error && /unique and strictly ascending/i.test(error.message), 'duplicate/descending versions are refused');
  close();
  restoreRegistry();
}

function main(): void {
  console.log(`Migration convergence contract (registry tail v${TAIL}, shared v1-v${SHARED_MAX})`);
  console.log('='.repeat(64));

  scenarioFreshInstall();
  scenarioUpstreamV92();
  scenarioUpstreamV98();
  scenarioLegacyForkLineages();
  scenarioFinancialPreservation();
  scenarioVersionAboveTail();
  scenarioLeftoverTempTable();
  scenarioAmbiguousRebuildStops();
  scenarioBothTablesWithData();
  scenarioCompleteMainWithLeftoverData();
  scenarioEmptyLeftoverWithOldMain();
  scenarioEmptyLeftoverWithCompleteMain();
  scenarioV93ColumnDriftStops();
  scenarioV93IndexDriftStops();
  scenarioV93CheckDriftStops();
  scenarioV95ColumnDriftStops();
  scenarioV98ForeignKeyDriftStops();
  scenarioV98IndexDriftStops();
  scenarioSettingsPresenceAndUserValue();
  scenarioUnifiedCatchUpRollback();
  scenarioBlockedDiagnosticIsActionable();
  scenarioRegistryGate();

  console.log(`\n${'='.repeat(64)}`);
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);

  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Windows may keep a handle open after a refused startup; the OS cleans the temp dir.
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();

// Module scope: keeps these top-level declarations out of the shared test-project globals.
export {};
