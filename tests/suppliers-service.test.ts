/**
 * Suppliers service: CRUD, duplicate code, validation, soft delete, list filters.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/suppliers-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-suppliers-service-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const {
  createSupplier, getSupplier, listSuppliers, updateSupplier, softDeleteSupplier, SupplierServiceError,
} = require('../main/services/suppliers');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Suppliers service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();

  // ── Create ──
  const ali = createSupplier(db, {
    name: 'Ali Beverage Co.', code: 'SUP-001', phone: '021-5550100', mobile: '09120000001',
    nationalId: '11111111111', economicCode: '999999', address: 'Tehran, Main St', notes: 'Primary distributor',
  });
  assertEqual(ali.name, 'Ali Beverage Co.', 'create stores name');
  assertEqual(ali.code, 'SUP-001', 'create stores code');
  assertEqual(ali.phone, '021-5550100', 'create stores phone');
  assertEqual(ali.mobile, '09120000001', 'create stores mobile');
  assertEqual(ali.national_id, '11111111111', 'create stores national id');
  assertEqual(ali.economic_code, '999999', 'create stores economic code');
  assertEqual(ali.address, 'Tehran, Main St', 'create stores address');
  assertEqual(ali.notes, 'Primary distributor', 'create stores notes');
  assertEqual(ali.is_active, 1, 'create defaults to active');
  assert(ali.id.startsWith('supp_'), 'create generates supplier id');
  assertEqual(ali.deleted_at, null, 'create has no deleted_at');

  // ── Validation ──
  expectServiceError(() => createSupplier(db, { name: '   ' }), 400, 'create rejects blank name');
  expectServiceError(() => createSupplier(db, { name: 'X'.repeat(201) }), 400, 'create rejects long name');
  expectServiceError(() => createSupplier(db, { name: 'Long Code', code: 'X'.repeat(65) }), 400, 'create rejects long code');
  expectServiceError(() => createSupplier(db, { name: 'Bad', address: 'X'.repeat(501) }), 400, 'create rejects long address');

  // code is trimmed; whitespace-only code collapses to NULL and is allowed
  const whitespaceCode = createSupplier(db, { name: 'Whitespace Code Supplier', code: '   ' });
  assertEqual(whitespaceCode.code, null, 'whitespace-only code is stored as null');

  // ── Duplicate code ──
  expectServiceError(() => createSupplier(db, { name: 'Dup', code: 'SUP-001' }), 409, 'duplicate code is rejected');
  // A deleted supplier's code can be reused.
  softDeleteSupplier(db, ali.id);
  const reused = createSupplier(db, { name: 'New Owner of SUP-001', code: 'SUP-001' });
  assertEqual(reused.code, 'SUP-001', 'code is reusable after the previous supplier is deleted');

  // ── national_id is not unique ──
  const dupNational = createSupplier(db, { name: 'Shared National Id', nationalId: '11111111111' });
  assertEqual(dupNational.national_id, '11111111111', 'duplicate national_id is allowed');

  // ── Update ──
  const milk = createSupplier(db, { name: 'Milk Farm', code: 'SUP-002', mobile: '09120000002' });
  const updated = updateSupplier(db, milk.id, { name: 'Fresh Milk Farm', notes: 'Delivers daily' });
  assertEqual(updated.name, 'Fresh Milk Farm', 'update renames supplier');
  assertEqual(updated.notes, 'Delivers daily', 'update sets notes');
  assertEqual(updated.mobile, '09120000002', 'update preserves untouched mobile');
  assertEqual(updated.code, 'SUP-002', 'update preserves untouched code');

  // update can clear optional fields (null input)
  const cleared = updateSupplier(db, milk.id, { code: null, mobile: null });
  assertEqual(cleared.code, null, 'update can clear code');
  assertEqual(cleared.mobile, null, 'update can clear mobile');

  // update to a code owned by another supplier is rejected
  const rival = createSupplier(db, { name: 'Rival', code: 'SUP-003' });
  expectServiceError(() => updateSupplier(db, milk.id, { code: 'SUP-003' }), 409, 'update to a duplicate code is rejected');
  // keeping the supplier's own code is fine
  const keepOwn = updateSupplier(db, rival.id, { name: 'Rival Renamed' });
  assertEqual(keepOwn.code, 'SUP-003', 'update may keep its own code');
  expectServiceError(() => updateSupplier(db, milk.id, { name: '' }), 400, 'update rejects blank name');

  // ── List filters ──
  updateSupplier(db, dupNational.id, { isActive: false });
  const active = listSuppliers(db, {});
  assert(!active.some((s: any) => s.id === dupNational.id), 'list excludes inactive by default');
  const withInactive = listSuppliers(db, { includeInactive: true });
  assert(withInactive.some((s: any) => s.id === dupNational.id), 'list includes inactive when requested');
  const byName = listSuppliesByName(listSuppliers(db, {}));
  assertEqual(byName[0], 'Fresh Milk Farm', 'list sorted by name nocase');
  const searched = listSuppliers(db, { search: 'FRESH' });
  assertEqual(searched.length, 1, 'search is case-insensitive and matches name');
  const searchedCode = listSuppliers(db, { search: 'SUP-003' });
  assertEqual(searchedCode.length, 1, 'search matches code');

  // ── Soft delete ──
  expectServiceError(() => getSupplier(db, 'missing-id'), 404, 'missing supplier is 404');
  softDeleteSupplier(db, rival.id);
  expectServiceError(() => getSupplier(db, rival.id), 404, 'soft-deleted supplier is not found');
  assert(!listSuppliers(db, { includeInactive: true }).some((s: any) => s.id === rival.id), 'soft-deleted supplier excluded from list');
  expectServiceError(() => softDeleteSupplier(db, rival.id), 404, 'soft delete is not repeatable on missing supplier');
  // deleted supplier remains recoverable from the table by id
  const row = db.prepare('SELECT deleted_at, is_active FROM suppliers WHERE id = ?').get(rival.id) as any;
  assertEqual(row.is_active, 0, 'soft delete marks supplier inactive in storage');
  assert(row.deleted_at !== null, 'soft delete records deleted_at in storage');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

function listSuppliesByName(suppliers: any[]): string[] {
  return suppliers.map((s) => s.name);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
