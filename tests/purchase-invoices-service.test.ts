/**
 * Purchase invoices service: create draft, post (stock receive + movement),
 * cancel, validation, and invoice numbering.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/purchase-invoices-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-purchase-invoices-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupplier } = require('../main/services/suppliers');
const { createSupply, getSupply } = require('../main/services/supplies');
const {
  cancelPurchaseInvoice,
  createPurchaseInvoice,
  getPurchaseInvoice,
  listPurchaseInvoices,
  postPurchaseInvoice,
  updatePurchaseInvoice,
  PurchaseInvoiceError,
} = require('../main/services/purchase-invoices');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

function makeInvoice(db: any, actor: string, overrides: any = {}) {
  return createPurchaseInvoice(db, {
    supplierId: overrides.supplierId || 'supp-a',
    invoiceDate: overrides.invoiceDate,
    dueDate: overrides.dueDate,
    notes: overrides.notes,
    items: overrides.items || [
      { supplyId: overrides.supplyId || 'sup-a', quantity: 5, unit: 'kg', unitPrice: 2000 },
    ],
    actorUserId: actor,
  });
}

async function main() {
  console.log('Purchase invoices service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  const supplier = createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 10, actorUserId: actor });

  // ── Create draft invoice ──
  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    invoiceDate: '2026-01-15',
    dueDate: '2026-02-15',
    notes: 'Monthly delivery',
    items: [
      { supplyId: 'sup-a', quantity: 5, unit: 'kg', unitPrice: 2000, taxAmount: 500 },
    ],
    actorUserId: actor,
  });
  assert(invoice.id.startsWith('pinv_'), 'invoice id uses pinv_ prefix');
  assertEqual(invoice.supplier_id, 'supp-a', 'invoice stores supplier');
  assertEqual(invoice.supplier_name, 'Supplier A', 'invoice exposes supplier name');
  assertEqual(invoice.status, 'draft', 'new invoice starts as draft');
  assertEqual(invoice.subtotal, 10000, 'subtotal = 5 * 2000');
  assertEqual(invoice.tax_amount, 500, 'tax stored');
  assertEqual(invoice.total, 10500, 'total = subtotal + tax');
  assertEqual(invoice.balance, 10500, 'unpaid invoice balance equals total');
  assertEqual(invoice.paid_amount, 0, 'paid_amount starts at 0');
  assertEqual(invoice.invoice_number, 'PINV-2026-01-15-0001', 'first invoice number of the day');
  assert(invoice.items !== undefined && invoice.items.length === 1, 'invoice exposes its items');
  assertEqual(invoice.items[0].supply_name, 'Sugar', 'item exposes supply name');

  // ── Draft does not change stock ──
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 10, 'draft invoice does not change stock');
  const movementsBefore = db.prepare('SELECT COUNT(*) AS n FROM supply_movements').get().n;
  assertEqual(movementsBefore, 1, 'no new movement for a draft invoice (only opening balance)');

  // ── Posting increases stock and records a receive movement ──
  const posted = postPurchaseInvoice(db, invoice.id, actor);
  assertEqual(posted.status, 'posted', 'posted invoice has status posted');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 15, 'posting receives 5 kg into stock (10 -> 15)');
  const movement = db.prepare(`
    SELECT movement_type, quantity_delta, reference_type, reference_id
    FROM supply_movements WHERE reference_type = 'purchase_invoice' AND reference_id = ?
  `).get(invoice.id) as any;
  assert(movement !== undefined, 'posting records a supply movement');
  assertEqual(movement.movement_type, 'receive', 'movement type is receive');
  assertEqual(movement.quantity_delta, 5, 'movement delta equals received quantity');
  assertEqual(movement.reference_type, 'purchase_invoice', 'movement references the invoice');

  // Posting is not repeatable.
  expectServiceError(() => postPurchaseInvoice(db, invoice.id, actor), 409, 'posting a posted invoice is 409');

  // ── Second invoice of the same day increments the sequence ──
  const second = makeInvoice(db, actor, { invoiceDate: '2026-01-15' });
  assertEqual(second.invoice_number, 'PINV-2026-01-15-0002', 'sequence increments within a day');
  const thirdDay = makeInvoice(db, actor, { invoiceDate: '2026-01-16' });
  assertEqual(thirdDay.invoice_number, 'PINV-2026-01-16-0001', 'sequence resets per day');

  // ── Validation ──
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'supp-a', items: [], actorUserId: actor,
  }), 400, 'empty items rejected');
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'missing', items: [{ supplyId: 'sup-a', quantity: 1, unit: 'kg', unitPrice: 10 }], actorUserId: actor,
  }), 404, 'missing supplier rejected');
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'supp-a', items: [{ supplyId: 'sup-missing', quantity: 1, unit: 'kg', unitPrice: 10 }], actorUserId: actor,
  }), 400, 'missing supply rejected');
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    items: [
      { supplyId: 'sup-a', quantity: 1, unit: 'kg', unitPrice: 10 },
      { supplyId: 'sup-a', quantity: 2, unit: 'kg', unitPrice: 10 },
    ],
    actorUserId: actor,
  }), 400, 'duplicate supply on one invoice rejected');
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'supp-a', items: [{ supplyId: 'sup-a', quantity: 0, unit: 'kg', unitPrice: 10 }], actorUserId: actor,
  }), 400, 'zero quantity rejected');
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'supp-a', items: [{ supplyId: 'sup-a', quantity: 1, unit: 'lb', unitPrice: 10 }], actorUserId: actor,
  }), 400, 'unknown unit rejected');
  expectServiceError(() => createPurchaseInvoice(db, {
    supplierId: 'supp-a', items: [{ supplyId: 'sup-a', quantity: 1, unit: 'kg', unitPrice: -1 }], actorUserId: actor,
  }), 400, 'negative unit price rejected');

  // ── Cancel draft ──
  const cancellable = makeInvoice(db, actor, { invoiceDate: '2026-03-01' });
  const cancelled = cancelPurchaseInvoice(db, cancellable.id, actor);
  assertEqual(cancelled.status, 'cancelled', 'cancelled invoice has status cancelled');
  assertEqual(cancelled.balance, 0, 'cancelled invoice has zero balance');
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 15, 'cancelling a draft leaves stock untouched');
  expectServiceError(() => cancelPurchaseInvoice(db, cancellable.id, actor), 409, 'cancelling twice is 409');
  expectServiceError(() => postPurchaseInvoice(db, cancellable.id, actor), 409, 'posting a cancelled invoice is 409');

  // ── Update draft ──
  const editable = makeInvoice(db, actor, { invoiceDate: '2026-03-02' });
  const updated = updatePurchaseInvoice(db, editable.id, {
    notes: 'Updated notes',
    items: [{ supplyId: 'sup-a', quantity: 8, unit: 'kg', unitPrice: 2000 }],
  });
  assertEqual(updated.notes, 'Updated notes', 'update stores notes');
  assertEqual(updated.subtotal, 16000, 'update recomputes subtotal');
  assertEqual(updated.total, 16000, 'update recomputes total');
  assertEqual(updated.balance, 16000, 'update recomputes balance');
  assertEqual(updated.items!.length, 1, 'update replaces items');
  expectServiceError(() => updatePurchaseInvoice(db, posted.id, { notes: 'x' }), 409, 'editing a posted invoice is 409');

  // ── List filters ──
  const listed = listPurchaseInvoices(db, {});
  assert(listed.invoices.length >= 5, 'list returns all invoices');
  const draftsOnly = listPurchaseInvoices(db, { status: 'draft' });
  assert(draftsOnly.invoices.every((i: any) => i.status === 'draft'), 'status filter works');
  const bySupplier = listPurchaseInvoices(db, { supplierId: 'supp-a' });
  assert(bySupplier.invoices.every((i: any) => i.supplier_id === 'supp-a'), 'supplier filter works');
  const byNumber = listPurchaseInvoices(db, { search: 'PINV-2026-01-15' });
  assertEqual(byNumber.invoices.length, 2, 'search matches invoice number');
  assert(byNumber.invoices.every((i: any) => i.supplier_name !== null), 'list exposes supplier name');

  expectServiceError(() => getPurchaseInvoice(db, 'missing'), 404, 'missing invoice is 404');

  // ── Cursor pagination with tied timestamps ──
  // Give every invoice the same created_at so a cursor that only compares
  // created_at would drop every row after the first page.
  const allInvoices = listPurchaseInvoices(db, {}).invoices.length;
  assert(allInvoices >= 5, 'enough invoices exist for the pagination walk');
  db.prepare("UPDATE purchase_invoices SET created_at = '2026-03-05 09:00:00'").run();
  const seenInvoiceIds: string[] = [];
  let invoiceCursor: string | null = null;
  do {
    const page = listPurchaseInvoices(db, { perPage: 2, beforeId: invoiceCursor ?? undefined });
    seenInvoiceIds.push(...page.invoices.map((i: any) => i.id));
    invoiceCursor = page.nextCursor;
  } while (invoiceCursor !== null);
  assertEqual(seenInvoiceIds.length, allInvoices, 'pagination visits every invoice despite tied timestamps');
  assertEqual(new Set(seenInvoiceIds).size, allInvoices, 'invoice pagination never repeats a row');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
