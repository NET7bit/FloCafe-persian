/**
 * Purchases & suppliers accounting adapter coverage (Milestone E).
 *
 * Exercises the real write paths (POST /api/purchase-invoices/:id/post,
 * POST/DELETE /api/supplier-payments, POST/DELETE /api/purchase-returns) plus
 * the adapter functions for scenarios that have no runtime trigger (skip
 * policies, reprocess after a period reopen). Proves that each of the three
 * source events journalizes exactly once under its own identity, that
 * deletions reverse through the shared core, and that replays/reprocesses
 * never duplicate or cross-post.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-purchases-adapter.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-purchases-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters, seedOwnerUser, seedManagerUser,
  createApp, startServer, api,
} = require('./helpers/test-setup');
const {
  createPurchaseInvoiceJournal, createSupplierPaymentJournal, createPurchaseReturnJournal,
  recordPurchaseInvoiceAccounting, recordSupplierPaymentAccounting, recordSupplierPaymentDeletionAccounting,
  recordPurchaseReturnAccounting, recordPurchaseReturnDeletionAccounting, reprocessPurchaseAccounting,
} = require('../main/services/accounting-purchases-adapter');
const {
  createPurchaseInvoice, postPurchaseInvoice, cancelPurchaseInvoice, getPurchaseInvoice, PurchaseInvoiceError,
} = require('../main/services/purchase-invoices');
const { createSupplierPayment, deleteSupplierPayment, SupplierPaymentError } = require('../main/services/supplier-payments');
const { createPurchaseReturn, deletePurchaseReturn, PurchaseReturnError } = require('../main/services/purchase-returns');
const { createSupplier } = require('../main/services/suppliers');
const { createSupply, getSupply } = require('../main/services/supplies');
const { getAccountByCode, createJournal, AccountingServiceError } = require('../main/services/accounting');
const {
  createFiscalPeriod, closeFiscalPeriod, reopenFiscalPeriod, FiscalPeriodError,
} = require('../main/services/fiscal-periods');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    const known = err instanceof AccountingServiceError || err instanceof FiscalPeriodError
      || err instanceof PurchaseInvoiceError || err instanceof SupplierPaymentError || err instanceof PurchaseReturnError;
    assert(known && err.statusCode === statusCode, `${message} (got ${err.statusCode}: ${err.message})`);
  }
}

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();

function journalCount(db: any, sourceModule: string, sourceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = ? AND source_id = ?')
    .get(sourceModule, String(sourceId)) as any).n;
}
function linesOf(db: any, journalId: string): Array<{ code: string; direction: string; amount: number }> {
  return db.prepare(`
    SELECT a.code AS code, l.direction AS direction, l.amount AS amount
    FROM journal_entry_lines l JOIN accounting_accounts a ON a.id = l.account_id
    WHERE l.journal_id = ? ORDER BY l.rowid
  `).all(journalId);
}
function theJournal(db: any, sourceModule: string, sourceId: string): any {
  return db.prepare('SELECT * FROM journal_entries WHERE source_module = ? AND source_id = ? AND seq = 1')
    .get(sourceModule, String(sourceId));
}

async function main() {
  console.log('Purchases & suppliers accounting adapter test (Milestone E)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);

  createSupplier(db, { id: 'supp-e', name: 'Supplier E', code: 'SE' });
  createSupply(db, { id: 'sup-e', name: 'Flour', baseUnit: 'kg', stockQuantity: 20, actorUserId: owner.userId });

  // ── Purchase invoice: journal only on post, Dr 1200 / Cr 2000 for total ──
  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-e', invoiceDate: TODAY,
    items: [{ supplyId: 'sup-e', quantity: 2, unit: 'kg', unitPrice: 100 }],
    actorUserId: owner.userId,
  });
  assertEqual(invoice.status, 'draft', 'a new purchase invoice is a draft');
  assertEqual(journalCount(db, 'purchases', invoice.id), 0, 'draft creation is not an accounting event');
  assertEqual(invoice.total, 200, 'invoice total is the authoritative 200');

  const posted = postPurchaseInvoice(db, invoice.id, owner.userId);
  assertEqual(posted.status, 'posted', 'posting flips the invoice to posted');
  assertEqual(getSupply(db, 'sup-e').stock_quantity, 22, 'posting receives stock (source-of-truth unchanged by accounting)');
  recordPurchaseInvoiceAccounting(posted.id, owner.userId);
  const piJournal = theJournal(db, 'purchases', invoice.id);
  assert(!!piJournal, 'posting the invoice creates the purchase journal');
  assertEqual(piJournal.seq, 1, 'purchase identity: seq 1');
  assertEqual(piJournal.reference, invoice.invoice_number, 'purchase journal references the invoice number');
  assertEqual(piJournal.entry_date, TODAY, 'purchase journal is dated by invoice_date');
  assertEqual(
    JSON.stringify(linesOf(db, piJournal.id).map((l) => [l.code, l.direction, l.amount])),
    JSON.stringify([['1200', 'debit', 200], ['2000', 'credit', 200]]),
    'purchase invoice maps Dr 1200 / Cr 2000 for the invoice total',
  );
  assertEqual(journalCount(db, 'purchases', invoice.id), 1, 'each posted invoice has exactly one journal');

  // Idempotency on replay.
  recordPurchaseInvoiceAccounting(invoice.id, owner.userId);
  recordPurchaseInvoiceAccounting(invoice.id, owner.userId);
  createPurchaseInvoiceJournal(invoice.id, owner.userId);
  assertEqual(journalCount(db, 'purchases', invoice.id), 1, 'replays create no duplicate purchase journal');

  // Amount comes from the invoice total, never from a product/supply cost.
  db.prepare('UPDATE supplies SET cost_price = 999 WHERE id = ?').run('sup-e');
  const pricedInvoice = createPurchaseInvoice(db, {
    supplierId: 'supp-e', invoiceDate: TODAY,
    items: [{ supplyId: 'sup-e', quantity: 1, unit: 'kg', unitPrice: 50 }],
    actorUserId: owner.userId,
  });
  postPurchaseInvoice(db, pricedInvoice.id, owner.userId);
  createPurchaseInvoiceJournal(pricedInvoice.id, owner.userId);
  const pricedLines = linesOf(db, theJournal(db, 'purchases', pricedInvoice.id).id);
  assertEqual(pricedLines[0].amount, 50, 'supply cost_price (999) is never used; the invoice total (50) is authoritative');

  // Draft cancellation is not an accounting event; a posted invoice cannot be cancelled.
  const draftCancelled = createPurchaseInvoice(db, {
    supplierId: 'supp-e', invoiceDate: TODAY,
    items: [{ supplyId: 'sup-e', quantity: 1, unit: 'kg', unitPrice: 10 }],
    actorUserId: owner.userId,
  });
  cancelPurchaseInvoice(db, draftCancelled.id, owner.userId);
  assertEqual(journalCount(db, 'purchases', draftCancelled.id), 0, 'cancelling a draft creates no journal');
  expectError(409, () => cancelPurchaseInvoice(db, invoice.id, owner.userId), 'a posted invoice cannot be cancelled (no accounting cancellation event)');

  // ── Supplier payment: independent event, Dr 2000 / Cr tender ──
  const cash = createSupplierPayment(db, {
    supplierId: 'supp-e', purchaseInvoiceId: invoice.id, amount: 50,
    paymentMethod: 'cash', actorUserId: owner.userId,
  });
  recordSupplierPaymentAccounting(cash.id, owner.userId);
  const cashJournal = theJournal(db, 'supplier_payments', cash.id);
  assert(!!cashJournal, 'creating a supplier payment creates its own journal');
  assertEqual(cashJournal.seq, 1, 'supplier payment identity: seq 1');
  assertEqual(cashJournal.reference, 'supp-e', 'supplier payment references the supplier');
  assertEqual(cashJournal.entry_date, TODAY, 'supplier payment journal is dated by the payment business date');
  assertEqual(
    JSON.stringify(linesOf(db, cashJournal.id).map((l) => [l.code, l.direction, l.amount])),
    JSON.stringify([['2000', 'debit', 50], ['1000', 'credit', 50]]),
    'cash supplier payment maps Dr 2000 / Cr 1000',
  );

  const bank = createSupplierPayment(db, { supplierId: 'supp-e', amount: 30, paymentMethod: 'bank_transfer', actorUserId: owner.userId });
  const bankJournal = createSupplierPaymentJournal(bank.id, owner.userId);
  assertEqual(
    JSON.stringify(linesOf(db, bankJournal.id).map((l) => [l.code, l.direction])),
    JSON.stringify([['2000', 'debit'], ['1010', 'credit']]),
    'bank_transfer supplier payment maps Dr 2000 / Cr 1010',
  );
  const cheque = createSupplierPayment(db, { supplierId: 'supp-e', amount: 20, paymentMethod: 'cheque', actorUserId: owner.userId });
  assertEqual(linesOf(db, createSupplierPaymentJournal(cheque.id, owner.userId).id)[1].code, '1010', 'cheque supplier payment credits 1010');

  const other = createSupplierPayment(db, { supplierId: 'supp-e', amount: 10, paymentMethod: 'other', actorUserId: owner.userId });
  recordSupplierPaymentAccounting(other.id, owner.userId);
  assertEqual(journalCount(db, 'supplier_payments', other.id), 0, 'payment_method other has no v1 account: skipped');

  recordSupplierPaymentAccounting(cash.id, owner.userId);
  createSupplierPaymentJournal(cash.id, owner.userId);
  assertEqual(journalCount(db, 'supplier_payments', cash.id), 1, 'replays create no duplicate supplier payment journal');

  // ── Purchase return: Dr 2000 / Cr 1200 for purchase_returns.total ──
  const itemId = getPurchaseInvoice(db, invoice.id, true).items[0].id;
  const ret = createPurchaseReturn(db, {
    purchaseInvoiceId: invoice.id, returnDate: TODAY,
    items: [{ purchaseInvoiceItemId: itemId, quantity: 1 }], actorUserId: owner.userId,
  });
  assertEqual(ret.total, 100, 'purchase return total is authoritative (100)');
  recordPurchaseReturnAccounting(ret.id, owner.userId);
  const retJournal = theJournal(db, 'purchase_returns', ret.id);
  assert(!!retJournal, 'creating a purchase return creates its own journal');
  assertEqual(retJournal.seq, 1, 'purchase return identity: seq 1');
  assertEqual(retJournal.reference, ret.return_number, 'purchase return references the return number');
  assertEqual(retJournal.entry_date, TODAY, 'purchase return journal is dated by return_date');
  assertEqual(
    JSON.stringify(linesOf(db, retJournal.id).map((l) => [l.code, l.direction, l.amount])),
    JSON.stringify([['2000', 'debit', 100], ['1200', 'credit', 100]]),
    'purchase return maps Dr 2000 / Cr 1200 for the return total',
  );
  recordPurchaseReturnAccounting(ret.id, owner.userId);
  assertEqual(journalCount(db, 'purchase_returns', ret.id), 1, 'replays create no duplicate purchase return journal');

  // ── Ownership boundary: no cross-posting between the three events ──
  assertEqual(journalCount(db, 'purchases', cash.id), 0, 'a supplier payment never creates a purchases-module journal');
  assertEqual(journalCount(db, 'supplier_payments', invoice.id), 0, 'a purchase invoice never creates a supplier_payments journal');
  assertEqual(journalCount(db, 'purchases', ret.id), 0, 'a purchase return does not reuse the purchases identity');
  assertEqual(journalCount(db, 'purchase_returns', invoice.id), 0, 'a purchase invoice never creates a purchase_returns journal');

  // The client can never supply repository/account/identity fields through the core.
  expectError(400, () => createJournal({
    entryDate: TODAY, sourceModule: 'purchases', actorUserId: owner.userId,
    lines: [
      { accountId: getAccountByCode('1200').id, direction: 'debit', amount: 1 },
      { accountId: getAccountByCode('2000').id, direction: 'credit', amount: 1 },
    ],
  }), 'createJournal still requires a source_id for purchases (identity stays with the source row)');

  // ── Deletion reversal: post-commit, idempotent, identity preserved ──
  deleteSupplierPayment(db, cash.id, owner.userId);
  recordSupplierPaymentDeletionAccounting(cash.id, owner.userId);
  const cashReversal = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(cashJournal.id) as any;
  assert(!!cashReversal, 'deleting a journalized supplier payment creates the reversal after commit');
  assertEqual(cashReversal.source_module, 'supplier_payments', 'reversal keeps the supplier_payments module');
  assertEqual(cashReversal.source_id, cash.id, 'reversal keeps the payment source identity');
  assertEqual(cashReversal.seq, 2, 'reversal joins the event chain at max(seq)+1');
  assertEqual((db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(cashJournal.id) as any).status, 'reversed', 'the original payment journal is marked reversed and stays in history');
  const cashReversedLines = linesOf(db, cashReversal.id);
  assert(
    cashReversedLines.some((l) => l.code === '2000' && l.direction === 'credit') && cashReversedLines.some((l) => l.code === '1000' && l.direction === 'debit'),
    'the payment reversal swaps directions (AP restored, cash returned)',
  );
  recordSupplierPaymentDeletionAccounting(cash.id, owner.userId);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(cashJournal.id) as any).n,
    1, 'repeated payment deletion hook creates no second reversal',
  );

  deletePurchaseReturn(db, ret.id, owner.userId);
  recordPurchaseReturnDeletionAccounting(ret.id, owner.userId);
  const retReversal = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(retJournal.id) as any;
  assert(!!retReversal, 'deleting a journalized purchase return creates the reversal after commit');
  assertEqual((db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(retJournal.id) as any).status, 'reversed', 'the original return journal is marked reversed');
  recordPurchaseReturnDeletionAccounting(ret.id, owner.userId);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(retJournal.id) as any).n,
    1, 'repeated return deletion hook creates no second reversal',
  );

  // ── Fiscal: source committed while open, adapter blocked by a later close ──
  const period = createFiscalPeriod(db, { periodType: 'month', startDate: LAST_MONTH, actorUserId: owner.userId });
  const monthInvoice = createPurchaseInvoice(db, {
    supplierId: 'supp-e', invoiceDate: LAST_MONTH,
    items: [{ supplyId: 'sup-e', quantity: 1, unit: 'kg', unitPrice: 100 }],
    actorUserId: owner.userId,
  });
  postPurchaseInvoice(db, monthInvoice.id, owner.userId);
  const monthItemId = getPurchaseInvoice(db, monthInvoice.id, true).items[0].id;
  const monthPayment = createSupplierPayment(db, { supplierId: 'supp-e', amount: 40, paymentMethod: 'cash', paidAt: LAST_MONTH, actorUserId: owner.userId });
  const monthReturn = createPurchaseReturn(db, {
    purchaseInvoiceId: monthInvoice.id, returnDate: LAST_MONTH,
    items: [{ purchaseInvoiceItemId: monthItemId, quantity: 1 }], actorUserId: owner.userId,
  });
  closeFiscalPeriod(db, period.id, owner.userId);

  recordPurchaseInvoiceAccounting(monthInvoice.id, owner.userId);
  recordSupplierPaymentAccounting(monthPayment.id, owner.userId);
  recordPurchaseReturnAccounting(monthReturn.id, owner.userId);
  assertEqual(journalCount(db, 'purchases', monthInvoice.id), 0, 'a closed period blocks the purchase journal');
  assertEqual(journalCount(db, 'supplier_payments', monthPayment.id), 0, 'a closed period blocks the supplier payment journal');
  assertEqual(journalCount(db, 'purchase_returns', monthReturn.id), 0, 'a closed period blocks the purchase return journal');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_id WHERE j.source_module = ? AND j.source_id = ?')
      .get('purchases', monthInvoice.id) as any).n,
    0, 'the rejected purchase journal left no partial lines',
  );
  assertEqual(getPurchaseInvoice(db, monthInvoice.id).status, 'posted', 'the source invoice stays committed when accounting is blocked');
  assertEqual(reprocessPurchaseAccounting('purchase_invoice', monthInvoice.id, owner.userId).status, 'skipped', 'reprocess is blocked by the closed period');
  assertEqual(reprocessPurchaseAccounting('supplier_payment', monthPayment.id, owner.userId).status, 'skipped', 'supplier payment reprocess is blocked by the closed period');
  assertEqual(reprocessPurchaseAccounting('purchase_return', monthReturn.id, owner.userId).status, 'skipped', 'purchase return reprocess is blocked by the closed period');

  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(require('bcryptjs').hashSync('1234', 10), owner.userId);
  reopenFiscalPeriod(db, period.id, '1234', owner.userId, owner.userId);
  assertEqual(reprocessPurchaseAccounting('purchase_invoice', monthInvoice.id, owner.userId).status, 'journalized', 'reprocess after reopen creates the pending purchase journal');
  assertEqual(reprocessPurchaseAccounting('supplier_payment', monthPayment.id, owner.userId).status, 'journalized', 'reprocess after reopen creates the pending payment journal');
  assertEqual(reprocessPurchaseAccounting('purchase_return', monthReturn.id, owner.userId).status, 'journalized', 'reprocess after reopen creates the pending return journal');
  assertEqual(journalCount(db, 'purchases', monthInvoice.id), 1, 'reopen reprocess creates exactly one purchase journal');
  assertEqual(journalCount(db, 'supplier_payments', monthPayment.id), 1, 'reopen reprocess creates exactly one payment journal');
  assertEqual(journalCount(db, 'purchase_returns', monthReturn.id), 1, 'reopen reprocess creates exactly one return journal');
  assertEqual(theJournal(db, 'purchases', monthInvoice.id).entry_date, LAST_MONTH, 'reprocessed purchase keeps its original entry_date');
  assertEqual(theJournal(db, 'supplier_payments', monthPayment.id).entry_date, LAST_MONTH, 'reprocessed payment keeps its original entry_date');
  assertEqual(theJournal(db, 'purchase_returns', monthReturn.id).entry_date, LAST_MONTH, 'reprocessed return keeps its original entry_date');

  // ── Every journal balanced ──
  const unbalanced = db.prepare(`
    SELECT j.id, COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS d,
           COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS c
    FROM journal_entries j JOIN journal_entry_lines l ON l.journal_id = j.id
    GROUP BY j.id HAVING ABS(d - c) > 1e-9
  `).all();
  assertEqual(unbalanced.length, 0, 'every journal in the ledger is balanced');

  // ── No pending/retry state; E leaves no new tables ──
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => String(r.name));
  assert(!tables.some((t) => ['adapter_failures', 'journal_sync_state', 'accounting_pending', 'accounting_retry'].includes(t)), 'no pending/retry/journal-sync table exists');

  // ── HTTP integration: the real production path ──
  const { purchaseInvoiceRoutes } = require('../main/routes/purchase-invoices');
  const { supplierPaymentRoutes } = require('../main/routes/supplier-payments');
  const { purchaseReturnRoutes } = require('../main/routes/purchase-returns');
  const { accountingRoutes } = require('../main/routes/accounting');
  const app = createApp({
    '/api/purchase-invoices': purchaseInvoiceRoutes,
    '/api/supplier-payments': supplierPaymentRoutes,
    '/api/purchase-returns': purchaseReturnRoutes,
    '/api/accounting': accountingRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  createSupplier(db, { id: 'supp-http', name: 'Supplier HTTP', code: 'SH' });
  createSupply(db, { id: 'sup-http', name: 'Rice', baseUnit: 'kg', stockQuantity: 30, actorUserId: owner.userId });

  const httpInvoiceRes = await api(baseUrl, '/api/purchase-invoices', {
    method: 'POST', headers: owner.authHeader,
    body: {
      supplier_id: 'supp-http',
      items: [{ supply_id: 'sup-http', quantity: 4, unit: 'kg', unit_price: 25 }],
    },
  });
  assertEqual(httpInvoiceRes.status, 201, 'POST /api/purchase-invoices accepts the draft');
  const httpInvoiceId = httpInvoiceRes.data.invoice.id;
  assertEqual(journalCount(db, 'purchases', httpInvoiceId), 0, 'the HTTP draft is not journalized');

  const httpPostRes = await api(baseUrl, `/api/purchase-invoices/${httpInvoiceId}/post`, { method: 'POST', headers: owner.authHeader });
  assertEqual(httpPostRes.status, 200, 'POST /api/purchase-invoices/:id/post succeeds');
  const httpPiJournal = theJournal(db, 'purchases', httpInvoiceId);
  assert(!!httpPiJournal, 'the post-commit hook journaled the HTTP-posted invoice');
  assertEqual(
    JSON.stringify(linesOf(db, httpPiJournal.id).map((l: any) => [l.code, l.direction, l.amount])),
    JSON.stringify([['1200', 'debit', 100], ['2000', 'credit', 100]]),
    'the HTTP purchase invoice maps Dr 1200 / Cr 2000 for its total',
  );

  const httpPaymentRes = await api(baseUrl, '/api/supplier-payments', {
    method: 'POST', headers: owner.authHeader,
    body: { supplier_id: 'supp-http', purchase_invoice_id: httpInvoiceId, amount: 60, payment_method: 'card' },
  });
  assertEqual(httpPaymentRes.status, 201, 'POST /api/supplier-payments accepts the payment');
  const httpPaymentId = httpPaymentRes.data.payment.id;
  const httpPaymentJournal = theJournal(db, 'supplier_payments', httpPaymentId);
  assert(!!httpPaymentJournal, 'the post-commit hook journaled the HTTP supplier payment');
  assertEqual(
    JSON.stringify(linesOf(db, httpPaymentJournal.id).map((l: any) => [l.code, l.direction])),
    JSON.stringify([['2000', 'debit'], ['1010', 'credit']]),
    'the HTTP card payment maps Dr 2000 / Cr 1010',
  );

  const httpItemId = getPurchaseInvoice(db, httpInvoiceId, true).items[0].id;
  const httpReturnRes = await api(baseUrl, '/api/purchase-returns', {
    method: 'POST', headers: owner.authHeader,
    body: { purchase_invoice_id: httpInvoiceId, items: [{ purchase_invoice_item_id: httpItemId, quantity: 1 }] },
  });
  assertEqual(httpReturnRes.status, 201, 'POST /api/purchase-returns accepts the return');
  const httpReturnId = httpReturnRes.data.return.id;
  const httpReturnJournal = theJournal(db, 'purchase_returns', httpReturnId);
  assert(!!httpReturnJournal, 'the post-commit hook journaled the HTTP purchase return');
  assertEqual(
    JSON.stringify(linesOf(db, httpReturnJournal.id).map((l: any) => [l.code, l.direction])),
    JSON.stringify([['2000', 'debit'], ['1200', 'credit']]),
    'the HTTP purchase return maps Dr 2000 / Cr 1200',
  );

  const httpPaymentDelete = await api(baseUrl, `/api/supplier-payments/${httpPaymentId}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(httpPaymentDelete.status, 200, 'DELETE /api/supplier-payments succeeds');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(httpPaymentJournal.id) as any).n,
    1, 'the HTTP payment delete reversal is journaled post-commit',
  );

  const httpReturnDelete = await api(baseUrl, `/api/purchase-returns/${httpReturnId}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(httpReturnDelete.status, 200, 'DELETE /api/purchase-returns succeeds');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(httpReturnJournal.id) as any).n,
    1, 'the HTTP return delete reversal is journaled post-commit',
  );

  // ── Production surface: read-only discovery + explicit one-event reprocess ──
  const journalsBefore = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n;
  const discovery = await api(baseUrl, '/api/accounting/purchases/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(discovery.status, 200, 'GET purchases/unresolved succeeds for owner');
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n, journalsBefore, 'discovery is read-only (no journal created)');

  // Missing journal for each kind (source committed, adapter never ran).
  const orphanInvoice = createPurchaseInvoice(db, {
    supplierId: 'supp-http', invoiceDate: TODAY,
    items: [{ supplyId: 'sup-http', quantity: 1, unit: 'kg', unitPrice: 70 }],
    actorUserId: owner.userId,
  });
  postPurchaseInvoice(db, orphanInvoice.id, owner.userId);
  const orphanPayment = createSupplierPayment(db, { supplierId: 'supp-http', amount: 15, paymentMethod: 'cash', actorUserId: owner.userId });
  const orphanReturn = createPurchaseReturn(db, {
    purchaseInvoiceId: orphanInvoice.id, returnDate: TODAY,
    items: [{ purchaseInvoiceItemId: getPurchaseInvoice(db, orphanInvoice.id, true).items[0].id, quantity: 1 }],
    actorUserId: owner.userId,
  });

  const discovery2 = await api(baseUrl, '/api/accounting/purchases/unresolved', { method: 'GET', headers: owner.authHeader });
  const byId = (events: any[], id: string) => events.find((e: any) => e.event_id === id);
  assertEqual(byId(discovery2.data.events, orphanInvoice.id).state, 'missing_journal', 'discovery lists an unjournalized posted invoice');
  assertEqual(byId(discovery2.data.events, orphanPayment.id).state, 'missing_journal', 'discovery lists an unjournalized supplier payment');
  assertEqual(byId(discovery2.data.events, orphanReturn.id).state, 'missing_journal', 'discovery lists an unjournalized purchase return');
  assertEqual(byId(discovery2.data.events, orphanPayment.id).kind, 'supplier_payment', 'discovery tags the source kind');
  assert(!discovery2.data.events.some((e: any) => e.event_id === httpInvoiceId), 'discovery excludes journalized events');
  assert(!discovery2.data.events.some((e: any) => e.event_id === draftCancelled.id), 'discovery excludes non-financial drafts');

  // Authorization: reads are ownerManager, reprocess is owner-only.
  assertEqual((await api(baseUrl, '/api/accounting/purchases/unresolved')).status, 401, 'discovery requires authentication');
  assertEqual((await api(baseUrl, '/api/accounting/purchases/unresolved', { headers: manager.authHeader })).status, 200, 'discovery allows manager (ownerManager)');
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/purchase_invoice/${orphanInvoice.id}/reprocess`, { method: 'POST', headers: manager.authHeader })).status,
    403, 'reprocess rejects a manager (owner-only)',
  );
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/purchase_invoice/${orphanInvoice.id}/reprocess`, { method: 'POST' })).status,
    401, 'reprocess requires authentication',
  );
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/bogus/${orphanInvoice.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).status,
    400, 'an unknown kind is a 400',
  );

  const reprocessedInvoice = await api(baseUrl, `/api/accounting/purchases/purchase_invoice/${orphanInvoice.id}/reprocess`, { method: 'POST', headers: owner.authHeader });
  assertEqual(reprocessedInvoice.data.result.status, 'journalized', 'reprocess journals a missing purchase invoice projection');
  const reprocessedPayment = await api(baseUrl, `/api/accounting/purchases/supplier_payment/${orphanPayment.id}/reprocess`, { method: 'POST', headers: owner.authHeader });
  assertEqual(reprocessedPayment.data.result.status, 'journalized', 'reprocess journals a missing supplier payment projection');
  const reprocessedReturn = await api(baseUrl, `/api/accounting/purchases/purchase_return/${orphanReturn.id}/reprocess`, { method: 'POST', headers: owner.authHeader });
  assertEqual(reprocessedReturn.data.result.status, 'journalized', 'reprocess journals a missing purchase return projection');
  assertEqual(journalCount(db, 'purchases', orphanInvoice.id), 1, 'reprocess creates exactly one purchase journal');
  assertEqual(journalCount(db, 'supplier_payments', orphanPayment.id), 1, 'reprocess creates exactly one payment journal');
  assertEqual(journalCount(db, 'purchase_returns', orphanReturn.id), 1, 'reprocess creates exactly one return journal');
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/purchase_invoice/${orphanInvoice.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_journalized', 'reprocessing an already journalized event is a no-op',
  );
  assertEqual(journalCount(db, 'purchases', orphanInvoice.id), 1, 'no-op reprocess creates no duplicate journal');
  assertEqual(
    (await api(baseUrl, '/api/accounting/purchases/purchase_invoice/does-not-exist/reprocess', { method: 'POST', headers: owner.authHeader })).data.result.status,
    'nothing_to_do', 'reprocess of an unknown id is a no-op',
  );

  // The client may only name the source row; identity/amount come from the source.
  const overrideInvoice = createPurchaseInvoice(db, {
    supplierId: 'supp-http', invoiceDate: TODAY,
    items: [{ supplyId: 'sup-http', quantity: 1, unit: 'kg', unitPrice: 33 }],
    actorUserId: owner.userId,
  });
  postPurchaseInvoice(db, overrideInvoice.id, owner.userId);
  const overridden = await api(baseUrl, `/api/accounting/purchases/purchase_invoice/${overrideInvoice.id}/reprocess`, {
    method: 'POST', headers: owner.authHeader,
    body: { source_module: 'sales', source_id: 'evil', seq: 99, amount: 999999 },
  });
  assertEqual(overridden.data.result.status, 'journalized', 'reprocess journals a missing purchase projection');
  const overrideJournal = theJournal(db, 'purchases', overrideInvoice.id);
  assert(!!overrideJournal, 'client body cannot override identity: journal keeps purchases + invoice id + seq 1');
  assertEqual(
    linesOf(db, overrideJournal.id).reduce((s: number, l: any) => s + (l.direction === 'debit' ? l.amount : 0), 0),
    33, 'client-supplied amount is ignored; the journal uses the source total',
  );

  // `other` supplier payment: listed but never journalizable.
  const otherPayment = createSupplierPayment(db, { supplierId: 'supp-http', amount: 12, paymentMethod: 'other', actorUserId: owner.userId });
  const discovery3 = await api(baseUrl, '/api/accounting/purchases/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(byId(discovery3.data.events, otherPayment.id).journalizable, false, '`other` payment is listed but not journalizable');
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/supplier_payment/${otherPayment.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'skipped', 'reprocess of an `other` payment is skipped (no v1 account)',
  );
  assertEqual(journalCount(db, 'supplier_payments', otherPayment.id), 0, '`other` reprocess left no journal');

  // Missing reversal: source gone but the adapter step (delete hook) never ran.
  const orphanReversalPayment = createSupplierPayment(db, { supplierId: 'supp-http', amount: 21, paymentMethod: 'card', actorUserId: owner.userId });
  recordSupplierPaymentAccounting(orphanReversalPayment.id, owner.userId);
  const orphanReversalJournal = theJournal(db, 'supplier_payments', orphanReversalPayment.id);
  db.prepare('DELETE FROM supplier_payments WHERE id = ?').run(orphanReversalPayment.id);
  const discovery4 = await api(baseUrl, '/api/accounting/purchases/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(byId(discovery4.data.events, orphanReversalPayment.id).state, 'missing_reversal', 'discovery derives missing_reversal for a hard-deleted payment');
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/supplier_payment/${orphanReversalPayment.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'reversal_created', 'reprocess creates the missing payment reversal',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(orphanReversalJournal.id) as any).n,
    1, 'exactly one reversal exists after reprocess',
  );
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/supplier_payment/${orphanReversalPayment.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_reversed', 'repeated reprocess after repair is a no-op',
  );
  assertEqual(journalCount(db, 'supplier_payments', orphanReversalPayment.id), 2, 'no resurrection: the original journal is never rebuilt');

  // Soft-deleted purchase return with a posted journal but no reversal.
  const orphanReversalReturn = createPurchaseReturn(db, {
    purchaseInvoiceId: overrideInvoice.id, returnDate: TODAY,
    items: [{ purchaseInvoiceItemId: getPurchaseInvoice(db, overrideInvoice.id, true).items[0].id, quantity: 1 }],
    actorUserId: owner.userId,
  });
  recordPurchaseReturnAccounting(orphanReversalReturn.id, owner.userId);
  const orphanReversalReturnJournal = theJournal(db, 'purchase_returns', orphanReversalReturn.id);
  db.prepare("UPDATE purchase_returns SET status = 'deleted', deleted_at = ? WHERE id = ?").run(TODAY, orphanReversalReturn.id);
  const discovery5 = await api(baseUrl, '/api/accounting/purchases/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(byId(discovery5.data.events, orphanReversalReturn.id).state, 'missing_reversal', 'discovery derives missing_reversal for a soft-deleted return');
  assertEqual(
    (await api(baseUrl, `/api/accounting/purchases/purchase_return/${orphanReversalReturn.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'reversal_created', 'reprocess creates the missing return reversal',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(orphanReversalReturnJournal.id) as any).n,
    1, 'exactly one return reversal exists after reprocess',
  );

  server.close();

  console.log('='.repeat(50));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
