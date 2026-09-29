/**
 * Receivables service: customer ledger with derived balance, statement with
 * running balance, validation, and hard delete.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/receivables-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receivables-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const {
  ReceivableError,
  createReceivableEntry,
  deleteReceivableEntry,
  getCustomerBalance,
  getCustomerStatement,
  getReceivableEntry,
  listCustomerBalances,
  listReceivableEntries,
} = require('../main/services/receivables');

function seedCustomer(db: any, id: string, name: string): void {
  db.prepare(`
    INSERT INTO customers (id, name, is_active, created_at, updated_at)
    VALUES (?, ?, 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run(id, name);
}

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Receivables service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  seedCustomer(db, 'cust-a', 'Cafe Naderi');
  seedCustomer(db, 'cust-b', 'Office Catering Co');

  // ── Charge creates debt ──
  const charge1 = createReceivableEntry(db, {
    customerId: 'cust-a',
    entryType: 'charge',
    amount: 500000,
    description: 'Neesie sales 20 Shahrivar',
    entryDate: '2026-01-10',
    actorUserId: actor,
  });
  assert(charge1.id.startsWith('rcv_'), 'entry id uses rcv_ prefix');
  assertEqual(charge1.direction, 'debit', 'charge is forced to debit');
  assertEqual(getCustomerBalance(db, 'cust-a'), 500000, 'charge sets the balance');

  // ── Partial settlement ──
  const settlement1 = createReceivableEntry(db, {
    customerId: 'cust-a',
    entryType: 'settlement',
    amount: 200000,
    paymentMethod: 'cash',
    entryDate: '2026-01-15',
    actorUserId: actor,
  });
  assertEqual(settlement1.direction, 'credit', 'settlement is forced to credit');
  assertEqual(getCustomerBalance(db, 'cust-a'), 300000, 'partial settlement reduces the balance');

  // ── Settlement without payment_method is rejected ──
  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'settlement', amount: 1, actorUserId: actor,
  }), 400, 'settlement without payment_method is a 400');

  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'settlement', amount: 1, paymentMethod: 'crypto', actorUserId: actor,
  }), 400, 'invalid settlement method is a 400');

  // ── Charge without description is rejected ──
  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'charge', amount: 100, actorUserId: actor,
  }), 400, 'charge without description is a 400');

  // ── Adjustment both ways ──
  createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'adjustment', direction: 'debit', amount: 50000,
    description: 'Missing item added later', entryDate: '2026-01-20', actorUserId: actor,
  });
  assertEqual(getCustomerBalance(db, 'cust-a'), 350000, 'debit adjustment raises the balance');
  createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'adjustment', direction: 'credit', amount: 50000,
    description: 'Goodwill discount', entryDate: '2026-01-21', actorUserId: actor,
  });
  assertEqual(getCustomerBalance(db, 'cust-a'), 300000, 'credit adjustment lowers the balance');

  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'adjustment', amount: 100,
    description: 'no direction', actorUserId: actor,
  }), 400, 'adjustment without direction is a 400');

  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'bogus', amount: 100,
    description: 'x', actorUserId: actor,
  }), 400, 'invalid entry_type is a 400');

  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-missing', entryType: 'charge', amount: 100,
    description: 'x', actorUserId: actor,
  }), 404, 'unknown customer is a 404');

  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'charge', amount: 0,
    description: 'x', actorUserId: actor,
  }), 400, 'zero amount is a 400');

  expectServiceError(() => createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'charge', amount: 100,
    description: 'x', entryDate: '2026/01/02', actorUserId: actor,
  }), 400, 'malformed entry_date is a 400');

  // ── Prepaid (negative) balance is allowed ──
  createReceivableEntry(db, {
    customerId: 'cust-a', entryType: 'settlement', amount: 400000,
    paymentMethod: 'bank_transfer', entryDate: '2026-02-01', actorUserId: actor,
  });
  assertEqual(getCustomerBalance(db, 'cust-a'), -100000, 'over-settlement leaves a prepaid negative balance');

  // ── Balances list ──
  createReceivableEntry(db, {
    customerId: 'cust-b', entryType: 'charge', amount: 750000,
    description: 'Weekly catering', entryDate: '2026-01-12', actorUserId: actor,
  });
  const balances = listCustomerBalances(db);
  assertEqual(balances.length, 2, 'balances list covers both customers');
  assertEqual(balances[0].customer_id, 'cust-b', 'balances order by debt descending');
  assertEqual(balances.find((b: any) => b.customer_id === 'cust-a').balance, -100000, 'prepaid customer shows negative balance');

  // ── Statement with running balance ──
  const statement = getCustomerStatement(db, 'cust-a');
  assertEqual(statement.customer.name, 'Cafe Naderi', 'statement names the customer');
  assertEqual(statement.balance, -100000, 'statement ends at the current balance');
  assertEqual(statement.entries.length, 5, 'statement lists every entry');
  const oldest = statement.entries[statement.entries.length - 1];
  assertEqual(oldest.balance_after, 500000, 'running balance starts from the oldest entry');
  assertEqual(statement.entries[0].balance_after, -100000, 'running balance ends at the current balance');

  // Paged statement keeps the running balance consistent across windows.
  const pagedPage = getCustomerStatement(db, 'cust-a', { perPage: 2 });
  assertEqual(pagedPage.entries.length, 2, 'statement pagination caps the page');
  assertEqual(pagedPage.entries[0].balance_after, -100000, 'paged running balance still ends at the current balance');
  assert(pagedPage.nextCursor !== null, 'statement exposes a cursor for older entries');

  // ── List filters ──
  const chargesOnly = listReceivableEntries(db, { customerId: 'cust-a', entryType: 'charge' });
  assertEqual(chargesOnly.entries.length, 1, 'type filter works');
  const ranged = listReceivableEntries(db, { customerId: 'cust-a', fromDate: '2026-01-01', toDate: '2026-01-31' });
  assertEqual(ranged.entries.length, 4, 'date-range filter works');

  // ── Cursor pagination with tied timestamps ──
  db.prepare("UPDATE receivable_entries SET entry_date = '2026-03-05'").run();
  const allEntries = listReceivableEntries(db, {}).entries.length;
  const seenIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page = listReceivableEntries(db, { perPage: 2, beforeId: cursor ?? undefined });
    seenIds.push(...page.entries.map((e: any) => e.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assertEqual(seenIds.length, allEntries, 'pagination visits every entry despite tied dates');
  assertEqual(new Set(seenIds).size, allEntries, 'entry pagination never repeats a row');

  // ── Delete ──
  deleteReceivableEntry(db, charge1.id, actor);
  expectServiceError(() => getReceivableEntry(db, charge1.id), 404, 'deleted entry is gone');
  assertEqual(getCustomerBalance(db, 'cust-a'), -600000, 'balance updates with no recompute after delete');
  expectServiceError(() => deleteReceivableEntry(db, charge1.id, actor), 404, 'deleting twice is a 404');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
