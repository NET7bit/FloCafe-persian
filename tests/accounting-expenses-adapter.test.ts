/**
 * Expenses accounting adapter coverage (Milestone F).
 *
 * Exercises the real write paths (POST /api/expenses, DELETE /api/expenses/:id)
 * plus the adapter functions for scenarios that have no runtime trigger (skip
 * policies, reprocess after a period reopen). Proves that an expense
 * journalizes exactly once on creation under `expenses + expense id + seq 1`,
 * that deletion reverses through the shared core, and that replays/reprocesses
 * never duplicate.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-expenses-adapter.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-expenses-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const {
  createExpenseJournal, recordExpenseAccounting, recordExpenseDeletionAccounting, reprocessExpenseAccounting,
} = require('../main/services/accounting-expenses-adapter');
const { createExpense, deleteExpense, getExpense, ExpenseError } = require('../main/services/expenses');
const { createSupplierPayment } = require('../main/services/supplier-payments');
const { createSupplier } = require('../main/services/suppliers');
const { getAccountByCode, createJournal, AccountingServiceError } = require('../main/services/accounting');
const {
  createFiscalPeriod, closeFiscalPeriod, reopenFiscalPeriod, FiscalPeriodError,
} = require('../main/services/fiscal-periods');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    const known = err instanceof AccountingServiceError || err instanceof FiscalPeriodError || err instanceof ExpenseError;
    assert(known && err.statusCode === statusCode, `${message} (got ${err.statusCode}: ${err.message})`);
  }
}

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();

function journalCount(db: any, sourceModule: string, sourceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = ? AND source_id = ?')
    .get(sourceModule, String(sourceId)) as any).n;
}
function linesOf(db: any, journalId: string): Array<{ code: string; direction: string; amount: number }> {
  return db.prepare(`
    SELECT a.code AS code, l.direction AS direction, l.amount AS amount
    FROM journal_entry_lines l JOIN accounting_accounts a ON a.id = l.account_id
    WHERE l.journal_id = ? ORDER BY l.rowid
  `).all(journalId);
}
function theJournal(db: any, sourceId: string): any {
  return db.prepare("SELECT * FROM journal_entries WHERE source_module = 'expenses' AND source_id = ? AND seq = 1")
    .get(String(sourceId));
}

async function main() {
  console.log('Expenses accounting adapter test (Milestone F)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);

  // ── Trigger + mapping: creation → one journal, Dr 5000 / Cr tender ──
  const cash = createExpense(db, {
    category: 'Fuel', description: 'Delivery van fuel', amount: 120.5,
    paymentMethod: 'cash', expenseDate: TODAY, actorUserId: owner.userId,
  });
  recordExpenseAccounting(cash.id, owner.userId);
  const cashJournal = theJournal(db, cash.id);
  assert(!!cashJournal, 'creating an expense creates its journal');
  assertEqual(cashJournal.seq, 1, 'expense identity: seq 1');
  assertEqual(cashJournal.reference, 'Fuel', 'expense journal references the category');
  assertEqual(cashJournal.entry_date, TODAY, 'expense journal is dated by expense_date');
  assertEqual(
    JSON.stringify(linesOf(db, cashJournal.id).map((l) => [l.code, l.direction, l.amount])),
    JSON.stringify([['5000', 'debit', 120.5], ['1000', 'credit', 120.5]]),
    'cash expense maps Dr 5000 / Cr 1000 for the expense amount',
  );
  assertEqual(journalCount(db, 'expenses', cash.id), 1, 'each expense has exactly one journal');

  // Bank/card family mapping.
  const bank = createExpense(db, { category: 'Rent', amount: 5000, paymentMethod: 'bank_transfer', expenseDate: TODAY, actorUserId: owner.userId });
  const bankJournal = createExpenseJournal(bank.id, owner.userId);
  assertEqual(
    JSON.stringify(linesOf(db, bankJournal.id).map((l) => [l.code, l.direction])),
    JSON.stringify([['5000', 'debit'], ['1010', 'credit']]),
    'bank_transfer expense maps Dr 5000 / Cr 1010',
  );
  const card = createExpense(db, { category: 'Utilities', amount: 200, paymentMethod: 'card', expenseDate: TODAY, actorUserId: owner.userId });
  assertEqual(linesOf(db, createExpenseJournal(card.id, owner.userId).id)[1].code, '1010', 'card expense credits 1010');
  const cheque = createExpense(db, { category: 'Maintenance', amount: 75, paymentMethod: 'cheque', expenseDate: TODAY, actorUserId: owner.userId });
  assertEqual(linesOf(db, createExpenseJournal(cheque.id, owner.userId).id)[1].code, '1010', 'cheque expense credits 1010 (existing bank/card convention)');

  // Unsupported tender.
  const other = createExpense(db, { category: 'Misc', amount: 10, paymentMethod: 'other', expenseDate: TODAY, actorUserId: owner.userId });
  recordExpenseAccounting(other.id, owner.userId);
  assertEqual(journalCount(db, 'expenses', other.id), 0, 'payment_method other has no v1 account: skipped');

  // Idempotency on replay.
  recordExpenseAccounting(cash.id, owner.userId);
  recordExpenseAccounting(cash.id, owner.userId);
  createExpenseJournal(cash.id, owner.userId);
  assertEqual(journalCount(db, 'expenses', cash.id), 1, 'replays create no duplicate expense journal');

  // No credit/AP mapping: an expense never credits 2000 (source has no payable state).
  assertEqual(linesOf(db, bankJournal.id).some((l) => l.code === '2000'), false, 'expenses never credit 2000 (no payable state in the source model)');

  // ── Ownership boundary: no cross-posting with the other modules ──
  assertEqual(journalCount(db, 'purchases', cash.id), 0, 'an expense never creates a purchases journal');
  assertEqual(journalCount(db, 'supplier_payments', cash.id), 0, 'an expense never creates a supplier_payments journal');
  assertEqual(journalCount(db, 'sales', cash.id), 0, 'an expense never creates a sales journal');
  assertEqual(journalCount(db, 'receivables', cash.id), 0, 'an expense never creates a receivables journal');

  // A supplier payment is never double-posted as an expense.
  createSupplier(db, { id: 'supp-f', name: 'Supplier F', code: 'SF' });
  const payment = createSupplierPayment(db, { supplierId: 'supp-f', amount: 40, paymentMethod: 'cash', actorUserId: owner.userId });
  assertEqual(journalCount(db, 'expenses', payment.id), 0, 'a supplier payment never creates an expense journal');

  // The client can never supply identity through the core.
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'expenses', actorUserId: owner.userId,
    lines: [
      { accountId: getAccountByCode('5000').id, direction: 'debit', amount: 1 },
      { accountId: getAccountByCode('1000').id, direction: 'credit', amount: 1 },
    ],
  }), 'createJournal still requires a source_id for expenses (identity stays with the source row)');

  // ── Deletion reversal: post-commit, idempotent, identity preserved ──
  deleteExpense(db, cash.id, owner.userId);
  recordExpenseDeletionAccounting(cash.id, owner.userId);
  const cashReversal = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(cashJournal.id) as any;
  assert(!!cashReversal, 'deleting a journalized expense creates the reversal after commit');
  assertEqual(cashReversal.source_module, 'expenses', 'reversal keeps the expenses module');
  assertEqual(cashReversal.source_id, cash.id, 'reversal keeps the expense source identity');
  assertEqual(cashReversal.seq, 2, 'reversal joins the event chain at max(seq)+1');
  assertEqual((db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(cashJournal.id) as any).status, 'reversed', 'the original expense journal is marked reversed and stays in history');
  const reversedLines = linesOf(db, cashReversal.id);
  assert(
    reversedLines.some((l) => l.code === '1000' && l.direction === 'debit') && reversedLines.some((l) => l.code === '5000' && l.direction === 'credit'),
    'the expense reversal inverts the original lines (Dr 1000 / Cr 5000)',
  );
  recordExpenseDeletionAccounting(cash.id, owner.userId);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(cashJournal.id) as any).n,
    1, 'repeated deletion hook creates no second reversal',
  );

  // ── Fiscal: source committed while open, adapter blocked by a later close ──
  const period = createFiscalPeriod(db, { periodType: 'month', startDate: LAST_MONTH, actorUserId: owner.userId });
  const monthExpense = createExpense(db, {
    category: 'Rent', amount: 900, paymentMethod: 'cash', expenseDate: LAST_MONTH, actorUserId: owner.userId,
  });
  closeFiscalPeriod(db, period.id, owner.userId);
  recordExpenseAccounting(monthExpense.id, owner.userId);
  assertEqual(journalCount(db, 'expenses', monthExpense.id), 0, 'a closed period blocks the expense journal');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_id WHERE j.source_module = ? AND j.source_id = ?')
      .get('expenses', monthExpense.id) as any).n,
    0, 'the rejected expense journal left no partial lines',
  );
  assertEqual(getExpense(db, monthExpense.id).id, monthExpense.id, 'the source expense stays committed when accounting is blocked');
  assertEqual(reprocessExpenseAccounting(monthExpense.id, owner.userId).status, 'skipped', 'reprocess is blocked by the closed period');
  assertEqual(journalCount(db, 'expenses', monthExpense.id), 0, 'closed-period reprocess creates no journal');

  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(require('bcryptjs').hashSync('1234', 10), owner.userId);
  reopenFiscalPeriod(db, period.id, '1234', owner.userId, owner.userId);
  assertEqual(reprocessExpenseAccounting(monthExpense.id, owner.userId).status, 'journalized', 'reprocess after reopen creates the pending journal');
  assertEqual(journalCount(db, 'expenses', monthExpense.id), 1, 'reopen reprocess creates exactly one journal (no duplicate)');
  assertEqual(theJournal(db, monthExpense.id).entry_date, LAST_MONTH, 'reprocessed expense keeps its original entry_date');

  // ── Every journal balanced ──
  const unbalanced = db.prepare(`
    SELECT j.id, COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS d,
           COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS c
    FROM journal_entries j JOIN journal_entry_lines l ON l.journal_id = j.id
    GROUP BY j.id HAVING ABS(d - c) > 1e-9
  `).all();
  assertEqual(unbalanced.length, 0, 'every journal in the ledger is balanced');

  // ── No pending/retry state; F leaves no new tables ──
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => String(r.name));
  assert(!tables.some((t) => ['adapter_failures', 'journal_sync_state', 'accounting_pending', 'accounting_retry'].includes(t)), 'no pending/retry/journal-sync table exists');

  // ── HTTP integration: the real production path ──
  const { expenseRoutes } = require('../main/routes/expenses');
  const { accountingRoutes } = require('../main/routes/accounting');
  const app = createApp({
    '/api/expenses': expenseRoutes,
    '/api/accounting': accountingRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const httpCreate = await api(baseUrl, '/api/expenses', {
    method: 'POST', headers: owner.authHeader,
    body: { category: 'Equipment', amount: 250, payment_method: 'card' },
  });
  assertEqual(httpCreate.status, 201, 'POST /api/expenses accepts the expense');
  const httpExpenseId = httpCreate.data.expense.id;
  const httpJournal = theJournal(db, httpExpenseId);
  assert(!!httpJournal, 'the post-commit hook journaled the HTTP expense');
  assertEqual(
    JSON.stringify(linesOf(db, httpJournal.id).map((l: any) => [l.code, l.direction])),
    JSON.stringify([['5000', 'debit'], ['1010', 'credit']]),
    'the HTTP card expense maps Dr 5000 / Cr 1010',
  );

  const httpDelete = await api(baseUrl, `/api/expenses/${httpExpenseId}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(httpDelete.status, 200, 'DELETE /api/expenses succeeds');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(httpJournal.id) as any).n,
    1, 'the HTTP delete reversal is journaled post-commit',
  );

  // ── Production surface: read-only discovery + explicit one-event reprocess ──
  const journalsBefore = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n;
  const discovery = await api(baseUrl, '/api/accounting/expenses/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(discovery.status, 200, 'GET expenses/unresolved succeeds for owner');
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n, journalsBefore, 'discovery is read-only (no journal created)');

  // Missing journal (source committed, adapter never ran).
  const orphan = createExpense(db, { category: 'Travel', amount: 80, paymentMethod: 'cash', actorUserId: owner.userId });
  const discovery2 = await api(baseUrl, '/api/accounting/expenses/unresolved', { method: 'GET', headers: owner.authHeader });
  const byId = (events: any[], id: string) => events.find((e: any) => e.event_id === id);
  assertEqual(byId(discovery2.data.events, orphan.id).state, 'missing_journal', 'discovery lists an unjournalized expense');
  assert(!discovery2.data.events.some((e: any) => e.event_id === httpExpenseId), 'discovery excludes journalized expenses');

  // Authorization: reads are ownerManager, reprocess is owner-only.
  assertEqual((await api(baseUrl, '/api/accounting/expenses/unresolved')).status, 401, 'discovery requires authentication');
  assertEqual((await api(baseUrl, '/api/accounting/expenses/unresolved', { headers: manager.authHeader })).status, 200, 'discovery allows manager (ownerManager)');
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${orphan.id}/reprocess`, { method: 'POST', headers: manager.authHeader })).status,
    403, 'reprocess rejects a manager (owner-only)',
  );
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${orphan.id}/reprocess`, { method: 'POST' })).status,
    401, 'reprocess requires authentication',
  );

  const reprocessedOrphan = await api(baseUrl, `/api/accounting/expenses/${orphan.id}/reprocess`, { method: 'POST', headers: owner.authHeader });
  assertEqual(reprocessedOrphan.data.result.status, 'journalized', 'reprocess journals a missing expense projection');
  assertEqual(journalCount(db, 'expenses', orphan.id), 1, 'reprocess creates exactly one expense journal');
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${orphan.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_journalized', 'reprocessing an already journalized expense is a no-op',
  );
  assertEqual(journalCount(db, 'expenses', orphan.id), 1, 'no-op reprocess creates no duplicate journal');
  assertEqual(
    (await api(baseUrl, '/api/accounting/expenses/does-not-exist/reprocess', { method: 'POST', headers: owner.authHeader })).data.result.status,
    'nothing_to_do', 'reprocess of an unknown id is a no-op',
  );

  // The client may only name the source row; identity/amount come from the source.
  const overrideExpense = createExpense(db, { category: 'Supplies', amount: 33, paymentMethod: 'cash', actorUserId: owner.userId });
  const overridden = await api(baseUrl, `/api/accounting/expenses/${overrideExpense.id}/reprocess`, {
    method: 'POST', headers: owner.authHeader,
    body: { source_module: 'sales', source_id: 'evil', seq: 99, amount: 999999 },
  });
  assertEqual(overridden.data.result.status, 'journalized', 'reprocess journals a missing expense projection');
  const overrideJournal = theJournal(db, overrideExpense.id);
  assert(!!overrideJournal, 'client body cannot override identity: journal keeps expenses + expense id + seq 1');
  assertEqual(
    linesOf(db, overrideJournal.id).reduce((s: number, l: any) => s + (l.direction === 'debit' ? l.amount : 0), 0),
    33, 'client-supplied amount is ignored; the journal uses the source amount',
  );

  // `other` expense: listed but never journalizable.
  const otherExpense = createExpense(db, { category: 'Misc', amount: 12, paymentMethod: 'other', actorUserId: owner.userId });
  const discovery3 = await api(baseUrl, '/api/accounting/expenses/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(byId(discovery3.data.events, otherExpense.id).journalizable, false, '`other` expense is listed but not journalizable');
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${otherExpense.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'skipped', 'reprocess of an `other` expense is skipped (no v1 account)',
  );
  assertEqual(journalCount(db, 'expenses', otherExpense.id), 0, '`other` reprocess left no journal');

  // Missing reversal: source gone but the delete hook never ran.
  const orphanReversal = createExpense(db, { category: 'Repairs', amount: 21, paymentMethod: 'card', actorUserId: owner.userId });
  recordExpenseAccounting(orphanReversal.id, owner.userId);
  const orphanReversalJournal = theJournal(db, orphanReversal.id);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(orphanReversal.id);
  const discovery4 = await api(baseUrl, '/api/accounting/expenses/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(byId(discovery4.data.events, orphanReversal.id).state, 'missing_reversal', 'discovery derives missing_reversal for a deleted source with a posted journal');
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${orphanReversal.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'reversal_created', 'reprocess creates the missing reversal',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(orphanReversalJournal.id) as any).n,
    1, 'exactly one reversal exists after reprocess',
  );
  const orphanReversalRow: any = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(orphanReversalJournal.id);
  const orphanReversalLines = linesOf(db, orphanReversalRow.id);
  assert(
    orphanReversalLines.some((l) => l.code === '1010' && l.direction === 'debit') && orphanReversalLines.some((l) => l.code === '5000' && l.direction === 'credit'),
    'the missing reversal is the exact inverse of the original (Dr 1010 / Cr 5000)',
  );
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${orphanReversal.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_reversed', 'repeated reprocess after repair is a no-op',
  );
  assertEqual(journalCount(db, 'expenses', orphanReversal.id), 2, 'no resurrection: the original journal is never rebuilt');

  // Deleted + never journalized is a no-op.
  const goneUnjournalized = createExpense(db, { category: 'Misc', amount: 5, paymentMethod: 'other', actorUserId: owner.userId });
  db.prepare('DELETE FROM expenses WHERE id = ?').run(goneUnjournalized.id);
  assertEqual(
    (await api(baseUrl, `/api/accounting/expenses/${goneUnjournalized.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'nothing_to_do', 'reprocess of a deleted, never-journalized expense creates nothing',
  );

  server.close();

  console.log('='.repeat(50));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
