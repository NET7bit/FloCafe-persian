import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';

export class ReceivableError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ReceivableError';
    this.statusCode = statusCode;
  }
}

export type ReceivableEntryType = 'charge' | 'settlement' | 'adjustment';
export type ReceivableDirection = 'debit' | 'credit';

const ENTRY_TYPES: ReceivableEntryType[] = ['charge', 'settlement', 'adjustment'];
const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];

export interface ReceivableEntryRecord {
  id: string;
  customer_id: string;
  customer_name: string | null;
  entry_type: ReceivableEntryType;
  direction: ReceivableDirection;
  /** Stored positive; the sign comes from direction (debit +, credit −). */
  amount: number;
  payment_method: string | null;
  reference: string | null;
  description: string | null;
  entry_date: string;
  created_by: string | null;
  created_by_name: string | null;
  notes: string | null;
  created_at: string;
  /** Signed running balance after this entry; present on customer statements. */
  balance_after?: number;
}

export interface CreateReceivableEntryInput {
  id?: string;
  customerId: string;
  entryType: string;
  direction?: string;
  amount: number;
  paymentMethod?: string | null;
  reference?: string | null;
  description?: string | null;
  entryDate?: string;
  notes?: string | null;
  actorUserId: string;
}

function newId(): string {
  return `rcv_${randomBytes(12).toString('hex')}`;
}

function trimToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function assertAmount(value: unknown): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ReceivableError(400, 'amount must be a finite number');
  }
  if (amount <= 0) throw new ReceivableError(400, 'amount must be positive');
  return Math.round(amount * 100) / 100;
}

function assertEntryDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return now().slice(0, 10);
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ReceivableError(400, 'entry_date must be a valid date (YYYY-MM-DD)');
  }
  return text;
}

function assertDescription(value: unknown, required: boolean): string | null {
  const description = trimToNull(value);
  if (required && !description) {
    throw new ReceivableError(400, 'description is required for charges and adjustments');
  }
  if (description && description.length > 200) {
    throw new ReceivableError(400, 'description is too long (max 200 characters)');
  }
  return description;
}

function roundMoney(value: unknown): number {
  return Math.round(Number(value) * 100) / 100;
}

function getCustomerRow(db: ReturnType<typeof getDatabase>, customerId: string): { id: string; name: string } {
  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId) as
    | { id: string; name: string }
    | undefined;
  if (!customer) throw new ReceivableError(404, 'Customer not found');
  return customer;
}

/** Customer balance = SUM(debit) − SUM(credit); negative means prepaid. */
export function getCustomerBalance(db: ReturnType<typeof getDatabase>, customerId: string): number {
  getCustomerRow(db, customerId);
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS balance
    FROM receivable_entries WHERE customer_id = ?
  `).get(customerId) as { balance: number };
  return roundMoney(row.balance);
}

/** Balances for every customer with at least one ledger entry. */
export function listCustomerBalances(
  db: ReturnType<typeof getDatabase>,
): { customer_id: string; customer_name: string | null; balance: number; entry_count: number }[] {
  return (db.prepare(`
    SELECT c.id AS customer_id, c.name AS customer_name,
      ROUND(COALESCE(SUM(CASE WHEN e.direction = 'debit' THEN e.amount ELSE -e.amount END), 0), 2) AS balance,
      COUNT(e.id) AS entry_count
    FROM customers c
    JOIN receivable_entries e ON e.customer_id = c.id
    GROUP BY c.id, c.name
    ORDER BY balance DESC, c.name
  `).all() as { customer_id: string; customer_name: string | null; balance: number; entry_count: number }[])
    .map((row) => ({ ...row, balance: roundMoney(row.balance) }));
}

export function getReceivableEntry(db: ReturnType<typeof getDatabase>, id: string): ReceivableEntryRecord {
  const row = db.prepare(`
    SELECT e.*, c.name AS customer_name, u.name AS created_by_name
    FROM receivable_entries e
    LEFT JOIN customers c ON c.id = e.customer_id
    LEFT JOIN users u ON u.id = e.created_by
    WHERE e.id = ?
  `).get(id) as ReceivableEntryRecord | undefined;
  if (!row) throw new ReceivableError(404, 'Receivable entry not found');
  return row;
}

export function listReceivableEntries(
  db: ReturnType<typeof getDatabase>,
  filters: {
    customerId?: string;
    entryType?: ReceivableEntryType;
    fromDate?: string;
    toDate?: string;
    search?: string;
    perPage?: number;
    beforeId?: string;
  } = {},
): { entries: ReceivableEntryRecord[]; nextCursor: string | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.customerId) {
    conditions.push('e.customer_id = ?');
    params.push(filters.customerId);
  }
  if (filters.entryType) {
    conditions.push('e.entry_type = ?');
    params.push(filters.entryType);
  }
  if (filters.fromDate) {
    conditions.push('e.entry_date >= ?');
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    conditions.push('e.entry_date <= ?');
    params.push(filters.toDate);
  }
  if (filters.search) {
    conditions.push('(e.description LIKE ? OR e.reference LIKE ? OR c.name LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  if (filters.beforeId !== undefined) {
    // Keyset cursor aligned with ORDER BY entry_date DESC, id DESC.
    conditions.push('(e.entry_date, e.id) < (SELECT entry_date, id FROM receivable_entries WHERE id = ?)');
    params.push(filters.beforeId);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const perPage = filters.perPage ?? 50;
  const rows = db.prepare(`
    SELECT e.*, c.name AS customer_name, u.name AS created_by_name
    FROM receivable_entries e
    LEFT JOIN customers c ON c.id = e.customer_id
    LEFT JOIN users u ON u.id = e.created_by
    ${whereSql}
    ORDER BY e.entry_date DESC, e.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as ReceivableEntryRecord[];

  const hasMore = rows.length > perPage;
  const entries = hasMore ? rows.slice(0, perPage) : rows;
  return {
    entries,
    nextCursor: hasMore ? entries[entries.length - 1].id : null,
  };
}

