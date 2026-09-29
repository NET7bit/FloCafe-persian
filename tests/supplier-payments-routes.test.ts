/**
 * Supplier payments REST routes: create, list, delete, totals, role gating.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supplier-payments-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supplier-payment-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { supplierPaymentRoutes } = require('../main/routes/supplier-payments');
const { supplierRoutes } = require('../main/routes/suppliers');
const { purchaseInvoiceRoutes } = require('../main/routes/purchase-invoices');
const { createSupplier } = require('../main/services/suppliers');
const { createSupply } = require('../main/services/supplies');
const { createPurchaseInvoice, postPurchaseInvoice } = require('../main/services/purchase-invoices');

async function main() {
  console.log('Supplier payments routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupplier(db, { id: 'supp-b', name: 'Supplier B', code: 'SB' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 0, actorUserId: owner.userId });

  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-a', invoiceDate: '2026-01-15',
    items: [{ supplyId: 'sup-a', quantity: 10, unit: 'kg', unitPrice: 1000 }],
    actorUserId: owner.userId,
  });
  postPurchaseInvoice(db, invoice.id, owner.userId);

  const app = createApp({
    '/api/supplier-payments': supplierPaymentRoutes,
    '/api/suppliers': supplierRoutes,
    '/api/purchase-invoices': purchaseInvoiceRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // ── Create payment ──
  const createRes = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST',
    headers: manager.authHeader,
    body: {
      supplier_id: 'supp-a',
      purchase_invoice_id: invoice.id,
      amount: 4000,
      payment_method: 'cash',
      paid_at: '2026-01-20',
      reference: 'CASH-001',
      notes: 'First installment',
    },
  });
  assertEqual(createRes.status, 201, 'POST /api/supplier-payments returns 201');
  assertEqual(createRes.data.payment.amount, 4000, 'API stores amount');
  assertEqual(createRes.data.payment.payment_method, 'cash', 'API stores method');
  assertEqual(createRes.data.payment.supplier_name, 'Supplier A', 'API exposes supplier name');
  assertEqual(createRes.data.payment.invoice_number, invoice.invoice_number, 'API exposes invoice number');

  // ── Validation ──
  const zeroAmount = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-a', amount: 0, payment_method: 'cash' },
  });
  assertEqual(zeroAmount.status, 400, 'zero amount is a 400');

  const badMethod = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-a', amount: 10, payment_method: 'crypto' },
  });
  assertEqual(badMethod.status, 400, 'unknown method is a 400');

  const missingSupplier = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'nope', amount: 10, payment_method: 'cash' },
  });
  assertEqual(missingSupplier.status, 404, 'missing supplier is a 404');

  const wrongSupplier = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-b', purchase_invoice_id: invoice.id, amount: 10, payment_method: 'cash' },
  });
  assertEqual(wrongSupplier.status, 400, 'payment for another supplier invoice is a 400');

  // ── Read ──
  const one = await api(baseUrl, `/api/supplier-payments/${createRes.data.payment.id}`, { headers: owner.authHeader });
  assertEqual(one.status, 200, 'GET /api/supplier-payments/:id returns 200');
  assertEqual(one.data.payment.reference, 'CASH-001', 'GET returns reference');

  const missing = await api(baseUrl, '/api/supplier-payments/does-not-exist', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing payment is a 404');

  // ── Supplier totals ──
  await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-a', amount: 250, payment_method: 'bank_transfer' },
  });
  const totals = await api(baseUrl, '/api/supplier-payments/supplier-totals/supp-a', { headers: owner.authHeader });
  assertEqual(totals.status, 200, 'supplier totals endpoint returns 200');
  assertEqual(totals.data.total, 4250, 'supplier totals sum all payments');

  // ── List filters ──
  const list = await api(baseUrl, '/api/supplier-payments', { headers: owner.authHeader });
  assertEqual(list.status, 200, 'GET /api/supplier-payments returns 200');
  assert(list.data.payments.length >= 2, 'list returns all payments');

  const byMethod = await api(baseUrl, '/api/supplier-payments?payment_method=cash', { headers: owner.authHeader });
  assert(byMethod.data.payments.every((p: any) => p.payment_method === 'cash'), 'method filter works via API');

  const byInvoice = await api(baseUrl, `/api/supplier-payments?purchase_invoice_id=${invoice.id}`, { headers: owner.authHeader });
  assert(byInvoice.data.payments.every((p: any) => p.purchase_invoice_id === invoice.id), 'invoice filter works via API');

  const badFilter = await api(baseUrl, '/api/supplier-payments?payment_method=bogus', { headers: owner.authHeader });
  assertEqual(badFilter.status, 400, 'invalid method filter is a 400');

  // ── Delete via API ──
  const del = await api(baseUrl, `/api/supplier-payments/${createRes.data.payment.id}`, {
    method: 'DELETE', headers: owner.authHeader,
  });
  assertEqual(del.status, 200, 'DELETE returns 200');
  assertEqual(del.data.success, true, 'DELETE reports success');
  const afterDelete = await api(baseUrl, `/api/supplier-payments/${createRes.data.payment.id}`, { headers: owner.authHeader });
  assertEqual(afterDelete.status, 404, 'deleted payment is a 404 afterward');

  // ── Role gating ──
  const unauth = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', body: { supplier_id: 'supp-a', amount: 1, payment_method: 'cash' },
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
