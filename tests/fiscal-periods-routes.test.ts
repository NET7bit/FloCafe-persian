/**
 * Fiscal periods routes coverage: role gating (owner/manager; owner-only
 * reopen), CRUD status codes, close/reopen with owner PIN, and error mapping.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/fiscal-periods-routes.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fiscal-routes-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const { fiscalPeriodRoutes } = require('../main/routes/fiscal-periods');
const bcrypt = require('bcryptjs');

async function main() {
  console.log('Fiscal periods routes test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('3333', 10), owner.userId);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('4444', 10), manager.userId);

  const app = createApp({ '/api/fiscal-periods': fiscalPeriodRoutes });
  const { baseUrl, server } = await startServer(app);

  // ── Create ──
  const create = await api(baseUrl, '/api/fiscal-periods', {
    method: 'POST',
    headers: owner.authHeader,
    body: { period_type: 'month', start_date: '2025-03-01', name: 'اسفند' },
  });
  assertEqual(create.status, 201, 'period created via API');
  assertEqual(create.data.period.end_date, '2025-03-31', 'API returns derived end date');
  const periodId = create.data.period.id;

  const invalid = await api(baseUrl, '/api/fiscal-periods', {
    method: 'POST',
    headers: owner.authHeader,
    body: { period_type: 'month', start_date: '2025-03-01' },
  });
  assertEqual(invalid.status, 409, 'duplicate period creation returns 409');

  const bad = await api(baseUrl, '/api/fiscal-periods', {
    method: 'POST',
    headers: owner.authHeader,
    body: { period_type: 'month', start_date: 'garbage' },
  });
  assertEqual(bad.status, 400, 'invalid date returns 400');

  // ── List & get ──
  const list = await api(baseUrl, '/api/fiscal-periods', { headers: owner.authHeader });
  assertEqual(list.status, 200, 'list periods');
  assertEqual(list.data.periods.length, 1, 'list contains the created period');

  const got = await api(baseUrl, `/api/fiscal-periods/${periodId}`, { headers: owner.authHeader });
  assertEqual(got.status, 200, 'get period by id');
  const missing = await api(baseUrl, '/api/fiscal-periods/fp_missing0000000', { headers: owner.authHeader });
  assertEqual(missing.status, 404, 'missing period returns 404');

  // ── Close: manager allowed, not-yet-ended rejected ──
  const ongoing = await api(baseUrl, '/api/fiscal-periods', {
    method: 'POST', headers: manager.authHeader,
    body: { period_type: 'year', start_date: `${new Date().getUTCFullYear() + 1}-01-01` },
  });
  assertEqual(ongoing.status, 201, 'ongoing-year period created');
  const earlyClose = await api(baseUrl, `/api/fiscal-periods/${ongoing.data.period.id}/close`, {
    method: 'POST', headers: manager.authHeader,
  });
  assertEqual(earlyClose.status, 409, 'closing a not-yet-ended period returns 409');

  const future = await api(baseUrl, '/api/fiscal-periods', {
    method: 'POST',
    headers: manager.authHeader,
    body: { period_type: 'month', start_date: '2024-10-01' },
  });
  assertEqual(future.status, 201, 'manager can create periods');
  const close = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/close`, {
    method: 'POST', headers: manager.authHeader,
  });
  assertEqual(close.status, 200, 'manager closes a past period');
  assertEqual(close.data.period.status, 'closed', 'period closed via API');

  // ── Reopen: owner role + owner PIN ──
  const noPin = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/reopen`, {
    method: 'POST', headers: owner.authHeader, body: {},
  });
  assertEqual(noPin.status, 400, 'reopen without PIN returns 400');

  const managerPin = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/reopen`, {
    method: 'POST', headers: owner.authHeader, body: { override_pin: '4444', approver_id: manager.userId },
  });
  assertEqual(managerPin.status, 403, 'manager PIN rejected on reopen');

  const ownerSelf = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/reopen`, {
    method: 'POST', headers: manager.authHeader, body: { override_pin: '4444', approver_id: manager.userId },
  });
  assertEqual(ownerSelf.status, 403, 'manager role cannot call reopen');

  const reopen = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/reopen`, {
    method: 'POST', headers: owner.authHeader, body: { override_pin: '3333', approver_id: owner.userId },
  });
  assertEqual(reopen.status, 200, 'owner PIN reopens');
  assertEqual(reopen.data.period.status, 'open', 'period reopened via API');
  assertEqual(reopen.data.period.reopened_by, owner.userId, 'reopen attribution returned');

  // Close it again, then a wrong owner PIN returns 403 before the status check.
  await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/close`, {
    method: 'POST', headers: owner.authHeader,
  });
  const wrongPin = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}/reopen`, {
    method: 'POST', headers: owner.authHeader, body: { override_pin: '9999', approver_id: owner.userId },
  });
  assertEqual(wrongPin.status, 403, 'wrong owner PIN returns 403');

  // ── Delete: open ok, closed rejected ──
  const delOpen = await api(baseUrl, `/api/fiscal-periods/${periodId}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(delOpen.status, 200, 'open period deleted');

  const delClosed = await api(baseUrl, `/api/fiscal-periods/${future.data.period.id}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(delClosed.status, 409, 'closed period delete returns 409');

  const unknownDel = await api(baseUrl, '/api/fiscal-periods/fp_missing0000000', { method: 'DELETE', headers: owner.authHeader });
  assertEqual(unknownDel.status, 404, 'deleting a missing period returns 404');

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
