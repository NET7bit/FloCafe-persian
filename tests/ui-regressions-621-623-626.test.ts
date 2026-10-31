/**
 * Source-level guards for the UI regressions fixed by issues #621, #623, and #626.
 * Behavioral table update coverage lives in tables-string-ids.test.ts; these checks
 * keep the responsive layout and dark-mode utilities from being accidentally removed.
 *
 * The final sections are different in kind: they render the real CartPanel and
 * TablePickerModal through react-dom/server and assert the rendered `disabled`
 * attribute of their place-order buttons under each tax-preview state
 * (D.10-H.11I F5; D.10-H.11P C3). Those blocks run the component body, so they
 * are rendered guards rather than text guards — but they run no effects and
 * fire no click, so they say nothing about onPlaceOrder, POST /orders, the
 * prepaid branch, or the table picker's own callback.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const tables = source('frontend/src/app/(dashboard)/tables/page.tsx');
assert.match(tables, /tenantCan\(currentTenant, 'tables\.manage'\)/, 'table management controls stay permission-gated');
assert.match(tables, /api\.put\(`\/tables\/\$\{editingTable\.id\}`/, 'table editor persists through PUT');
assert.match(tables, /TABLE_NAME_DUPLICATE: tTables\('tableNameDuplicate'\)/, 'backend table errors map to localized UI messages');
assert.match(tables, /TABLE_LOCATION_INVALID: tTables\('tableLocationInvalid'\)/, 'backend location errors map to localized UI messages');
assert.match(tables, /Number\.isInteger\(capacity\).*capacity < 1/s, 'table capacity is validated before submission');
assert.match(tables, /tTables\('allFloors'\)/, 'floor filter retains its all-floors option');
assert.match(tables, /\[table\.floor, table\.section\]/, 'floor and section remain visible together');

const whatsapp = source('frontend/src/components/settings/WhatsAppEnableCard.tsx');
assert.match(whatsapp, /font-semibold text-foreground/, 'WhatsApp enable heading uses theme foreground');

const settings = source('frontend/src/app/(dashboard)/settings/page.tsx');
assert.match(settings, /dark:bg-yellow-950\/50 dark:border-yellow-800/, 'update warning has a dark-mode surface');
assert.match(settings, /text-yellow-700 dark:text-yellow-300/, 'update warning copy has dark-mode contrast');
assert.match(settings, /text-red-600 dark:text-red-300/, 'update failure copy has dark-mode contrast');

const kds = source('frontend/src/hooks/useKdsConnection.ts');
assert.match(kds, /bg-yellow-50 dark:bg-yellow-950\/60/, 'waiting KDS cards use a dark-mode background');
assert.match(kds, /text-yellow-700 dark:text-yellow-300/, 'waiting KDS labels use dark-mode text');

const customers = source('frontend/src/app/(dashboard)/customers/page.tsx');
assert.match(customers, /text-muted-foreground whitespace-nowrap.*formatDate/, 'ledger dates use semantic text color');
assert.match(customers, /text-end text-foreground whitespace-nowrap.*fmt\(b\.total\)/, 'ledger totals use semantic text color');

const payment = source('frontend/src/components/pos/PaymentModal.tsx');
assert.match(payment, /sm:max-w-4xl/, 'desktop payment modal stays wide');
assert.match(payment, /lg:grid lg:grid-cols-2/, 'desktop payment content stays side by side');
assert.match(payment, /max-h-\[75vh\] overflow-y-auto.*lg:grid lg:grid-cols-2/, 'desktop payment stays two-column with bounded overflow fallback');
assert.doesNotMatch(payment, /lg:overflow-visible/, 'desktop payment does not clip controls outside its bounded container');

const dashboard = source('frontend/src/app/(dashboard)/dashboard/page.tsx');
assert.match(dashboard, /dayInputRef.*monthInputRef/s, 'dashboard retains explicit date and month picker controls');
assert.match(dashboard, /input\.showPicker\(\)/, 'dashboard calendar buttons invoke the native Chromium picker');
assert.match(dashboard, /aria-label=\{t\('openDatePicker'\)\}/, 'dashboard date picker trigger stays accessible');

const prepaidCheckout = source('frontend/src/components/pos/PrepaidCheckoutModal.tsx');
assert.doesNotMatch(prepaidCheckout, /bg-gradient-to-br from-slate-800 to-slate-900/, 'prepaid checkout does not restore the oversized total card');
assert.match(prepaidCheckout, /preview\.discountedSubtotal/, 'prepaid checkout shows the post-discount subtotal');
assert.match(prepaidCheckout, /t\('discounts'\)/, 'prepaid checkout retains the compact cart-level discounts control');
const numberPadIndex = prepaidCheckout.indexOf('<CurrencyTouchNumberPad');
const changeReturnedIndex = prepaidCheckout.indexOf("t('changeReturned')");
assert.ok(
  numberPadIndex >= 0 && changeReturnedIndex > numberPadIndex,
  'change returned stays below the payment controls',
);

// The table picker must be told about the same blocked state the cart uses, or
// it places the order on a preview the screen already refused (C3, D.10-H.11P).
const posPage = source('frontend/src/app/(dashboard)/pos/page.tsx');
assert.match(
  posPage,
  /<TablePickerModal[\s\S]*?placeOrderBlocked=\{taxPreviewBlocksOrder\}/,
  'the table picker receives the same blocked state as the cart',
);

// ── F5 place-order gate, rendered (D.10-H.11I) ──────────────────────────────
// CartPanel.tsx:453 disables the place-order button on
// `submitting || cart.items.length === 0 || placeOrderBlocked`. These four
// checks render the actual component and read the actual attribute, so they
// hold the component's own logic to that contract.
const Module = require('module');
const frontendRequire = Module.createRequire(resolve(process.cwd(), 'frontend/package.json'));

interface PosRenderHarness {
  React: any;
  ReactDOMServer: any;
  IntlProvider: any;
  CartPanel: any;
  TablePickerModal: any;
  useCartStore: any;
  useAuthStore: any;
  messages: any;
}

function loadPosRenderHarness(): PosRenderHarness {
  const originalResolveFilename = Module._resolveFilename;
  // The frontend resolves tsconfig path aliases; mirror them exactly, and only
  // while the module graph below is loading. Same pattern as
  // rtl-dashboard-pos-common.test.ts.
  Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
    let aliased = request;
    if (request.startsWith('@/')) aliased = resolve(process.cwd(), 'frontend/src', request.slice(2));
    else if (request.startsWith('@print/')) aliased = resolve(process.cwd(), 'shared/print', request.slice('@print/'.length));
    else if (request.startsWith('@shared/')) aliased = resolve(process.cwd(), 'shared', request.slice('@shared/'.length));
    else if (request === '@countries') aliased = resolve(process.cwd(), 'main/countries.ts');
    return originalResolveFilename.call(this, aliased, parent, isMain, options);
  };
  try {
    return {
      React: frontendRequire('react'),
      ReactDOMServer: frontendRequire('react-dom/server'),
      IntlProvider: frontendRequire('use-intl').IntlProvider,
      CartPanel: require('../frontend/src/components/pos/CartPanel').default,
      TablePickerModal: require('../frontend/src/components/pos/TablePickerModal').default,
      useCartStore: require('../frontend/src/store/cart').useCartStore,
      useAuthStore: require('../frontend/src/store/auth').useAuthStore,
      messages: require('../frontend/src/lib/i18n/messages/en.json'),
    };
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }
}

const {
  React, ReactDOMServer, IntlProvider, CartPanel, TablePickerModal, useCartStore, useAuthStore, messages,
} = loadPosRenderHarness();

// zustand reads its store through useSyncExternalStore, and a server render uses
// that hook's *server* snapshot — the state captured when the store was created,
// not the state this test seeds. Substituting getSnapshot (the same override
// rtl-dashboard-pos-common.test.ts uses, restored in the finally below) lets the
// seeded cart reach the render. Without it the cart would always render empty and
// the button would be disabled for the wrong reason.
const originalUseSyncExternalStore = React.useSyncExternalStore;
React.useSyncExternalStore = (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot();

const SEEDED_CART_LINE = 'F5 Guard Espresso';
const placeOrderLabel: string = messages.pos.placeOrderButton;

/** The opening tag of the <button> whose content carries `label`. */
function placeOrderButtonTag(markup: string, label: string): string {
  const at = markup.indexOf(label);
  assert.ok(at >= 0, `place-order label ${JSON.stringify(label)} is missing from the rendered markup`);
  const open = markup.lastIndexOf('<button', at);
  assert.ok(open >= 0, `place-order label ${JSON.stringify(label)} does not sit inside a <button>`);
  const close = markup.indexOf('>', open);
  assert.ok(close > open, 'rendered markup contains a malformed <button>');
  return markup.slice(open, close + 1);
}

