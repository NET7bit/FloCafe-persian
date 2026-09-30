import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import { getSupplier } from './suppliers';
import { getPurchaseInvoice } from './purchase-invoices';
import { assertNotInClosedPeriod, fiscalDateForInstant } from './fiscal-periods';
import type { PurchaseInvoiceStatus } from './purchase-invoices';

export class SupplierPaymentError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'SupplierPaymentError';
    this.statusCode = statusCode;
  }
}

export type SupplierPaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';

const PAYMENT_METHODS: SupplierPaymentMethod[] = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];

export interface SupplierPaymentRecord {
  id: string;
  supplier_id: string;
  supplier_name: string | null;
  purchase_invoice_id: string | null;
  invoice_number: string | null;
  amount: number;
  payment_method: SupplierPaymentMethod;
  reference: string | null;
  paid_at: string;
  created_by: string | null;
  created_by_name: string | null;
  notes: string | null;
  created_at: string;
}

export interface CreateSupplierPaymentInput {
  id?: string;
  supplierId: string;
  purchaseInvoiceId?: string | null;
  amount: number;
  paymentMethod: string;
  reference?: string | null;
  paidAt?: string;
  notes?: string | null;
  actorUserId: string;
}

function newId(): string {
  return `spay_${randomBytes(12).toString('hex')}`;
}

function trimToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function assertAmount(value: unknown): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new SupplierPaymentError(400, 'amount must be a finite number');
  }
  if (amount <= 0) throw new SupplierPaymentError(400, 'amount must be positive');
  return Math.round(amount * 100) / 100;
}

