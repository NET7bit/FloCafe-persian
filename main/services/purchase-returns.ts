import { randomBytes } from 'crypto';
import {
  getDatabase,
  now,
  withTxn,
  nextPurchaseReturnSequence,
  formatPurchaseReturnNumber,
} from '../db';
import { getSupplier } from './suppliers';
import { getPurchaseInvoice } from './purchase-invoices';
import { roundQuantity } from './units';
import { applySupplyStockChange } from './supplies';
import { assertNotInClosedPeriod } from './fiscal-periods';

export type PurchaseReturnStatus = 'completed' | 'deleted';

export class PurchaseReturnError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'PurchaseReturnError';
    this.statusCode = statusCode;
  }
}

export interface PurchaseReturnItemRecord {
  id: string;
  purchase_return_id: string;
  purchase_invoice_item_id: string;
  supply_id: string;
  supply_name: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  tax_amount: number;
  total: number;
  created_at: string;
}

export interface PurchaseReturnRecord {
  id: string;
  return_number: string;
  purchase_invoice_id: string;
  invoice_number: string | null;
  supplier_id: string;
  supplier_name: string | null;
  return_date: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  status: PurchaseReturnStatus;
  reason: string | null;
  created_by: string | null;
  deleted_by: string | null;
  deleted_at: string | null;
  deletion_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  items?: PurchaseReturnItemRecord[];
}

export interface CreatePurchaseReturnInput {
  id?: string;
  purchaseInvoiceId: string;
  returnDate?: string;
  reason?: string | null;
  notes?: string | null;
  items: PurchaseReturnItemInput[];
  actorUserId: string;
}

export interface PurchaseReturnItemInput {
  purchaseInvoiceItemId: string;
  quantity: number;
}

function newId(): string {
  return `pret_${randomBytes(12).toString('hex')}`;
}

function newItemId(): string {
  return `pret_item_${randomBytes(12).toString('hex')}`;
}

function assertFiniteNumber(value: unknown, field: string): number {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) {
    throw new PurchaseReturnError(400, `${field} must be a finite number`);
  }
  return num;
}

function assertPositive(value: number, field: string): number {
  if (value <= 0) throw new PurchaseReturnError(400, `${field} must be positive`);
  return value;
}

function assertValidDate(value: unknown, field: string): string {
  if (value === undefined || value === null || value === '') {
    throw new PurchaseReturnError(400, `${field} is required`);
  }
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(text)) {
    throw new PurchaseReturnError(400, `${field} must be a valid date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)`);
  }
  return text;
}

function trimToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function assertReason(value: unknown): string | null {
  const reason = trimToNull(value);
  if (reason && reason.length > 500) {
    throw new PurchaseReturnError(400, 'reason is too long (max 500 characters)');
  }
  return reason;
}

function getInvoiceItem(
  db: ReturnType<typeof getDatabase>,
  invoiceId: string,
  invoiceItemId: string,
): { id: string; supply_id: string; quantity: number; unit: string; unit_price: number; tax_amount: number } {
  const item = db.prepare('SELECT * FROM purchase_invoice_items WHERE id = ? AND purchase_invoice_id = ?')
    .get(invoiceItemId, invoiceId) as
    | { id: string; supply_id: string; quantity: number; unit: string; unit_price: number; tax_amount: number }
    | undefined;
  if (!item) {
    throw new PurchaseReturnError(400, `invoice item ${invoiceItemId} does not belong to this invoice`);
  }
  return item;
}

function rowToReturn(db: ReturnType<typeof getDatabase>, row: PurchaseReturnRecord): PurchaseReturnRecord {
  const invoice = db.prepare('SELECT invoice_number FROM purchase_invoices WHERE id = ?').get(row.purchase_invoice_id) as
    | { invoice_number: string }
    | undefined;
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.supplier_id) as
    | { name: string }
    | undefined;
  return {
    ...row,
    invoice_number: invoice?.invoice_number ?? null,
    supplier_name: supplier?.name ?? null,
  };
}

export function getPurchaseReturn(
  db: ReturnType<typeof getDatabase>,
  id: string,
  includeItems = true,
): PurchaseReturnRecord {
  const row = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(id) as
    | PurchaseReturnRecord
    | undefined;
  if (!row) throw new PurchaseReturnError(404, 'Purchase return not found');
  const record = rowToReturn(db, row);
  if (includeItems) {
    record.items = listPurchaseReturnItems(db, id);
  }
  return record;
}