/**
 * True only for the real `disabled` attribute. The Button's own Tailwind classes
 * contain the word (`disabled:pointer-events-none`), so a substring check would
 * call every button disabled — the lookahead rejects that form.
 */
function hasDisabledAttribute(tag: string): boolean {
  return /(?:^|\s)disabled(?==|\s|\/?>)/.test(tag);
}

const validPreview = {
  subtotal: 5.4,
  discount_amount: 0,
  discounted_subtotal: 5.4,
  tax_amount: 0.54,
  tax_breakdown: [{ title: 'VAT', rate: 10, amount: 0.54 }],
  packaging_charge: 0,
  delivery_charge: 0,
  service_charge: 0,
  round_off: 0,
  total: 5.94,
};

const cartItemsBefore = useCartStore.getState().items;
const tenantBefore = useAuthStore.getState().currentTenant;

try {
  // A non-empty cart with submitting:false, so a disabled button can only come
  // from placeOrderBlocked — an empty cart or an in-flight submit would disable
  // it independently and make every assertion below pass for the wrong reason.
  useCartStore.setState({
    items: [{
      id: 'f5-guard-line',
      product: { id: 9001, name: SEEDED_CART_LINE, price: 5.4 },
      quantity: 1,
      addons: [],
      special_instructions: '',
    }],
    orderType: 'takeaway',
    tableId: null,
    orderNotes: '',
  });
  useAuthStore.setState({
    currentTenant: {
      country: 'US',
      currency: 'USD',
      business_type: 'restaurant',
      currency_display: 'symbol',
      number_digits: 2,
    },
  });

  const renderCartPanel = (props: Record<string, unknown>): string => ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      IntlProvider,
      { locale: 'en', messages },
      React.createElement(CartPanel, {
        tables: [],
        currency: 'USD',
        submitting: false,
        onPlaceOrder: () => undefined,
        onShowTablePicker: () => undefined,
        ...props,
      }),
    ),
  );

  // T5 — the screen reports a preview still loading.
  const loadingMarkup = renderCartPanel({
    placeOrderBlocked: true, taxPreviewLoading: true, taxPreviewError: null, taxPreview: null,
  });
  assert.ok(
    loadingMarkup.includes(SEEDED_CART_LINE),
    'T5 precondition: the seeded cart line must reach the render, otherwise the button is disabled for being empty',
  );
  assert.ok(
    hasDisabledAttribute(placeOrderButtonTag(loadingMarkup, placeOrderLabel)),
    'T5: a place-order button under a loading preview must render disabled',
  );

  // T6 — the screen reports a failed preview. CartPanel receives only the final
  // prop, so this pins the blocked rendering; it does not prove that
  // useTaxPreview produced the error.
  const errorMarkup = renderCartPanel({
    placeOrderBlocked: true, taxPreviewLoading: false, taxPreviewError: 'preview failed', taxPreview: null,
  });
  assert.ok(
    hasDisabledAttribute(placeOrderButtonTag(errorMarkup, placeOrderLabel)),
    'T6: a place-order button under a failed preview must render disabled',
  );

  // T7 — no preview at all, with loading and error both clear.
  const emptyPreviewMarkup = renderCartPanel({
    placeOrderBlocked: true, taxPreviewLoading: false, taxPreviewError: null, taxPreview: null,
  });
  assert.ok(
    hasDisabledAttribute(placeOrderButtonTag(emptyPreviewMarkup, placeOrderLabel)),
    'T7: a place-order button with no preview must render disabled',
  );

  // T8 — the control. Same cart, same everything, only placeOrderBlocked flips,
  // so the difference between this and T5 is the gate and nothing else.
  const unblockedMarkup = renderCartPanel({
    placeOrderBlocked: false, taxPreviewLoading: false, taxPreviewError: null, taxPreview: validPreview,
  });
  assert.ok(
    unblockedMarkup.includes(SEEDED_CART_LINE),
    'T8 precondition: the seeded cart line must reach the render',
  );
  assert.ok(
    !hasDisabledAttribute(placeOrderButtonTag(unblockedMarkup, placeOrderLabel)),
    'T8: a place-order button with a valid preview must not be disabled by the F5 gate',
  );
} finally {
  useCartStore.setState({ items: cartItemsBefore });
  useAuthStore.setState({ currentTenant: tenantBefore });
  React.useSyncExternalStore = originalUseSyncExternalStore;
}

