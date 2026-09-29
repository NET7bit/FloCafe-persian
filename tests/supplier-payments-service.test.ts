/**
 * Supplier payments service: record payment, invoice balance transitions,
 * validation, deletion, and supplier totals.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supplier-payments-service.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supplier-payments-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupplier } = require('../main/services/suppliers');
const { createSupply } = require('../main/services/supplies');
const {
  createPurchaseInvoice, getPurchaseInvoice, postPurchaseInvoice,
} = require('../main/services/purchase-invoices');
const {
  createSupplierPayment,
  deleteSupplierPayment,
  getSupplierPaidTotal,
  getSupplierPayment,
  listSupplierPayments,
  SupplierPaymentError,
} = require('../main/services/supplier-payments');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

async function main() {
  console.log('Supplier payments service test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupplier(db, { id: 'supp-b', name: 'Supplier B', code: 'SB' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 0, actorUserId: actor });

  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    invoiceDate: '2026-01-15',
    items: [{ supplyId: 'sup-a', quantity: 10, unit: 'kg', unitPrice: 1000 }],
    actorUserId: actor,
  });
  assertEqual(invoice.total, 10000, 'invoice total');
  assertEqual(invoice.balance, 10000, 'unpaid invoice balance');

  // ── Payment on a draft invoice is rejected ──
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-a', purchaseInvoiceId: invoice.id, amount: 5000, paymentMethod: 'cash',
    actorUserId: actor,
  }), 409, 'payment on a draft invoice is 409');

  postPurchaseInvoice(db, invoice.id, actor);

  // ── Partial payment ──
  const partial = createSupplierPayment(db, {
    supplierId: 'supp-a', purchaseInvoiceId: invoice.id, amount: 4000, paymentMethod: 'cash',
    paidAt: '2026-01-20', actorUserId: actor,
  });
  assert(partial.id.startsWith('spay_'), 'payment id uses spay_ prefix');
  assertEqual(partial.amount, 4000, 'payment stores amount');
  assertEqual(partial.payment_method, 'cash', 'payment stores method');
  assertEqual(partial.supplier_name, 'Supplier A', 'payment exposes supplier name');
  assertEqual(partial.invoice_number, invoice.invoice_number, 'payment exposes invoice number');

  const afterPartial = getPurchaseInvoice(db, invoice.id, false);
  assertEqual(afterPartial.paid_amount, 4000, 'partial payment increases paid_amount');
  assertEqual(afterPartial.balance, 6000, 'partial payment reduces balance');
  assertEqual(afterPartial.status, 'partially_paid', 'invoice becomes partially_paid');

  // ── Full payment ──
  const full = createSupplierPayment(db, {
    supplierId: 'supp-a', purchaseInvoiceId: invoice.id, amount: 6000, paymentMethod: 'bank_transfer',
    reference: 'TR-123', actorUserId: actor,
  });
  const afterFull = getPurchaseInvoice(db, invoice.id, false);
  assertEqual(afterFull.paid_amount, 10000, 'full payment covers the invoice');
  assertEqual(afterFull.balance, 0, 'full payment zeroes the balance');
  assertEqual(afterFull.status, 'paid', 'invoice becomes paid');
  assertEqual(full.reference, 'TR-123', 'payment stores reference');

  // ── Overpayment is rejected (balance would exceed invoice total) ──
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-a', purchaseInvoiceId: invoice.id, amount: 1, paymentMethod: 'cash',
    actorUserId: actor,
  }), 409, 'payment on a fully paid invoice is 409');

  // ── On-account payment (no invoice) ──
  const onAccount = createSupplierPayment(db, {
    supplierId: 'supp-a', amount: 500, paymentMethod: 'cash', actorUserId: actor,
  });
  assertEqual(onAccount.purchase_invoice_id, null, 'on-account payment has no invoice');
  assertEqual(getSupplierPaidTotal(db, 'supp-a'), 10500, 'supplier totals include all payments');

  // ── Validation ──
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-a', amount: 0, paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'zero amount rejected');
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-a', amount: -100, paymentMethod: 'cash', actorUserId: actor,
  }), 400, 'negative amount rejected');
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-a', amount: 100, paymentMethod: 'bitcoin', actorUserId: actor,
  }), 400, 'unknown payment method rejected');
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'missing', amount: 100, paymentMethod: 'cash', actorUserId: actor,
  }), 404, 'missing supplier rejected');
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-b', purchaseInvoiceId: invoice.id, amount: 100, paymentMethod: 'cash',
    actorUserId: actor,
  }), 400, 'payment for another supplier invoice rejected');
  expectServiceError(() => createSupplierPayment(db, {
    supplierId: 'supp-a', amount: 100, paymentMethod: 'cash', paidAt: 'not-a-date', actorUserId: actor,
  }), 400, 'invalid paid_at rejected');

  // ── Delete reverts the balance ──
  deleteSupplierPayment(db, full.id, actor);
  const afterDelete = getPurchaseInvoice(db, invoice.id, false);
  assertEqual(afterDelete.paid_amount, 4000, 'deleting a payment reverts paid_amount');
  assertEqual(afterDelete.balance, 6000, 'deleting a payment restores balance');
  assertEqual(afterDelete.status, 'partially_paid', 'invoice reverts to partially_paid');
  expectServiceError(() => getSupplierPayment(db, full.id), 404, 'deleted payment is 404');

  // ── List filters ──
  const listed = listSupplierPayments(db, {});
  assert(listed.payments.length >= 2, 'list returns all payments');
  const bySupplier = listSupplierPayments(db, { supplierId: 'supp-a' });
  assert(bySupplier.payments.every((p: any) => p.supplier_id === 'supp-a'), 'supplier filter works');
  const byMethod = listSupplierPayments(db, { paymentMethod: 'bank_transfer' });
  assert(byMethod.payments.every((p: any) => p.payment_method === 'bank_transfer'), 'method filter works');
  const byInvoice = listSupplierPayments(db, { purchaseInvoiceId: invoice.id });
  assert(byInvoice.payments.every((p: any) => p.purchase_invoice_id === invoice.id), 'invoice filter works');
  const byReference = listSupplierPayments(db, { search: 'TR-123' });
  assertEqual(byReference.payments.length, 0, 'search matches reference (deleted full payment gone)');
  const onAccountList = listSupplierPayments(db, { search: 'Supplier A' });
  assert(onAccountList.payments.length >= 2, 'search matches supplier name');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