/**
 * Per-customer statement: entries oldest → newest with the running balance
 * after each row, ending at the customer's current balance.
 */
export function getCustomerStatement(
  db: ReturnType<typeof getDatabase>,
  customerId: string,
  options: { fromDate?: string; toDate?: string; perPage?: number } = {},
): {
  customer: { id: string; name: string };
  balance: number;
  entries: ReceivableEntryRecord[];
  nextCursor: string | null;
} {
  const customer = getCustomerRow(db, customerId);
  const page = listReceivableEntries(db, {
    customerId,
    fromDate: options.fromDate,
    toDate: options.toDate,
    perPage: options.perPage,
  });

  // Running balance: seed with everything NEWER than the window's oldest row,
  // then walk the newest-first page in reverse so balance_after always ends
  // at the customer's current balance regardless of pagination.
  const newer = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END), 0) AS balance
    FROM receivable_entries
    WHERE customer_id = ?
      AND (entry_date, id) < (SELECT entry_date, id FROM receivable_entries WHERE id = ?)
  `).get(customerId, page.entries.length > 0 ? page.entries[page.entries.length - 1].id : '') as { balance: number };

  let running = roundMoney(newer.balance);
  for (const entry of [...page.entries].reverse()) {
    running = roundMoney(running + (entry.direction === 'debit' ? entry.amount : -entry.amount));
    entry.balance_after = running;
  }

  return {
    customer,
    balance: getCustomerBalance(db, customerId),
    entries: page.entries,
    nextCursor: page.nextCursor,
  };
}

export function createReceivableEntry(
  db: ReturnType<typeof getDatabase>,
  input: CreateReceivableEntryInput,
): ReceivableEntryRecord {
  if (!input.actorUserId) throw new ReceivableError(400, 'actor_user_id is required');
  const customer = getCustomerRow(db, input.customerId);
  const amount = assertAmount(input.amount);
  const entryDate = assertEntryDate(input.entryDate);

  const entryType = input.entryType;
  if (!ENTRY_TYPES.includes(entryType as ReceivableEntryType)) {
    throw new ReceivableError(400, `entry_type must be one of: ${ENTRY_TYPES.join(', ')}`);
  }

  // Direction is type-driven so the ledger stays consistent by construction.
  let direction: ReceivableDirection;
  let paymentMethod: string | null = null;
  if (entryType === 'charge') {
    direction = 'debit';
  } else if (entryType === 'settlement') {
    direction = 'credit';
    if (input.paymentMethod === undefined || input.paymentMethod === null) {
      throw new ReceivableError(400, 'payment_method is required for settlements');
    }
    if (typeof input.paymentMethod !== 'string' || !PAYMENT_METHODS.includes(input.paymentMethod)) {
      throw new ReceivableError(400, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`);
    }
    paymentMethod = input.paymentMethod;
  } else {
    if (input.direction !== 'debit' && input.direction !== 'credit') {
      throw new ReceivableError(400, 'direction must be debit or credit for adjustments');
    }
    direction = input.direction;
  }

  const description = assertDescription(input.description, entryType !== 'settlement');
  const reference = trimToNull(input.reference);
  if (reference && reference.length > 128) {
    throw new ReceivableError(400, 'reference is too long (max 128 characters)');
  }
  const notes = trimToNull(input.notes);
  if (notes && notes.length > 500) {
    throw new ReceivableError(400, 'notes is too long (max 500 characters)');
  }

  const id = input.id || newId();

  withTxn(() => {
    db.prepare(`
      INSERT INTO receivable_entries (
        id, customer_id, entry_type, direction, amount, payment_method,
        reference, description, entry_date, created_by, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, customer.id, entryType, direction, amount, paymentMethod,
      reference, description, entryDate, input.actorUserId, notes, now(),
    );
  });

  return getReceivableEntry(db, id);
}

/** Deletes a ledger row. The derived balance updates with no recompute step. */
export function deleteReceivableEntry(
  db: ReturnType<typeof getDatabase>,
  id: string,
  _actorUserId: string,
): void {
  withTxn(() => {
    getReceivableEntry(db, id);
    db.prepare('DELETE FROM receivable_entries WHERE id = ?').run(id);
  });
}
