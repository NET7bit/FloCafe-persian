/**
 * Tax preview ↔ order parity for add-ons, and charge-error sanitisation.
 *
 * Pins the behaviour fixed in the D.10-H series:
 *  - the preview prices add-ons from the catalog, never from the request, so a
 *    preview total equals the total the order endpoint will store (T1)
 *  - a forged `price` on an add-on cannot move the preview total (T2)
 *  - unknown / inactive / unlinked / id-less add-ons are rejected with a stable
 *    code, and a required group left unselected is rejected by BOTH endpoints (T3, T7)
 *  - a malformed charge amount answers 400 `invalid_charge_amount` without
 *    echoing the decimal.js message or a stack (T4 preview, T5 order)
 *
 * Every run creates its own mkdtemp database, so the fixture ids below can be
 * fixed without colliding across runs.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/tax-preview-addon-parity.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-preview-parity-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

// A database path inherited from the environment would win over the mock's userData
// dir (getDbPath checks FLO_E2E_DB_PATH first), so this suite would silently run
// against whatever that variable points at. Clear it before any app module loads and
// restore it afterwards; the only database this file may touch is the temp dir above.
const inheritedDbPath = process.env.FLO_E2E_DB_PATH;
delete process.env.FLO_E2E_DB_PATH;

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, seedCategory, seedProduct,
  installAndActivateTestTaxPack,
  api, assert, assertEqual, assertOrThrow,
  getResults, closeDatabase, now,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { registerRoutes } = require('../main/routes/index');
const indiaTaxPackData = require('./fixtures/synthetic-dual-rate-pack.json');

/** True when a response body leaks implementation detail instead of a public message. */
function leaksInternals(data: any): boolean {
  const body = JSON.stringify(data ?? {});
  return /DecimalError|at Object\.|node_modules|\bat [A-Za-z]+ \(/.test(body);
}

async function main() {
  console.log('Integration Test: Add-on preview/order parity and charge-error sanitisation');
  console.log('='.repeat(70));

  const db = initTestDb();

  // Prove the file actually opened, rather than trusting that the mock was honoured:
  // a wrong path here would mean the suite is writing into someone else's database.
  const dbFile = (db.pragma('database_list') as Array<{ file?: string }>)[0]?.file || '';
  console.log('test database =', dbFile);
  const testDirReal = fs.realpathSync(testDir);
  const dbFileReal = fs.realpathSync(dbFile);
  assertOrThrow(
    dbFileReal.startsWith(testDirReal + path.sep),
    `the suite must use its own temp database, got ${dbFile || '(no file)'}`,
  );

  // A deterministic 5% restaurant tax so subtotal/tax/total are exact integers.
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('country', 'IN', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('business_type', 'restaurant', ?)").run(now());
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('state_code', '27', ?)").run(now());
  installAndActivateTestTaxPack(db, { ...indiaTaxPackData, id: 'test-in-pack', country: 'IN', currency: 'INR' });

  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-parity', 'Parity Menu');
  seedProduct(db, 'prod-parity-plain', 'cat-parity', 'Plain Item', 1000, {
    tax_category_id: 'standard', tax_behavior: 'exclusive',
  });
  seedProduct(db, 'prod-parity-required', 'cat-parity', 'Needs Size', 500, {
    tax_category_id: 'standard', tax_behavior: 'exclusive',
  });

  // Add-on fixtures. There is no route-level helper for the product↔group link,
  // so the three tables are seeded directly, exactly as the add-on suites do.
  const stamp = now();
  const insertGroup = db.prepare(`INSERT INTO addon_groups
    (id, name, description, is_required, min_selection, max_selection, allow_multiple_quantities, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, 0, ?, 0, ?, ?)`);
  const insertAddon = db.prepare(`INSERT INTO addons
    (id, addon_group_id, name, price, tax_category_id, tax_behavior, inherit_parent_tax_category, is_active, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, 'country_default', 1, ?, 0, ?, ?)`);
  const link = db.prepare('INSERT INTO addon_group_product (product_id, addon_group_id) VALUES (?, ?)');

  insertGroup.run('grp-parity-ok', 'OK group', 0, 0, 3, 1, stamp, stamp);
  insertAddon.run('addon-parity-ok', 'grp-parity-ok', 'Extra Shot', 100, 1, stamp, stamp);
  link.run('prod-parity-plain', 'grp-parity-ok');

  insertGroup.run('grp-parity-inactive', 'Inactive group', 0, 0, 3, 0, stamp, stamp);
  insertAddon.run('addon-parity-in-inactive-group', 'grp-parity-inactive', 'Hidden', 50, 1, stamp, stamp);
  link.run('prod-parity-plain', 'grp-parity-inactive');

  insertGroup.run('grp-parity-inactive-addon', 'Group with inactive addon', 0, 0, 3, 1, stamp, stamp);
  insertAddon.run('addon-parity-inactive', 'grp-parity-inactive-addon', 'Retired', 70, 0, stamp, stamp);
  link.run('prod-parity-plain', 'grp-parity-inactive-addon');

  // Created but never linked to the product.
  insertGroup.run('grp-parity-unlinked', 'Unlinked group', 0, 0, 3, 1, stamp, stamp);
  insertAddon.run('addon-parity-unlinked', 'grp-parity-unlinked', 'Elsewhere', 90, 1, stamp, stamp);

  insertGroup.run('grp-parity-required', 'Size (required)', 1, 1, 1, 1, stamp, stamp);
  insertAddon.run('addon-parity-required', 'grp-parity-required', 'Large', 0, 1, stamp, stamp);
  link.run('prod-parity-required', 'grp-parity-required');

  const app = createApp({ '/api/orders': orderRoutes });
  registerRoutes(app); // the tax preview is registered on `app`, not on a router
  const { baseUrl, server } = await startServer(app);

  const preview = (items: any[], extra: Record<string, unknown> = {}) => api(baseUrl, '/api/tax/preview', {
    method: 'POST',
    body: { items, customer_id: null, ...extra },
    headers: authHeader,
  });
  const placeOrder = (body: any) => api(baseUrl, '/api/orders', {
    method: 'POST', body, headers: authHeader,
  });

  try {
    // ── T1: preview and order agree on a valid add-on basket ─────────────
    console.log('\nT1. Preview and order produce the same money for one basket');
    const t1Items = [{ product_id: 'prod-parity-plain', quantity: 1, addons: [{ id: 'addon-parity-ok', quantity: 1 }] }];
    const t1Preview = await preview(t1Items);
    assertEqual(t1Preview.status, 200, 'preview succeeds');
    assertEqual(t1Preview.data.summary.subtotal, 1100, 'preview subtotal = 1000 + 100 add-on');
    assertEqual(t1Preview.data.summary.tax_amount, 55, 'preview tax = 5% of 1100');
    assertEqual(t1Preview.data.summary.total, 1155, 'preview total = 1100 + 55');

    const t1Order = await placeOrder({ type: 'takeaway', items: t1Items });
    assertEqual(t1Order.status, 201, 'order created');
    assertEqual(t1Order.data.order.subtotal, t1Preview.data.summary.subtotal, 'order subtotal equals preview subtotal');
    assertEqual(t1Order.data.order.tax_amount, t1Preview.data.summary.tax_amount, 'order tax equals preview tax');
    assertEqual(t1Order.data.order.total, t1Preview.data.summary.total, 'order total equals preview total');
    assertEqual(t1Order.data.order.total, 1155, 'order total = 1155');

    // ── T2: the client cannot set the price ──────────────────────────────
    console.log('\nT2. A forged add-on price does not move the preview total');
    const t2 = async (price: number | undefined) => preview([{
      product_id: 'prod-parity-plain',
      quantity: 1,
      addons: [{ id: 'addon-parity-ok', quantity: 1, ...(price === undefined ? {} : { price }) }],
    }]);
    const t2Base = await t2(undefined);
    const t2Zero = await t2(0);
    const t2Huge = await t2(999999);
    // Fail here with a readable message rather than on a field read below.
    assertOrThrow(
      t2Base.status === 200,
      `the un-forged baseline preview must succeed before comparing prices (got ${t2Base.status}: ${JSON.stringify(t2Base.data)})`,
    );
    assertEqual(t2Zero.status, 200, 'forged price 0 is still priced');
    assertEqual(t2Huge.status, 200, 'forged price 999999 is still priced');
    assertEqual(t2Zero.data.summary.total, t2Base.data.summary.total, 'price 0 does not change the total');
    assertEqual(t2Huge.data.summary.total, t2Base.data.summary.total, 'price 999999 does not change the total');
    assertEqual(t2Huge.data.summary.total, 1155, 'catalog price still drives the total');

    // ── T3: invalid add-on states ────────────────────────────────────────
    console.log('\nT3. Invalid add-on states are rejected with stable codes');
    const t3Cases: Array<[string, any[], string]> = [
      ['unknown id', [{ id: 'addon-parity-does-not-exist', quantity: 1 }], 'addon_invalid'],
      ['inactive add-on', [{ id: 'addon-parity-inactive', quantity: 1 }], 'addon_invalid'],
      ['inactive group', [{ id: 'addon-parity-in-inactive-group', quantity: 1 }], 'addon_invalid'],
      ['unlinked group', [{ id: 'addon-parity-unlinked', quantity: 1 }], 'addon_invalid'],
      ['no catalog id', [{ price: 0, quantity: 1 }], 'addon_id_required'],
      // services/addons.ts requires a positive integer quantity, so all three are
      // resolver rejections and reach the preview as addon_invalid.
      ['quantity 0', [{ id: 'addon-parity-ok', quantity: 0 }], 'addon_invalid'],
      ['quantity -1', [{ id: 'addon-parity-ok', quantity: -1 }], 'addon_invalid'],
      ['quantity 1.5', [{ id: 'addon-parity-ok', quantity: 1.5 }], 'addon_invalid'],
    ];
    for (const [label, addons, expectedCode] of t3Cases) {
      const res = await preview([{ product_id: 'prod-parity-plain', quantity: 1, addons }]);
      assertEqual(res.status, 400, `${label} is rejected with 400`);
      assertEqual(res.data?.code, expectedCode, `${label} carries code ${expectedCode}`);
      assertOrThrow(!leaksInternals(res.data), `${label} leaks no internal detail`);
    }

    // The order endpoint runs the same resolver; one representative case proves the
    // rejection is not preview-only.
    const t3OrderQuantity = await placeOrder({
      type: 'takeaway',
      items: [{ product_id: 'prod-parity-plain', quantity: 1, addons: [{ id: 'addon-parity-ok', quantity: 0 }] }],
    });
    assertEqual(t3OrderQuantity.status, 400, 'order rejects quantity 0 as well');
    assertOrThrow(!leaksInternals(t3OrderQuantity.data), 'order quantity rejection leaks no internal detail');

    // ── T4: malformed charge amount on the preview ───────────────────────
    console.log('\nT4. A malformed charge amount on the preview answers 400 without leaking');
    const t4 = await preview([{ product_id: 'prod-parity-plain', quantity: 1 }], { delivery_charge: 'abc' });
    assertEqual(t4.status, 400, 'preview rejects delivery_charge="abc"');
    assertEqual(t4.data?.code, 'invalid_charge_amount', 'preview carries invalid_charge_amount');
    assertOrThrow(!leaksInternals(t4.data), 'preview response leaks no DecimalError or stack');

    // ── T5: malformed charge amount on order creation ────────────────────
    console.log('\nT5. The same input on order creation answers 400 without leaking');
    const t5 = await placeOrder({
      type: 'takeaway',
      items: [{ product_id: 'prod-parity-plain', quantity: 1, addons: null }],
      delivery_charge: 'abc',
    });
    assertEqual(t5.status, 400, 'order rejects delivery_charge="abc"');
    assertEqual(t5.data?.code, 'invalid_charge_amount', 'order carries invalid_charge_amount');
    assertOrThrow(!leaksInternals(t5.data), 'order response leaks no DecimalError or stack');

    // ── T7: required group left unselected ───────────────────────────────
    console.log('\nT7. A required group left unselected is rejected by both endpoints');
    const t7Items = [{ product_id: 'prod-parity-required', quantity: 1, addons: [] }];
    const t7Preview = await preview(t7Items);
    const t7Order = await placeOrder({ type: 'takeaway', items: t7Items });
    assertEqual(t7Preview.status, 400, 'preview refuses to price an unselected required group');
    assertEqual(t7Preview.data?.code, 'addon_invalid', 'preview carries addon_invalid');
    assertEqual(t7Order.status, 400, 'order rejects the same basket');
    assertOrThrow(!leaksInternals(t7Preview.data), 'preview error leaks no internal detail');

    // An order must exist for T1 only: the rejected attempts above created none.
    const orderCount = (db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c;
    assert(orderCount === 1, `only the T1 order was persisted (got ${orderCount})`);
  } finally {
    server.close();
    closeDatabase();
    if (inheritedDbPath !== undefined) process.env.FLO_E2E_DB_PATH = inheritedDbPath;
  }

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(70));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
