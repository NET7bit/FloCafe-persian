/**
 * Accounting core service coverage (Milestone A, v102).
 *
 * Covers balanced/unbalanced journals, positive amounts, valid+active
 * accounts, idempotency (`source_module + source_id + seq`), the v101
 * closed-period gate (409), reversal linking, and derived balances with no
 * stored balance columns.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-core-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-service-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const {
  createJournal, getJournal, reverseJournal, getAccountBalances,
  getAccountByCode, listAccounts, AccountingServiceError,
} = require('../main/services/accounting');
const { createFiscalPeriod, closeFiscalPeriod, FiscalPeriodError } = require('../main/services/fiscal-periods');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    const isService = err instanceof AccountingServiceError;
    const isFiscal = err instanceof FiscalPeriodError;
    assert(
      (isService || isFiscal) && err.statusCode === statusCode,
      `${message} (got ${err.statusCode}: ${err.message})`,
    );
  }
}

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();

async function main() {
  console.log('Accounting core service test (Milestone A)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);

  const cash = getAccountByCode('1000');
  const bank = getAccountByCode('1010');
  const revenue = getAccountByCode('4000');
  const returns = getAccountByCode('4010');

  assertEqual(listAccounts().length, 12, '12 seeded accounts are listed');
  assert(listAccounts({ activeOnly: true }).every((a: any) => a.is_active === 1), 'activeOnly filters inactive accounts');

  // ── Balanced journal succeeds ──
  const sale = createJournal({
    entryDate: TODAY,
    description: 'Cash sale #A1',
    sourceModule: 'sales',
    sourceId: 'bill-A1',
    seq: 1,
    actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 118 },
      { accountId: revenue.id, direction: 'credit', amount: 100 },
      { accountId: getAccountByCode('2100').id, direction: 'credit', amount: 18 },
    ],
  });
  assert(!!sale.id && sale.status === 'posted', 'balanced journal is created posted');
  assertEqual(getJournal(sale.id).lines.length, 3, 'journal lines persisted');

  // ── Unbalanced → 400 ──
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'sales', sourceId: 'bill-BAD', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 100 },
      { accountId: revenue.id, direction: 'credit', amount: 90 },
    ],
  }), 'unbalanced journal rejected');

  // ── Amount zero/negative → 400 ──
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'sales', sourceId: 'bill-Z', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 0 },
      { accountId: revenue.id, direction: 'credit', amount: 0 },
    ],
  }), 'zero amounts rejected');
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'sales', sourceId: 'bill-NEG', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: -5 },
      { accountId: revenue.id, direction: 'credit', amount: -5 },
    ],
  }), 'negative amounts rejected');

  // ── Invalid + inactive account → 400 ──
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'sales', sourceId: 'bill-X', actorUserId: owner.userId,
    lines: [
      { accountId: 'acct_9999', direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  }), 'unknown account rejected');

  db.prepare('UPDATE accounting_accounts SET is_active = 0 WHERE id = ?').run(returns.id);
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'refunds', sourceId: 'ref-X', actorUserId: owner.userId,
    lines: [
      { accountId: returns.id, direction: 'debit', amount: 1 },
      { accountId: cash.id, direction: 'credit', amount: 1 },
    ],
  }), 'inactive account rejected');
  db.prepare('UPDATE accounting_accounts SET is_active = 1 WHERE id = ?').run(returns.id);

  // ── Idempotency: duplicate source event → 409; different seq OK ──
  expectError(409, () => createJournal({
    entryDate: TODAY, sourceModule: 'sales', sourceId: 'bill-A1', seq: 1, actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  }), 'duplicate source_module+source_id+seq rejected');
  const collection = createJournal({
    entryDate: TODAY, sourceModule: 'sales', sourceId: 'bill-A1', seq: 2, actorUserId: owner.userId,
    lines: [
      { accountId: bank.id, direction: 'debit', amount: 10 },
      { accountId: cash.id, direction: 'credit', amount: 10 },
    ],
  });
  assert(!!collection.id, 'same source with seq=2 is accepted (collection event)');

  // Manual journals: source_id stays NULL, service-side uniqueness enforced.
  const manual = createJournal({
    entryDate: TODAY, sourceModule: 'manual', actorUserId: owner.userId,
    description: 'Opening balances',
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 500 },
      { accountId: getAccountByCode('3000').id, direction: 'credit', amount: 500 },
    ],
  });
  assertEqual(getJournal(manual.id).source_id, null, 'manual journal has NULL source_id');
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'manual', sourceId: 'm-1', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  }), 'manual journals reject a source_id');
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'sales', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  }), 'module journals require a source_id');

  // ── Closed fiscal period → 409; open/current → success ──
  const month = createFiscalPeriod(db, { periodType: 'month', startDate: LAST_MONTH, actorUserId: owner.userId });
  closeFiscalPeriod(db, month.id, owner.userId);
  expectError(409, () => createJournal({
    entryDate: LAST_MONTH, sourceModule: 'expenses', sourceId: 'exp-CLOSED', actorUserId: owner.userId,
    lines: [
      { accountId: getAccountByCode('5000').id, direction: 'debit', amount: 10 },
      { accountId: cash.id, direction: 'credit', amount: 10 },
    ],
  }), 'journal in a closed fiscal period is rejected with 409');
  assert(!getAccountBalances().some((b: any) => b.code === '5000' && b.debit_total > 0), 'closed-period journal wrote nothing (rolled back)');

  // ── Reversal: new journal + link; original kept, not deleted ──
  const reversal = reverseJournal(sale.id, owner.userId, TODAY);
  assert(!!reversal.id && reversal.id !== sale.id, 'reversal creates a new journal');
  assertEqual(reversal.reverses_journal_id, sale.id, 'reversal links back via reverses_journal_id');
  assertEqual(getJournal(sale.id).status, 'reversed', 'original journal is marked reversed, still present');
  const saleLines = getJournal(sale.id).lines;
  const reversalLines = getJournal(reversal.id).lines;
  assertEqual(reversalLines.length, saleLines.length, 'reversal mirrors the line count');
  assert(reversalLines.every((l: any, i: number) =>
    l.account_id === saleLines[i].account_id
    && l.amount === saleLines[i].amount
    && l.direction === (saleLines[i].direction === 'debit' ? 'credit' : 'debit'),
  ), 'reversal mirrors lines with swapped directions');
  assertEqual(reversal.seq, 3, 'reversal joins the document chain after existing events (sale=1, collection=2)');
  expectError(409, () => reverseJournal(sale.id, owner.userId, TODAY), 'double reversal rejected');
  expectError(409, () => reverseJournal(reversal.id, owner.userId, TODAY), 'reversing a reversal journal rejected');

  // ── Derived balances: reversal cancels the original; nothing stored ──
  const balances = getAccountBalances();
  const cashBalance = balances.find((b: any) => b.code === '1000');
  const revenueBalance = balances.find((b: any) => b.code === '4000');
  assertEqual(cashBalance.debit_total, 618, 'cash debit total derived from posted journals (manual 500 + sale 118)');
  assertEqual(cashBalance.credit_total, 128, 'cash credit total (collection 10 + reversal mirror 118)');
  assertEqual(cashBalance.balance, 490, 'reversed sale is cancelled out of the derived balance (manual 500 − collection 10)');
  assertEqual(revenueBalance.balance, 0, 'fully reversed revenue nets to zero');
  const accountColumns = db.prepare('PRAGMA table_info(accounting_accounts)').all().map((c: any) => c.name);
  assert(!accountColumns.includes('balance'), 'no stored balance column exists on accounts');

  console.log('='.repeat(50));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
