/**
 * Customer-account (neesie) bill payments: paying a bill with
 * method 'customer_account' posts a charge to the customer's receivable
 * ledger inside the same transaction; refunding such a bill to
 * 'customer_account' posts a credit. Payment without an associated customer
 * is rejected.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/bills-customer-account.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cust-acct-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { billRoutes } = require('../main/routes/bills');
const { refundRoutes } = require('../main/routes/refunds');
const { getCustomerBalance, listReceivableEntries } = require('../main/services/receivables');

async function main() {
  console.log('Bill customer-account (neesie) payment test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  // Refund approvals verify the override PIN against the approver's pin_hash.
  const bcrypt = require('bcryptjs');
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('4321', 10), manager.userId);

  db.prepare(`
    INSERT INTO customers (id, name, is_active, created_at, updated_at)
    VALUES ('cust-a', 'Cafe Naderi', 1, '2026-01-01 00:00:00', '2026-01-01 00:00:00')
  `).run();
  const order = db.prepare(`
    INSERT INTO orders (order_number, customer_id, user_id, status, total)
    VALUES ('ORD-CA-0001', 'cust-a', ?, 'pending', 0)
  `).run(owner.userId);
  const orderId = Number(order.lastInsertRowid);
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, customer_id, total)
    VALUES ('INV-CA-0001', ?, 'cust-a', 300000)
  `).run(orderId);
  const bill = db.prepare("SELECT id, bill_number, total FROM bills WHERE bill_number = 'INV-CA-0001'").get() as any;

  const app = createApp({
    '/api/bills': billRoutes,
    '/api/refunds': refundRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // ── Guard: customer_account without a customer is rejected ──
  const noCustomerOrder = db.prepare(`
    INSERT INTO orders (order_number, user_id, status, total) VALUES ('ORD-CA-0002', ?, 'pending', 0)
  `).run(owner.userId);
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, total) VALUES ('INV-CA-0002', ?, 100000)
  `).run(Number(noCustomerOrder.lastInsertRowid));
  const orphanBill = db.prepare("SELECT id FROM bills WHERE bill_number = 'INV-CA-0002'").get() as any;

  const rejected = await api(baseUrl, `/api/bills/${orphanBill.id}/payment`, {
    method: 'POST',
    headers: owner.authHeader,
    body: { method: 'customer_account' },
  });
  assertEqual(rejected.status, 400, 'customer_account without an associated customer is a 400');

  // ── Partial neesie payment posts a proportional charge ──
  const partial = await api(baseUrl, `/api/bills/${bill.id}/payment`, {
    method: 'POST',
    headers: owner.authHeader,
    body: { method: 'customer_account', amount: 100000 },
  });
  assertEqual(partial.status, 200, 'partial customer_account payment returns 200');
  assertEqual(partial.data.bill.payment_status, 'partial', 'partial payment leaves the bill partial');
  assertEqual(getCustomerBalance(db, 'cust-a'), 100000, 'charge posts the paid amount to the ledger');

  const charges = listReceivableEntries(db, { customerId: 'cust-a', entryType: 'charge' }).entries;
  assertEqual(charges.length, 1, 'one charge row exists');
  assertEqual(charges[0].description, `Bill ${bill.bill_number}`, 'charge description names the bill');
  assertEqual(charges[0].reference, String(bill.id), 'charge references the bill id');
  assertEqual(charges[0].created_by, owner.userId, 'charge attributes the actor');

  // ── Settle the rest in cash: no extra charge ──
  const cash = await api(baseUrl, `/api/bills/${bill.id}/payment`, {
    method: 'POST',
    headers: manager.authHeader,
    body: { method: 'cash', amount: 200000 },
  });
  assertEqual(cash.status, 200, 'cash settlement returns 200');
  assertEqual(cash.data.bill.payment_status, 'paid', 'cash completes the bill');
  assertEqual(getCustomerBalance(db, 'cust-a'), 100000, 'cash payment does not touch the ledger');

  // ── Refund to customer_account posts a credit ──
  // Manager PIN flow: refunds require an override PIN; resolveRefundApprover
  // accepts an approverId fallback when the PIN matches the approver role.
  const refundRes = await api(baseUrl, `/api/refunds`, {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      bill_id: bill.id,
      amount: 50000,
      method: 'customer_account',
      reason: 'Wrong item',
      override_pin: '4321',
      manager_id: manager.userId,
    },
  });
  assert([200, 201].includes(refundRes.status), `refund returns success (got ${refundRes.status}: ${JSON.stringify(refundRes.data)})`);
  const balanceAfterRefund = getCustomerBalance(db, 'cust-a');
  assertEqual(balanceAfterRefund, 100000 - 50000, 'refund posts a credit and lowers the debt');

  // Ledger shows both sides for the same bill reference.
  const credits = db.prepare(`
    SELECT e.* FROM receivable_entries e WHERE e.customer_id = 'cust-a' AND e.direction = 'credit'
  `).all();
  assertEqual(credits.length, 1, 'one credit row exists');
  assertEqual(credits[0].entry_type, 'adjustment', 'refund credit is an adjustment');
  assertEqual(credits[0].description, `Refund of bill ${bill.bill_number}`, 'credit description names the bill');

  // ── Idempotent replay does not double-charge ──
  const replayBill = db.prepare(`
    INSERT INTO bills (bill_number, order_id, customer_id, total) VALUES ('INV-CA-0003', ?, 'cust-a', 80000)
  `).run(orderId);
  const replayBillId = Number(replayBill.lastInsertRowid);
  const firstPay = await api(baseUrl, `/api/bills/${replayBillId}/payment`, {
    method: 'POST',
    headers: owner.authHeader,
    body: { method: 'customer_account', amount: 80000, transaction_id: 'TX-CA-1' },
  });
  assertEqual(firstPay.status, 200, 'first neesie payment succeeds');
  const balanceBeforeReplay = getCustomerBalance(db, 'cust-a');
  const replay = await api(baseUrl, `/api/bills/${replayBillId}/payment`, {
    method: 'POST',
    headers: owner.authHeader,
    body: { method: 'customer_account', amount: 80000, transaction_id: 'TX-CA-1' },
  });
  assertEqual(replay.status, 200, 'replayed payment returns 200');
  assertEqual(getCustomerBalance(db, 'cust-a'), balanceBeforeReplay, 'replay does not double-charge the ledger');

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
