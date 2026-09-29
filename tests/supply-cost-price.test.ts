/**
 * Weighted-average cost: priced inflows blend into supplies.cost_price,
 * outflows keep the average, negative stock is left untouched, and posting a
 * purchase invoice feeds unit prices into the average.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/supply-cost-price.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-supply-cost-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const { createSupplier } = require('../main/services/suppliers');
const { createSupply, getSupply, applySupplyStockChange } = require('../main/services/supplies');
const { createPurchaseInvoice, postPurchaseInvoice } = require('../main/services/purchase-invoices');

function expectServiceError(fn: () => void, statusCode: number, label: string): void {
  try {
    fn();
    assert(false, `${label} (expected statusCode ${statusCode})`);
  } catch (error: any) {
    assertEqual(error?.statusCode, statusCode, label);
  }
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

async function main() {
  console.log('Supply weighted-average cost test');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;

  createSupplier(db, { id: 'supp-a', name: 'Supplier A', code: 'SA' });
  createSupply(db, { id: 'sup-a', name: 'Sugar', baseUnit: 'kg', stockQuantity: 0, actorUserId: actor });
  assertEqual(getSupply(db, 'sup-a').cost_price, 0, 'fresh supply starts at cost 0');

  // ── Priced inflow sets the average ──
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 5, movementType: 'receive',
    unitCost: 2000, actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-a').cost_price, 2000, 'first priced inflow sets the average');

  // ── Outflow keeps the average ──
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: -2, movementType: 'waste', actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 3, 'outflow reduces stock');
  assertEqual(getSupply(db, 'sup-a').cost_price, 2000, 'outflow keeps the average');

  // ── Unpriced inflow keeps the average ──
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 2, movementType: 'receive', actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 5, 'unpriced inflow adds stock');
  assertEqual(getSupply(db, 'sup-a').cost_price, 2000, 'unpriced inflow keeps the average');

  // ── Priced inflow blends: (3kg @2000 + 2kg @3000) / 5kg = 2400 ──
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 2, movementType: 'receive',
    unitCost: 3000, actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 7, 'blend inflow adds stock');
  assertEqual(getSupply(db, 'sup-a').cost_price, 2285.71428571, 'priced inflow blends the average');

  // ── Unit conversion: 500 g @ 4 per g (= 4000/kg) blends per base unit ──
  const wacBefore = getSupply(db, 'sup-a').cost_price;
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 500, movementType: 'receive',
    unit: 'g', unitCost: 4, actorUserId: actor,
  });
  const wacAfter = getSupply(db, 'sup-a').cost_price;
  assertEqual(wacAfter, 2400, 'unitCost converts into the base unit before blending');

  // ── Empty stock resets to the incoming price ──
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: -7.5, movementType: 'waste', actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 0, 'stock hits zero');
  const avgAtZero = getSupply(db, 'sup-a').cost_price;
  applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 4, movementType: 'receive',
    unitCost: 1500, actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-a').cost_price, 1500, 'inflow onto empty stock resets the average to the incoming price');

  // ── Negative stock is left untouched ──
  const negativeProbe = createSupply(db, { id: 'sup-neg', name: 'Flour', baseUnit: 'kg', stockQuantity: 0, actorUserId: actor });
  db.prepare('UPDATE supplies SET stock_quantity = -3 WHERE id = ?').run(negativeProbe.id);
  applySupplyStockChange(db, {
    supplyId: 'sup-neg', quantityDelta: 3, movementType: 'receive',
    unitCost: 9000, actorUserId: actor,
  });
  assertEqual(getSupply(db, 'sup-neg').stock_quantity, 0, 'negative stock absorbs the inflow');
  assertEqual(getSupply(db, 'sup-neg').cost_price, 0, 'negative stock leaves the average untouched');

  // ── Invalid unitCost is rejected ──
  expectServiceError(() => applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 1, movementType: 'receive',
    unitCost: -5, actorUserId: actor,
  }), 400, 'negative unitCost is a 400');
  expectServiceError(() => applySupplyStockChange(db, {
    supplyId: 'sup-a', quantityDelta: 1, movementType: 'receive',
    unitCost: Number.NaN, actorUserId: actor,
  }), 400, 'NaN unitCost is a 400');

  // ── Purchase invoice post feeds the average per item ──
  const invoice = createPurchaseInvoice(db, {
    supplierId: 'supp-a',
    invoiceDate: '2026-02-01',
    items: [{ supplyId: 'sup-a', quantity: 5, unit: 'kg', unitPrice: 4000 }],
    actorUserId: actor,
  });
  postPurchaseInvoice(db, invoice.id, actor);
  // (4kg @1500 + 5kg @4000) / 9kg
  const expectedInvoice = roundCost((1500 * 4 + 4000 * 5) / 9);
  assertEqual(getSupply(db, 'sup-a').stock_quantity, 9, 'invoice post receives stock');
  assertEqual(
    getSupply(db, 'sup-a').cost_price,
    expectedInvoice,
    'posting an invoice blends its unit price into the average',
  );

  // Movement rows still record stock-only data.
  const lastMovement = db.prepare(
    "SELECT * FROM supply_movements WHERE supply_id = 'sup-a' ORDER BY id DESC LIMIT 1",
  ).get();
  assert(lastMovement !== undefined, 'movements are still recorded');
  assertEqual(lastMovement.quantity_delta, 5, 'movement delta stays quantity-only');

  console.log('='.repeat(50));
  const { passed, failed, total } = getResults();
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
