import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn, formatPurchaseInvoiceNumber, nextPurchaseInvoiceSequence } from '../db';
import { getSupplier } from './suppliers';
import { assertSupplyUnit, roundQuantity } from './units';
import { applySupplyStockChange } from './supplies';

export type PurchaseInvoiceStatus = 'draft' | 'posted' | 'partially_paid' | 'paid' | 'cancelled';

export class PurchaseInvoiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'PurchaseInvoiceError';
    this.statusCode = statusCode;
  }
}

export interface PurchaseInvoiceItemRecord {
  id: string;
  purchase_invoice_id: string;
  supply_id: string;
  supply_name: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  created_at: string;
}

export interface PurchaseInvoiceRecord {
  id: string;
  invoice_number: string;
  supplier_id: string;
  supplier_name: string | null;
  invoice_date: string;
  due_date: string | null;
  subtotal: number;
  discount_amount: number;
  tax_amount: number;
  total: number;
  paid_amount: number;
  balance: number;
  status: PurchaseInvoiceStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items?: PurchaseInvoiceItemRecord[];
}

export interface PurchaseInvoiceItemInput {
  supplyId: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discountAmount?: number;
  taxAmount?: number;
}

function newId(): string {
  return `pinv_${randomBytes(12).toString('hex')}`;
}

function newItemId(): string {
  return `pinv_item_${randomBytes(12).toString('hex')}`;
}

function assertFiniteNumber(value: unknown, field: string): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new PurchaseInvoiceError(400, `${field} must be a finite number`);
  }
  return num;
}

function assertNonNegative(value: number, field: string): number {
  if (value < 0) throw new PurchaseInvoiceError(400, `${field} must be non-negative`);
  return value;
}

function assertPositive(value: number, field: string): number {
  if (value <= 0) throw new PurchaseInvoiceError(400, `${field} must be positive`);
  return value;
}

function assertValidDate(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new PurchaseInvoiceError(400, `${field} is required`);
  }
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(text)) {
    throw new PurchaseInvoiceError(400, `${field} must be a valid date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)`);
  }
  return text;
}

function trimToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function assertItems(db: ReturnType<typeof getDatabase>, items: PurchaseInvoiceItemInput[]): PurchaseInvoiceItemInput[] {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PurchaseInvoiceError(400, 'at least one invoice item is required');
  }
  if (items.length > 200) throw new PurchaseInvoiceError(400, 'too many invoice items (max 200)');
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.supplyId) throw new PurchaseInvoiceError(400, 'supply_id is required for every invoice item');
    if (seen.has(item.supplyId)) {
      throw new PurchaseInvoiceError(400, 'a supply cannot appear twice on the same invoice');
    }
    seen.add(item.supplyId);
    const supply = db.prepare('SELECT id FROM supplies WHERE id = ? AND deleted_at IS NULL').get(item.supplyId) as
      | { id: string }
      | undefined;
    if (!supply) throw new PurchaseInvoiceError(400, `supply ${item.supplyId} does not exist`);
    assertPositive(assertFiniteNumber(item.quantity, 'quantity'), 'quantity');
    assertSupplyUnit(item.unit, 'unit');
    assertNonNegative(assertFiniteNumber(item.unitPrice, 'unit_price'), 'unit_price');
    if (item.discountAmount !== undefined && item.discountAmount !== null) {
      assertNonNegative(assertFiniteNumber(item.discountAmount, 'discount_amount'), 'discount_amount');
    }
    if (item.taxAmount !== undefined && item.taxAmount !== null) {
      assertNonNegative(assertFiniteNumber(item.taxAmount, 'tax_amount'), 'tax_amount');
    }
  }
  return items;
}

function computeItemTotal(item: PurchaseInvoiceItemInput): {
  gross: number;
  discount: number;
  tax: number;
  total: number;
} {
  const gross = roundQuantity(assertFiniteNumber(item.quantity, 'quantity') * assertFiniteNumber(item.unitPrice, 'unit_price'));
  const discount = item.discountAmount === undefined || item.discountAmount === null
    ? 0
    : roundQuantity(assertFiniteNumber(item.discountAmount, 'discount_amount'));
  const tax = item.taxAmount === undefined || item.taxAmount === null
    ? 0
    : roundQuantity(assertFiniteNumber(item.taxAmount, 'tax_amount'));
  const total = roundQuantity(Math.max(0, gross - discount) + tax);
  return { gross, discount, tax, total };
}

function assertTotals(items: PurchaseInvoiceItemInput[]): {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
} {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  let total = 0;
  for (const item of items) {
    const computed = computeItemTotal(item);
    subtotal += computed.gross;
    discount += computed.discount;
    tax += computed.tax;
    total += computed.total;
  }
  return {
    subtotal: roundQuantity(subtotal),
    discount: roundQuantity(discount),
    tax: roundQuantity(tax),
    total: roundQuantity(total),
  };
}

