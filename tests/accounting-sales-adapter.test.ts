/**
 * Sales accounting adapter coverage (Milestone C).
 *
 * Exercises the real write paths where they exist (the adapter hook is the
 * same function the routes call post-commit) plus the adapter service
 * functions for scenarios that have no runtime trigger in C (credit sale at
 * issue, closed-period reprocessing). Covers the mandated sale/collection/
 * refund mappings, tax v1 (2100), deterministic source_module+source_id+seq
 * idempotency, closed-period behavior with reopen+reprocess, post-commit
 * failure safety, and the A/B/fiscal invariants.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-sales-adapter.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-sales-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters, seedOwnerUser, now,
} = require('./helpers/test-setup');
const {
  createSaleJournal, createCollectionJournal, createRefundJournal,
  recordBillPaymentAccounting, recordRefundAccounting,
} = require('../main/services/accounting-sales-adapter');
const {
  createJournal, createManualJournal, createOpeningBalance, getAccountByCode,
  getAccountBalances, AccountingServiceError,
} = require('../main/services/accounting');
const {
  createFiscalPeriod, closeFiscalPeriod, reopenFiscalPeriod,
  fiscalDateForInstant, FiscalPeriodError,
} = require('../main/services/fiscal-periods');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    const isService = err instanceof AccountingServiceError;
    const isFiscal = err instanceof FiscalPeriodError;
    assert(
      (isService || isFiscal) && err.statusCode === statusCode,
      `${message} (got ${err.statusCode}: ${err.message})`,
    );
  }
}

/** SQLite-format (`YYYY-MM-DD HH:MM:SS`, UTC) timestamp shifted by whole seconds. */
function secondsAfter(timestamp: string, seconds: number): string {
  const date = new Date(`${timestamp.replace(' ', 'T')}Z`);
  date.setUTCSeconds(date.getUTCSeconds() + seconds);
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();
const lastMonthTs = `${LAST_MONTH} 10:00:00`;

async function main() {
  console.log('Sales accounting adapter test (Milestone C)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);

  let orderSeq = 0;
  let billSeq = 0;

  function insertOrder(total: number, tax: number, customer: string | null = null, createdAt = now()): number {
    const info = db.prepare(`
      INSERT INTO orders (order_number, customer_id, type, status, subtotal, tax_amount, total, created_at, updated_at)
      VALUES (?, ?, 'takeaway', 'completed', ?, ?, ?, ?, ?)
    `).run(`ORD-C${++orderSeq}`, customer, total - tax, tax, total, createdAt, createdAt);
    return Number(info.lastInsertRowid);
  }
  function insertBill(orderId: number, total: number, tax: number, customer: string | null = null, createdAt = now()): number {
    const info = db.prepare(`
      INSERT INTO bills (bill_number, order_id, customer_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'unpaid', ?, ?)
    `).run(`B-C${++billSeq}`, orderId, customer, total - tax, tax, total, total, createdAt, createdAt);
    return Number(info.lastInsertRowid);
  }
  function payLine(method: string, amount: number, at = now(), batchId?: string) {
    return { method, amount, event_id: randomUUID(), batch_id: batchId ?? randomUUID(), timestamp: at };
  }
  function setPaymentDetails(billId: number, total: number, lines: any[]): any {
    const paid = lines.reduce((sum, line) => sum + line.amount, 0);
    const balance = Math.max(0, total - paid);
    const status = balance === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    db.prepare('UPDATE bills SET payment_details = ?, paid_amount = ?, balance = ?, payment_status = ?, paid_at = ? WHERE id = ?')
      .run(JSON.stringify(lines), paid, balance, status, lines.length > 0 ? lines[0].timestamp : null, billId);
    return db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  }
  function insertRefund(billId: number, amountCents: number, method: string, at = now()): number {
    const info = db.prepare(
      'INSERT INTO refunds (bill_id, amount_cents, method, approved_by, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(billId, amountCents, method, owner.userId, owner.userId, at);
    return Number(info.lastInsertRowid);
  }
  function journalsFor(sourceModule: string, sourceId: string): any[] {
    return db.prepare('SELECT * FROM journal_entries WHERE source_module = ? AND source_id = ? ORDER BY seq').all(sourceModule, String(sourceId));
  }
  function accountLines(journalId: string): Array<{ code: string; direction: string; amount: number }> {
    const rows = db.prepare(`
      SELECT a.code AS code, l.direction AS direction, l.amount AS amount
      FROM journal_entry_lines l JOIN accounting_accounts a ON a.id = l.account_id
      WHERE l.journal_id = ? ORDER BY l.rowid
    `).all(journalId);
    return rows;
  }
  function expectLines(journalId: string, expected: Array<[string, string, number]>, message: string): void {
    const actual = accountLines(journalId).map((l) => [l.code, l.direction, l.amount]);
    assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
  }

  // ── Sale: 1. cash ──
  let bill = insertBill(insertOrder(500, 0), 500, 0);
  setPaymentDetails(bill, 500, [payLine('cash', 500)]);
  const cashSale = createSaleJournal(bill, owner.userId);
  assert(!!cashSale, 'cash sale creates a journal');
  assertEqual((cashSale as any).source_module, 'sales', 'sale journal carries source_module sales');
  assertEqual((cashSale as any).source_id, String(bill), 'sale source_id is the bill id');
  assertEqual((cashSale as any).seq, 1, 'sale journal is seq 1');
  expectLines((cashSale as any).id, [['1000', 'debit', 500], ['4000', 'credit', 500]], 'cash sale maps Dr 1000 / Cr 4000');

  // ── Sale: 2. card (no tax) ──
  bill = insertBill(insertOrder(300, 0), 300, 0);
  setPaymentDetails(bill, 300, [payLine('card', 300)]);
  const cardSale: any = createSaleJournal(bill, owner.userId);
  expectLines(cardSale.id, [['1010', 'debit', 300], ['4000', 'credit', 300]], 'card sale maps Dr 1010 / Cr 4000');

  // ── Sale: 3. credit boundary (no runtime trigger in C; D owns standalone settlement) ──
  const unpaidBill = insertBill(insertOrder(250, 0), 250, 0);
  assertEqual(createSaleJournal(unpaidBill, owner.userId), null, 'an unpaid bill gets no sale journal in C (credit sale remains milestone D)');
  const legacyBill = insertBill(insertOrder(90, 0), 90, 0);
  setPaymentDetails(legacyBill, 90, [{ method: 'cash', amount: 90 }]);
  assertEqual(createSaleJournal(legacyBill, owner.userId), null, 'pre-C payment lines without event_id are skipped, not guessed');

  // ── Sale: 4. partial payment (mandate example) ──
  const partialBill = insertBill(insertOrder(1000, 0), 1000, 0);
  const partialAt = now();
  const partialBatch = randomUUID();
  setPaymentDetails(partialBill, 1000, [payLine('cash', 200, partialAt, partialBatch), payLine('customer_account', 800, partialAt, partialBatch)]);
  const partialSale: any = createSaleJournal(partialBill, owner.userId);
  expectLines(partialSale.id, [['1000', 'debit', 200], ['1100', 'debit', 800], ['4000', 'credit', 1000]], 'partial payment sale splits tenders plus AR remainder');
  assertEqual(journalsFor('sales', partialBill).length, 1, 'exactly one sale journal per bill');

  // ── Sale: 5. with tax ──
  bill = insertBill(insertOrder(118, 18), 118, 18);
  setPaymentDetails(bill, 118, [payLine('cash', 118)]);
  const taxSale: any = createSaleJournal(bill, owner.userId);
  expectLines(taxSale.id, [['1000', 'debit', 118], ['4000', 'credit', 100], ['2100', 'credit', 18]], 'tax v1 splits revenue (total - tax) and Cr 2100');

  // ── Sale: 6. invalid amounts ──
  const overTender = insertBill(insertOrder(100, 0), 100, 0);
  setPaymentDetails(overTender, 100, [payLine('cash', 999)]);
  assertEqual(createSaleJournal(overTender, owner.userId), null, 'tender exceeding the bill total is skipped, not misposted');
  const zeroRevenue = insertBill(insertOrder(0, 0), 0, 0);
  setPaymentDetails(zeroRevenue, 0, [payLine('cash', 1)]);
  assertEqual(createSaleJournal(zeroRevenue, owner.userId), null, 'a zero-revenue bill is skipped');

  // ── Sale: 7. duplicate ──
  const beforeDup = journalsFor('sales', partialBill).length;
  createSaleJournal(partialBill, owner.userId);
  assertEqual(journalsFor('sales', partialBill).length, beforeDup, 're-invoking the sale journal creates no duplicate');

  // ── Wallet/custom skip policy (confirmed decision) ──
  const walletBill = insertBill(insertOrder(70, 0), 70, 0);
  setPaymentDetails(walletBill, 70, [payLine('wallet', 70)]);
  assertEqual(createSaleJournal(walletBill, owner.userId), null, 'wallet tender has no v1 account: skipped with a logged reason');
  assertEqual(journalsFor('sales', walletBill).length, 0, 'no journal was misposted for the wallet bill');

  // ── Sale: 8. closed period (fiscal period created and closed here) ──
  const period = createFiscalPeriod(db, { periodType: 'month', startDate: LAST_MONTH, actorUserId: owner.userId });
  closeFiscalPeriod(db, period.id, owner.userId);
  const closedBill = insertBill(insertOrder(400, 0, null, lastMonthTs), 400, 0, null, lastMonthTs);
  setPaymentDetails(closedBill, 400, [payLine('cash', 400)]);
  assertEqual(createSaleJournal(closedBill, owner.userId), null, 'a sale journal for a bill dated in a closed period is not created');
  assertEqual(journalsFor('sales', closedBill).length, 0, 'closed-period sale wrote no journal');

  // ── Timestamp helper: strictly monotonic for every second of the minute ──
  assertEqual(secondsAfter('2026-10-05 07:28:56', 5), '2026-10-05 07:29:01', 'a second event crosses the minute boundary forward');
  assertEqual(secondsAfter('2026-10-05 23:59:58', 5), '2026-10-06 00:00:03', 'a second event crosses midnight forward');
  let nonMonotonic = 0;
  for (let s = 0; s < 60; s += 1) {
    const base = `2026-10-05 07:28:${String(s).padStart(2, '0')}`;
    if (secondsAfter(base, 5) <= base) nonMonotonic += 1;
  }
  assertEqual(nonMonotonic, 0, 'the later event is strictly later for all 60 seconds of a minute');

  // ── Collection: 10. cash ──
  const collectBill = insertBill(insertOrder(1000, 0), 1000, 0);
  const firstAt = now();
  const saleBatch = randomUUID();
  setPaymentDetails(collectBill, 1000, [payLine('cash', 400, firstAt, saleBatch)]);
  createSaleJournal(collectBill, owner.userId);
  const laterEvent = payLine('cash', 300, secondsAfter(firstAt, 5));
  setPaymentDetails(collectBill, 1000, [payLine('cash', 400, firstAt, saleBatch), laterEvent]);
  recordBillPaymentAccounting(collectBill, owner.userId);
  const saleRows = journalsFor('sales', collectBill);
  assertEqual(saleRows.length, 2, 'payment event projects a collection journal (sale + collection)');
  const collection: any = saleRows[1];
  assertEqual(collection.seq, 2, 'collection joins the document chain at max(seq)+1');
  assertEqual(collection.reference, laterEvent.event_id, 'collection reference is the payment event_id');
  expectLines(collection.id, [['1000', 'debit', 300], ['1100', 'credit', 300]], 'cash collection maps Dr 1000 / Cr 1100');
  assertEqual(collection.entry_date, fiscalDateForInstant(laterEvent.timestamp), 'collection is dated at the payment event, not the bill');

  // ── Collection: 10b. minute boundary (the later payment lands in the next minute) ──
  const boundaryFirstAt = `${TODAY} 07:28:56`;
  const boundaryLaterAt = secondsAfter(boundaryFirstAt, 5);
  assertEqual(boundaryLaterAt, `${TODAY} 07:29:01`, 'the boundary scenario really crosses the minute');
  const boundaryBill = insertBill(insertOrder(700, 0, null, boundaryFirstAt), 700, 0, null, boundaryFirstAt);
  const boundarySaleBatch = randomUUID();
  setPaymentDetails(boundaryBill, 700, [payLine('cash', 400, boundaryFirstAt, boundarySaleBatch)]);
  createSaleJournal(boundaryBill, owner.userId);
  const boundaryEvent = payLine('cash', 300, boundaryLaterAt);
  setPaymentDetails(boundaryBill, 700, [payLine('cash', 400, boundaryFirstAt, boundarySaleBatch), boundaryEvent]);
  recordBillPaymentAccounting(boundaryBill, owner.userId);
  const boundaryRows = journalsFor('sales', String(boundaryBill));
  assertEqual(boundaryRows.length, 2, 'the minute-boundary payment projects exactly one collection journal');
  assertEqual(boundaryRows[1].reference, boundaryEvent.event_id, 'the minute-boundary collection belongs to the newer payment event');
  expectLines(boundaryRows[1].id, [['1000', 'debit', 300], ['1100', 'credit', 300]], 'the minute-boundary collection keeps its tender mapping');

  // ── Collection: 11. card ──
  const cardCollectBill = insertBill(insertOrder(900, 0), 900, 0);
  const firstAt2 = now();
  const cardSaleBatch = randomUUID();
  setPaymentDetails(cardCollectBill, 900, [payLine('cash', 400, firstAt2, cardSaleBatch)]);
  createSaleJournal(cardCollectBill, owner.userId);
  const cardEvent = payLine('card', 500, secondsAfter(firstAt2, 5));
  setPaymentDetails(cardCollectBill, 900, [payLine('cash', 400, firstAt2, cardSaleBatch), cardEvent]);
  recordBillPaymentAccounting(cardCollectBill, owner.userId);
  const cardCollection: any = journalsFor('sales', cardCollectBill)[1];
  expectLines(cardCollection.id, [['1010', 'debit', 500], ['1100', 'credit', 500]], 'card collection maps Dr 1010 / Cr 1100');
  assertEqual((db.prepare('SELECT payment_status FROM bills WHERE id = ?').get(cardCollectBill) as any).payment_status, 'paid', 'the bill settled fully through two events');

  // ── Collection: 12. duplicate ──
  recordBillPaymentAccounting(collectBill, owner.userId);
  assertEqual(journalsFor('sales', collectBill).length, 2, 're-running the hook creates no duplicate collection');
  createCollectionJournal(collectBill, laterEvent.event_id, owner.userId);
  assertEqual(journalsFor('sales', collectBill).length, 2, 'the collection identity (source_id + reference) is UNIQUE-enforced on replay');

  // ── Collection: 13. closed period (sale predates the closed month) ──
  const fiveMonthsAgoTs = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 5);
    return `${d.toISOString().slice(0, 10)} 10:00:00`;
  })();
  const closedCollectionBill = insertBill(insertOrder(600, 0, null, fiveMonthsAgoTs), 600, 0, null, fiveMonthsAgoTs);
  const closedCollectSaleBatch = randomUUID();
  setPaymentDetails(closedCollectionBill, 600, [payLine('cash', 500, fiveMonthsAgoTs, closedCollectSaleBatch)]);
  createSaleJournal(closedCollectionBill, owner.userId);
  const closedEvent = payLine('cash', 100, lastMonthTs);
  setPaymentDetails(closedCollectionBill, 600, [payLine('cash', 500, fiveMonthsAgoTs, closedCollectSaleBatch), closedEvent]);
  recordBillPaymentAccounting(closedCollectionBill, owner.userId);
  assertEqual(journalsFor('sales', closedCollectionBill).length, 1, 'a collection in a closed period is not created');

  // ── Refunds: 15/16/17 ──
  const refundCashBill = insertBill(insertOrder(500, 0), 500, 0);
  setPaymentDetails(refundCashBill, 500, [payLine('cash', 500)]);
  createSaleJournal(refundCashBill, owner.userId);
  const refundCashId = insertRefund(refundCashBill, 10000, 'cash');
  const refundCash: any = createRefundJournal(refundCashId, owner.userId);
  assertEqual(refundCash.source_module, 'refunds', 'refund journal carries source_module refunds');
  assertEqual(refundCash.source_id, String(refundCashId), 'refund source_id is the refund id');
  assertEqual(refundCash.seq, 1, 'refund journal is seq 1');
  expectLines(refundCash.id, [['4010', 'debit', 100], ['1000', 'credit', 100]], 'cash refund maps Dr 4010 / Cr 1000');

  const refundCardBill = insertBill(insertOrder(300, 0), 300, 0);
  setPaymentDetails(refundCardBill, 300, [payLine('card', 300)]);
  createSaleJournal(refundCardBill, owner.userId);
  const refundCard: any = createRefundJournal(insertRefund(refundCardBill, 5000, 'card'), owner.userId);
  expectLines(refundCard.id, [['4010', 'debit', 50], ['1010', 'credit', 50]], 'card refund maps Dr 4010 / Cr 1010');

  const refundCreditBill = insertBill(insertOrder(400, 0), 400, 0);
  setPaymentDetails(refundCreditBill, 400, [payLine('customer_account', 400)]);
  createSaleJournal(refundCreditBill, owner.userId);
  const refundCredit: any = createRefundJournal(insertRefund(refundCreditBill, 4000, 'customer_account'), owner.userId);
  expectLines(refundCredit.id, [['4010', 'debit', 40], ['1100', 'credit', 40]], 'credit refund maps Dr 4010 / Cr 1100');

  const walletRefundBill = insertBill(insertOrder(80, 0), 80, 0);
  setPaymentDetails(walletRefundBill, 80, [payLine('cash', 80)]);
  createSaleJournal(walletRefundBill, owner.userId);
  assertEqual(createRefundJournal(insertRefund(walletRefundBill, 8000, 'wallet'), owner.userId), null, 'wallet refund is skipped (no v1 account)');
  const orphanRefundId = insertRefund(unpaidBill, 1000, 'cash');
  assertEqual(createRefundJournal(orphanRefundId, owner.userId), null, 'a refund whose bill has no sale journal is skipped');

  // ── Refund: 18. duplicate ──
  recordRefundAccounting(refundCashId, owner.userId);
  assertEqual(journalsFor('refunds', refundCashId).length, 1, 're-invoking the refund projection creates no duplicate');

  // ── Refund: 19. closed period ──
  const closedRefundId = insertRefund(refundCashBill, 2000, 'cash', lastMonthTs);
  assertEqual(createRefundJournal(closedRefundId, owner.userId), null, 'a refund dated in a closed period is not created');
  assertEqual(journalsFor('refunds', closedRefundId).length, 0, 'closed-period refund wrote no journal');

  // ── 21/22. post-commit failures never touch the source documents ──
  assertEqual((db.prepare('SELECT payment_status, paid_amount FROM bills WHERE id = ?').get(closedBill) as any).payment_status, 'paid', 'the closed-period bill survived the adapter failure intact');
  assertEqual(Number((db.prepare('SELECT amount_cents FROM refunds WHERE id = ?').get(closedRefundId) as any).amount_cents), 2000, 'the closed-period refund survived the adapter failure intact');

  // ── 9/14/20. reopen + reprocess (one owner-approved reopen) ──
  const { createHash } = require('crypto');
  const bcrypt = require('bcryptjs');
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(bcrypt.hashSync('1234', 10), owner.userId);
  reopenFiscalPeriod(db, period.id, '1234', owner.userId, owner.userId);

  const reprocessedSale: any = createSaleJournal(closedBill, owner.userId);
  assert(!!reprocessedSale, 'reprocessing after the reopen creates the sale journal');
  assertEqual(reprocessedSale.entry_date, fiscalDateForInstant(lastMonthTs), 'reprocessed sale keeps its original business date');
  assertEqual(journalsFor('sales', closedBill).length, 1, 'reprocess restores the same identity (no double journal)');

  recordBillPaymentAccounting(closedCollectionBill, owner.userId);
  const reprocessedCollection: any = journalsFor('sales', closedCollectionBill)[1];
  assert(!!reprocessedCollection, 'reprocessing after the reopen creates the collection journal');
  assertEqual(reprocessedCollection.entry_date, LAST_MONTH, 'reprocessed collection keeps the payment event date');

  const reprocessedRefund: any = createRefundJournal(closedRefundId, owner.userId);
  assert(!!reprocessedRefund, 'reprocessing after the reopen creates the refund journal');
  assertEqual(reprocessedRefund.entry_date, LAST_MONTH, 'reprocessed refund keeps the refund event date');

  // ── 23. receivable mirror creates no duplicate journal ──
  const mirrorBill = insertBill(insertOrder(300, 0), 300, 0);
  db.prepare("INSERT INTO customers (id, name, is_active) VALUES ('cust-mirror', 'Mirror Customer', 1)").run();
  const mirrorAt = now();
  setPaymentDetails(mirrorBill, 300, [payLine('customer_account', 300, mirrorAt)]);
  db.prepare(`
    INSERT INTO receivable_entries (id, customer_id, entry_type, direction, amount, description, reference, entry_date, created_at)
    VALUES ('rcv-mirror', 'cust-mirror', 'charge', 'debit', 300, 'Bill mirror', ?, ?, ?)
  `).run(String(mirrorBill), mirrorAt.slice(0, 10), mirrorAt);
  recordBillPaymentAccounting(mirrorBill, owner.userId);
  assertEqual(journalsFor('sales', mirrorBill).length, 1, 'the mirror charge produced no second journal — the sale journal is the only event');
  const mirrorSaleLines = accountLines(journalsFor('sales', mirrorBill)[0].id);
  assert(mirrorSaleLines.some((l) => l.code === '1100' && l.direction === 'debit'), 'the sale journal itself carries the AR debit');

  // ── 24. repeated hook (idempotent by construction) ──
  recordBillPaymentAccounting(collectBill, owner.userId);
  recordBillPaymentAccounting(collectBill, owner.userId);
  assertEqual(journalsFor('sales', collectBill).length, 2, 'three hook invocations still yield sale + collection only');

  // ── 25. every C journal is balanced ──
  const unbalanced = db.prepare(`
    SELECT j.id, COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS d,
           COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS c
    FROM journal_entries j JOIN journal_entry_lines l ON l.journal_id = j.id
    GROUP BY j.id
    HAVING ABS(d - c) > 1e-9
  `).all();
  assertEqual(unbalanced.length, 0, 'every journal in the ledger is balanced');

  // ── 27/28/29. identity contract consolidated ──
  assertEqual(reprocessedSale.source_module, 'sales', 'sale identity: source_module sales');
  assertEqual(reprocessedSale.source_id, String(closedBill), 'sale identity: source_id = bill id');
  assertEqual(reprocessedSale.seq, 1, 'sale identity: seq 1');
  assertEqual(reprocessedCollection.source_module, 'sales', 'collection identity: source_module sales');
  assertEqual(reprocessedCollection.seq, 2, 'collection identity: seq 2 on the bill chain');
  assertEqual(reprocessedCollection.reference, closedEvent.event_id, 'collection identity: reference = payment event_id');
  assertEqual(reprocessedRefund.source_module, 'refunds', 'refund identity: source_module refunds');
  assertEqual(reprocessedRefund.source_id, String(closedRefundId), 'refund identity: source_id = refund id');
  assertEqual(reprocessedRefund.seq, 1, 'refund identity: seq 1');

  // ── 26. correct business date on the main sale path ──
  const businessDatedBill = insertBill(insertOrder(60, 0, null, lastMonthTs), 60, 0, null, lastMonthTs);
  setPaymentDetails(businessDatedBill, 60, [payLine('cash', 60)]);
  const businessDated: any = createSaleJournal(businessDatedBill, owner.userId);
  assertEqual(businessDated.entry_date, fiscalDateForInstant(lastMonthTs), 'sale journals are dated by the bill business date, not the adapter run time');

  // ── Real HTTP path: the same bill write path the routes run, incl. batch_id stamping ──
  const billRoutes = require('../main/routes/bills').billRoutes;
  const refundRoutes = require('../main/routes/refunds').refundRoutes;
  const { createApp, startServer, api, seedManagerUser: seedManager } = require('./helpers/test-setup');
  const app = createApp({ '/api/bills': billRoutes, '/api/refunds': refundRoutes });
  const { baseUrl, server } = await startServer(app);
  const manager = seedManager(db);

  const liveBill = insertBill(insertOrder(120, 0), 120, 0);
  const payRes = await api(baseUrl, `/api/bills/${liveBill}/payment`, {
    method: 'POST', headers: owner.authHeader, body: { method: 'cash' },
  });
  assertEqual(payRes.status, 200, 'the real payment endpoint accepts the payment');
  const storedLines = JSON.parse((db.prepare('SELECT payment_details FROM bills WHERE id = ?').get(liveBill) as any).payment_details);
  assert(storedLines[0].batch_id && storedLines[0].event_id, 'the write path stamps event_id and batch_id on the payment line');
  const liveSale = journalsFor('sales', liveBill)[0];
  assert(!!liveSale, 'the post-commit hook produced the sale journal on the real path');
  expectLines(liveSale.id, [['1000', 'debit', 120], ['4000', 'credit', 120]], 'the real-path sale maps Dr 1000 / Cr 4000');

  const liveRefundRes = await api(baseUrl, '/api/refunds', {
    method: 'POST', headers: manager.authHeader,
    body: { bill_id: String(liveBill), amount: 20, method: 'cash', override_pin: '1234', approver_id: manager.userId },
  });
  assertEqual(liveRefundRes.status, 201, 'the real refund endpoint accepts the refund');
  const liveRefundId = Number(liveRefundRes.data.refund.id);
  const liveRefund = journalsFor('refunds', liveRefundId)[0];
  assert(!!liveRefund, 'the post-commit hook produced the refund journal on the real path');
  expectLines(liveRefund.id, [['4010', 'debit', 20], ['1000', 'credit', 20]], 'the real-path refund maps Dr 4010 / Cr 1000');
  server.close();

  // ── 30. no persistent retry/pending state ──
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => String(r.name));
  const forbidden = ['adapter_failures', 'journal_sync_state', 'accounting_pending', 'accounting_retry', 'accounting_queue'];
  assert(!tables.some((t) => forbidden.includes(t)), 'no pending/retry/queue/journal-sync table exists');

  // ── 31. A/B behavior remains intact ──
  const manual = createManualJournal({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: getAccountByCode('1000').id, direction: 'debit', amount: 7 },
      { accountId: getAccountByCode('5900').id, direction: 'credit', amount: 7 },
    ],
  });
  assertEqual(manual.source_module, 'manual', 'B manual journals still carry the manual identity');
  const opening = createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: getAccountByCode('1200').id, amount: 50 },
      { accountId: getAccountByCode('3000').id, amount: -50 },
    ],
  });
  assert(String(opening.source_id).startsWith('opening-'), 'B opening identity is unchanged');
  const cashBalance = getAccountBalances().find((b: any) => b.code === '1000');
  assert(Number(cashBalance.debit_total) > 0, 'derived balances reflect the C journals (A invariant)');

  // ── 32. fiscal lock behavior remains intact ──
  const otherPast = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 4);
    return d.toISOString().slice(0, 10);
  })();
  const otherPeriod = createFiscalPeriod(db, { periodType: 'month', startDate: otherPast, actorUserId: owner.userId });
  closeFiscalPeriod(db, otherPeriod.id, owner.userId);
  expectError(409, () => createJournal({
    entryDate: otherPast, sourceModule: 'manual', actorUserId: owner.userId,
    lines: [
      { accountId: getAccountByCode('1000').id, direction: 'debit', amount: 1 },
      { accountId: getAccountByCode('4000').id, direction: 'credit', amount: 1 },
    ],
  }), 'the v101 closed-period gate still rejects new journals in closed periods');

  console.log('='.repeat(50));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
