/**
 * Expenses REST routes: create, list with filters, summary, delete, and role
 * gating.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/expenses-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-expense-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { expenseRoutes } = require('../main/routes/expenses');

async function main() {
  console.log('Expenses routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);

  const app = createApp({ '/api/expenses': expenseRoutes });
  const { baseUrl, server } = await startServer(app);

  // ── Create via API ──
  const createRes = await api(baseUrl, '/api/expenses', {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      category: 'Rent',
      description: 'January rent',
      amount: 5000000,
      payment_method: 'bank_transfer',
      expense_date: '2026-01-01',
    },
  });
  assertEqual(createRes.status, 201, 'POST /api/expenses returns 201');
  assertEqual(createRes.data.expense.category, 'Rent', 'API stores the category');
  assertEqual(createRes.data.expense.created_by_name, 'Test Owner', 'API exposes the actor name');

  const second = await api(baseUrl, '/api/expenses', {
    method: 'POST',
    headers: manager.authHeader,
    body: { category: 'Fuel', amount: 120.5, payment_method: 'cash', expense_date: '2026-01-15' },
  });
  assertEqual(second.status, 201, 'manager can create an expense');

  // ── Validation ──
  const noCategory = await api(baseUrl, '/api/expenses', {
    method: 'POST', headers: owner.authHeader, body: { amount: 100, payment_method: 'cash' },
  });
  assertEqual(noCategory.status, 400, 'missing category is a 400');

  const badMethod = await api(baseUrl, '/api/expenses', {
    method: 'POST', headers: owner.authHeader, body: { category: 'Fuel', amount: 100, payment_method: 'crypto' },
  });
  assertEqual(badMethod.status, 400, 'invalid payment_method is a 400');

  // ── Read ──
  const one = await api(baseUrl, `/api/expenses/${createRes.data.expense.id}`, { headers: owner.authHeader });
  assertEqual(one.status, 200, 'GET /:id returns 200');

  const missing = await api(baseUrl, '/api/expenses/does-not-exist', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing expense is a 404');

  // ── List and filters ──
  const list = await api(baseUrl, '/api/expenses', { headers: owner.authHeader });
  assertEqual(list.status, 200, 'GET / returns 200');
  assertEqual(list.data.expenses.length, 2, 'list returns both expenses');

  const filtered = await api(baseUrl, '/api/expenses?category=Fuel', { headers: owner.authHeader });
  assertEqual(filtered.data.expenses.length, 1, 'category filter works via API');

  const badFilter = await api(baseUrl, '/api/expenses?payment_method=crypto', { headers: owner.authHeader });
  assertEqual(badFilter.status, 400, 'invalid payment_method filter is a 400');

  // ── Summary ──
  const summary = await api(baseUrl, '/api/expenses/summary', { headers: owner.authHeader });
  assertEqual(summary.status, 200, 'GET /summary returns 200');
  assertEqual(summary.data.summary.total, 5000120.5, 'summary totals via API');
  assertEqual(summary.data.summary.count, 2, 'summary counts via API');

  const ranged = await api(baseUrl, '/api/expenses/summary?from_date=2026-01-01&to_date=2026-01-10', { headers: manager.authHeader });
  assertEqual(ranged.data.summary.total, 5000000, 'summary respects from/to via API');

  // ── Delete ──
  const del = await api(baseUrl, `/api/expenses/${second.data.expense.id}`, {
    method: 'DELETE', headers: owner.authHeader,
  });
  assertEqual(del.status, 200, 'DELETE /:id returns 200');
  assert(!db.prepare('SELECT 1 FROM expenses WHERE id = ?').get(second.data.expense.id), 'deleted row is gone from the table');

  const reDelete = await api(baseUrl, `/api/expenses/${second.data.expense.id}`, {
    method: 'DELETE', headers: owner.authHeader,
  });
  assertEqual(reDelete.status, 404, 'deleting twice is a 404');

  // ── Role gating ──
  const unauth = await api(baseUrl, '/api/expenses', { method: 'POST', body: { category: 'Fuel', amount: 1, payment_method: 'cash' } });
  assertEqual(unauth.status, 401, 'POST without a token is 401');

  server.close();
  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