function attachSupplier(db: ReturnType<typeof getDatabase>, row: PurchaseInvoiceRecord): PurchaseInvoiceRecord {
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.supplier_id) as
    | { name: string }
    | undefined;
  return { ...row, supplier_name: supplier?.name ?? null };
}

function rowToInvoice(db: ReturnType<typeof getDatabase>, row: PurchaseInvoiceRecord): PurchaseInvoiceRecord {
  return attachSupplier(db, row);
}

export function getPurchaseInvoice(
  db: ReturnType<typeof getDatabase>,
  id: string,
  includeItems = true,
): PurchaseInvoiceRecord {
  const row = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(id) as
    | PurchaseInvoiceRecord
    | undefined;
  if (!row) throw new PurchaseInvoiceError(404, 'Purchase invoice not found');
  const invoice = rowToInvoice(db, row);
  if (includeItems) {
    invoice.items = listPurchaseInvoiceItems(db, id);
  }
  return invoice;
}

export function listPurchaseInvoiceItems(
  db: ReturnType<typeof getDatabase>,
  invoiceId: string,
): PurchaseInvoiceItemRecord[] {
  return db.prepare(`
    SELECT i.*, s.name AS supply_name
    FROM purchase_invoice_items i
    LEFT JOIN supplies s ON s.id = i.supply_id
    WHERE i.purchase_invoice_id = ?
    ORDER BY i.created_at, i.id
  `).all(invoiceId) as PurchaseInvoiceItemRecord[];
}

