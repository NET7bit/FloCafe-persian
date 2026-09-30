/**
 * Fiscal periods service coverage: period math (month/year end dates),
 * overlap rejection, close gating on future/ongoing periods, owner-PIN
 * reopen, delete rules, and the derived closed-period gate that v93–v99
 * modules consume.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/fiscal-periods-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-fiscal-service-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser, seedManagerUser,
} = require('./helpers/test-setup');
const {
  createFiscalPeriod, closeFiscalPeriod, reopenFiscalPeriod, deleteFiscalPeriod,
  getFiscalPeriod, listFiscalPeriods, assertNotInClosedPeriod, FiscalPeriodError,
} = require('../main/services/fiscal-periods');
const bcrypt = require('bcryptjs');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    assert(err instanceof FiscalPeriodError && err.statusCode === statusCode, `${message} (got ${err.statusCode}: ${err.message})`);
  }
}

async function main() {
  console.log('Fiscal periods service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('1111', 10), owner.userId);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('2222', 10), manager.userId);

  // ── Creation & period math ──
  const month = createFiscalPeriod(db, { periodType: 'month', startDate: '2026-02-01', name: 'بهمن', actorUserId: owner.userId });
  assertEqual(month.end_date, '2026-02-28', 'month period ends on its last day (2026 not a leap year)');
  assertEqual(month.status, 'open', 'period starts open');

  const leap = createFiscalPeriod(db, { periodType: 'month', startDate: '2024-02-01', actorUserId: owner.userId });
  assertEqual(leap.end_date, '2024-02-29', 'leap February ends on the 29th');

  const year = createFiscalPeriod(db, { periodType: 'year', startDate: '2025-01-01', name: '۱۴۰۴', actorUserId: owner.userId });
  assertEqual(year.end_date, '2025-12-31', 'year period spans the calendar year');

  expectError(400, () => createFiscalPeriod(db, { periodType: 'year', startDate: '2026-06-01', actorUserId: owner.userId }), 'year period must start on January 1');
  expectError(400, () => createFiscalPeriod(db, { periodType: 'month', startDate: 'not-a-date', actorUserId: owner.userId }), 'invalid start_date rejected');
  expectError(400, () => createFiscalPeriod(db, { periodType: 'week' as any, startDate: '2026-03-01', actorUserId: owner.userId }), 'unknown period_type rejected');
  expectError(400, () => createFiscalPeriod(db, { periodType: 'month', startDate: '2026-04-01', actorUserId: '' }), 'missing actor rejected');
  expectError(409, () => createFiscalPeriod(db, { periodType: 'month', startDate: '2025-07-15', actorUserId: owner.userId }), 'month inside a closed-year candidate overlaps the year period');
  expectError(409, () => createFiscalPeriod(db, { periodType: 'year', startDate: '2026-01-01', actorUserId: owner.userId }), 'year overlapping an existing month period is rejected');
  // Adjacent periods are fine (no overlap).
  const nextMonth = createFiscalPeriod(db, { periodType: 'month', startDate: '2026-03-01', actorUserId: owner.userId });
  assertEqual(nextMonth.end_date, '2026-03-31', 'adjacent month period accepted');

  // ── Close gating ──
  // A period whose end date has not passed yet (dynamically the next year) cannot close.
  const futureYear = createFiscalPeriod(db, { periodType: 'year', startDate: `${new Date().getUTCFullYear() + 1}-01-01`, actorUserId: owner.userId });
  expectError(409, () => closeFiscalPeriod(db, futureYear.id, owner.userId), 'a period that has not ended cannot be closed');
  const past = createFiscalPeriod(db, { periodType: 'month', startDate: '2024-12-01', actorUserId: owner.userId });
  expectError(409, () => createFiscalPeriod(db, { periodType: 'month', startDate: '2024-12-01', actorUserId: owner.userId }), 'duplicate same-type period rejected');
  const closed = closeFiscalPeriod(db, past.id, owner.userId);
  assertEqual(closed.status, 'closed', 'past period closed');
  assert(!!closed.closed_by && !!closed.closed_at, 'close attribution recorded');
  expectError(409, () => closeFiscalPeriod(db, past.id, owner.userId), 'already-closed period cannot be re-closed');

  // ── The derived lock gate ──
  expectError(409, () => assertNotInClosedPeriod(db, '2024-12-15'), 'document dated inside the closed period is rejected');
  expectError(409, () => assertNotInClosedPeriod(db, '2024-12-01'), 'first day of the closed period is rejected (inclusive)');
  expectError(409, () => assertNotInClosedPeriod(db, '2024-12-31'), 'last day of the closed period is rejected (inclusive)');
  assertNotInClosedPeriod(db, '2024-11-30');
  assertNotInClosedPeriod(db, '2025-01-01');
  console.log('  ✓ dates outside the closed period pass the gate');

  // ── Reopen: owner PIN required ──
  expectError(400, () => reopenFiscalPeriod(db, past.id, '', owner.userId, owner.userId), 'reopen without a PIN is rejected');
  expectError(403, () => reopenFiscalPeriod(db, past.id, '9999', owner.userId, owner.userId), 'wrong PIN rejected');
  expectError(403, () => reopenFiscalPeriod(db, past.id, '2222', manager.userId, owner.userId), 'manager PIN rejected (owner only)');
  const reopened = reopenFiscalPeriod(db, past.id, '1111', owner.userId, owner.userId);
  assertEqual(reopened.status, 'open', 'owner PIN reopens the period');
  assertEqual(reopened.reopened_by, owner.userId, 'reopen attribution records the approving owner');
  assertNotInClosedPeriod(db, '2024-12-15');
  console.log('  ✓ reopened period accepts documents again');

  // Close again for the lock interplay test.
  closeFiscalPeriod(db, past.id, owner.userId);
  expectError(409, () => assertNotInClosedPeriod(db, '2024-12-20'), 're-closed period locks again');

  // ── Delete rules ──
  const openPeriod = createFiscalPeriod(db, { periodType: 'month', startDate: '2026-06-01', actorUserId: owner.userId });
  deleteFiscalPeriod(db, openPeriod.id, owner.userId);
  expectError(404, () => getFiscalPeriod(db, openPeriod.id), 'open period deleted');
  expectError(409, () => deleteFiscalPeriod(db, past.id, owner.userId), 'closed period cannot be deleted');

  // ── Listing ──
  assert(listFiscalPeriods(db).length >= 4, 'list returns all periods');
  assert(listFiscalPeriods(db, 'closed').every((p: any) => p.status === 'closed'), 'closed filter works');
  assertEqual(listFiscalPeriods(db, 'closed')[0].start_date, '2024-12-01', 'closed list ordered newest first');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
