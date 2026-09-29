/**
 * Expenses service: create, validate, list with filters, date-range summary,
 * and delete.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/expenses-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-expenses-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const {
  ExpenseError,
  createExpense,
  deleteExpense,
  getExpense,
  getExpenseSummary,
  listExpenses,
} = require('../main/services/expenses');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Expenses service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  // ── Create ──
  const expense = createExpense(db, {
    category: 'Rent',
    description: 'January rent',
    amount: 5000000,
    paymentMethod: 'bank_transfer',
    expenseDate: '2026-01-01',
    notes: 'Paid from business account',
    actorUserId: actor,
  });
  assert(expense.id.startsWith('exp_'), 'expense id uses exp_ prefix');
  assertEqual(expense.category, 'Rent', 'expense stores the category');
  assertEqual(expense.amount, 5000000, 'expense stores the amount');
  assertEqual(expense.created_by, actor, 'expense records the actor');
  assertEqual(expense.created_by_name, 'Test Owner', 'expense exposes the actor name');

  // ── Validation ──
  expectServiceError(() => createExpense(db, {
    category: '  ', amount: 100, paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'blank category is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'x'.repeat(61), amount: 100, paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'over-long category is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: 0, paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'zero amount is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: -5, paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'negative amount is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: 'abc', paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'non-numeric amount is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: 100, paymentMethod: 'crypto', actorUserId: actor,
  }), 400, 'invalid payment method is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: 100, paymentMethod: 'cash', expenseDate: '01/02/2026', actorUserId: actor,
  }), 400, 'malformed expense_date is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: 100, paymentMethod: 'cash', notes: 'x'.repeat(501), actorUserId: actor,
  }), 400, 'over-long notes is a 400');
  expectServiceError(() => createExpense(db, {
    category: 'Fuel', amount: 100, paymentMethod: 'cash', actorUserId: '',
  }), 400, 'missing actor is a 400');

  // Rounding to 2 decimals.
  const rounded = createExpense(db, {
    category: 'Fuel', amount: '10.999', paymentMethod: 'cash', actorUserId: actor,
  });
  assertEqual(rounded.amount, 11, 'amount rounds to 2 decimals');

  // ── Default date ──
  const today = createExpense(db, {
    category: 'Utilities', amount: 50, paymentMethod: 'cash', actorUserId: actor,
  });
  assert(/^\d{4}-\d{2}-\d{2}$/.test(today.expense_date), 'missing expense_date defaults to today');

  // ── Reads and filters ──
  assertEqual(getExpense(db, expense.id).id, expense.id, 'get returns the expense');
  expectServiceError(() => getExpense(db, 'missing'), 404, 'missing expense is a 404');

  const all = listExpenses(db);
  assertEqual(all.expenses.length, 3, 'list returns all expenses');

  const byCategory = listExpenses(db, { category: 'Fuel' });
  assertEqual(byCategory.expenses.length, 1, 'category filter works');

  const byMethod = listExpenses(db, { paymentMethod: 'bank_transfer' });
  assertEqual(byMethod.expenses.length, 1, 'payment method filter works');

  const byDate = listExpenses(db, { fromDate: '2026-01-01', toDate: '2026-01-31' });
  assertEqual(byDate.expenses.length, 1, 'date-range filter works');

  const bySearch = listExpenses(db, { search: 'rent' });
  assertEqual(bySearch.expenses.length, 1, 'search matches description');

  // Pagination cursor.
  const paged = listExpenses(db, { perPage: 2 });
  assertEqual(paged.expenses.length, 2, 'per_page caps the page size');
  assert(paged.nextCursor !== null, 'nextCursor is set when more rows exist');
  const nextPage = listExpenses(db, { perPage: 2, beforeId: paged.nextCursor });
  assertEqual(nextPage.expenses.length, 1, 'cursor pagination returns the remaining row');

  // ── Summary ──
  const summary = getExpenseSummary(db);
  assertEqual(summary.total, 5000061, 'summary totals all expenses');
  assertEqual(summary.count, 3, 'summary counts all expenses');
  assertEqual(summary.byCategory.length, 3, 'summary groups by category');
  assertEqual(summary.byCategory[0].category, 'Rent', 'summary orders categories by total');
  assertEqual(summary.byMethod.find((m: any) => m.payment_method === 'bank_transfer')!.total, 5000000, 'summary groups by method');

  const ranged = getExpenseSummary(db, { from: '2026-01-01', to: '2026-01-31' });
  assertEqual(ranged.total, 5000000, 'summary respects the date range');
  assertEqual(ranged.count, 1, 'summary counts only in-range expenses');
  assertEqual(getExpenseSummary(db, {}).total, 5000061, 'empty range means all time');

  // ── Delete ──
  deleteExpense(db, rounded.id, actor);
  expectServiceError(() => getExpense(db, rounded.id), 404, 'deleted expense is gone');
  expectServiceError(() => deleteExpense(db, rounded.id, actor), 404, 'deleting twice is a 404');
  assertEqual(getExpenseSummary(db).total, 5000050, 'summary excludes deleted expenses');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
