/**
 * Toman display + Persian invoice formatting (presentation only).
 *
 * Contract: stored amounts stay canonical Rial (IRR) and nothing here writes to
 * the database, journals, balances, receivables or COGS. Only the rendered
 * presentation converts Rial → Toman (÷10) and declares the unit once in the
 * amount column header and in each summary row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderClassicReceiptViaDocument } from '../main/printers/document-classic';
import { renderCompactReceiptViaDocument } from '../main/printers/document-compact';
import { capabilitiesForPrinter, resolvePrinterProfile } from '../main/printers/profiles';
import { formatMoney, getCurrencyUnitAdapter, resolveCurrencyDisplayUnit, resolveStoredCurrencyDisplay } from '../main/countries';
import type { PrintDocument } from '../shared/print';

const CLASSIC_CAPS = capabilitiesForPrinter(resolvePrinterProfile({ profile_id: 'xprinter-xp-v320m-v330m' }), '80mm');
const TOKENS = /\{[^}]*\}/g;

/** 1,400,000 Rial = 140,000 Toman (kebab 100,000 T / doogh 2 × 20,000 T). */
function iranFixture(currencyDisplay = 'toman') {
  const order: any = {
    order_number: 'ORD-TOMAN-001',
    created_at: '2026-08-21 18:42:00',
    table: { name: '4' },
    items: [
      { product_name: 'Kabab Koobideh', quantity: 1, unit_price: 1000000, total: 1000000, addons: [], special_instructions: '' },
      { product_name: 'Doogh', quantity: 2, unit_price: 200000, total: 400000, addons: [], special_instructions: '' },
    ],
  };
  const bill: any = {
    bill_number: 'INV-TOMAN-001',
    subtotal: 1400000,
    discount_amount: 0,
    tax_amount: 0,
    total: 1400000,
    payment_details: [{ method: 'cash', amount: 1400000 }],
  };
  const business: any = {
    name: 'Flo Persian Cafe',
    address: 'Tehran',
    phone: '',
    taxRegistrationNumber: '',
    country: 'IR',
    currency: 'IRR',
    currency_display: currencyDisplay,
    trim_decimals: true,
    show_tax_id: false,
    show_tax_breakdown: false,
    show_name: true,
    show_address: false,
    show_phone: false,
    show_table_number: false,
    show_customer_name: false,
    show_customer_phone: false,
    points_earned: 0,
    points_redeemed: 0,
    points_balance: null,
  };
  return { order, bill, business };
}

function classicIran(currencyDisplay = 'toman', columns = 48) {
  const { order, bill, business } = iranFixture(currencyDisplay);
  const result = renderClassicReceiptViaDocument(order, bill, business, {
    columns,
    language: 'fa',
    isReprint: false,
    useUnicode: true,
    arabicShaping: true,
    cutMode: 'full',
    capabilities: CLASSIC_CAPS,
  });
  return { ...result, lines: result.lines.map((line) => line.replace(TOKENS, '')) };
}

function itemTable(document: PrintDocument) {
  const block = document.blocks.find((candidate) => candidate.kind === 'item-table');
  assert.ok(block && block.kind === 'item-table', 'expected an item table block');
  return block;
}

/** The rendered amount columns for the two fixture items. */
function itemLines(lines: readonly string[]): string[] {
  return lines.filter((line) => /^(Kabab Koobideh|Doogh)\b/.test(line));
}