console.log('  ✓ CartPanel renders the place-order button disabled exactly when the tax preview is blocked (F5)');

// ── C3 place-order gate in the table picker, rendered (D.10-H.11P) ──────────
// TablePickerModal's place-order button used to call onPlaceOrder *and* close
// the modal unconditionally, so a preview the screen had already refused still
// dismissed the picker and left only the handler's toast. The button now mirrors
// CartPanel's `placeOrderBlocked`. These two checks render the real component
// and read the real attribute. They run no effects and fire no click, so they
// pin the rendered contract, not onPlaceOrder.
const pickerUseSyncExternalStore = React.useSyncExternalStore;
React.useSyncExternalStore = (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot();
try {
  const renderTablePicker = (props: Record<string, unknown>): string => ReactDOMServer.renderToStaticMarkup(
    React.createElement(
      IntlProvider,
      { locale: 'en', messages },
      React.createElement(TablePickerModal, {
        tables: [],
        selectedTableId: '1',
        onSelectAvailable: () => undefined,
        onSelectOccupied: () => undefined,
        onSelectHeld: () => undefined,
        onPlaceOrder: () => undefined,
        onHoldTable: () => undefined,
        onClose: () => undefined,
        ...props,
      }),
    ),
  );

  // T11 — blocked preview: the picker must render its place-order button disabled.
  const blockedPicker = renderTablePicker({ placeOrderBlocked: true });
  assert.ok(
    hasDisabledAttribute(placeOrderButtonTag(blockedPicker, placeOrderLabel)),
    'T11: the table picker must render its place-order button disabled while the preview is blocked',
  );

  // T12 — the control: same picker, only placeOrderBlocked flips.
  const unblockedPicker = renderTablePicker({ placeOrderBlocked: false });
  assert.ok(
    !hasDisabledAttribute(placeOrderButtonTag(unblockedPicker, placeOrderLabel)),
    'T12: the table picker must not disable its place-order button when the preview is usable',
  );
} finally {
  React.useSyncExternalStore = pickerUseSyncExternalStore;
}

console.log('  ✓ TablePickerModal renders the place-order button disabled exactly when the tax preview is blocked (C3)');

console.log('✓ UI regression guards for issues #621, #623, #625, and #626 passed');
