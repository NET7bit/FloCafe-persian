/**
 * Stage-1 fiscal hardening coverage.
 *
 * Documents the decided matrix:
 * - a draft purchase invoice dated inside a CLOSED period stays editable
 *   (draft edits have no financial effect; posting is what is gated),
 * - that draft still cannot be posted while the period is closed, and posts
 *   immediately after the owner reopens it,
 * - reopening is owner-PIN gated and PIN attempts are rate limited,
 * - a period containing the current business date cannot be closed,
 * - fiscal routes return 401 without authentication.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/fiscal-hardening.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fiscal-hardening-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { supplierRoutes } = require('../main/routes/suppliers');
const { purchaseInvoiceRoutes } = require('../main/routes/purchase-invoices');
const { fiscalPeriodRoutes } = require('../main/routes/fiscal-periods');
const { createFiscalPeriod, closeFiscalPeriod } = require('../main/services/fiscal-periods');
const { resetPinRateLimitForTests } = require('../main/routes/orders');
const bcrypt = require('bcryptjs');

async function main() {
  console.log('Fiscal hardening (Stage 1) test');
  console.log('='.repeat(50));
  resetCounters();
  resetPinRateLimitForTests();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedManagerUser(db);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('6666', 10), owner.userId);

  db.prepare(`
    INSERT INTO supplies (id, name, base_unit, stock_quantity, is_active, created_at, updated_at)
    VALUES ('sup-hard', 'Saffron', 'g', 0, 1, '2025-04-01 00:00:00', '2025-04-01 00:00:00')
  `).run();

  const app = createApp({
    '/api/suppliers': supplierRoutes,
    '/api/purchase-invoices': purchaseInvoiceRoutes,
    '/api/fiscal-periods': fiscalPeriodRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  const supplier = await api(baseUrl, '/api/suppliers', { method: 'POST', headers: owner.authHeader, body: { name: 'Hardening Supplier' } });
  const supplierId = supplier.data.supplier.id;

  // Draft invoice dated inside a month we will close.
  const invoice = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST', headers: owner.authHeader,
    body: {
      supplier_id: supplierId,
      invoice_date: '2025-04-10',
      items: [{ supply_id: 'sup-hard', quantity: 5, unit: 'g', unit_price: 2000 }],
    },
  });
  assertEqual(invoice.status, 201, 'draft invoice created');
  const invoiceId = invoice.data.invoice.id;

  const period = createFiscalPeriod(db, { periodType: 'month', startDate: '2025-04-01', actorUserId: owner.userId });
  closeFiscalPeriod(db, period.id, owner.userId);

  // ── F1: draft stays editable inside a closed period ──
  const edit = await api(baseUrl, `/api/purchase-invoices/${invoiceId}`, {
    method: 'PUT', headers: owner.authHeader,
    body: {
      notes: 'edited while period closed',
      items: [{ supply_id: 'sup-hard', quantity: 7, unit: 'g', unit_price: 2100 }],
    },
  });
  assertEqual(edit.status, 200, 'draft invoice dated in a closed period stays editable');

  // ── Post stays locked while closed ──
  const postLocked = await api(baseUrl, `/api/purchase-invoices/${invoiceId}/post`, { method: 'POST', headers: owner.authHeader });
  assertEqual(postLocked.status, 409, 'posting into a closed period remains a 409');

  // ── Reopen is owner-PIN gated and rate limited ──
  resetPinRateLimitForTests();
  let lastStatus = 0;
  for (let attempt = 0; attempt < 7; attempt++) {
    const res = await api(baseUrl, `/api/fiscal-periods/${period.id}/reopen`, {
      method: 'POST', headers: owner.authHeader,
      body: { override_pin: '0000', approver_id: owner.userId },
    });
    lastStatus = res.status;
  }
  assertEqual(lastStatus, 429, 'repeated bad reopen PINs hit the rate limiter (429)');

  resetPinRateLimitForTests();
  const reopen = await api(baseUrl, `/api/fiscal-periods/${period.id}/reopen`, {
    method: 'POST', headers: owner.authHeader,
    body: { override_pin: '6666', approver_id: owner.userId },
  });
  assertEqual(reopen.status, 200, 'correct owner PIN reopens after limiter reset');

  // ── Post succeeds after reopen ──
  const postAfter = await api(baseUrl, `/api/purchase-invoices/${invoiceId}/post`, { method: 'POST', headers: owner.authHeader });
  assertEqual(postAfter.status, 200, 'invoice posts right after reopening');
  assertEqual(postAfter.data.invoice.status, 'posted', 'invoice is posted with the edited items');

  // ── A period containing the current business date cannot close ──
  const today = new Date();
  const thisMonth = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const currentPeriod = await api(baseUrl, '/api/fiscal-periods', {
    method: 'POST', headers: owner.authHeader,
    body: { period_type: 'month', start_date: thisMonth },
  });
  assertEqual(currentPeriod.status, 201, 'current-month period created');
  const earlyClose = await api(baseUrl, `/api/fiscal-periods/${currentPeriod.data.period.id}/close`, {
    method: 'POST', headers: owner.authHeader,
  });
  assertEqual(earlyClose.status, 409, 'a period containing today cannot be closed');

  // ── Unauthenticated fiscal routes are 401 ──
  const noAuthList = await api(baseUrl, '/api/fiscal-periods');
  assertEqual(noAuthList.status, 401, 'listing without auth is 401');
  const noAuthCreate = await api(baseUrl, '/api/fiscal-periods', { method: 'POST', body: { period_type: 'month', start_date: '2030-01-01' } });
  assertEqual(noAuthCreate.status, 401, 'creating without auth is 401');
  const noAuthReopen = await api(baseUrl, `/api/fiscal-periods/${period.id}/reopen`, { method: 'POST', body: { override_pin: '6666' } });
  assertEqual(noAuthReopen.status, 401, 'reopening without auth is 401');

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