test('suffix display unit resolves for Iran Toman and never for other currencies', () => {
  assert.equal(resolveStoredCurrencyDisplay('toman', 'IR'), 'toman');
  assert.equal(resolveStoredCurrencyDisplay('toman_short', 'IR'), 'toman_short');
  // Unset or unsupported falls back to the country default, which is toman.
  assert.equal(resolveStoredCurrencyDisplay('bogus', 'IR'), 'toman');
  assert.equal(resolveStoredCurrencyDisplay(undefined, 'IR'), 'toman');

  assert.equal(resolveCurrencyDisplayUnit('IRR', 'rial'), null);
  assert.deepEqual(resolveCurrencyDisplayUnit('IRR', 'toman'), { label: 'تومان', scale: 0.1 });
  assert.deepEqual(resolveCurrencyDisplayUnit('IRR', 'toman_short'), { label: 'ت', scale: 0.1 });
  assert.equal(resolveCurrencyDisplayUnit('USD', 'toman'), null);
  assert.equal(resolveCurrencyDisplayUnit('AED', 'toman_short'), null);
});

test('Rial → Toman conversion is display-only and preserves fractional values', () => {
  const adapter = getCurrencyUnitAdapter('IRR', 'IR', { currencyDisplay: 'toman' });
  assert.equal(adapter.toDisplay(10), 1);
  assert.equal(adapter.toDisplay(100), 10);
  assert.equal(adapter.toDisplay(1000), 100);
  assert.equal(adapter.toDisplay(10000), 1000);
  assert.equal(adapter.toDisplay(100000), 10000);
  assert.equal(adapter.toDisplay(1250000), 125000);
  assert.equal(adapter.toDisplay(1528000), 152800);
  // A Rial amount not divisible by 10 keeps its fraction instead of truncating to 0.
  assert.equal(adapter.toDisplay(1), 0.1);
  assert.equal(adapter.toDisplay(15), 1.5);
});

test('Toman display renders the unit as a suffix, never as a prefix', () => {
  const out = formatMoney(1200000, 'IRR', 'fa-IR', { currencyDisplay: 'toman' });
  assert.ok(out.endsWith(' تومان'), `expected a suffix unit, got: ${out}`);
  assert.ok(!/^تومان/.test(out), `expected no prefix unit, got: ${out}`);
});

test('Persian invoice header declares the unit once: مبلغ (تومان)', () => {
  const { document } = classicIran('toman');
  const header = itemTable(document).header;
  assert.equal(header.amount.primary, 'مبلغ (تومان)');
  assert.equal(header.amount.conceptId, 'receipt.amount');
  assert.equal(header.item.primary, 'اقلام');
  assert.equal(header.quantity.primary, 'تعداد');
});

test('Persian invoice item rows are numeric-only and never repeat the unit', () => {
  const { lines } = classicIran('toman');
  const rows = itemLines(lines);
  assert.equal(rows.length, 2, `expected two item rows, got: ${JSON.stringify(rows)}`);
  assert.match(rows[0]!, /^Kabab Koobideh\s+1\s+100,000$/);
  assert.match(rows[1]!, /^Doogh\s+2\s+40,000$/);
  for (const row of rows) {
    assert.ok(!row.includes('تومان'), `unit repeated in an item row: ${row}`);
    assert.ok(!row.includes('IRR'), `symbol repeated in an item row: ${row}`);
  }
});

test('Persian invoice total renders جمع کل with the amount then the unit', () => {
  const { lines } = classicIran('toman');
  const total = lines.find((line) => line.includes('جمع کل'));
  assert.ok(total, `expected a total row, got: ${JSON.stringify(lines)}`);
  assert.match(total!, /جمع کل\s+140,000 تومان$/);
});

test('the unit never precedes the amount in any rendered line', () => {
  for (const display of ['toman', 'toman_short'] as const) {
    const { lines } = classicIran(display);
    for (const line of lines) {
      assert.ok(!/تومان\s*[\d۰-۹]/.test(line), `prefix form rendered: ${line}`);
    }
  }
});

