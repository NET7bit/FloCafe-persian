/**
 * Receivables (neesie) end-to-end: customer → order → full customer_account
 * bill payment → ledger charge → balance → settlement → zero balance →
 * hard delete → split-check where some checks are cash and some are neesie.
 *
 * The split scenario intentionally charges every neesie check to the ORDER's
 * single customer: per-check customers are out of scope for v99 and the
 * backend rejects a customer mismatch, so this documents that constraint.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/receivables-e2e.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-receivables-e2e-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters,
  seedOwnerUser, seedCategory, seedProduct, api, now, createApp, startServer,
} = require('./helpers/test-setup');
const { customerRoutes } = require('../main/routes/customers');
const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { receivableRoutes } = require('../main/routes/receivables');

async function main() {
  console.log('Receivables end-to-end (neesie lifecycle + split checks)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'e2e-cat', 'E2E menu');
  seedProduct(db, 'e2e-ghormeh', 'e2e-cat', 'Ghormeh Sabzi', 450);
  seedProduct(db, 'e2e-tea', 'e2e-cat', 'Tea', 80);
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', ?)").run(now());

  const app = createApp({
    '/api/customers': customerRoutes,
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/receivables': receivableRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const findBalance = (data: any) => (data.balances || []).find((row: any) => String(row.customer_id) === String(customerId));

  // ── 1) Customer created through the real API ──
  const custRes = await api(baseUrl, '/api/customers', {
    method: 'POST',
    headers: owner.authHeader,
    body: { name: 'نسیه‌چی تهران', phone: '+989121234567' },
  });
  assertEqual(custRes.status, 201, 'customer created via API');
  const customerId = String(custRes.data.customer.id);

  // ── 2) Dine-in order linked to that customer, then its bill ──
  const orderRes = await api(baseUrl, '/api/orders', {
    method: 'POST',
    headers: owner.authHeader,
    body: { type: 'dine_in', customer_id: customerId, guest_count: 2, items: [{ product_id: 'e2e-ghormeh', quantity: 2 }, { product_id: 'e2e-tea', quantity: 1 }] },
  });
  assertEqual(orderRes.status, 201, 'order with the customer created');
  const billRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orderRes.data.order.id }, headers: owner.authHeader });
  const bill = billRes.data.bill;
  assert(Number(bill.total) > 0, `bill has a positive total (got ${bill.total})`);

  // ── 3) Full payment on the customer account posts one charge ──
  const payRes = await api(baseUrl, `/api/bills/${bill.id}/payments`, {
    method: 'POST',
    headers: owner.authHeader,
    body: { payments: [{ method: 'customer_account', amount: bill.total }] },
  });
  assertEqual(payRes.status, 200, 'full neesie payment accepted');
  assertEqual(payRes.data.bill.payment_status, 'paid', 'bill fully paid on the account');

  const listRes = await api(baseUrl, `/api/receivables?customer_id=${customerId}`, { headers: owner.authHeader });
  assertEqual(listRes.status, 200, 'ledger lists the entry');
  assertEqual(listRes.data.entries.length, 1, 'exactly one charge posted');
  const charge = listRes.data.entries[0];
  assertEqual(charge.entry_type, 'charge', 'posted entry is a charge');
  assertEqual(charge.direction, 'debit', 'charge is a debit');
  assertEqual(charge.amount, bill.total, 'charge equals the paid amount');
  assertEqual(charge.reference, String(bill.id), 'charge references the bill');
  assertEqual(charge.customer_id, customerId, 'charge belongs to the order customer');

  const balancesRes = await api(baseUrl, '/api/receivables/balances', { headers: owner.authHeader });
  assertEqual(findBalance(balancesRes.data).balance, bill.total, 'balance equals the outstanding charge');

  // ── 4) Settlement for the full balance zeroes it ──
  const settleRes = await api(baseUrl, '/api/receivables', {
    method: 'POST',
    headers: owner.authHeader,
    body: { customer_id: customerId, entry_type: 'settlement', direction: 'credit', amount: bill.total, payment_method: 'cash' },
  });
  assertEqual(settleRes.status, 201, 'settlement recorded');
  const settledBalances = await api(baseUrl, '/api/receivables/balances', { headers: owner.authHeader });
  assertEqual(findBalance(settledBalances.data).balance, 0, 'balance is zero after the settlement');

  // Settlement requires a payment method.
  const badSettle = await api(baseUrl, '/api/receivables', {
    method: 'POST',
    headers: owner.authHeader,
    body: { customer_id: customerId, entry_type: 'settlement', direction: 'credit', amount: 1000 },
  });
  assertEqual(badSettle.status, 400, 'settlement without a payment method is rejected');

  // ── 5) Hard delete removes rows and their balance effect ──
  const manualCharge = await api(baseUrl, '/api/receivables', {
    method: 'POST',
    headers: owner.authHeader,
    body: { customer_id: customerId, entry_type: 'charge', direction: 'debit', amount: 1000, description: 'Manual charge' },
  });
  assertEqual(manualCharge.status, 201, 'manual charge recorded');
  const delRes = await api(baseUrl, `/api/receivables/${manualCharge.data.entry.id}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(delRes.status, 200, 'charge hard-deleted');
  const balancesAfterDel = await api(baseUrl, '/api/receivables/balances', { headers: owner.authHeader });
  assertEqual(findBalance(balancesAfterDel.data).balance, 0, 'deleting the charge restores the settled balance');

  const settleEntryId = settleRes.data.entry.id;
  const delSettle = await api(baseUrl, `/api/receivables/${settleEntryId}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(delSettle.status, 200, 'settlement hard-deleted');
  // Hard delete also removes ledger rows created by the payment flow itself.
  const delOriginal = await api(baseUrl, `/api/receivables/${charge.id}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(delOriginal.status, 200, 'bill-payment charge hard-deleted');
  const balancesEmpty = await api(baseUrl, '/api/receivables/balances', { headers: owner.authHeader });
  assert(findBalance(balancesEmpty.data) === undefined, 'customer with no remaining ledger rows drops off the balances list');

  const missingDel = await api(baseUrl, '/api/receivables/rcv_missing000000', { method: 'DELETE', headers: owner.authHeader });
  assertEqual(missingDel.status, 404, 'deleting an unknown entry is a 404');

  // ── 6) Split check: guests 1–2 neesie, guest 3 cash — all to one customer ──
  const order2Res = await api(baseUrl, '/api/orders', {
    method: 'POST',
    headers: owner.authHeader,
    body: { type: 'dine_in', customer_id: customerId, guest_count: 3, items: [{ product_id: 'e2e-ghormeh', quantity: 2 }, { product_id: 'e2e-tea', quantity: 1 }] },
  });
  assertEqual(order2Res.status, 201, 'split scenario order created');
  const order2 = order2Res.data.order;
  const ghormeh = order2.items.find((item: any) => item.product_id === 'e2e-ghormeh');
  const tea = order2.items.find((item: any) => item.product_id === 'e2e-tea');
  const bill2Res = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: order2.id }, headers: owner.authHeader });

  const splitRes = await api(baseUrl, `/api/bills/${bill2Res.data.bill.id}/split-check`, {
    method: 'POST',
    headers: owner.authHeader,
    body: { checks: [
      { label: 'Guest 1', items: [{ order_item_id: ghormeh.id, quantity: 1 }] },
      { label: 'Guest 2', items: [{ order_item_id: ghormeh.id, quantity: 1 }] },
      { label: 'Guest 3', items: [{ order_item_id: tea.id, quantity: 1 }] },
    ] },
    });
  assertEqual(splitRes.status, 201, 'three guest checks created');
  const checks = splitRes.data.bills;
  assertEqual(checks.length, 3, 'three guest checks exist');

  const neesie1 = await api(baseUrl, `/api/bills/${checks[0].id}/payments`, {
    method: 'POST', headers: owner.authHeader,
    body: { payments: [{ method: 'customer_account', amount: checks[0].total }] },
  });
  assertEqual(neesie1.status, 200, 'guest 1 check charged to the account');
  const neesie2 = await api(baseUrl, `/api/bills/${checks[1].id}/payments`, {
    method: 'POST', headers: owner.authHeader,
    body: { payments: [{ method: 'customer_account', amount: checks[1].total }] },
  });
  assertEqual(neesie2.status, 200, 'guest 2 check charged to the account');
  const cash3 = await api(baseUrl, `/api/bills/${checks[2].id}/payments`, {
    method: 'POST', headers: owner.authHeader,
    body: { payments: [{ method: 'cash', amount: checks[2].total }] },
  });
  assertEqual(cash3.status, 200, 'guest 3 check paid in cash');
  assertEqual(cash3.data.bill.payment_status, 'paid', 'cash check is paid');

  // The order completes only after every check is settled.
  assertEqual((db.prepare('SELECT status FROM orders WHERE id = ?').get(order2.id) as any).status, 'completed', 'order completes after all checks settle');

  // Exactly the two neesie checks hit the ledger, both to the ORDER's customer.
  const splitChargesRes = await api(baseUrl, `/api/receivables?customer_id=${customerId}&type=charge`, { headers: owner.authHeader });
  const splitCharges = splitChargesRes.data.entries;
  assertEqual(splitCharges.length, 2, 'exactly the two neesie checks posted charges');
  const references = new Set(splitCharges.map((entry: any) => String(entry.reference)));
  assert(references.has(String(checks[0].id)) && references.has(String(checks[1].id)), 'each neesie charge references its own guest check');
  assert(splitCharges.every((entry: any) => String(entry.customer_id) === customerId), 'every split-check charge belongs to the order customer (per-check customers are out of scope for v99)');
  const splitBalances = await api(baseUrl, '/api/receivables/balances', { headers: owner.authHeader });
  assertEqual(findBalance(splitBalances.data).balance, Number(checks[0].total) + Number(checks[1].total), 'balance equals the sum of the neesie checks only');
  assertEqual(Number(checks[0].total) + Number(checks[1].total) + Number(checks[2].total), Number(bill2Res.data.bill.total), 'cash + neesie totals preserve the original bill total');

  // ── 7) Gate: neesie payment with no customer anywhere is rejected ──
  const orphanOrderRes = await api(baseUrl, '/api/orders', {
    method: 'POST',
    headers: owner.authHeader,
    body: { type: 'dine_in', guest_count: 2, items: [{ product_id: 'e2e-tea', quantity: 1 }] },
  });
  const orphanBillRes = await api(baseUrl, '/api/bills/generate', { method: 'POST', body: { order_id: orphanOrderRes.data.order.id }, headers: owner.authHeader });
  const orphanPay = await api(baseUrl, `/api/bills/${orphanBillRes.data.bill.id}/payments`, {
    method: 'POST', headers: owner.authHeader,
    body: { payments: [{ method: 'customer_account', amount: orphanBillRes.data.bill.total }] },
  });
  assertEqual(orphanPay.status, 400, 'customer_account payment without any customer is a 400');

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