function assertPaymentMethod(value: unknown): SupplierPaymentMethod {
  if (typeof value !== 'string') {
    throw new SupplierPaymentError(400, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  if (!PAYMENT_METHODS.includes(value as SupplierPaymentMethod)) {
    throw new SupplierPaymentError(400, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  return value as SupplierPaymentMethod;
}

function assertPaidAt(value: unknown): string {
  if (value === undefined || value === null || value === '') return now();
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(text)) {
    throw new SupplierPaymentError(400, 'paid_at must be a valid date (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS)');
  }
  return text;
}

function rowToPayment(db: ReturnType<typeof getDatabase>, row: SupplierPaymentRecord): SupplierPaymentRecord {
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.supplier_id) as
    | { name: string }
    | undefined;
  const invoice = row.purchase_invoice_id
    ? (db.prepare('SELECT invoice_number FROM purchase_invoices WHERE id = ?').get(row.purchase_invoice_id) as
      | { invoice_number: string }
      | undefined)
    : undefined;
  const user = row.created_by
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(row.created_by) as { name: string } | undefined)
    : undefined;
  return {
    ...row,
    supplier_name: supplier?.name ?? null,
    invoice_number: invoice?.invoice_number ?? null,
    created_by_name: user?.name ?? null,
  };
}

export function getSupplierPayment(db: ReturnType<typeof getDatabase>, id: string): SupplierPaymentRecord {
  const row = db.prepare(`
    SELECT * FROM supplier_payments WHERE id = ?
  `).get(id) as SupplierPaymentRecord | undefined;
  if (!row) throw new SupplierPaymentError(404, 'Supplier payment not found');
  return rowToPayment(db, row);
}

export function listSupplierPayments(
  db: ReturnType<typeof getDatabase>,
  filters: {
    supplierId?: string;
    purchaseInvoiceId?: string;
    paymentMethod?: SupplierPaymentMethod;
    search?: string;
    perPage?: number;
    beforeId?: string;
  } = {},
): { payments: SupplierPaymentRecord[]; nextCursor: string | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.supplierId) {
    conditions.push('p.supplier_id = ?');
    params.push(filters.supplierId);
  }
  if (filters.purchaseInvoiceId) {
    conditions.push('p.purchase_invoice_id = ?');
    params.push(filters.purchaseInvoiceId);
  }
  if (filters.paymentMethod) {
    conditions.push('p.payment_method = ?');
    params.push(filters.paymentMethod);
  }
  if (filters.search) {
    conditions.push('(p.reference LIKE ? OR s.name LIKE ? OR i.invoice_number LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  if (filters.beforeId !== undefined) {
    // Keyset cursor aligned with ORDER BY paid_at DESC, id DESC so rows
    // sharing a paid_at second are not skipped between pages.
    conditions.push('(p.paid_at, p.id) < (SELECT paid_at, id FROM supplier_payments WHERE id = ?)');
    params.push(filters.beforeId);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const perPage = filters.perPage ?? 50;
  const rows = db.prepare(`
    SELECT p.*, s.name AS supplier_name, i.invoice_number, u.name AS created_by_name
    FROM supplier_payments p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN purchase_invoices i ON i.id = p.purchase_invoice_id
    LEFT JOIN users u ON u.id = p.created_by
    ${whereSql}
    ORDER BY p.paid_at DESC, p.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as SupplierPaymentRecord[];

  const hasMore = rows.length > perPage;
  const payments = hasMore ? rows.slice(0, perPage) : rows;
  return {
    payments,
    nextCursor: hasMore ? payments[payments.length - 1].id : null,
  };
}

function invoicePayableStatus(status: PurchaseInvoiceStatus): boolean {
  return status === 'posted' || status === 'partially_paid';
}

/** Recomputes paid_amount/balance/status for a posted invoice from its payments. */
function recomputeInvoiceBalance(db: ReturnType<typeof getDatabase>, invoiceId: string): void {
  const invoice = getPurchaseInvoice(db, invoiceId, false);
  if (!invoicePayableStatus(invoice.status)) {
    throw new SupplierPaymentError(409, `cannot record a payment on an invoice with status ${invoice.status}`);
  }
  const paid = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS paid
    FROM supplier_payments WHERE purchase_invoice_id = ?
  `).get(invoiceId) as { paid: number };
  const paidAmount = Math.round(paid.paid * 100) / 100;
  const balance = Math.round((invoice.total - paidAmount) * 100) / 100;
  const status: PurchaseInvoiceStatus = balance <= 0 ? 'paid' : 'partially_paid';
  db.prepare(`
    UPDATE purchase_invoices
    SET paid_amount = ?, balance = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(paidAmount, Math.max(0, balance), status, now(), invoiceId);
}

export function createSupplierPayment(
  db: ReturnType<typeof getDatabase>,
  input: CreateSupplierPaymentInput,
): SupplierPaymentRecord {
  if (!input.actorUserId) throw new SupplierPaymentError(400, 'actor_user_id is required');
  if (!input.supplierId) throw new SupplierPaymentError(400, 'supplier_id is required');
  const supplier = getSupplier(db, input.supplierId);
  const amount = assertAmount(input.amount);
  const paymentMethod = assertPaymentMethod(input.paymentMethod);
  const paidAt = assertPaidAt(input.paidAt);
  assertNotInClosedPeriod(db, fiscalDateForInstant(paidAt));

  if (input.purchaseInvoiceId !== undefined && input.purchaseInvoiceId !== null) {
    const invoice = getPurchaseInvoice(db, input.purchaseInvoiceId, false);
    if (invoice.supplier_id !== supplier.id) {
      throw new SupplierPaymentError(400, 'invoice does not belong to this supplier');
    }
  }

  const id = input.id || newId();
  const reference = trimToNull(input.reference);
  const notes = trimToNull(input.notes);

  withTxn(() => {
    db.prepare(`
      INSERT INTO supplier_payments (
        id, supplier_id, purchase_invoice_id, amount, payment_method,
        reference, paid_at, created_by, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, supplier.id, input.purchaseInvoiceId ?? null, amount, paymentMethod,
      reference, paidAt, input.actorUserId, notes, now(),
    );
    if (input.purchaseInvoiceId) {
      recomputeInvoiceBalance(db, input.purchaseInvoiceId);
    }
  });

  return getSupplierPayment(db, id);
}

/** Deletes a payment and reverts the invoice balance. */
export function deleteSupplierPayment(
  db: ReturnType<typeof getDatabase>,
  id: string,
  _actorUserId: string,
): void {
  withTxn(() => {
    const payment = getSupplierPayment(db, id);
    const invoiceId = payment.purchase_invoice_id;
    assertNotInClosedPeriod(db, fiscalDateForInstant(payment.paid_at));
    db.prepare('DELETE FROM supplier_payments WHERE id = ?').run(id);
    if (invoiceId) {
      // A paid invoice is terminal for recompute gating, so reopen it first.
      const invoice = getPurchaseInvoice(db, invoiceId, false);
      if (invoice.status === 'paid') {
        db.prepare(`
          UPDATE purchase_invoices SET status = 'partially_paid', updated_at = ? WHERE id = ?
        `).run(now(), invoiceId);
      }
      recomputeInvoiceBalance(db, invoiceId);
    }
  });
}


/** Total amount paid to a supplier across all invoices. */
export function getSupplierPaidTotal(db: ReturnType<typeof getDatabase>, supplierId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM supplier_payments WHERE supplier_id = ?
  `).get(supplierId) as { total: number };
  return Math.round(row.total * 100) / 100;
}