export function listPurchaseReturnItems(
  db: ReturnType<typeof getDatabase>,
  returnId: string,
): PurchaseReturnItemRecord[] {
  return db.prepare(`
    SELECT i.*, s.name AS supply_name
    FROM purchase_return_items i
    LEFT JOIN supplies s ON s.id = i.supply_id
    WHERE i.purchase_return_id = ?
    ORDER BY i.created_at, i.id
  `).all(returnId) as PurchaseReturnItemRecord[];
}

export function listPurchaseReturns(
  db: ReturnType<typeof getDatabase>,
  filters: {
    purchaseInvoiceId?: string;
    supplierId?: string;
    search?: string;
    perPage?: number;
    beforeId?: string;
  } = {},
): { returns: PurchaseReturnRecord[]; nextCursor: string | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.purchaseInvoiceId) {
    conditions.push('r.purchase_invoice_id = ?');
    params.push(filters.purchaseInvoiceId);
  }
  if (filters.supplierId) {
    conditions.push('r.supplier_id = ?');
    params.push(filters.supplierId);
  }
  if (filters.search) {
    conditions.push('(r.return_number LIKE ? OR s.name LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }
  if (filters.beforeId !== undefined) {
    // Keyset cursor aligned with ORDER BY created_at DESC, id DESC so rows
    // sharing a timestamp are not skipped between pages.
    conditions.push('(r.created_at, r.id) < (SELECT created_at, id FROM purchase_returns WHERE id = ?)');
    params.push(filters.beforeId);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const perPage = filters.perPage ?? 50;
  const rows = db.prepare(`
    SELECT r.*, s.name AS supplier_name, pi.invoice_number
    FROM purchase_returns r
    LEFT JOIN suppliers s ON s.id = r.supplier_id
    LEFT JOIN purchase_invoices pi ON pi.id = r.purchase_invoice_id
    ${whereSql}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as PurchaseReturnRecord[];

  const hasMore = rows.length > perPage;
  const returns = hasMore ? rows.slice(0, perPage) : rows;
  return {
    returns,
    nextCursor: hasMore ? returns[returns.length - 1].id : null,
  };
}

/**
 * Records a return against a posted invoice: stock leaves through
 * applySupplyStockChange and the invoice balance drops by the return total.
 */
export function createPurchaseReturn(
  db: ReturnType<typeof getDatabase>,
  input: CreatePurchaseReturnInput,
): PurchaseReturnRecord {
  if (!input.actorUserId) throw new PurchaseReturnError(400, 'actor_user_id is required');
  if (!input.purchaseInvoiceId) throw new PurchaseReturnError(400, 'purchase_invoice_id is required');
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new PurchaseReturnError(400, 'at least one return item is required');
  }
  if (input.items.length > 200) throw new PurchaseReturnError(400, 'too many return items (max 200)');

  const returnDate = input.returnDate === undefined || input.returnDate === null
    ? now().slice(0, 10)
    : assertValidDate(input.returnDate, 'return_date');
  assertNotInClosedPeriod(db, returnDate);
  const reason = assertReason(input.reason);
  const notes = trimToNull(input.notes);

  return withTxn(() => {
    const invoice = getPurchaseInvoice(db, input.purchaseInvoiceId, true);
    if (invoice.status !== 'posted' && invoice.status !== 'partially_paid' && invoice.status !== 'paid') {
      throw new PurchaseReturnError(409, 'returns are only allowed for posted invoices');
    }
    const supplier = getSupplier(db, invoice.supplier_id);

    // Collapse by invoice item so one return line carries each item's full quantity.
    const byInvoiceItem = new Map<string, number>();
    for (const item of input.items) {
      if (!item.purchaseInvoiceItemId) {
        throw new PurchaseReturnError(400, 'purchase_invoice_item_id is required for every return item');
      }
      const quantity = assertPositive(assertFiniteNumber(item.quantity, 'quantity'), 'quantity');
      if (byInvoiceItem.has(item.purchaseInvoiceItemId)) {
        throw new PurchaseReturnError(400, 'each invoice item can appear at most once per return');
      }
      byInvoiceItem.set(item.purchaseInvoiceItemId, quantity);
    }

    let subtotal = 0;
    let tax = 0;
    const resolvedItems = [...byInvoiceItem.entries()].map(([invoiceItemId, quantity]) => {
      const invoiceItem = getInvoiceItem(db, invoice.id, invoiceItemId);
      const alreadyReturned = db.prepare(`
        SELECT COALESCE(SUM(i.quantity), 0) AS qty
        FROM purchase_return_items i
        JOIN purchase_returns r ON r.id = i.purchase_return_id
        WHERE i.purchase_invoice_item_id = ? AND r.status = 'completed'
      `).get(invoiceItemId) as { qty: number };
      const remaining = roundQuantity(Number(invoiceItem.quantity) - Number(alreadyReturned.qty));
      if (quantity > remaining + 1e-9) {
        throw new PurchaseReturnError(
          409,
          `return quantity exceeds the remaining returnable quantity for invoice item ${invoiceItemId} (remaining: ${remaining})`,
        );
      }
      const unitPrice = roundQuantity(Number(invoiceItem.unit_price));
      const gross = roundQuantity(quantity * unitPrice);
      const itemTax = roundQuantity(
        Number(invoiceItem.tax_amount) * (Number(invoiceItem.quantity) === 0 ? 0 : quantity / Number(invoiceItem.quantity)),
      );
      subtotal += gross;
      tax += itemTax;
      return { invoiceItem, quantity, unitPrice, gross, itemTax };
    });

    const total = roundQuantity(subtotal + tax);
    const id = input.id || newId();
    const timestamp = now();
    const dateStamp = returnDate.slice(0, 10);
    const sequence = nextPurchaseReturnSequence(db, dateStamp);
    const returnNumber = formatPurchaseReturnNumber(dateStamp, sequence);

    db.prepare(`
      INSERT INTO purchase_returns (
        id, return_number, purchase_invoice_id, supplier_id, return_date,
        subtotal, tax_amount, total, status, reason, notes, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
    `).run(
      id, returnNumber, invoice.id, supplier.id, returnDate,
      roundQuantity(subtotal), roundQuantity(tax), total,
      reason, notes, input.actorUserId, timestamp, timestamp,
    );

    const itemStmt = db.prepare(`
      INSERT INTO purchase_return_items (
        id, purchase_return_id, purchase_invoice_item_id, supply_id,
        quantity, unit, unit_price, tax_amount, total, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const resolved of resolvedItems) {
      itemStmt.run(
        newItemId(), id, resolved.invoiceItem.id, resolved.invoiceItem.supply_id,
        roundQuantity(resolved.quantity), resolved.invoiceItem.unit, resolved.unitPrice,
        resolved.itemTax, resolved.gross, timestamp,
      );
      applySupplyStockChange(db, {
        supplyId: resolved.invoiceItem.supply_id,
        quantityDelta: -resolved.quantity,
        movementType: 'waste',
        unit: resolved.invoiceItem.unit,
        reason: `Purchase return ${returnNumber} (invoice ${invoice.invoice_number})`,
        actorUserId: input.actorUserId,
        referenceType: 'purchase_return',
        referenceId: id,
        createdAt: timestamp,
      });
    }

    db.prepare('UPDATE purchase_invoices SET balance = MAX(0, ROUND(balance - ?, 2)), updated_at = ? WHERE id = ?')
      .run(total, timestamp, invoice.id);

    return getPurchaseReturn(db, id);
  });
}

/** Deletes a completed return: stock comes back and the invoice balance is restored. */
export function deletePurchaseReturn(
  db: ReturnType<typeof getDatabase>,
  id: string,
  actorUserId: string,
  deletionReason?: string | null,
): PurchaseReturnRecord {
  if (!actorUserId) throw new PurchaseReturnError(400, 'actor_user_id is required');
  const reason = assertReason(deletionReason);

  return withTxn(() => {
    const record = getPurchaseReturn(db, id, true);
    if (record.status !== 'completed') {
      throw new PurchaseReturnError(409, 'this return has already been deleted');
    }
    assertNotInClosedPeriod(db, record.return_date);
    const items = record.items || [];
    const invoice = getPurchaseInvoice(db, record.purchase_invoice_id, false);
    const timestamp = now();

    for (const item of items) {
      applySupplyStockChange(db, {
        supplyId: item.supply_id,
        quantityDelta: item.quantity,
        movementType: 'receive',
        unit: item.unit,
        reason: `Purchase return ${record.return_number} deleted`,
        actorUserId,
        referenceType: 'purchase_return_delete',
        referenceId: record.id,
        createdAt: timestamp,
      });
    }

    db.prepare(`
      UPDATE purchase_returns
      SET status = 'deleted', deleted_by = ?, deleted_at = ?, deletion_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'completed'
    `).run(actorUserId, timestamp, reason, timestamp, id);

    db.prepare('UPDATE purchase_invoices SET balance = MAX(0, ROUND(balance + ?, 2)), updated_at = ? WHERE id = ?')
      .run(record.total, timestamp, invoice.id);

    return getPurchaseReturn(db, id);
  });
}