test('58mm keeps the header, the quantity label and the amounts intact', () => {
  const { lines, document } = classicIran('toman', 32);
  const headerLine = lines.find((line) => line.includes('مبلغ'));
  assert.ok(headerLine, 'expected the amount column header at 58mm');
  assert.ok(headerLine!.includes('مبلغ (تومان)'), `amount header truncated at 58mm: ${headerLine}`);
  assert.ok(headerLine!.includes('تعداد'), `quantity header clipped at 58mm: ${headerLine}`);
  assert.ok(headerLine!.includes('اقلام'), `item header clipped at 58mm: ${headerLine}`);
  assert.equal(itemTable(document).header.quantity.primary.length, 5);
  const amounts = lines.filter((line) => /\d{1,3}(,\d{3})+/.test(line));
  assert.ok(amounts.some((line) => line.includes('100,000')), 'expected the first item amount at 58mm');
  assert.ok(amounts.some((line) => line.includes('40,000')), 'expected the second item amount at 58mm');
  const total = lines.find((line) => line.includes('جمع کل'));
  assert.match(total!, /140,000 تومان$/);
});

test('raster layout carries the same unit-once contract', () => {
  const { rasterGroups } = classicIran('toman');
  const rowGroup = rasterGroups.find((group) => group.groupId === 'item-table-row-0');
  assert.ok(rowGroup?.sourceLayouts?.[0], 'expected a raster layout for the first item row');
  const rowColumns = rowGroup!.sourceLayouts![0]!.columns;
  assert.equal(rowColumns[2]!.text, '100,000');
  assert.equal(rowGroup!.sourceLines?.[0], 'Kabab Koobideh 1 100,000');

  const totalsGroup = rasterGroups.find((group) => group.groupId === 'totals');
  assert.ok(totalsGroup, 'expected a raster group for the totals block');
  const totalsLayouts = totalsGroup!.sourceLayouts ?? [];
  const grandTotal = totalsLayouts
    .map((layout) => layout?.columns?.[1]?.text ?? '')
    .find((text) => text.includes('140,000'));
  assert.equal(grandTotal, '140,000 تومان');
});

test('the compact template follows the same Persian contract', () => {
  const { order, bill, business } = iranFixture('toman');
  const result = renderCompactReceiptViaDocument(order, bill, business, {
    columns: 48,
    language: 'fa',
    isReprint: false,
    useUnicode: true,
    arabicShaping: true,
    cutMode: 'full',
    capabilities: CLASSIC_CAPS,
  });
  const lines = result.lines.map((line) => line.replace(TOKENS, ''));
  assert.ok(lines.some((line) => line.includes('مبلغ (تومان)')), 'expected the header in compact');
  assert.match(lines.find((line) => line.includes('Kabab Koobideh'))!, /^Kabab Koobideh\s+1\s+100,000$/);
  assert.match(lines.find((line) => line.includes('جمع کل'))!, /جمع کل\s+140,000 تومان$/);
});

test('Rial display keeps today’s symbol-prefix layout (regression)', () => {
  const { document, lines } = classicIran('rial');
  assert.equal(itemTable(document).header.amount.primary, 'مبلغ');
  const rows = itemLines(lines);
  assert.match(rows[0]!, /^Kabab Koobideh\s+1\s+IRR1,000,000$/);
  assert.match(rows[1]!, /^Doogh\s+2\s+IRR400,000$/);
  assert.match(lines.find((line) => line.includes('جمع کل'))!, /IRR1,400,000$/);
  for (const line of lines) assert.ok(!line.includes('تومان'), `unexpected Toman token in Rial mode: ${line}`);
});

