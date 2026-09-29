/**
 * Purchase returns REST routes: create, delete, list, validation, and role
 * gating.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchase-returns-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchase-return-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { purchaseReturnRoutes } = require('../main/routes/purchase-returns');
const { getPurchaseReturn } = require('../main/services/purchase-returns');
const { getSupply } = require('../main/services/supplies');

async function main() {
  console.log('Purchase returns routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const { createSupplier } = require('../main/services/suppliers');
  const { createSupply } = require('../main/services/supplies');
  const { createPurchaseInvoice, postPurchaseInvoice } = require('../main/services/purchase-invoices');
  createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupplier(db, { id: 'supp-b', name: 'Supplier B', code: 'SB' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 0, actorUserId: owner.userId });

  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    invoiceDate: '2026-01-15',
    items: [
      { supplyId: 'sup-a', quantity: 5, unit: 'kg', unitPrice: 2000 },
    ],
    actorUserId: owner.userId,
  });
  postPurchaseInvoice(db, invoice.id, owner.userId);
  const invoiceItem = require('../main/services/purchase-invoices').getPurchaseInvoice(db, invoice.id, true).items![0];

  const app = createApp({
    '/api/purchase-returns': purchaseReturnRoutes,
    '/api/suppliers': require('../main/routes/suppliers').supplierRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // ── Create via API ──
  const createRes = await api(baseUrl, '/api/purchase-returns', {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      purchase_invoice_id: invoice.id,
      return_date: '2026-01-20',
      reason: 'Damaged bags',
      items: [{ purchase_invoice_item_id: invoiceItem.id, quantity: 2 }],
    },
  });
  assertEqual(createRes.status, 201, 'POST /api/purchase-returns returns 201');
  assertEqual(createRes.data.return.status, 'completed', 'API creates a completed return');
  assertEqual(createRes.data.return.total, 4000, 'API computes the return total');
  assertEqual(createRes.data.return.supplier_name, 'Supplier A', 'API exposes supplier name');
  assertEqual(createRes.data.return.invoice_number, invoice.invoice_number, 'API exposes invoice number');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 3, 'return via API removes stock');

  // ── Validation ──
  const noItems = await api(baseUrl, '/api/purchase-returns', {
    method: 'POST', headers: owner.authHeader, body: { purchase_invoice_id: invoice.id, items: [] },
  });
  assertEqual(noItems.status, 400, 'empty items is a 400');

  const badItems = await api(baseUrl, '/api/purchase-returns', {
    method: 'POST', headers: owner.authHeader, body: { purchase_invoice_id: invoice.id, items: 'nope' },
  });
  assertEqual(badItems.status, 400, 'non-array items is a 400');

  const overReturn = await api(baseUrl, '/api/purchase-returns', {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      purchase_invoice_id: invoice.id,
      items: [{ purchase_invoice_item_id: invoiceItem.id, quantity: 10 }],
    },
  });
  assertEqual(overReturn.status, 409, 'over-return is a 409');

  // ── Read ──
  const one = await api(baseUrl, `/api/purchase-returns/${createRes.data.return.id}`, { headers: owner.authHeader });
  assertEqual(one.status, 200, 'GET /api/purchase-returns/:id returns 200');
  assertEqual(one.data.return.items.length, 1, 'GET returns the record with items');

  const missing = await api(baseUrl, '/api/purchase-returns/does-not-exist', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing return is a 404');

  // ── Delete via API (manager is allowed) ──
  const deleteRes = await api(baseUrl, `/api/purchase-returns/${createRes.data.return.id}`, {
    method: 'DELETE',
    headers: manager.authHeader,
    body: { deletion_reason: 'Wrong entry' },
  });
  assertEqual(deleteRes.status, 200, 'DELETE /:id returns 200');
  assertEqual(deleteRes.data.return.status, 'deleted', 'delete flips status to deleted');
  assertEqual(deleteRes.data.return.deletion_reason, 'Wrong entry', 'delete stores the deletion reason');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 5, 'delete via API restores stock');

  const reDelete = await api(baseUrl, `/api/purchase-returns/${createRes.data.return.id}`, {
    method: 'DELETE', headers: owner.authHeader,
  });
  assertEqual(reDelete.status, 409, 'deleting twice is a 409');

  // ── List filters ──
  const list = await api(baseUrl, '/api/purchase-returns', { headers: owner.authHeader });
  assertEqual(list.status, 200, 'GET /api/purchase-returns returns 200');
  assert(Array.isArray(list.data.returns), 'list returns an array');

  const bySupplier = await api(baseUrl, '/api/purchase-returns?supplier_id=supp-b', { headers: owner.authHeader });
  assertEqual(bySupplier.data.returns.length, 0, 'supplier filter works via API');

  const byInvoice = await api(baseUrl, `/api/purchase-returns?purchase_invoice_id=${invoice.id}`, { headers: owner.authHeader });
  assertEqual(byInvoice.data.returns.length, 1, 'invoice filter works via API');

  // ── Role gating ──
  const unauth = await api(baseUrl, '/api/purchase-returns', {
    method: 'POST', body: { purchase_invoice_id: invoice.id, items: [] },
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
