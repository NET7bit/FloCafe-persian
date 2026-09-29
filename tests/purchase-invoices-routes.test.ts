/**
 * Purchase invoices REST routes: create draft, post, cancel, list, validation,
 * and role gating.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchase-invoices-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchase-invoice-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { purchaseInvoiceRoutes } = require('../main/routes/purchase-invoices');
const { getPurchaseInvoice } = require('../main/services/purchase-invoices');
const { getSupply } = require('../main/services/supplies');

async function main() {
  console.log('Purchase invoices routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const { createSupplier } = require('../main/services/suppliers');
  const { createSupply } = require('../main/services/supplies');
  createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupplier(db, { id: 'supp-b', name: 'Supplier B', code: 'SB' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 10, actorUserId: owner.userId });

  const app = createApp({
    '/api/purchase-invoices': purchaseInvoiceRoutes,
    '/api/suppliers': require('../main/routes/suppliers').supplierRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  // ── Create draft ──
  const createRes = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      supplier_id: 'supp-a',
      invoice_date: '2026-01-15',
      due_date: '2026-02-15',
      notes: 'Monthly delivery',
      items: [{ supply_id: 'sup-a', quantity: 5, unit: 'kg', unit_price: 2000, tax_amount: 500 }],
    },
  });
  assertEqual(createRes.status, 201, 'POST /api/purchase-invoices returns 201');
  assertEqual(createRes.data.invoice.status, 'draft', 'API creates a draft invoice');
  assertEqual(createRes.data.invoice.total, 10500, 'API computes the invoice total');
  assertEqual(createRes.data.invoice.supplier_name, 'Supplier A', 'API exposes supplier name');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 10, 'draft via API does not change stock');

  // ── Validation ──
  const noSupplier = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST', headers: owner.authHeader, body: { items: [] },
  });
  assertEqual(noSupplier.status, 400, 'missing supplier is a 400');

  const badItems = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST', headers: owner.authHeader, body: { supplier_id: 'supp-a', items: 'not-an-array' },
  });
  assertEqual(badItems.status, 400, 'non-array items is a 400');

  // ── Read ──
  const one = await api(baseUrl, `/api/purchase-invoices/${createRes.data.invoice.id}`, { headers: owner.authHeader });
  assertEqual(one.status, 200, 'GET /api/purchase-invoices/:id returns 200');
  assertEqual(one.data.invoice.items.length, 1, 'GET returns invoice with items');

  const missing = await api(baseUrl, '/api/purchase-invoices/does-not-exist', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing invoice is a 404');

  // ── Post via API ──
  const postRes = await api(baseUrl, `/api/purchase-invoices/${createRes.data.invoice.id}/post`, {
    method: 'POST', headers: manager.authHeader,
  });
  assertEqual(postRes.status, 200, 'POST /:id/post returns 200');
  assertEqual(postRes.data.invoice.status, 'posted', 'posting flips status to posted');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 15, 'posting via API receives stock');

  const rePost = await api(baseUrl, `/api/purchase-invoices/${createRes.data.invoice.id}/post`, {
    method: 'POST', headers: owner.authHeader,
  });
  assertEqual(rePost.status, 409, 'posting twice is a 409');

  // ── Cancel via API ──
  const draft2 = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-b', invoice_date: '2026-01-16', items: [{ supply_id: 'sup-a', quantity: 2, unit: 'kg', unit_price: 1000 }] },
  });
  const cancelRes = await api(baseUrl, `/api/purchase-invoices/${draft2.data.invoice.id}/cancel`, {
    method: 'POST', headers: owner.authHeader,
  });
  assertEqual(cancelRes.status, 200, 'POST /:id/cancel returns 200');
  assertEqual(cancelRes.data.invoice.status, 'cancelled', 'cancel flips status to cancelled');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 15, 'cancelling a draft does not change stock');

  // ── Update draft via API ──
  const draft3 = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-a', invoice_date: '2026-01-17', items: [{ supply_id: 'sup-a', quantity: 1, unit: 'kg', unit_price: 1000 }] },
  });
  const updateRes = await api(baseUrl, `/api/purchase-invoices/${draft3.data.invoice.id}`, {
    method: 'PUT', headers: owner.authHeader,
    body: { notes: 'Updated', items: [{ supply_id: 'sup-a', quantity: 3, unit: 'kg', unit_price: 1000 }] },
  });
  assertEqual(updateRes.status, 200, 'PUT returns 200 for a draft');
  assertEqual(updateRes.data.invoice.total, 3000, 'PUT recomputes the total');
  assertEqual(updateRes.data.invoice.notes, 'Updated', 'PUT stores notes');

  const updatePosted = await api(baseUrl, `/api/purchase-invoices/${createRes.data.invoice.id}`, {
    method: 'PUT', headers: owner.authHeader, body: { notes: 'No' },
  });
  assertEqual(updatePosted.status, 409, 'PUT on a posted invoice is a 409');

  // ── List filters ──
  const list = await api(baseUrl, '/api/purchase-invoices', { headers: owner.authHeader });
  assertEqual(list.status, 200, 'GET /api/purchase-invoices returns 200');
  assert(list.data.invoices.length >= 3, 'list returns the created invoices');

  const draftsOnly = await api(baseUrl, '/api/purchase-invoices?status=draft', { headers: owner.authHeader });
  assert(draftsOnly.data.invoices.every((i: any) => i.status === 'draft'), 'status filter works via API');

  const bySupplier = await api(baseUrl, '/api/purchase-invoices?supplier_id=supp-b', { headers: owner.authHeader });
  assert(bySupplier.data.invoices.every((i: any) => i.supplier_id === 'supp-b'), 'supplier filter works via API');

  const badStatus = await api(baseUrl, '/api/purchase-invoices?status=bogus', { headers: owner.authHeader });
  assertEqual(badStatus.status, 400, 'invalid status filter is a 400');

  // ── Role gating ──
  const unauth = await api(baseUrl, '/api/purchase-invoices', { method: 'POST', body: { supplier_id: 'supp-a', items: [] } });
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