export function listPurchaseInvoices(
  db: ReturnType<typeof getDatabase>,
  filters: {
    supplierId?: string;
    status?: PurchaseInvoiceStatus;
    search?: string;
    perPage?: number;
    beforeId?: string;
  } = {},
): { invoices: PurchaseInvoiceRecord[]; nextCursor: string | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.supplierId) {
    conditions.push('i.supplier_id = ?');
    params.push(filters.supplierId);
  }
  if (filters.status) {
    conditions.push('i.status = ?');
    params.push(filters.status);
  }
  if (filters.search) {
    conditions.push('(i.invoice_number LIKE ? OR s.name LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }
  if (filters.beforeId !== undefined) {
    // Keyset cursor aligned with ORDER BY created_at DESC, id DESC so rows
    // sharing a timestamp are not skipped between pages.
    conditions.push('(i.created_at, i.id) < (SELECT created_at, id FROM purchase_invoices WHERE id = ?)');
    params.push(filters.beforeId);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const perPage = filters.perPage ?? 50;
  const rows = db.prepare(`
    SELECT i.*, s.name AS supplier_name
    FROM purchase_invoices i
    LEFT JOIN suppliers s ON s.id = i.supplier_id
    ${whereSql}
    ORDER BY i.created_at DESC, i.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as PurchaseInvoiceRecord[];

  const hasMore = rows.length > perPage;
  const invoices = hasMore ? rows.slice(0, perPage) : rows;
  return {
    invoices,
    nextCursor: hasMore ? invoices[invoices.length - 1].id : null,
  };
}

export interface CreatePurchaseInvoiceInput {
  id?: string;
  supplierId: string;
  invoiceDate?: string;
  dueDate?: string | null;
  notes?: string | null;
  items: PurchaseInvoiceItemInput[];
  actorUserId: string;
}

export function createPurchaseInvoice(
  db: ReturnType<typeof getDatabase>,
  input: CreatePurchaseInvoiceInput,
): PurchaseInvoiceRecord {
  if (!input.actorUserId) throw new PurchaseInvoiceError(400, 'actor_user_id is required');
  if (!input.supplierId) throw new PurchaseInvoiceError(400, 'supplier_id is required');
  const supplier = getSupplier(db, input.supplierId);
  assertItems(db, input.items);

  const invoiceDate = input.invoiceDate === undefined || input.invoiceDate === null
    ? now().slice(0, 10)
    : assertValidDate(input.invoiceDate, 'invoice_date');
  const dueDate = input.dueDate === undefined || input.dueDate === null
    ? null
    : assertValidDate(input.dueDate, 'due_date');
  const totals = assertTotals(input.items);
  const id = input.id || newId();
  const timestamp = now();

  withTxn(() => {
    const dateStamp = invoiceDate.slice(0, 10);
    const sequence = nextPurchaseInvoiceSequence(db, dateStamp);
    const invoiceNumber = formatPurchaseInvoiceNumber(dateStamp, sequence);

    db.prepare(`
      INSERT INTO purchase_invoices (
        id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, discount_amount, tax_amount, total, paid_amount, balance,
        status, notes, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'draft', ?, ?, ?, ?)
    `).run(
      id, invoiceNumber, supplier.id, invoiceDate, dueDate,
      totals.subtotal, totals.discount, totals.tax, totals.total, totals.total,
      trimToNull(input.notes), input.actorUserId, timestamp, timestamp,
    );

    const itemStmt = db.prepare(`
      INSERT INTO purchase_invoice_items (
        id, purchase_invoice_id, supply_id, quantity, unit, unit_price,
        discount_amount, tax_amount, total, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of input.items) {
      const computed = computeItemTotal(item);
      itemStmt.run(
        newItemId(), id, item.supplyId, roundQuantity(item.quantity), assertSupplyUnit(item.unit, 'unit'),
        assertFiniteNumber(item.unitPrice, 'unit_price'), computed.discount, computed.tax, computed.total, timestamp,
      );
    }
  });

  return getPurchaseInvoice(db, id);
}

/** Posts a draft invoice: receives stock, records movements, and updates balance. */
export function postPurchaseInvoice(
  db: ReturnType<typeof getDatabase>,
  id: string,
  actorUserId: string,
): PurchaseInvoiceRecord {
  if (!actorUserId) throw new PurchaseInvoiceError(400, 'actor_user_id is required');
  return withTxn(() => {
    const invoice = getPurchaseInvoice(db, id, true);
    if (invoice.status !== 'draft') {
      throw new PurchaseInvoiceError(409, `only draft invoices can be posted (current status: ${invoice.status})`);
    }
    if (!invoice.items || invoice.items.length === 0) {
      throw new PurchaseInvoiceError(400, 'cannot post an invoice without items');
    }
    const supplier = getSupplier(db, invoice.supplier_id);
    if (!supplier.is_active) throw new PurchaseInvoiceError(409, 'cannot post an invoice for an inactive supplier');

    for (const item of invoice.items) {
      applySupplyStockChange(db, {
        supplyId: item.supply_id,
        quantityDelta: item.quantity,
        movementType: 'receive',
        unit: item.unit,
        unitCost: item.unit_price,
        reason: `Purchase invoice ${invoice.invoice_number}`,
        actorUserId,
        referenceType: 'purchase_invoice',
        referenceId: invoice.id,
      });
    }

    db.prepare(`
      UPDATE purchase_invoices
      SET status = 'posted', balance = ?, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(invoice.total, now(), id);

    return getPurchaseInvoice(db, id, true);
  });
}

/** Cancels a draft invoice. Posted invoices must be returned instead. */
export function cancelPurchaseInvoice(
  db: ReturnType<typeof getDatabase>,
  id: string,
  actorUserId: string,
): PurchaseInvoiceRecord {
  if (!actorUserId) throw new PurchaseInvoiceError(400, 'actor_user_id is required');
  return withTxn(() => {
    const invoice = getPurchaseInvoice(db, id, false);
    if (invoice.status !== 'draft') {
      throw new PurchaseInvoiceError(409, `only draft invoices can be cancelled (current status: ${invoice.status})`);
    }
    db.prepare(`
      UPDATE purchase_invoices SET status = 'cancelled', balance = 0, updated_at = ?
      WHERE id = ? AND status = 'draft'
    `).run(now(), id);
    return getPurchaseInvoice(db, id, false);
  });
}

export function updatePurchaseInvoice(
  db: ReturnType<typeof getDatabase>,
  id: string,
  input: {
    dueDate?: string | null;
    notes?: string | null;
    items?: PurchaseInvoiceItemInput[];
  },
): PurchaseInvoiceRecord {
  return withTxn(() => {
    const invoice = getPurchaseInvoice(db, id, false);
    if (invoice.status !== 'draft') {
      throw new PurchaseInvoiceError(409, `only draft invoices can be edited (current status: ${invoice.status})`);
    }

    const dueDate = input.dueDate === undefined
      ? invoice.due_date
      : (input.dueDate === null ? null : assertValidDate(input.dueDate, 'due_date'));
    const notes = input.notes === undefined ? invoice.notes : trimToNull(input.notes);

    if (input.items !== undefined) {
      assertItems(db, input.items);
      const totals = assertTotals(input.items);
      db.prepare('DELETE FROM purchase_invoice_items WHERE purchase_invoice_id = ?').run(id);
      const timestamp = now();
      const itemStmt = db.prepare(`
        INSERT INTO purchase_invoice_items (
          id, purchase_invoice_id, supply_id, quantity, unit, unit_price,
          discount_amount, tax_amount, total, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.items) {
        const computed = computeItemTotal(item);
        itemStmt.run(
          newItemId(), id, item.supplyId, roundQuantity(item.quantity), assertSupplyUnit(item.unit, 'unit'),
          assertFiniteNumber(item.unitPrice, 'unit_price'), computed.discount, computed.tax, computed.total, timestamp,
        );
      }
      db.prepare(`
        UPDATE purchase_invoices SET
          due_date = ?, notes = ?, subtotal = ?, discount_amount = ?, tax_amount = ?,
          total = ?, balance = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'
      `).run(dueDate, notes, totals.subtotal, totals.discount, totals.tax, totals.total, totals.total, now(), id);
    } else {
      db.prepare(`
        UPDATE purchase_invoices SET due_date = ?, notes = ?, updated_at = ?
        WHERE id = ? AND status = 'draft'
      `).run(dueDate, notes, now(), id);
    }

    return getPurchaseInvoice(db, id, true);
  });
}