test('a non-Iran tenant keeps its existing currency rendering (regression)', () => {
  const order: any = {
    order_number: 'ORD-USD-001',
    created_at: '2026-08-21 18:42:00',
    table: { name: '' },
    items: [{ product_name: 'Espresso', quantity: 1, unit_price: 4.5, total: 4.5, addons: [], special_instructions: '' }],
  };
  const bill: any = {
    bill_number: 'INV-USD-001',
    subtotal: 4.5,
    discount_amount: 0,
    tax_amount: 0,
    total: 4.5,
    payment_details: [{ method: 'cash', amount: 4.5 }],
  };
  const business: any = {
    name: 'Flo Cafe',
    address: '',
    phone: '',
    taxRegistrationNumber: '',
    country: 'US',
    currency: 'USD',
    trim_decimals: false,
    show_tax_id: false,
    show_tax_breakdown: false,
    show_name: true,
    show_address: false,
    show_phone: false,
    show_table_number: false,
    show_customer_name: false,
    show_customer_phone: false,
    points_earned: 0,
    points_redeemed: 0,
    points_balance: null,
  };
  const result = renderClassicReceiptViaDocument(order, bill, business, {
    columns: 48,
    language: 'en',
    isReprint: false,
    useUnicode: true,
    arabicShaping: false,
    cutMode: 'full',
    capabilities: CLASSIC_CAPS,
  });
  const lines = result.lines.map((line) => line.replace(TOKENS, ''));
  assert.match(lines.find((line) => line.includes('Espresso'))!, /^Espresso\s+1\s+\$4\.50$/);
  assert.match(lines.find((line) => line.includes('TOTAL'))!, /\$4\.50$/);
});

/** LTR control: same machine and fixture, English labels → base direction stays ltr. */
function classicEnglish() {
  const { order, bill, business } = iranFixture('rial');
  return renderClassicReceiptViaDocument(order, bill, business, {
    columns: 48,
    language: 'en',
    isReprint: false,
    useUnicode: true,
    arabicShaping: false,
    cutMode: 'full',
    capabilities: CLASSIC_CAPS,
  });
}

test('RTL receipts mirror the item table and lay the header out in columns', () => {
  const { rasterGroups } = classicIran('toman');
  const headerGroup = rasterGroups.find((group) => group.groupId === 'item-table-header');
  assert.ok(headerGroup, 'expected an RTL raster group for the item table header');
  assert.equal(headerGroup!.sourceLayouts?.[0]?.direction, 'rtl');
  assert.deepEqual(
    headerGroup!.sourceLayouts?.[0]?.columns.map((column) => column.text),
    ['اقلام', 'تعداد', 'مبلغ (تومان)'],
  );

  const rowLayout = rasterGroups.find((group) => group.groupId === 'item-table-row-0')?.sourceLayouts?.[0];
  assert.equal(rowLayout?.direction, 'rtl');

  const totalsLayouts = rasterGroups.find((group) => group.groupId === 'totals')?.sourceLayouts ?? [];
  assert.ok(totalsLayouts.length > 0, 'expected totals layouts');
  assert.ok(totalsLayouts.every((layout) => layout?.direction === 'rtl'), 'totals must mirror with the rows');
});

test('LTR receipts keep the left-to-right column order', () => {
  const { rasterGroups } = classicEnglish();
  assert.equal(rasterGroups.find((group) => group.groupId === 'item-table-header'), undefined, 'LTR adds no mirrored header group');
  const layouts = rasterGroups.flatMap((group) => group.sourceLayouts ?? []);
  assert.ok(layouts.length > 0, 'expected raster layouts in the LTR receipt');
  for (const layout of layouts) assert.equal(layout?.direction, undefined);
});

test('rendering a Persian Toman invoice never mutates the source amounts', () => {
  const { order, bill, business } = iranFixture('toman');
  const before = JSON.stringify({ order, bill });
  classicIran('toman');
  classicIran('toman', 32);
  classicIran('rial');
  renderCompactReceiptViaDocument(order, bill, business, {
    columns: 48,
    language: 'fa',
    isReprint: false,
    useUnicode: true,
    arabicShaping: true,
    cutMode: 'full',
    capabilities: CLASSIC_CAPS,
  });
  assert.equal(JSON.stringify({ order, bill }), before);
  assert.equal(bill.total, 1400000);
  assert.deepEqual(order.items.map((item: any) => item.total), [1000000, 400000]);
});
