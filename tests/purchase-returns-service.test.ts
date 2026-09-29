/**
 * Purchase returns service: create against posted invoices, stock movements,
 * balance recompute, delete restores stock/balance, and validation.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchase-returns-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchase-returns-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupplier } = require('../main/services/suppliers');
const { createSupply, getSupply } = require('../main/services/supplies');
const { createPurchaseInvoice, postPurchaseInvoice, getPurchaseInvoice } = require('../main/services/purchase-invoices');
const {
  PurchaseReturnError,
  createPurchaseReturn,
  deletePurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns,
} = require('../main/services/purchase-returns');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Purchase returns service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 0, actorUserId: actor });

  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    invoiceDate: '2026-01-15',
    items: [
      { supplyId: 'sup-a', quantity: 5, unit: 'kg', unitPrice: 2000, taxAmount: 500 },
    ],
    actorUserId: actor,
  });
  postPurchaseInvoice(db, invoice.id, actor);
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 5, 'posted invoice puts 5 kg in stock');

  const invoiceItem = getPurchaseInvoice(db, invoice.id, true).items![0];

  // ── Create return ──
  const record = createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    returnDate: '2026-01-20',
    reason: 'Damaged bags',
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 2 }],
    actorUserId: actor,
  });
  assert(record.id.startsWith('pret_'), 'return id uses pret_ prefix');
  assert(record.return_number.startsWith('PRET-2026-01-20-'), 'return number uses PRET-<date> format');
  assertEqual(record.status, 'completed', 'new return is completed');
  assertEqual(record.total, 4200, 'return total is gross plus proportional tax');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 3, 'return removes 2 kg from stock');

  const movements = db.prepare(
    "SELECT * FROM supply_movements WHERE reference_type = 'purchase_return' AND reference_id = ?",
  ).all(record.id);
  assertEqual(movements.length, 1, 'one supply movement is recorded for the return');
  assertEqual(movements[0].quantity_delta, -2, 'movement delta is negative for a return');
  assertEqual(movements[0].movement_type, 'waste', 'movement type is waste');
  assertEqual(movements[0].actor_user_id, actor, 'movement records the actor');

  const invoiceAfter = getPurchaseInvoice(db, invoice.id);
  assertEqual(invoiceAfter.balance, 6300, 'invoice balance drops by the return total');

  // ── Over-return is rejected ──
  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 4 }],
    actorUserId: actor,
  }), 409, 'returning more than received is a 409');

  // ── Validation ──
  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [],
    actorUserId: actor,
  }), 400, 'empty items is a 400');

  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [{ purchaseInvoiceItemId: 'missing', quantity: 1 }],
    actorUserId: actor,
  }), 400, 'unknown invoice item is a 400');

  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 0 }],
    actorUserId: actor,
  }), 400, 'zero quantity is a 400');

  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: 'pinv-missing',
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 1 }],
    actorUserId: actor,
  }), 404, 'unknown invoice is a 404');

  // ── Draft invoice cannot be returned ──
  const draft = createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    items: [{ supplyId: 'sup-a', quantity: 1, unit: 'kg', unitPrice: 1000 }],
    actorUserId: actor,
  });
  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: draft.id,
    items: [{ purchaseInvoiceItemId: 'any', quantity: 1 }],
    actorUserId: actor,
  }), 409, 'returns against a draft invoice are a 409');

  // ── Second partial return reaches the cap ──
  const second = createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 3 }],
    actorUserId: actor,
  });
  assertEqual(second.total, 6300, 'second return totals the remaining 3 kg');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 0, 'stock hits zero after full return');
  assertEqual(
    getPurchaseInvoice(db, invoice.id).balance,
    0,
    'balance drops to zero after full return',
  );
  expectServiceError(() => createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 1 }],
    actorUserId: actor,
  }), 409, 'returning beyond the cap is a 409');

  // ── Delete restores stock and balance ──
  const restored = deletePurchaseReturn(db, record.id, actor, 'Wrong entry');
  assertEqual(restored.status, 'deleted', 'delete flips status to deleted');
  assertEqual(restored.deleted_by, actor, 'delete records the actor');
  assertEqual(restored.deletion_reason, 'Wrong entry', 'delete stores the deletion reason');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 2, 'delete restores 2 kg to stock');
  assertEqual(getPurchaseInvoice(db, invoice.id).balance, 4200, 'delete restores the balance');

  const restoreMovements = db.prepare(
    "SELECT * FROM supply_movements WHERE reference_type = 'purchase_return_delete' AND reference_id = ?",
  ).all(record.id);
  assertEqual(restoreMovements.length, 1, 'one restore movement is recorded');
  assertEqual(restoreMovements[0].quantity_delta, 2, 'restore movement delta is positive');

  expectServiceError(() => deletePurchaseReturn(db, record.id, actor), 409, 'deleting twice is a 409');

  // Deleted return quantity no longer counts against the cap.
  const reReturn = createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id,
    items: [{ purchaseInvoiceItemId: invoiceItem.id, quantity: 2 }],
    actorUserId: actor,
  });
  assertEqual(reReturn.total, 4200, 'a new return can reuse the freed quantity');

  // ── Reads ──
  assertEqual(getPurchaseReturn(db, record.id).items!.length, 1, 'get returns the record with items');
  assertEqual(listPurchaseReturns(db, { purchaseInvoiceId: invoice.id }).returns.length, 3, 'list filters by invoice');
  assertEqual(listPurchaseReturns(db, { supplierId: 'supp-a' }).returns.length, 3, 'list filters by supplier');
  assertEqual(
    listPurchaseReturns(db, { search: reReturn.return_number }).returns.length,
    1,
    'search matches the return number',
  );

  expectServiceError(() => getPurchaseReturn(db, 'missing'), 404, 'missing return is a 404');

  // ── Cursor pagination with tied timestamps ──
  // Tie every return's created_at so a created_at-only cursor would drop rows
  // after the first page.
  const allReturns = listPurchaseReturns(db, {}).returns.length;
  assert(allReturns >= 3, 'enough returns exist for the pagination walk');
  db.prepare("UPDATE purchase_returns SET created_at = '2026-03-05 09:00:00'").run();
  const seenReturnIds: string[] = [];
  let returnCursor: string | null = null;
  do {
    const page = listPurchaseReturns(db, { perPage: 2, beforeId: returnCursor ?? undefined });
    seenReturnIds.push(...page.returns.map((r: any) => r.id));
    returnCursor = page.nextCursor;
  } while (returnCursor !== null);
  assertEqual(seenReturnIds.length, allReturns, 'pagination visits every return despite tied timestamps');
  assertEqual(new Set(seenReturnIds).size, allReturns, 'return pagination never repeats a row');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
