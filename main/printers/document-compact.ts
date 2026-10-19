/** PrintDocument v1 compact thermal receipt renderer; maps print blocks to ESC/POS token lines. */

import { parseDbTimestamp } from '../db';
import { getCurrencyFractionDigits } from '../countries';
import type { PrinterCutMode } from './profiles';
import { isThermalTextRepresentable, type ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { RasterSemanticLineGroup, RasterTextLayout } from '../../shared/print/raster';
import {
  addonRows,
  appendPoweredByFooter,
  buildEscPos,
  financialRows,
  formatCurrency,
  itemAmountWidth,
  itemRows,
  itemNameWidth,
  normalizeThermalText,
  maskPhoneOnReceipt,
  pushCenteredWrapped,
  pushWrapped,
  resolveCurrencyPrefix,
  truncate,
  truncateShapedLine,
  type PrintWarning,
} from './formatting-helpers';
import { buildBillPrintContext, buildBillPrintData, detectPrintLanguageDirection } from './document-classic';
import {
  buildBillDocument,
  getBlock,
  type BusinessHeaderBlock,
  type CustomerBlock,
  type DocumentMetaBlock,
  type ItemTableBlock,
  type MessageBlock,
  type PaymentsBlock,
  type PrintDocument,
  type SemanticLabel,
  type TaxBreakdownBlock,
  type TotalsBlock,
  layoutStyledUnit,
  paymentDisplayRows,
  type SuffixAmountUnit,
  type ThermalLayoutContext,
} from '../../shared/print';

// Document to compact ESC/POS token lines.

/** Renderer options: physical/locale presentation only, no business data. */
export interface CompactDocumentRenderOptions {
  readonly columns: number;
  readonly language: string;
  readonly locale: string;
  readonly timezone?: string;
  /** Currency prefix preference (symbol + unicode mode). */
  readonly currency: string;
  readonly currencySymbol: string;
  /** Suffix amount unit (e.g. `تومان`) when the tenant displays a unit word instead of a symbol. */
  readonly currencyUnit?: SuffixAmountUnit | null;
  readonly trimDecimals: boolean;
  readonly useUnicode: boolean;
  readonly arabicShaping: boolean;
  readonly preserveCurrencySymbol?: boolean;
  readonly cutMode: PrinterCutMode;
  readonly capabilities?: ThermalPrinterCapabilities;
  readonly maskCustomerPhone?: boolean;
  readonly rasterGroups?: RasterSemanticLineGroup[];
  readonly financialLineRanges?: Array<{ lineIndex: number; lineCount: number }>;
}

function labelOf(label: SemanticLabel): string {
  return label.primary;
}

/** Literal payment methods keep the legacy capitalize fallback. */
function paymentLabel(label: SemanticLabel): string {
  return label.conceptId !== undefined ? label.primary : capitalize(label.primary);
}

function capitalize(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function compactBannerLines(label: SemanticLabel, context: ThermalLayoutContext): string[] {
  const layout = layoutStyledUnit({
    label: {
      primary: `** ${label.primary} **`,
      ...(label.secondary ? { secondary: `** ${label.secondary} **` } : {}),
    },
    widthMultiplier: 2,
    field: 'reprint banner',
  }, context);
  const widthToken = layout.widthMultiplier === 2 ? '{DOUBLE_WIDTH}' : '';
  const closeWidthToken = layout.widthMultiplier === 2 ? '{/DOUBLE_WIDTH}' : '';
  return layout.lines.map((line) => `{CENTER}{BOLD}{DOUBLE_HEIGHT}${widthToken}${normalizeThermalText(line, context.capabilities)}${closeWidthToken}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}`);
}

/** Column header row, composed from the document's own header labels. */
function compactItemHeader(block: ItemTableBlock, nameLen: number, amtLen: number, qtyW: number, language: string, capabilities?: ThermalPrinterCapabilities): string {
  const itemLabel = normalizeThermalText(labelOf(block.header.item), capabilities);
  const qtyLabel = normalizeThermalText(labelOf(block.header.quantity), capabilities);
  const amountLabel = normalizeThermalText(labelOf(block.header.amount), capabilities);
  const fit = (value: string, length: number): string => capabilities?.raster.enabled === true && !isThermalTextRepresentable(value, capabilities)
    ? value
    : value.slice(0, length);
  const item = fit(itemLabel, nameLen).padEnd(nameLen);
  const qty = fit(qtyLabel, qtyW).padEnd(qtyW);
  const amount = fit(amountLabel, Math.max(1, amtLen - 1));
  return item + qty + ' '.repeat(Math.max(0, amtLen - amount.length)) + amount;
}

/** Map a PrintDocument onto compact token-line layout. */
export function renderBillDocumentToCompactLines(
  document: PrintDocument,
  options: CompactDocumentRenderOptions,
): string[] {
  const cols = options.columns;
  const lines: string[] = [];

  const header = getBlock(document, 'business-header') as BusinessHeaderBlock | undefined;
  const meta = getBlock(document, 'document-meta') as DocumentMetaBlock | undefined;
  const customer = getBlock(document, 'customer') as CustomerBlock | undefined;
  const items = getBlock(document, 'item-table') as ItemTableBlock | undefined;
  const breakdown = getBlock(document, 'tax-breakdown') as TaxBreakdownBlock | undefined;
  const totals = getBlock(document, 'totals') as TotalsBlock | undefined;
  const payments = getBlock(document, 'payments') as PaymentsBlock | undefined;
  const messages = getBlock(document, 'message') as MessageBlock | undefined;

  const prefix = resolveCurrencyPrefix(options.currencySymbol, options.useUnicode, options.capabilities, options.preserveCurrencySymbol === true, options.currency);
  const fractionDigits = getCurrencyFractionDigits(options.currency);
  const trimDecimals = options.trimDecimals === true;
  const tzOptions = options.timezone ? { timeZone: options.timezone } : undefined;
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  const normalize = (text: string): string => normalizeThermalText(text, options.capabilities);
  // Suffix-unit display (e.g. Toman) declares the unit once — in the amount
  // column header and in each summary row — so item rows stay numeric-only.
  const unit = options.currencyUnit ?? null;
  // RTL documents mirror the item-table columns; LTR output stays byte-identical.
  const rtlLayout = detectPrintLanguageDirection(options.language) === 'rtl';
  const orientedLayouts = (layouts: readonly (RasterTextLayout | undefined)[]): readonly (RasterTextLayout | undefined)[] => rtlLayout
    ? layouts.map((layout) => (layout ? { ...layout, direction: 'rtl' as const } : undefined))
    : layouts;
  const amountPrefix = unit ? '' : prefix;
  // Stored amounts are canonical; the suffix unit scales them for display only.
  const displayAmount = (value: number): number => (unit && unit.scale !== 1 ? value * unit.scale : value);
  const summaryAmount = (value: number): string =>
    formatCurrency(displayAmount(value), amountPrefix, options.locale, trimDecimals, fractionDigits, unit?.label ?? null);
  const markGroup = (groupId: string, start: number, sourceLines?: readonly string[], sourceControlLines?: readonly string[], financial = false, sourceLayouts?: readonly (RasterTextLayout | undefined)[]): void => {
    if (options.rasterGroups && lines.length > start) options.rasterGroups.push({ groupId, lineIndex: start, lineCount: lines.length - start, ...(sourceLines ? { sourceLines } : {}), ...(sourceControlLines ? { sourceControlLines } : {}), ...(sourceLayouts ? { sourceLayouts: orientedLayouts(sourceLayouts) } : {}), ...(financial ? { financial: true } : {}) });
  };
  const recordFinancialLines = (start: number, rendered: readonly string[], financial = true): void => {
    if (!financial) return;
    if (!options.financialLineRanges) return;
    rendered.forEach((line, offset) => {
      options.financialLineRanges!.push({ lineIndex: start + offset, lineCount: 1 });
    });
  };

  lines.push('{INIT}');

  // Reprint banner (MessageBlock).
  const messageStart = lines.length;
  const messageSourceLines: string[] = [];
  const messageSourceControlLines: string[] = [];
  if (messages?.reprintBanner) {
    const bannerLines = compactBannerLines(messages.reprintBanner, {
      logicalColumns: cols,
      direction: document.direction.base,
      languages: document.languages,
      capabilities: options.capabilities,
    });
    lines.push(...bannerLines);
    messageSourceLines.push(...bannerLines.map((line) => line.replace(/\{[^}]+\}/g, '')));
    messageSourceControlLines.push(...bannerLines);
  }

  // Online-order banner (#284, MessageBlock).
  if (messages?.onlineOrderBanner) {
    const banner = messages.onlineOrderBanner;
    const bannerLines = compactBannerLines(banner.label, {
      logicalColumns: cols,
      direction: document.direction.base,
      languages: document.languages,
      capabilities: options.capabilities,
    });
    lines.push(...bannerLines);
    messageSourceLines.push(...bannerLines.map((line) => line.replace(/\{[^}]+\}/g, '')));
    messageSourceControlLines.push(...bannerLines);
    if (banner.platform.text) {
      lines.push('{CENTER}' + normalize(banner.platform.text) + '{/CENTER}');
      messageSourceLines.push(banner.platform.text);
      messageSourceControlLines.push(lines.at(-1) ?? '');
    }
    if (banner.externalOrderId.text) {
      lines.push('{CENTER}#' + normalize(banner.externalOrderId.text) + '{/CENTER}');
      messageSourceLines.push('#' + banner.externalOrderId.text);
      messageSourceControlLines.push(lines.at(-1) ?? '');
    }
  }
  markGroup('message', messageStart, messageSourceLines, messageSourceControlLines);

  // Business header (store name only — compact keeps contact facts in the footer).
  const headerStart = lines.length;
  if (header?.name) lines.push('{STORE_NAME}{CENTER}{BOLD}' + truncateShapedLine(header.name.text, cols, options.arabicShaping, options.language, options.capabilities) + '{/BOLD}{/CENTER}');
  markGroup('business-header', headerStart, header?.name ? [header.name.text] : [], header?.name ? [lines[headerStart] ?? ''] : []);
  lines.push(bar);

  // Document meta.
  const metaStart = lines.length;
  const metaSourceLines: string[] = [];
  if (meta) {
    lines.push(normalize(labelOf(meta.billNumberLabel) + ': ' + meta.invoiceNumber.text));
    metaSourceLines.push(labelOf(meta.billNumberLabel) + ': ' + meta.invoiceNumber.text);
    const date = parseDbTimestamp(meta.timestamp.text);
    const dateText = date.toLocaleDateString(options.locale + '-u-nu-latn', tzOptions) + ' ' + date.toLocaleTimeString(options.locale + '-u-nu-latn', tzOptions);
    lines.push(normalize(labelOf(meta.dateLabel) + ': ' + dateText));
    metaSourceLines.push(labelOf(meta.dateLabel) + ': ' + dateText);
    if (meta.table) {
      lines.push(truncateShapedLine(meta.table.label.primary.replace('{name}', meta.table.name.text), cols, options.arabicShaping, options.language, options.capabilities));
      metaSourceLines.push(meta.table.label.primary.replace('{name}', meta.table.name.text));
    }
  }
  markGroup('document-meta', metaStart, metaSourceLines);
  const customerStart = lines.length;
  const customerSourceLines: string[] = [];
  const customerSourceControlLines: string[] = [];
  if (customer?.heading) {
    lines.push(normalize(labelOf(customer.heading)));
    customerSourceLines.push(labelOf(customer.heading));
    customerSourceControlLines.push(lines.at(-1) ?? '');
  }
  if (customer?.name) {
    lines.push(truncateShapedLine(labelOf(customer.nameLabel) + ': ' + customer.name.text, cols, options.arabicShaping, options.language, options.capabilities));
    customerSourceLines.push(labelOf(customer.nameLabel) + ': ' + customer.name.text);
    customerSourceControlLines.push(lines.at(-1) ?? '');
  }
  if (customer?.phone) {
    const phone = options.maskCustomerPhone ? maskPhoneOnReceipt(customer.phone.text) : customer.phone.text;
    lines.push(normalize(labelOf(customer.phoneLabel) + ': ' + phone));
    customerSourceLines.push(labelOf(customer.phoneLabel) + ': ' + phone);
    customerSourceControlLines.push(lines.at(-1) ?? '');
  }
  if (customer?.address) {
    // Wrapped, not truncated: the compact layout still has to carry a full address.
    const labeled = labelOf(customer.addressLabel) + ': ' + customer.address.text;
    const addressStart = lines.length;
    pushWrapped(lines, labeled, cols, options.language, options.capabilities);
    customerSourceLines.push(labeled);
    customerSourceControlLines.push(lines[addressStart] ?? '');
  }
  if (options.rasterGroups && lines.length > customerStart) options.rasterGroups.push({ groupId: 'customer', lineIndex: customerStart, lineCount: lines.length - customerStart, sourceLines: customerSourceLines, sourceControlLines: customerSourceControlLines });
  lines.push(dash);

  // Item table.
  if (items) {
    // A suffix unit widens the quantity header to its whole label so the
    // column reads as `تعداد` instead of a clipped stem.
    const qtyWidth = unit ? Math.max(4, labelOf(items.header.quantity).length) : 4;
    const amtLen = Math.max(
      itemAmountWidth(
        { items: items.rows.map((row) => ({ total: displayAmount(row.amount), addons: row.addons.map((addon) => ({ price: displayAmount(addon.price) })) })) },
        amountPrefix,
        options.locale,
        trimDecimals,
        cols,
        fractionDigits,
        qtyWidth,
      ),
      // The unit-bearing header must fit the amount column, otherwise it is
      // truncated mid-word and the rows lose their declared unit.
      unit ? Math.min(labelOf(items.header.amount).length + 1, Math.max(1, cols - qtyWidth - 1)) : 0,
    );
    const nameLen = itemNameWidth(cols, amtLen, qtyWidth);
    const headerStart = lines.length;
    lines.push(compactItemHeader(items, nameLen, amtLen, qtyWidth, options.language, options.capabilities));
    lines.push(dash);
    // The padded header text cannot survive bidi reordering, so RTL receipts
    // lay it out with the same columns as the rows it labels.
    if (options.rasterGroups && rtlLayout) {
      const headerSourceLine = [labelOf(items.header.item), labelOf(items.header.quantity), labelOf(items.header.amount)].join(' ');
      options.rasterGroups.push({
        groupId: 'item-table-header',
        lineIndex: headerStart,
        lineCount: 1,
        sourceLines: [headerSourceLine],
        sourceControlLines: [lines[headerStart] ?? ''],
        sourceLayouts: orientedLayouts([{
          kind: 'financial-item',
          columns: [
            { text: labelOf(items.header.item), align: 'left', widthRatio: nameLen / cols },
            { text: labelOf(items.header.quantity), align: 'left', widthRatio: 4 / cols },
            { text: labelOf(items.header.amount), align: 'right', widthRatio: amtLen / cols },
          ],
        }]),
      });
    }

    for (const [rowIndex, row] of items.rows.entries()) {
      const rowStart = lines.length;
      const rowLines = itemRows(
        { product_name: row.name.text, quantity: row.quantity, total: displayAmount(row.amount) },
        nameLen,
        amtLen,
        cols,
        amountPrefix,
        options.locale,
        trimDecimals,
        options.language,
        fractionDigits,
        options.capabilities,
        qtyWidth,
      );
      lines.push(...rowLines);
      recordFinancialLines(rowStart, rowLines);
      const amount = formatCurrency(displayAmount(row.amount), amountPrefix, options.locale, trimDecimals, fractionDigits);
      const sourceLines = [`${row.name.text} ${row.quantity} ${amount}`];
      const sourceControlLines = [rowLines[0] ?? ''];
      const sourceLayouts: Array<RasterTextLayout | undefined> = [{
        kind: 'financial-item',
        columns: [
          { text: row.name.text, align: 'left', widthRatio: nameLen / cols },
          { text: String(row.quantity), align: 'left', widthRatio: 4 / cols },
          { text: amount.trimStart(), align: 'right', widthRatio: amtLen / cols },
        ],
      }];
      const financialSourceLines = [true];
      for (const addon of row.addons) {
        const addonLines = addonRows({ name: addon.name.text, price: displayAmount(addon.price), quantity: addon.quantity }, nameLen, amtLen, cols, amountPrefix, options.locale, trimDecimals, options.language, fractionDigits, options.capabilities);
        const addonStart = lines.length;
        lines.push(...addonLines);
        if (addon.price) recordFinancialLines(addonStart, addonLines);
        const quantitySuffix = (addon.quantity ?? 1) > 1 ? ` x${addon.quantity}` : '';
        const addonLabel = `  + ${addon.name.text}${quantitySuffix}`;
        const addonAmount = addon.price ? formatCurrency(displayAmount(addon.price), amountPrefix, options.locale, trimDecimals, fractionDigits) : '';
        sourceLines.push(`${addonLabel}${addon.price ? ` ${addonAmount}` : ''}`);
        sourceControlLines.push(addonLines[0] ?? '');
        sourceLayouts.push(addon.price ? {
          kind: 'financial-summary',
          columns: [
            { text: addonLabel, align: 'left', widthRatio: nameLen / cols },
            { text: addonAmount.trimStart(), align: 'right', widthRatio: (cols - nameLen) / cols },
          ],
        } : undefined);
        financialSourceLines.push(Boolean(addon.price));
      }
      if (row.specialInstructions) {
        const instructionLine = normalize('  ' + labelOf(items.noteLabel) + ': ' + truncate(row.specialInstructions.text, cols - 8, options.language, options.capabilities));
        lines.push(instructionLine);
        sourceLines.push('  ' + labelOf(items.noteLabel) + ': ' + row.specialInstructions.text);
        sourceControlLines.push(instructionLine);
        sourceLayouts.push(undefined);
        financialSourceLines.push(false);
      }
      if (options.rasterGroups && lines.length > rowStart) {
        const group = { groupId: `item-table-row-${rowIndex}`, lineIndex: rowStart, lineCount: lines.length - rowStart };
        options.rasterGroups.push({ ...group, sourceLines, sourceControlLines, sourceLayouts: orientedLayouts(sourceLayouts), financialSourceLines, financial: true });
      }
    }
  }

  lines.push(dash);

  // Totals (compact has no loyalty points section).
  const totalsStart = lines.length;
  const totalsSourceLines: string[] = [];
  const totalsSourceControlLines: string[] = [];
  const totalsSourceLayouts: Array<RasterTextLayout | undefined> = [];
  const pushTotalRow = (rendered: string[], bold = false, sourceLabel?: string, sourceValue?: string): void => {
    const start = lines.length;
    const tokenLines = bold ? rendered.map((line) => `{BOLD}${line}{/BOLD}`) : rendered;
    lines.push(...tokenLines);
    recordFinancialLines(start, tokenLines);
    totalsSourceLines.push(sourceLabel !== undefined && sourceValue !== undefined ? `${sourceLabel} ${sourceValue.trimStart()}` : rendered.join(' '));
    totalsSourceControlLines.push(tokenLines[0] ?? '');
    totalsSourceLayouts.push(sourceLabel !== undefined && sourceValue !== undefined ? {
      kind: 'financial-summary',
      columns: [
        { text: sourceLabel, align: 'left', widthRatio: Math.max(0.1, (cols - 12) / cols) },
        { text: sourceValue.trimStart(), align: 'right', widthRatio: Math.min(0.9, 12 / cols) },
      ],
    } : undefined);
  };
  if (totals) {
    const subtotalValue = summaryAmount(totals.subtotal.amount);
    pushTotalRow(financialRows(labelOf(totals.subtotal.label), subtotalValue, cols, options.language, options.capabilities), false, labelOf(totals.subtotal.label), subtotalValue);
    if (totals.discount) {
      const discountValue = '-' + summaryAmount(totals.discount.amount);
      pushTotalRow(financialRows(labelOf(totals.discount.label), discountValue, cols, options.language, options.capabilities), false, labelOf(totals.discount.label), discountValue);
    }
    if (breakdown && breakdown.lines.length > 0) {
      for (const line of breakdown.lines) {
        const rateSuffix = line.rate === null ? '' : ` @${line.rate}%`;
        const rawLabel = labelOf(line.label) + rateSuffix;
        const label = truncate(rawLabel, cols - 12, options.language, options.capabilities);
        const value = summaryAmount(line.amount);
        pushTotalRow(financialRows(label, value, cols, options.language, options.capabilities), false, rawLabel, value);
      }
    } else if (totals.tax) {
      const value = summaryAmount(totals.tax.amount);
      pushTotalRow(financialRows(labelOf(totals.tax.label), value, cols, options.language, options.capabilities), false, labelOf(totals.tax.label), value);
    }
    if (totals.serviceCharge) {
      const value = summaryAmount(totals.serviceCharge.amount);
      pushTotalRow(financialRows(labelOf(totals.serviceCharge.label), value, cols, options.language, options.capabilities), false, labelOf(totals.serviceCharge.label), value);
    }
    if (totals.deliveryCharge) {
      const value = summaryAmount(totals.deliveryCharge.amount);
      pushTotalRow(financialRows(labelOf(totals.deliveryCharge.label), value, cols, options.language, options.capabilities), false, labelOf(totals.deliveryCharge.label), value);
    }
    if (totals.packagingCharge) {
      const value = summaryAmount(totals.packagingCharge.amount);
      pushTotalRow(financialRows(labelOf(totals.packagingCharge.label), value, cols, options.language, options.capabilities), false, labelOf(totals.packagingCharge.label), value);
    }
    const grandTotalValue = summaryAmount(totals.grandTotal.amount);
    pushTotalRow(financialRows(labelOf(totals.grandTotal.label), grandTotalValue, cols, options.language, options.capabilities), true, labelOf(totals.grandTotal.label), grandTotalValue);
  }
  markGroup('totals', totalsStart, totalsSourceLines, totalsSourceControlLines, true, totalsSourceLayouts);

  // Payments.
  const paymentsStart = lines.length;
  const paymentSourceLines: string[] = [];
  const paymentSourceControlLines: string[] = [];
  const paymentSourceLayouts: Array<RasterTextLayout | undefined> = [];
  if (payments && payments.lines.length > 0) {
    lines.push(dash);
    paymentSourceLines.push(dash);
    paymentSourceControlLines.push(dash);
    paymentSourceLayouts.push(undefined);
    const pushPaymentRow = (rawLabel: string, amount: number): void => {
      const methodLabel = truncate(rawLabel, cols - 12, options.language, options.capabilities);
      const value = summaryAmount(amount);
      const rendered = financialRows(methodLabel, value, cols, options.language, options.capabilities);
      recordFinancialLines(lines.length, rendered);
      lines.push(...rendered);
      paymentSourceLines.push(`${rawLabel} ${value.trimStart()}`);
      paymentSourceControlLines.push(rendered[0] ?? '');
      paymentSourceLayouts.push({
        kind: 'financial-summary',
        columns: [
          { text: rawLabel, align: 'left', widthRatio: Math.max(0.1, (cols - 12) / cols) },
          { text: value.trimStart(), align: 'right', widthRatio: Math.min(0.9, 12 / cols) },
        ],
      });
    };
    for (const line of payments.lines) {
      for (const row of paymentDisplayRows(line)) {
        pushPaymentRow(paymentLabel(row.label), row.amount);
      }
    }
  }
  markGroup('payments', paymentsStart, paymentSourceLines, paymentSourceControlLines, true, paymentSourceLayouts);

  // Footer contact details.
  lines.push(bar);
  const businessFooterStart = lines.length;
  const businessFooterSourceLines: string[] = [];
  const businessFooterSourceControlLines: string[] = [];
  if (header?.address) {
    const start = lines.length;
    pushWrapped(lines, header.address.text, cols, options.language, options.capabilities);
    businessFooterSourceLines.push(header.address.text);
    businessFooterSourceControlLines.push(lines[start] ?? '');
  }
  if (header?.phone && header.phoneLabel) {
    const start = lines.length;
    pushWrapped(lines, labelOf(header.phoneLabel) + ': ' + header.phone.text, cols, options.language, options.capabilities);
    businessFooterSourceLines.push(labelOf(header.phoneLabel) + ': ' + header.phone.text);
    businessFooterSourceControlLines.push(lines[start] ?? '');
  }
  if (header?.taxId) {
    const start = lines.length;
    pushWrapped(lines, labelOf(header.taxId.label) + ': ' + header.taxId.value.text, cols, options.language, options.capabilities);
    businessFooterSourceLines.push(labelOf(header.taxId.label) + ': ' + header.taxId.value.text);
    businessFooterSourceControlLines.push(lines[start] ?? '');
  }
  markGroup('business-header', businessFooterStart, businessFooterSourceLines, businessFooterSourceControlLines);

  const messageFooterStart = lines.length;
  const messageFooterSourceLines: string[] = [];
  const messageFooterSourceControlLines: string[] = [];
  if (messages?.footerNote) {
    const start = lines.length;
    pushCenteredWrapped(lines, messages.footerNote.text, cols, options.language, options.capabilities);
    messageFooterSourceLines.push(messages.footerNote.text);
    messageFooterSourceControlLines.push(lines[start] ?? '');
  } else if (messages?.thankYou) {
    lines.push('{CENTER}' + normalize(labelOf(messages.thankYou)) + '{/CENTER}');
    messageFooterSourceLines.push(labelOf(messages.thankYou));
    messageFooterSourceControlLines.push(lines.at(-1) ?? '');
  }
  markGroup('message', messageFooterStart, messageFooterSourceLines, messageFooterSourceControlLines);
  appendPoweredByFooter(lines, cols);
  lines.push('{CUT}');

  return lines;
}

