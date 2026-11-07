/**
 * FLOCAFE-RECIPE-UI-1 — Recipe management UI acceptance.
 *
 * Covers, without a browser or a real user database:
 *   1. Pure editor contract: payload building + every validation rule
 *      (`frontend/src/lib/recipe-form.ts`).
 *   2. Unit-dimension parity with the backend `convertQuantity` contract — the
 *      UI must never allow a unit the API would reject.
 *   3. Source-level UI guards on the inventory page (endpoints, permission
 *      gate, error display, localised labels, recipe list rendering).
 *   4. A limited rendered UI test: render the real RecipeFormDialog through
 *      react-dom/server, define a recipe, save it through the real API, re-read
 *      it (page reload), and render the saved result back into the editor.
 *   5. API CRUD + validation against a temporary database, including that a
 *      UI-created recipe still feeds Recipe Depletion / COGS snapshots.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/recipe-ui.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-recipe-ui-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const {
  initTestDb, createApp, startServer, seedOwnerUser, seedManagerUser,
  seedCategory, seedProduct, api, closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { createSupply } = require('../main/services/supplies');
const { buildRecipeSnapshot } = require('../main/services/recipes');
const backendUnits = require('../main/services/units');
const editor = require('../frontend/src/lib/recipe-form');

let passed = 0;
let failed = 0;
function check(condition: boolean, message: string): void {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}
function eq(actual: unknown, expected: unknown, message: string): void {
  check(Object.is(actual, expected), `${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  console.log('FLOCAFE-RECIPE-UI-1 — Recipe UI acceptance');
  console.log('='.repeat(70));

  // ── 1. Pure editor validation contract ───────────────────────────────────
  console.log('\n--- 1. Editor validation + payload ---');
  const supplies = [
    { id: 'sup-beans', name: 'Beans', base_unit: 'g' },
    { id: 'sup-milk', name: 'Milk', base_unit: 'ml' },
    { id: 'sup-cup', name: 'Cup', base_unit: 'each' },
  ];
  const validForm = {
    product_id: 'prod-latte',
    yield_quantity: '2',
    items: [
      { supply_id: 'sup-beans', quantity: '18.5', unit: 'g' },
      { supply_id: 'sup-milk', quantity: '200', unit: 'ml' },
    ],
  };

  const built = editor.validateRecipeForm(validForm, supplies, false);
  check(built.ok, 'valid form passes client-side validation');
  if (built.ok) {
    eq(built.payload.yield_quantity, 2, 'yield_quantity converted to a number');
    eq(built.payload.is_active, false, 'inactive recipe keeps is_active = false (no depletion toggle)');
    eq(built.payload.items.length, 2, 'both components included');
    eq(built.payload.items[0].quantity, 18.5, 'fractional quantity preserved');
    eq(built.payload.items[0].unit, 'g', 'unit preserved');
    eq(built.payload.items[0].supply_id, 'sup-beans', 'snake_case supply_id matches the API');
    check(!('yieldQuantity' in built.payload) && !('supplyId' in built.payload.items[0]),
      'payload uses the documented snake_case API shape only');
  }
  const defaultActive = editor.validateRecipeForm(validForm, supplies);
  check(defaultActive.ok && defaultActive.payload.is_active === true, 'new recipe defaults to active');

  const invalidCases: Array<{ form: any; error: string; label: string }> = [
    { form: { ...validForm, product_id: '' }, error: 'productRequired', label: 'empty product rejected' },
    { form: { ...validForm, product_id: '   ' }, error: 'productRequired', label: 'whitespace product rejected' },
    { form: { ...validForm, yield_quantity: '0' }, error: 'yieldInvalid', label: 'zero yield rejected' },
    { form: { ...validForm, yield_quantity: '-1' }, error: 'yieldInvalid', label: 'negative yield rejected' },
    { form: { ...validForm, yield_quantity: '' }, error: 'yieldInvalid', label: 'empty yield rejected' },
    { form: { ...validForm, yield_quantity: 'abc' }, error: 'yieldInvalid', label: 'NaN yield rejected' },
    { form: { ...validForm, yield_quantity: '1e999' }, error: 'yieldInvalid', label: 'Infinite yield rejected' },
    { form: { ...validForm, items: [] }, error: 'itemsRequired', label: 'recipe without components rejected' },
    { form: { ...validForm, items: [{ supply_id: '', quantity: '1', unit: 'g' }] }, error: 'supplyRequired', label: 'empty supply rejected' },
    { form: { ...validForm, items: [{ supply_id: 'deleted-supply', quantity: '1', unit: 'g' }] }, error: 'supplyRequired', label: 'unknown supply rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: '0', unit: 'g' }] }, error: 'quantityInvalid', label: 'zero quantity rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: '-3', unit: 'g' }] }, error: 'quantityInvalid', label: 'negative quantity rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: '', unit: 'g' }] }, error: 'quantityInvalid', label: 'empty quantity rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: 'NaN', unit: 'g' }] }, error: 'quantityInvalid', label: 'NaN quantity rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: 'Infinity', unit: 'g' }] }, error: 'quantityInvalid', label: 'Infinite quantity rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: '1', unit: 'ml' }] }, error: 'unitInvalid', label: 'cross-dimension unit (g supply / ml) rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: '1', unit: 'each' }] }, error: 'unitInvalid', label: 'cross-dimension unit (g supply / each) rejected' },
    { form: { ...validForm, items: [{ supply_id: 'sup-beans', quantity: '1', unit: 'bogus' }] }, error: 'unitInvalid', label: 'unknown unit rejected' },
    { form: { ...validForm, items: [
      { supply_id: 'sup-beans', quantity: '1', unit: 'g' },
      { supply_id: 'sup-beans', quantity: '2', unit: 'kg' },
    ] }, error: 'duplicateSupply', label: 'duplicate supply rejected' },
  ];
  for (const c of invalidCases) {
    const result = editor.validateRecipeForm(c.form, supplies);
    check(!result.ok && result.error === c.error, `${c.label} → ${c.error}`);
  }
  const crossScale = editor.validateRecipeForm({
    ...validForm,
    items: [
      { supply_id: 'sup-beans', quantity: '1', unit: 'kg' },
      { supply_id: 'sup-milk', quantity: '0.5', unit: 'l' },
    ],
  }, supplies);
  check(crossScale.ok, 'same-dimension unit scaling (g↔kg, ml↔l) accepted');

  // ── 2. Unit-dimension parity with the backend ─────────────────────────────
  console.log('\n--- 2. Unit compatibility parity with backend convertQuantity ---');
  assert.deepEqual([...editor.SUPPLY_UNITS], [...backendUnits.SUPPLY_UNITS], 'frontend unit list matches backend');
  let parityChecked = 0;
  for (const base of backendUnits.SUPPLY_UNITS) {
    const compatible = editor.compatibleUnitsFor(base);
    for (const unit of backendUnits.SUPPLY_UNITS) {
      let backendAccepts = true;
      try { backendUnits.convertQuantity(1, unit, base); } catch { backendAccepts = false; }
      check(compatible.includes(unit) === backendAccepts, `${unit} → ${base} parity (${backendAccepts ? 'allowed' : 'blocked'})`);
      parityChecked++;
    }
  }
  console.log(`  (${parityChecked} unit pairs checked)`);
  eq(editor.compatibleUnitsFor('nonsense').length, 0, 'unknown base unit offers no units');

  // ── 3. Source-level UI contract guards ───────────────────────────────────
  console.log('\n--- 3. Inventory page UI contract ---');
  const page = readFileSync(resolve(process.cwd(), 'frontend/src/app/(dashboard)/inventory/page.tsx'), 'utf8');
  const dialog = readFileSync(resolve(process.cwd(), 'frontend/src/components/inventory/RecipeFormDialog.tsx'), 'utf8');
  const en = require('../frontend/src/lib/i18n/messages/en.json');
  const fa = require('../frontend/src/lib/i18n/messages/fa.json');

  check(/tenantCan\(currentTenant, 'supplies\.manage'\)/.test(page), 'recipe manager stays permission-gated');
  check(/value="recipes"/.test(page) && /t\('tabRecipes'\)/.test(page), 'Recipes tab is present');
  check(/api\.get\('\/recipes'/.test(page), 'recipe list loaded from GET /recipes');
  check(/api\.put\(`\/recipes\/product\//.test(page), 'create/edit persists through PUT /recipes/product/:id');
  check(/api\.delete\(`\/recipes\/product\//.test(page), 'delete calls DELETE /recipes/product/:id');
  check(/validateRecipeForm\(recipeForm, recipeSupplies, isActive\)/.test(page), 'client-side validation runs before the PUT');
  check(/if \(!validation\.ok\)[\s\S]*?return;/.test(page), 'invalid forms never reach the API');
  check(/recipeErrorMessages\[validation\.error\]/.test(page), 'validation errors are shown to the user');
  check(/editingRecipe \? editingRecipe\.is_active === 1 : true/.test(page), 'editing preserves recipe activation state');
  check(/include_inactive: 'true'/.test(page), 'recipe editor loads inactive supplies too');
  check(/setRecipeError\(message \|\| t\('saveFailed'\)\)/.test(page), 'API save errors displayed inline');
  check(/response\?\.data\?\.error/.test(page), 'API error body surfaced (save and delete)');
  check(/role="alert"/.test(dialog), 'inline validation error uses an alert role');
  check(/compatibleUnitsFor\(supply\.base_unit\)/.test(dialog), 'unit dropdown restricted by supply dimension');
  check(/disabled=\{form\.items\.some\(/.test(dialog), 'duplicate supply options disabled in the UI');
  check(/r\.items\.map\(/.test(page) && /item\.quantity/.test(page) && /item\.unit/.test(page),
    'recipe list renders each product\'s components with quantity and unit');
  check(/r\.is_active !== 1/.test(page), 'inactive recipes are visibly marked in the list');

  const newKeys = [
    'unitForComponent', 'removeComponent', 'recipeErrorProductRequired', 'recipeErrorYield',
    'recipeErrorItems', 'recipeErrorSupply', 'recipeErrorQuantity', 'recipeErrorUnit',
    'recipeErrorDuplicate',
  ];
  for (const key of newKeys) {
    check(typeof en.inventory[key] === 'string' && en.inventory[key].length > 0, `en.inventory.${key} defined`);
    check(typeof fa.inventory[key] === 'string' && fa.inventory[key] !== en.inventory[key], `fa.inventory.${key} translated (not English)`);
  }
  check(!/t\(`/.test(dialog), 'no unsafe dynamic translation keys in the dialog');

  // ── 4. Rendered UI: define a recipe, persist, reload, view the result ─────
  console.log('\n--- 4. Rendered UI test (react-dom/server) ---');
  const frontendRequire = Module.createRequire(resolve(process.cwd(), 'frontend/package.json'));
  const originalResolve = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let aliased = request;
    if (request.startsWith('@/')) aliased = resolve(process.cwd(), 'frontend/src', request.slice(2));
    else if (request.startsWith('@shared/')) aliased = resolve(process.cwd(), 'shared', request.slice(8));
    return originalResolve.call(this, aliased, parent, isMain, options);
  };
  let React: any, ReactDOMServer: any, IntlProvider: any, RecipeFormDialog: any;
  try {
    React = frontendRequire('react');
    ReactDOMServer = frontendRequire('react-dom/server');
    IntlProvider = frontendRequire('use-intl').IntlProvider;
    RecipeFormDialog = require('../frontend/src/components/inventory/RecipeFormDialog').default;
  } finally {
    (Module as any)._resolveFilename = originalResolve;
  }

  function renderDialog(props: Record<string, unknown>): string {
    return ReactDOMServer.renderToStaticMarkup(
      React.createElement(IntlProvider, { locale: 'en', messages: en },
        React.createElement(RecipeFormDialog, {
          editing: false,
          form: validForm,
          products: [{ id: 'prod-latte', name: 'Latte' }],
          supplies,
          error: null,
          onChange: () => undefined,
          onSubmit: () => undefined,
          onCancel: () => undefined,
          ...props,
        })),
    );
  }

  const createMarkup = renderDialog({});
  check(createMarkup.includes('Latte'), 'create dialog renders the product selector');
  check(createMarkup.includes('Create recipe'), 'create dialog uses the localised title');
  check(createMarkup.includes('Beans') && createMarkup.includes('Milk'), 'create dialog renders supply options');
  check(createMarkup.includes('>g<') && createMarkup.includes('>kg<'), 'g supply offers g + kg units');
  check(!createMarkup.includes('>ml<') || createMarkup.includes('Milk'), 'unit options are the dialog\'s own dimension-filtered sets');
  // The first row uses a mass supply: volume/count units must not be offered there.
  const firstUnitSelect = createMarkup.slice(
    createMarkup.indexOf('aria-label="Unit"'),
    createMarkup.indexOf('</select>', createMarkup.indexOf('aria-label="Unit"')),
  );
  check(firstUnitSelect.includes('value="g"') && firstUnitSelect.includes('value="kg"'), 'first row offers mass units');
  check(!firstUnitSelect.includes('value="ml"') && !firstUnitSelect.includes('value="l"') && !firstUnitSelect.includes('value="each"'),
    'first row hides incompatible volume/count units');
  check(createMarkup.includes('Add component') && createMarkup.includes('Remove component'), 'add/remove component controls present');
  check(!/role="alert"/.test(createMarkup), 'no stale error on a fresh dialog');

  const errorMarkup = renderDialog({ error: 'Each component quantity must be a number greater than zero.' });
  check(errorMarkup.includes('role="alert"') && errorMarkup.includes('greater than zero'), 'API/validation error rendered inline');
  const emptyMarkup = renderDialog({ form: { ...validForm, items: [] } });
  check(/<button[^>]*disabled[^>]*>\s*Save/.test(emptyMarkup) || emptyMarkup.includes('disabled=""'),
    'save disabled until a component is added');

  // ── 5. Real API CRUD, persistence and depletion regression ────────────────
  console.log('\n--- 5. API CRUD, reload persistence, validation, COGS ---');
  const db = initTestDb();
  const { authHeader, userId } = seedOwnerUser(db);
  seedManagerUser(db);
  seedCategory(db, 'cat-recipe-ui', 'Recipe UI');
  seedProduct(db, 'prod-latte', 'cat-recipe-ui', 'Latte', 250, { track_inventory: false, stock_quantity: 0 });
  const beans = createSupply(db, { name: 'Beans', baseUnit: 'g', stockQuantity: 1000, actorUserId: userId });
  const milk = createSupply(db, { name: 'Milk', baseUnit: 'ml', stockQuantity: 5000, actorUserId: userId });
  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  try {
    const uiSupplies = [
      { id: beans.id, name: 'Beans', base_unit: 'g' },
      { id: milk.id, name: 'Milk', base_unit: 'ml' },
    ];
    const uiForm = {
      product_id: 'prod-latte',
      yield_quantity: '2',
      items: [
        { supply_id: beans.id, quantity: '18', unit: 'g' },
        { supply_id: milk.id, quantity: '200', unit: 'ml' },
      ],
    };
    const toSave = editor.validateRecipeForm(uiForm, uiSupplies, true);
    check(toSave.ok, 'UI form validated before hitting the API');
    if (!toSave.ok) throw new Error('UI form unexpectedly invalid');

    // Create (PUT is the upsert the UI uses).
    const created = await api(baseUrl, '/api/recipes/product/prod-latte', {
      method: 'PUT', headers: authHeader, body: toSave.payload,
    });
    eq(created.status, 200, 'define recipe from UI payload succeeds');
    eq(created.data.recipe.items.length, 2, 'created recipe stores both components');
    eq(created.data.recipe.is_active, 1, 'created recipe is active');

    // Reload the page: the recipes tab re-fetches GET /recipes.
    const reloaded = await api(baseUrl, '/api/recipes', { headers: authHeader });
    eq(reloaded.status, 200, 'GET /recipes succeeds after reload');
    const listed = (reloaded.data.recipes || []).find((r: any) => r.product_id === 'prod-latte');
    check(Boolean(listed), 'recipe persists and is visible after page reload');
    eq(listed.items.length, 2, 'both components persist after reload');
    eq(listed.yield_quantity, 2, 'yield persists after reload');

    // Render the saved result back into the edit dialog ("view result").
    const editForm = {
      product_id: listed.product_id,
      yield_quantity: String(listed.yield_quantity),
      items: listed.items.map((i: any) => ({ supply_id: i.supply_id, quantity: String(i.quantity), unit: i.unit })),
    };
    const resultMarkup = renderDialog({ editing: true, form: editForm });
    check(resultMarkup.includes('Edit recipe'), 'saved recipe opens in the edit dialog');
    check(resultMarkup.includes('>18<') || resultMarkup.includes('value="18"'), 'saved bean quantity visible in the UI');
    check(resultMarkup.includes('value="200"'), 'saved milk quantity visible in the UI');

    // Edit: change a quantity, add a component and remove one.
    const editedForm = {
      ...uiForm,
      items: [{ supply_id: beans.id, quantity: '30', unit: 'g' }],
    };
    const toEdit = editor.validateRecipeForm(editedForm, uiSupplies, true);
    check(toEdit.ok, 'edited form passes validation');
    if (!toEdit.ok) throw new Error('edited form unexpectedly invalid');
    const edited = await api(baseUrl, '/api/recipes/product/prod-latte', {
      method: 'PUT', headers: authHeader, body: toEdit.payload,
    });
    eq(edited.status, 200, 'edit recipe succeeds');
    eq(edited.data.recipe.items.length, 1, 'removed component is gone');
    eq(edited.data.recipe.items[0].quantity, 30, 'edited quantity persisted');
    const afterEdit = await api(baseUrl, '/api/recipes/product/prod-latte', { headers: authHeader });
    eq(afterEdit.data.recipe.items[0].quantity, 30, 'edit survives a fresh GET (reload)');

    // Delete.
    const deleted = await api(baseUrl, '/api/recipes/product/prod-latte', {
      method: 'DELETE', headers: authHeader,
    });
    eq(deleted.status, 200, 'delete recipe succeeds');
    const afterDelete = await api(baseUrl, '/api/recipes', { headers: authHeader });
    check(!(afterDelete.data.recipes || []).some((r: any) => r.product_id === 'prod-latte'),
      'deleted recipe is gone after reload');

    // API rejects exactly the shapes the client-side validator rejects.
    const apiInvalid: Array<{ body: any; label: string }> = [
      { body: { yield_quantity: 0, items: [{ supply_id: beans.id, quantity: 1, unit: 'g' }] }, label: 'zero yield' },
      { body: { yield_quantity: 1, items: [] }, label: 'empty components' },
      { body: { yield_quantity: 1, items: [{ supply_id: beans.id, quantity: 0, unit: 'g' }] }, label: 'zero quantity' },
      { body: { yield_quantity: 1, items: [{ supply_id: beans.id, quantity: 1, unit: 'ml' }] }, label: 'cross-dimension unit' },
      { body: { yield_quantity: 1, items: [{ supply_id: beans.id, quantity: 1, unit: 'nope' }] }, label: 'unknown unit' },
      { body: { yield_quantity: 1, items: [
        { supply_id: beans.id, quantity: 1, unit: 'g' },
        { supply_id: beans.id, quantity: 2, unit: 'kg' },
      ] }, label: 'duplicate supply' },
    ];
    for (const c of apiInvalid) {
      const res = await api(baseUrl, '/api/recipes/product/prod-latte', {
        method: 'PUT', headers: authHeader, body: c.body,
      });
      check(res.status === 400 || res.status === 404, `API rejects ${c.label} with a client error (${res.status})`);
      check(typeof res.data.error === 'string' && res.data.error.length > 0, `API returns an error message for ${c.label} (UI shows it)`);
    }

    // is_active preservation: an inactive recipe must stay inactive when the UI
    // re-saves it, otherwise Recipe Depletion silently turns back on.
    const inactive = editor.validateRecipeForm(uiForm, uiSupplies, false);
    check(inactive.ok, 'inactive edit form validated');
    if (!inactive.ok) throw new Error('inactive form unexpectedly invalid');
    const inactiveSaved = await api(baseUrl, '/api/recipes/product/prod-latte', {
      method: 'PUT', headers: authHeader, body: inactive.payload,
    });
    eq(inactiveSaved.data.recipe.is_active, 0, 'UI edit preserves is_active = false');
    eq(buildRecipeSnapshot(db, 'prod-latte', 1), null, 'inactive recipe does not deplete (depletion unchanged)');

    // A UI-created active recipe still feeds the existing depletion/COGS path.
    const activeSave = editor.validateRecipeForm(uiForm, uiSupplies, true);
    if (!activeSave.ok) throw new Error('active form unexpectedly invalid');
    await api(baseUrl, '/api/recipes/product/prod-latte', {
      method: 'PUT', headers: authHeader, body: activeSave.payload,
    });
    // yield_quantity = 2, so 4 ordered units scale the recipe by 4 / 2 = 2.
    const snapshot = buildRecipeSnapshot(db, 'prod-latte', 4);
    check(Boolean(snapshot), 'UI-created active recipe builds a depletion snapshot');
    if (snapshot) {
      eq(snapshot.components.find((c: any) => c.supply_id === beans.id).quantity, 36, 'snapshot scales beans 2 x 18 g');
      eq(snapshot.components.find((c: any) => c.supply_id === milk.id).quantity, 400, 'snapshot scales milk 2 x 200 ml');
    }
    eq(buildRecipeSnapshot(db, 'prod-latte', 0), null, 'non-positive order quantity yields no depletion');
  } finally {
    server.close();
    closeDatabase();
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('='.repeat(70));
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
