/**
 * Suppliers REST routes: CRUD, duplicate code, validation, soft delete, role gating.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/suppliers-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-suppliers-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { supplierRoutes } = require('../main/routes/suppliers');
const { getSupplier } = require('../main/services/suppliers');

async function main() {
  console.log('Suppliers routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const app = createApp({ '/api/suppliers': supplierRoutes });
  const { baseUrl, server } = await startServer(app);

  // ── Create ──
  const createRes = await api(baseUrl, '/api/suppliers', {
    method: 'POST',
    headers: owner.authHeader,
    body: {
      name: 'Tehran Dairy', code: 'SUP-100', phone: '021-7771000', mobile: '09121000000',
      national_id: '12345678901', economic_code: '100001', address: ' industrial zone', notes: 'Cold chain',
    },
  });
  assertEqual(createRes.status, 201, 'POST /api/suppliers returns 201');
  assertEqual(createRes.data.supplier.name, 'Tehran Dairy', 'API stores supplier name');
  assertEqual(createRes.data.supplier.code, 'SUP-100', 'API stores supplier code');
  assertEqual(createRes.data.supplier.mobile, '09121000000', 'API stores supplier mobile');
  assertEqual(createRes.data.supplier.is_active, 1, 'API defaults to active');

  // snake_case fields round-trip through the API boundary.
  assertEqual(createRes.data.supplier.national_id, '12345678901', 'API exposes national_id');
  assertEqual(createRes.data.supplier.economic_code, '100001', 'API exposes economic_code');
  assertEqual(getSupplier(db, createRes.data.supplier.id).code, 'SUP-100', 'created supplier is persisted');

  // ── Validation ──
  const blankName = await api(baseUrl, '/api/suppliers', {
    method: 'POST', headers: owner.authHeader, body: { name: '   ' },
  });
  assertEqual(blankName.status, 400, 'blank name is a 400');

  const dupCode = await api(baseUrl, '/api/suppliers', {
    method: 'POST', headers: owner.authHeader, body: { name: 'Second', code: 'SUP-100' },
  });
  assertEqual(dupCode.status, 409, 'duplicate code is a 409');

  // ── Read ──
  const one = await api(baseUrl, `/api/suppliers/${createRes.data.supplier.id}`, { headers: owner.authHeader });
  assertEqual(one.status, 200, 'GET /api/suppliers/:id returns 200');
  assertEqual(one.data.supplier.id, createRes.data.supplier.id, 'GET returns the requested supplier');

  const missing = await api(baseUrl, '/api/suppliers/does-not-exist', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing supplier is a 404');

  // ── List ──
  await api(baseUrl, '/api/suppliers', { method: 'POST', headers: owner.authHeader, body: { name: 'Zeytoon Foods' } });
  const list = await api(baseUrl, '/api/suppliers', { headers: owner.authHeader });
  assertEqual(list.status, 200, 'GET /api/suppliers returns 200');
  assertEqual(list.data.suppliers.length, 2, 'list returns all active suppliers');
  assertEqual(list.data.suppliers[0].name, 'Tehran Dairy', 'list is sorted by name nocase');

  const search = await api(baseUrl, '/api/suppliers?search=Zeytoon', { headers: owner.authHeader });
  assertEqual(search.data.suppliers.length, 1, 'list search filters by name');

  // ── Update ──
  const updateRes = await api(baseUrl, `/api/suppliers/${createRes.data.supplier.id}`, {
    method: 'PUT', headers: owner.authHeader, body: { name: 'Tehran Dairy Co.', code: 'SUP-101' },
  });
  assertEqual(updateRes.status, 200, 'PUT /api/suppliers/:id returns 200');
  assertEqual(updateRes.data.supplier.name, 'Tehran Dairy Co.', 'PUT renames supplier');
  assertEqual(updateRes.data.supplier.code, 'SUP-101', 'PUT changes code');

  // Reuse the freed code to prove codes can be re-assigned, then collide.
  const reclaimed = await api(baseUrl, '/api/suppliers', {
    method: 'POST', headers: owner.authHeader, body: { name: 'Code Reclaimer', code: 'SUP-100' },
  });
  assertEqual(reclaimed.status, 201, 'a freed code can be claimed by a new supplier');

  const updateDup = await api(baseUrl, `/api/suppliers/${reclaimed.data.supplier.id}`, {
    method: 'PUT', headers: manager.authHeader, body: { code: 'SUP-101' },
  });
  assertEqual(updateDup.status, 409, 'PUT with a taken code is a 409');

  // ── Soft delete ──
  const del = await api(baseUrl, `/api/suppliers/${createRes.data.supplier.id}`, {
    method: 'DELETE', headers: owner.authHeader,
  });
  assertEqual(del.status, 200, 'DELETE /api/suppliers/:id returns 200');
  assertEqual(del.data.success, true, 'DELETE reports success');

  const afterDelete = await api(baseUrl, `/api/suppliers/${createRes.data.supplier.id}`, { headers: owner.authHeader });
  assertEqual(afterDelete.status, 404, 'deleted supplier is a 404 afterward');

  const includeInactive = await api(baseUrl, '/api/suppliers?include_inactive=true', { headers: owner.authHeader });
  assert(!includeInactive.data.suppliers.some((s: any) => s.id === createRes.data.supplier.id), 'deleted supplier is excluded even with include_inactive');

  // Reclaimed code survives the delete of the original holder.
  assert(
    includeInactive.data.suppliers.some((s: any) => s.code === 'SUP-100'),
    'reclaimed SUP-100 supplier is still listed',
  );

  // ── Role gating ──
  const unauth = await api(baseUrl, '/api/suppliers', { method: 'POST', body: { name: 'No Auth' } });
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