// Entry: data -> document -> lines -> bytes.

export interface CompactDocumentRenderResult {
  readonly document: PrintDocument;
  readonly lines: string[];
  readonly data: Buffer;
  readonly warnings: PrintWarning[];
  readonly rasterGroups: readonly RasterSemanticLineGroup[];
}

/** Full document-driven compact pipeline: data -> document -> lines -> bytes. */
export function renderCompactReceiptViaDocument(
  order: any,
  bill: any,
  business: any,
  opts: {
    columns: number;
    language: string;
    additionalLanguage?: string;
    isReprint: boolean;
    useUnicode: boolean;
    arabicShaping: boolean;
    cutMode: PrinterCutMode;
    capabilities?: import('../../shared/print/thermal-capabilities').ThermalPrinterCapabilities;
    maskCustomerPhone?: boolean;
    preserveCurrencySymbol?: boolean;
  },
): CompactDocumentRenderResult {
  const semanticBusiness = opts.maskCustomerPhone
    ? { ...(business || {}), customer_phone: maskPhoneOnReceipt(String(business?.customer_phone ?? '')) }
    : business;
  const printData = buildBillPrintData(order, bill, semanticBusiness, opts.isReprint);
  const printContext = buildBillPrintContext({
    columns: opts.columns,
    language: opts.language,
    ...(opts.additionalLanguage !== undefined ? { additionalLanguage: opts.additionalLanguage } : {}),
    business: semanticBusiness,
  });
  const document = buildBillDocument(printData, printContext);
  const warnings: PrintWarning[] = [];
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const financialLineRanges: Array<{ lineIndex: number; lineCount: number }> = [];
  const lines = renderBillDocumentToCompactLines(document, {
    columns: opts.columns,
    language: printContext.languages[0],
    locale: printContext.locale,
    ...(printContext.timezone !== undefined ? { timezone: printContext.timezone } : {}),
    currency: printContext.currency,
    currencySymbol: printContext.currencySymbol,
    currencyUnit: printContext.currencyUnit ?? null,
    trimDecimals: printContext.trimDecimals,
    useUnicode: opts.useUnicode,
    arabicShaping: opts.arabicShaping,
    cutMode: opts.cutMode,
    capabilities: opts.capabilities,
    maskCustomerPhone: false,
    preserveCurrencySymbol: opts.preserveCurrencySymbol,
    rasterGroups,
    financialLineRanges,
  });
  const data = buildEscPos(lines, opts.useUnicode, { cutMode: opts.cutMode, arabicShaping: opts.arabicShaping, columns: opts.columns, language: opts.language, capabilities: opts.capabilities, financialLineRanges }, warnings);
  return { document, lines, data, warnings, rasterGroups };
}
