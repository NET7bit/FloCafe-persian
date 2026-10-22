/**
 * COGS accounting adapter coverage (Milestone G).
 *
 * Exercises the real order write paths (POST /api/orders depletes supply
 * stock, item cancel/void/restore) plus the adapter functions that the payment
 * and refund routes call post-commit. Proves that cost is frozen on
 * `supply_movements`, that COGS is recognized at financial sale recognition
 * under `cogs + order item id + seq`, that an item-level refund reverses the
 * frozen original, that a cancel reverses while a void does not, that a split
 * bill allocates nothing extra, that pre-migration (cost-less) movements are
 * excluded, and that discovery/reprocess are idempotent.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-cogs-adapter.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-cogs-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, assertGreaterThan, getResults, resetCounters,
  seedOwnerUser, seedManagerUser, seedCategory, seedProduct, seedTable,
  createApp, startServer, api, now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { createSupply } = require('../main/services/supplies');
const { applySupplyStockChange } = require('../main/services/supplies');
const { saveRecipe } = require('../main/services/recipes');
const { getAccountByCode } = require('../main/services/accounting');
const { recordBillPaymentAccounting } = require('../main/services/accounting-sales-adapter');
const {
  createItemCogsJournal, recordBillCogsAccounting, recordRefundCogsAccounting,
  recordItemCancelCogsAccounting, reprocessCogsAccounting, listUnresolvedCogsEvents,
} = require('../main/services/accounting-cogs-adapter');

function cogsJournals(db: any, orderItemId: string | number): any[] {
  return db.prepare("SELECT * FROM journal_entries WHERE source_module = 'cogs' AND source_id = ? ORDER BY seq")
    .all(String(orderItemId));
}
function linesOf(db: any, journalId: string): Array<{ code: string; direction: string; amount: number }> {
  return db.prepare(`
    SELECT a.code AS code, l.direction AS direction, l.amount AS amount
    FROM journal_entry_lines l JOIN accounting_accounts a ON a.id = l.account_id
    WHERE l.journal_id = ? ORDER BY l.rowid
  `).all(journalId);
}
function expectLines(db: any, journalId: string, expected: Array<[string, string, number]>, message: string): void {
  const actual = linesOf(db, journalId).map((l) => [l.code, l.direction, l.amount]);
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}

async function main() {
  console.log('COGS accounting adapter test (Milestone G)');
  console.log('='.repeat(55));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'cat-cogs', 'COGS');
  seedTable(db, 'tbl-cogs', 1, 4);

  // ── Migration v104 surface: columns, account, allowed source module ──
  const cols = db.prepare('PRAGMA table_info(supply_movements)').all().map((c: any) => c.name);
  assert(cols.includes('unit_cost') && cols.includes('total_cost'), 'v104 adds frozen cost columns to supply_movements');
  assertEqual(getAccountByCode('5100').code, '5100', 'v104 seeds the COGS account 5100');
  assertEqual(getAccountByCode('5100').type, 'expense', 'COGS account is an expense');

  // ── Supplies with a priced inflow so cost is frozen (WAC = 2 per g) ──
  const beans = createSupply(db, { name: 'Beans', baseUnit: 'g', stockQuantity: 0, actorUserId: owner.userId });
  applySupplyStockChange(db, {
    supplyId: beans.id, quantityDelta: 1000, movementType: 'receive', unitCost: 2,
    actorUserId: owner.userId, referenceType: 'purchase_invoice', referenceId: 'pi-beans',
  });
  assertEqual(Number(db.prepare('SELECT cost_price FROM supplies WHERE id = ?').get(beans.id).cost_price), 2, 'priced inflow sets the weighted-average cost');
  assertEqual(
    Number(db.prepare("SELECT unit_cost FROM supply_movements WHERE supply_id = ? AND movement_type = 'receive'").get(beans.id).unit_cost),
    2, 'the inflow movement freezes its purchase price',
  );

  // Zero-cost supply: no priced inflow, so consumption has no valid cost.
  const freebie = createSupply(db, { name: 'Freebie', baseUnit: 'g', stockQuantity: 0, actorUserId: owner.userId });

  seedProduct(db, 'prod-latte', 'cat-cogs', 'Latte', 250, { track_inventory: false });
  seedProduct(db, 'prod-mocha', 'cat-cogs', 'Mocha', 280, { track_inventory: false });
  seedProduct(db, 'prod-free', 'cat-cogs', 'Freebie Item', 10, { track_inventory: false });
  saveRecipe(db, { productId: 'prod-latte', yieldQuantity: 1, items: [{ supply_id: beans.id, quantity: 18, unit: 'g' }] });
  saveRecipe(db, { productId: 'prod-mocha', yieldQuantity: 1, items: [{ supply_id: beans.id, quantity: 20, unit: 'g' }] });
  saveRecipe(db, { productId: 'prod-free', yieldQuantity: 1, items: [{ supply_id: freebie.id, quantity: 10, unit: 'g' }] });

  const { orderRoutes } = require('../main/routes/orders');
  const { orderItemRoutes } = require('../main/routes/order-items');
  const { accountingRoutes } = require('../main/routes/accounting');
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/order-items': orderItemRoutes,
    '/api/accounting': accountingRoutes,
  });
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  let billSeq = 0;
  function insertBill(orderId: number, total: number, splitGroupId: string | null = null): number {
    const at = now();
    const info = db.prepare(`
      INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, split_group_id, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, 0, ?, 'unpaid', ?, ?, ?)
    `).run(`B-COGS-${++billSeq}`, orderId, total, total, total, splitGroupId, at, at);
    return Number(info.lastInsertRowid);
  }
  function payBill(billId: number, total: number): void {
    const at = now();
    const line = { method: 'cash', amount: total, event_id: randomUUID(), batch_id: randomUUID(), timestamp: at };
    db.prepare("UPDATE bills SET payment_details = ?, paid_amount = ?, balance = 0, payment_status = 'paid', paid_at = ? WHERE id = ?")
      .run(JSON.stringify([line]), total, at, billId);
  }
  function recognizeSale(billId: number, total: number): void {
    payBill(billId, total);
    recordBillPaymentAccounting(billId, owner.userId);
  }
  function orderItemId(orderId: number, productId: string): number {
    return Number((db.prepare('SELECT id FROM order_items WHERE order_id = ? AND product_id = ? LIMIT 1').get(orderId, productId) as any).id);
  }
  async function createOrder(items: any[]): Promise<number> {
    const res = await api(baseUrl, '/api/orders', {
      method: 'POST', headers: owner.authHeader,
      body: { type: 'dine_in', table_id: 'tbl-cogs', items },
    });
    assertEqual(res.status, 201, 'order created');
    return Number(res.data.order.id);
  }

  // ── Recognition at sale recognition (Option B) ──
  const order1 = await createOrder([{ product_id: 'prod-latte', quantity: 3 }]);
  const item1 = orderItemId(order1, 'prod-latte');
  const depletion = db.prepare("SELECT * FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'").get(String(item1)) as any;
  assert(!!depletion, 'order creation freezes a recipe_depletion movement');
  assertEqual(Number(depletion.unit_cost), 2, 'consumption freezes the moving average as unit cost');
  assertEqual(Number(depletion.total_cost), -108, 'consumption freezes a signed total cost (3 × 18 × 2 = 108)');

  const bill1 = insertBill(order1, 750);
  recordBillCogsAccounting(bill1, owner.userId); // unpaid bill, no sale journal
  assertEqual(cogsJournals(db, item1).length, 0, 'no COGS before the sale journal exists');
  recognizeSale(bill1, 750);
  recordBillCogsAccounting(bill1, owner.userId);
  const cogs1 = cogsJournals(db, item1);
  assertEqual(cogs1.length, 1, 'payment creates exactly one COGS journal for the item');
  assertEqual(cogs1[0].seq, 1, 'COGS identity: seq 1');
  assertEqual(cogs1[0].reference, String(bill1), 'COGS references the bill that recognized the sale');
  expectLines(db, cogs1[0].id, [['5100', 'debit', 108], ['1200', 'credit', 108]], 'COGS maps Dr 5100 / Cr 1200 for the frozen amount');

  recordBillCogsAccounting(bill1, owner.userId);
  assertEqual(cogsJournals(db, item1).length, 1, 'replays create no duplicate COGS journal');

  // An unpaid bill (no sale journal) never gets COGS.
  const orderUnpaid = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemUnpaid = orderItemId(orderUnpaid, 'prod-latte');
  const unpaidBill = insertBill(orderUnpaid, 250);
  recordBillCogsAccounting(unpaidBill, owner.userId);
  assertEqual(cogsJournals(db, itemUnpaid).length, 0, 'a bill without a sale journal gets no COGS');

  // ── Data-derived activation: cost-less consumption is excluded ──
  const orderFree = await createOrder([{ product_id: 'prod-free', quantity: 5 }]);
  const itemFree = orderItemId(orderFree, 'prod-free');
  const freeMovement = db.prepare("SELECT * FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ?").get(String(itemFree)) as any;
  assertEqual(freeMovement.unit_cost, null, 'a zero-cost supply freezes an unknown unit cost');
  assertEqual(freeMovement.total_cost, null, 'a zero-cost supply freezes an unknown total');
  const freeBill = insertBill(orderFree, 50);
  recognizeSale(freeBill, 50);
  recordBillCogsAccounting(freeBill, owner.userId);
  assertEqual(cogsJournals(db, itemFree).length, 0, 'consumption without a valid frozen cost creates no COGS (never guessed from products.cost)');
  assertEqual(createItemCogsJournal(itemFree, owner.userId), null, 'recognition of a cost-less item is a no-op');
  const unresolvedFree = listUnresolvedCogsEvents().find((e: any) => e.event_id === String(itemFree));
  assert(!!unresolvedFree && unresolvedFree.state === 'missing_journal', 'zero-sentinel cost remains visible for reconciliation');
  assertEqual(unresolvedFree!.amount, null, 'zero-sentinel cost is reported as unknown, not a zero amount');
  db.prepare("UPDATE supply_movements SET unit_cost = 0, total_cost = 0 WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'")
    .run(String(itemFree));
  assertEqual(createItemCogsJournal(itemFree, owner.userId), null, 'legacy zero-cost snapshots never post as actual zero COGS');
  const unresolvedLegacyZero = listUnresolvedCogsEvents().find((e: any) => e.event_id === String(itemFree));
  assert(!!unresolvedLegacyZero && unresolvedLegacyZero.state === 'missing_journal', 'legacy zero-cost snapshots remain reconcilable');

  // ── Negative stock with a valid average still recognizes ──
  const orderNegative = await createOrder([{ product_id: 'prod-latte', quantity: 100 }]); // 1800 g > 1000 g on hand
  const itemNegative = orderItemId(orderNegative, 'prod-latte');
  assertGreaterThan(-Number(db.prepare('SELECT stock_quantity FROM supplies WHERE id = ?').get(beans.id).stock_quantity), 0, 'supply stock went negative (no clamping)');
  const negativeBill = insertBill(orderNegative, 25000);
  recognizeSale(negativeBill, 25000);
  recordBillCogsAccounting(negativeBill, owner.userId);
  assertEqual(cogsJournals(db, itemNegative).length, 1, 'negative stock with a valid average still recognizes COGS');
  expectLines(db, cogsJournals(db, itemNegative)[0].id, [['5100', 'debit', 3600], ['1200', 'credit', 3600]], 'negative-stock COGS uses the frozen average (100 × 18 × 2)');

  // ── Split bill: one COGS per order item, no extra allocation ──
  const orderSplit = await createOrder([
    { product_id: 'prod-latte', quantity: 1 },
    { product_id: 'prod-mocha', quantity: 1 },
  ]);
  const splitLatte = orderItemId(orderSplit, 'prod-latte');
  const splitMocha = orderItemId(orderSplit, 'prod-mocha');
  const billLatte = insertBill(orderSplit, 250, 'sg-cogs');
  const billMocha = insertBill(orderSplit, 280, 'sg-cogs');
  db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, ?)').run(billLatte, splitLatte, 1);
  db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, ?)').run(billMocha, splitMocha, 1);
  recognizeSale(billLatte, 250);
  recognizeSale(billMocha, 280);
  recordBillCogsAccounting(billLatte, owner.userId);
  recordBillCogsAccounting(billMocha, owner.userId);
  assertEqual(cogsJournals(db, splitLatte).length, 1, 'split bill: each item gets exactly one COGS journal');
  assertEqual(cogsJournals(db, splitMocha).length, 1, 'split bill: the second item gets its own COGS');
  expectLines(db, cogsJournals(db, splitLatte)[0].id, [['5100', 'debit', 36], ['1200', 'credit', 36]], 'split latte COGS (18 × 2)');
  expectLines(db, cogsJournals(db, splitMocha)[0].id, [['5100', 'debit', 40], ['1200', 'credit', 40]], 'split mocha COGS (20 × 2)');
  // Re-recognizing both bills changes nothing (item-level identity, not bill-level).
  recordBillCogsAccounting(billLatte, owner.userId);
  recordBillCogsAccounting(billMocha, owner.userId);
  assertEqual(cogsJournals(db, splitLatte).length, 1, 'no duplicate COGS from a split bill replay');
  assertEqual(cogsJournals(db, splitMocha).length, 1, 'no duplicate COGS from a split bill replay');

  // ── Item-level refund reverses the frozen original (Dr 1200 / Cr 5100) ──
  const refundAt = now();
  const refundInfo = db.prepare(
    "INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, approved_by, created_by, created_at) VALUES (?, ?, ?, 'cash', ?, ?, ?)",
  ).run(bill1, item1, 75000, owner.userId, owner.userId, refundAt);
  recordRefundCogsAccounting(Number(refundInfo.lastInsertRowid), owner.userId);
  const original1: any = cogsJournals(db, item1)[0];
  const reversal1: any = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(original1.id);
  assert(!!reversal1, 'an item refund creates a reversal');
  assertEqual(reversal1.seq, 2, 'the reversal joins the item chain at max(seq)+1');
  expectLines(db, reversal1.id, [['5100', 'credit', 108], ['1200', 'debit', 108]], 'the refund reversal inverts the frozen original (Cr 5100 / Dr 1200)');
  assertEqual((db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(original1.id) as any).status, 'reversed', 'the original COGS is marked reversed');
  recordRefundCogsAccounting(Number(refundInfo.lastInsertRowid), owner.userId);
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(original1.id) as any).n, 1, 'repeated refund hook creates no second reversal');

  // Bill-level refund (no order_item_id) leaves COGS untouched.
  const billLevelRefund = db.prepare(
    "INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, approved_by, created_by, created_at) VALUES (?, NULL, ?, 'cash', ?, ?, ?)",
  ).run(negativeBill, 1000, owner.userId, owner.userId, now());
  recordRefundCogsAccounting(Number(billLevelRefund.lastInsertRowid), owner.userId);
  assertEqual(cogsJournals(db, itemNegative).length, 1, 'a bill-level refund creates no COGS reversal (left to reconciliation)');

  // ── Cancel reverses; void does not ──
  // (Adapter-level: the cancel hook reverses an active COGS journal.)
  const orderCancel = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemCancel = orderItemId(orderCancel, 'prod-latte');
  const cancelBill = insertBill(orderCancel, 250);
  recognizeSale(cancelBill, 250);
  recordBillCogsAccounting(cancelBill, owner.userId);
  const cancelOriginal: any = cogsJournals(db, itemCancel)[0];
  recordItemCancelCogsAccounting(itemCancel, owner.userId);
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(cancelOriginal.id) as any).n, 1, 'the cancel hook reverses the item COGS');
  recordItemCancelCogsAccounting(itemCancel, owner.userId);
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(cancelOriginal.id) as any).n, 1, 'repeated cancel hook creates no second reversal');

  // Route-level: a pre-payment void restores no inventory and creates no COGS;
  // a pre-payment cancel restores inventory and also creates no COGS (no sale).
  const orderVoid = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemVoid = orderItemId(orderVoid, 'prod-latte');
  const stockBeforeVoid = Number(db.prepare('SELECT stock_quantity FROM supplies WHERE id = ?').get(beans.id).stock_quantity);
  // Move the item in front of the void guard (an in-progress item voids rather than cancels).
  db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(itemVoid);
  const voidRes = await api(baseUrl, `/api/orders/${orderVoid}/items/${itemVoid}/cancel`, {
    method: 'PATCH', headers: owner.authHeader, body: { override_pin: '1234', manager_id: manager.userId, reason: 'void test' },
  });
  assertEqual(voidRes.status, 200, 'voiding the in-progress item succeeds');
  assertEqual((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemVoid) as any).status, 'voided', 'the voided item is marked voided');
  assertEqual(Number(db.prepare('SELECT stock_quantity FROM supplies WHERE id = ?').get(beans.id).stock_quantity), stockBeforeVoid, 'void does not restore inventory');
  assertEqual(cogsJournals(db, itemVoid).length, 0, 'a void creates no COGS journal (and nothing to reverse, since inventory is not restored)');

  const orderCancelRoute = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemCancelRoute = orderItemId(orderCancelRoute, 'prod-latte');
  const stockBeforeCancel = Number(db.prepare('SELECT stock_quantity FROM supplies WHERE id = ?').get(beans.id).stock_quantity);
  const cancelRes = await api(baseUrl, `/api/orders/${orderCancelRoute}/items/${itemCancelRoute}/cancel`, {
    method: 'PATCH', headers: owner.authHeader, body: { reason: 'cancel test' },
  });
  assertEqual(cancelRes.status, 200, 'cancelling a pending item succeeds');
  assertEqual((db.prepare('SELECT status FROM order_items WHERE id = ?').get(itemCancelRoute) as any).status, 'cancelled', 'the item is marked cancelled');
  assertEqual(Number(db.prepare('SELECT stock_quantity FROM supplies WHERE id = ?').get(beans.id).stock_quantity), stockBeforeCancel + 18, 'cancel restores the consumed supply');
  assertEqual(cogsJournals(db, itemCancelRoute).length, 0, 'a pre-payment cancel creates no COGS (no sale recognized)');

  // ── Discovery + reprocess ──
  const orderDiscover = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemDiscover = orderItemId(orderDiscover, 'prod-latte');
  const discoverBill = insertBill(orderDiscover, 250);
  recognizeSale(discoverBill, 250); // sale journal, but COGS hook deliberately not called
  const discovery = listUnresolvedCogsEvents();
  const found = discovery.find((e: any) => e.event_id === String(itemDiscover));
  assert(!!found && found.state === 'missing_journal', 'discovery lists a consumed, sale-recognized item without COGS');
  assertEqual(found!.amount, 36, 'discovery reports the frozen consumption value (18 × 2)');

  // Authorization: reads are ownerManager, reprocess is owner-only.
  assertEqual((await api(baseUrl, '/api/accounting/cogs/unresolved')).status, 401, 'discovery requires authentication');
  assertEqual((await api(baseUrl, '/api/accounting/cogs/unresolved', { headers: manager.authHeader })).status, 200, 'discovery allows manager');
  assertEqual(
    (await api(baseUrl, `/api/accounting/cogs/${itemDiscover}/reprocess`, { method: 'POST', headers: manager.authHeader })).status,
    403, 'reprocess rejects a manager (owner-only)',
  );
  assertEqual(
    (await api(baseUrl, `/api/accounting/cogs/${itemDiscover}/reprocess`, { method: 'POST' })).status,
    401, 'reprocess requires authentication',
  );
  const reprocessed = await api(baseUrl, `/api/accounting/cogs/${itemDiscover}/reprocess`, { method: 'POST', headers: owner.authHeader });
  assertEqual(reprocessed.data.result.status, 'recognized', 'reprocess recognizes the missing COGS projection');
  assertEqual(cogsJournals(db, itemDiscover).length, 1, 'reprocess creates exactly one COGS journal');
  assertEqual(
    (await api(baseUrl, `/api/accounting/cogs/${itemDiscover}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_recognized', 'reprocessing an already recognized item is a no-op',
  );
  assertEqual(
    (await api(baseUrl, '/api/accounting/cogs/999999/reprocess', { method: 'POST', headers: owner.authHeader })).data.result.status,
    'nothing_to_do', 'reprocess of an unknown item is a no-op',
  );
  assertEqual(reprocessCogsAccounting('999999', owner.userId).status, 'nothing_to_do', 'direct reprocess of an unknown item is a no-op');

  // Missing reversal: a refunded item whose COGS was never reversed.
  const orderMissingRev = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemMissingRev = orderItemId(orderMissingRev, 'prod-latte');
  const missingRevBill = insertBill(orderMissingRev, 250);
  recognizeSale(missingRevBill, 250);
  recordBillCogsAccounting(missingRevBill, owner.userId);
  db.prepare("UPDATE order_items SET status = 'refunded' WHERE id = ?").run(itemMissingRev);
  const discovery2 = listUnresolvedCogsEvents();
  const found2 = discovery2.find((e: any) => e.event_id === String(itemMissingRev));
  assert(!!found2 && found2.state === 'missing_reversal', 'discovery lists a refunded item whose COGS is not reversed');
  assertEqual(reprocessCogsAccounting(String(itemMissingRev), owner.userId).status, 'reversal_created', 'reprocess creates the missing reversal');
  assertEqual(reprocessCogsAccounting(String(itemMissingRev), owner.userId).status, 'already_reversed', 'a refunded, already-reversed item is never re-recognized');

  // ── P1/P2: NULL frozen cost is never zero; only depletion/restore count ──
  function cogsDebitTotal(journalId: string | number): number {
    return Number((db.prepare(
      "SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0) AS a FROM journal_entry_lines WHERE journal_id = ?",
    ).get(journalId) as any).a);
  }

  // (a) numeric baseline — a fully priced consumption still posts COGS
  const orderNum = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemNum = orderItemId(orderNum, 'prod-latte');
  const billNum = insertBill(orderNum, 250);
  recognizeSale(billNum, 250);
  const journalNum = createItemCogsJournal(itemNum, owner.userId);
  assert(!!journalNum, 'P1: a fully numeric consumption still posts a COGS journal');
  assertEqual(cogsDebitTotal(journalNum!.id), 36, 'P1: frozen amount is 1 × 18 × 2 = 36');

  // (b) P2 — a non-consumption movement referencing the same order item is excluded
  const orderP2 = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemP2 = orderItemId(orderP2, 'prod-latte');
  const depletionP2 = db.prepare(
    "SELECT supply_id, unit FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'",
  ).get(String(itemP2)) as any;
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, reason,
      actor_user_id, reference_type, reference_id, created_at, unit_cost, total_cost)
    VALUES (?, -1, 'waste', ?, 0, 'P2 probe', ?, 'order_item', ?, ?, 5, -5)
  `).run(depletionP2.supply_id, depletionP2.unit, owner.userId, String(itemP2), now());
  const billP2 = insertBill(orderP2, 250);
  recognizeSale(billP2, 250);
  const journalP2 = createItemCogsJournal(itemP2, owner.userId);
  assert(!!journalP2, 'P2: the item still posts COGS alongside an unrelated movement');
  assertEqual(cogsDebitTotal(journalP2!.id), 36, 'P2: a waste movement on the order item never enters sale COGS');

  // (c) P1 — an unknown frozen cost yields no journal, never a zero one
  const orderNull = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemNull = orderItemId(orderNull, 'prod-latte');
  db.prepare(
    "UPDATE supply_movements SET total_cost = NULL WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'",
  ).run(String(itemNull));
  const billNull = insertBill(orderNull, 250);
  recognizeSale(billNull, 250);
  assertEqual(createItemCogsJournal(itemNull, owner.userId), null, 'P1: an unknown frozen cost posts no COGS instead of zero');
  assertEqual(cogsJournals(db, itemNull).length, 0, 'P1: no journal row is written for an unknown cost');
  const unresolvedNull = listUnresolvedCogsEvents().find((e: any) => e.event_id === String(itemNull));
  assert(!!unresolvedNull && unresolvedNull.state === 'missing_journal', 'P1-b: all-NULL recipe movements remain unresolved');
  assertEqual(unresolvedNull!.amount, null, 'P1-b: an all-NULL unresolved amount remains unknown');

  // (d) a NULL qualifying movement remains unresolved beside a numeric movement
  const orderMixed = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemMixed = orderItemId(orderMixed, 'prod-latte');
  const depletionMixed = db.prepare(
    "SELECT supply_id, unit FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'",
  ).get(String(itemMixed)) as any;
  db.prepare(
    "UPDATE supply_movements SET total_cost = NULL WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'",
  ).run(String(itemMixed));
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, reason,
      actor_user_id, reference_type, reference_id, created_at, unit_cost, total_cost)
    VALUES (?, 1, 'recipe_restore', ?, 1, 'P1-b mixed-cost probe', ?, 'order_item', ?, ?, 1, 1)
  `).run(depletionMixed.supply_id, depletionMixed.unit, owner.userId, String(itemMixed), now());
  const billMixed = insertBill(orderMixed, 250);
  recognizeSale(billMixed, 250);
  const unresolvedMixed = listUnresolvedCogsEvents().find((e: any) => e.event_id === String(itemMixed));
  assert(!!unresolvedMixed && unresolvedMixed.state === 'missing_journal', 'P1-b: NULL and numeric recipe movements remain unresolved');
  assertEqual(unresolvedMixed!.amount, null, 'P1-b: a mixed-cost event still reports unknown amount');

  // (e) no qualifying movements — empty sets stay resolved
  const orderNone = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemNone = orderItemId(orderNone, 'prod-latte');
  db.prepare("DELETE FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ?").run(String(itemNone));
  const billNone = insertBill(orderNone, 250);
  recognizeSale(billNone, 250);
  assertEqual(createItemCogsJournal(itemNone, owner.userId), null, 'P1: an empty movement set posts nothing');
  assert(!listUnresolvedCogsEvents().some((e: any) => e.event_id === String(itemNone)), 'P1-b: an empty movement set is not unresolved');

  // (f) unrelated NULL movements do not enter unresolved discovery
  const orderUnrelated = await createOrder([{ product_id: 'prod-latte', quantity: 1 }]);
  const itemUnrelated = orderItemId(orderUnrelated, 'prod-latte');
  const depletionUnrelated = db.prepare(
    "SELECT supply_id, unit FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ? AND movement_type = 'recipe_depletion'",
  ).get(String(itemUnrelated)) as any;
  db.prepare("DELETE FROM supply_movements WHERE reference_type = 'order_item' AND reference_id = ?").run(String(itemUnrelated));
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, reason,
      actor_user_id, reference_type, reference_id, created_at, unit_cost, total_cost)
    VALUES (?, -1, 'waste', ?, 0, 'P1-b unrelated NULL probe', ?, 'order_item', ?, ?, 5, NULL)
  `).run(depletionUnrelated.supply_id, depletionUnrelated.unit, owner.userId, String(itemUnrelated), now());
  const billUnrelated = insertBill(orderUnrelated, 250);
  recognizeSale(billUnrelated, 250);
  assert(!listUnresolvedCogsEvents().some((e: any) => e.event_id === String(itemUnrelated)), 'P1-b: unrelated NULL movements do not become unresolved');

  // ── Ledger invariants ──
  const unbalanced = db.prepare(`
    SELECT j.id, COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS d,
           COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS c
    FROM journal_entries j JOIN journal_entry_lines l ON l.journal_id = j.id
    GROUP BY j.id HAVING ABS(d - c) > 1e-9
  `).all();
  assertEqual(unbalanced.length, 0, 'every journal in the ledger is balanced');
  const orphanCogs = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = 'cogs' AND reference IS NULL").get() as any;
  assertEqual(orphanCogs.n, 0, 'every COGS journal references the bill that recognized its sale');

  server.close();

  console.log('='.repeat(55));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
