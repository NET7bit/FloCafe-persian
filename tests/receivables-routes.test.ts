/**
 * Receivables REST routes: create entries, statement, balances, summary,
 * delete, and role gating.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/receivables-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receivable-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { receivableRoutes } = require('../main/routes/receivables');
const { getCustomerBalance } = require('../main/services/receivables');

async function main() {
  console.log('Receivables routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);

  db.prepare(`
    INSERT INTO customers (id, name, is_active, created_at, updated_at)
    VALUES ('cust-a', 'Cafe Naderi', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();

  const app = createApp({
    '/api/receivables': receivableRoutes,
    '/api/customers': require('../main/routes/customers').customerRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // ── Charge via API ──
  const charge = await api(baseUrl, '/api/receivables', {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      customer_id: 'cust-a',
      entry_type: 'charge',
      amount: 400000,
      description: 'Neesie sales',
      entry_date: '2026-01-10',
    },
  });
  assertEqual(charge.status, 201, 'POST /api/receivables returns 201');
  assertEqual(charge.data.entry.direction, 'debit', 'API forces charge direction to debit');
  assertEqual(charge.data.entry.customer_name, 'Cafe Naderi', 'API exposes the customer name');

  // ── Settlement via API (manager allowed) ──
  const settle = await api(baseUrl, '/api/receivables', {
    method: 'POST',
    headers: manager.authHeader,
    body: {
      customer_id: 'cust-a',
      entry_type: 'settlement',
      amount: 150000,
      payment_method: 'cash',
      entry_date: '2026-01-12',
    },
  });
  assertEqual(settle.status, 201, 'manager can settle via API');
  assertEqual(getCustomerBalance(db, 'cust-a'), 250000, 'API settlement reduces the balance');

  // ── Validation ──
  const badType = await api(baseUrl, '/api/receivables', {
    method: 'POST', headers: owner.authHeader,
    body: { customer_id: 'cust-a', entry_type: 'bogus', amount: 100, description: 'x' },
  });
  assertEqual(badType.status, 400, 'invalid entry_type is a 400');

  const noMethod = await api(baseUrl, '/api/receivables', {
    method: 'POST', headers: owner.authHeader,
    body: { customer_id: 'cust-a', entry_type: 'settlement', amount: 100 },
  });
  assertEqual(noMethod.status, 400, 'settlement without payment_method is a 400');

  // ── Statement ──
  const statement = await api(baseUrl, '/api/receivables/statement?customer_id=cust-a', { headers: owner.authHeader });
  assertEqual(statement.status, 200, 'GET /statement returns 200');
  assertEqual(statement.data.statement.balance, 250000, 'statement exposes the balance');
  assertEqual(statement.data.statement.entries.length, 2, 'statement lists both entries');

  const noCustomer = await api(baseUrl, '/api/receivables/statement', { headers: owner.authHeader });
  assertEqual(noCustomer.status, 400, 'statement without customer_id is a 400');

  // ── Balances ──
  const balances = await api(baseUrl, '/api/receivables/balances', { headers: owner.authHeader });
  assertEqual(balances.status, 200, 'GET /balances returns 200');
  assertEqual(balances.data.balances.length, 1, 'balances lists the debtor');
  assertEqual(balances.data.balances[0].balance, 250000, 'balances expose the amount');

  // ── Summary ──
  const summary = await api(baseUrl, '/api/receivables/summary', { headers: owner.authHeader });
  assertEqual(summary.status, 200, 'GET /summary returns 200');
  assertEqual(summary.data.summary.charged, 400000, 'summary totals charges');
  assertEqual(summary.data.summary.settled, 150000, 'summary totals settlements');
  assertEqual(summary.data.summary.net, 250000, 'summary nets the balance');

  // ── Read one ──
  const one = await api(baseUrl, `/api/receivables/${charge.data.entry.id}`, { headers: owner.authHeader });
  assertEqual(one.status, 200, 'GET /:id returns 200');

  const missing = await api(baseUrl, '/api/receivables/does-not-exist', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing entry is a 404');

  // ── Delete ──
  const del = await api(baseUrl, `/api/receivables/${charge.data.entry.id}`, {
    method: 'DELETE', headers: owner.authHeader,
  });
  assertEqual(del.status, 200, 'DELETE /:id returns 200');
  assertEqual(getCustomerBalance(db, 'cust-a'), -150000, 'delete updates the balance immediately');

  // ── Role gating ──
  const unauth = await api(baseUrl, '/api/receivables', {
    method: 'POST', body: { customer_id: 'cust-a', entry_type: 'charge', amount: 1, description: 'x' },
  });
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
