import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import { assertNotInClosedPeriod } from './fiscal-periods';

export class ExpenseError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ExpenseError';
    this.statusCode = statusCode;
  }
}

export type ExpensePaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cheque' | 'other';

const PAYMENT_METHODS: ExpensePaymentMethod[] = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];

export interface ExpenseRecord {
  id: string;
  category: string;
  description: string | null;
  amount: number;
  payment_method: ExpensePaymentMethod;
  expense_date: string;
  created_by: string | null;
  created_by_name: string | null;
  notes: string | null;
  created_at: string;
}

export interface CreateExpenseInput {
  id?: string;
  category: string;
  description?: string | null;
  amount: number;
  paymentMethod: string;
  expenseDate?: string;
  notes?: string | null;
  actorUserId: string;
}

function newId(): string {
  return `exp_${randomBytes(12).toString('hex')}`;
}

function trimToNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function assertCategory(value: unknown): string {
  const category = trimToNull(value);
  if (!category) throw new ExpenseError(400, 'category is required');
  if (category.length > 60) throw new ExpenseError(400, 'category is too long (max 60 characters)');
  return category;
}

function assertAmount(value: unknown): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ExpenseError(400, 'amount must be a finite number');
  }
  if (amount <= 0) throw new ExpenseError(400, 'amount must be positive');
  return Math.round(amount * 100) / 100;
}

function assertPaymentMethod(value: unknown): ExpensePaymentMethod {
  if (typeof value !== 'string' || !PAYMENT_METHODS.includes(value as ExpensePaymentMethod)) {
    throw new ExpenseError(400, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  return value as ExpensePaymentMethod;
}

function assertExpenseDate(value: unknown): string {
  if (value === undefined || value === null || value === '') return now().slice(0, 10);
  const text = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ExpenseError(400, 'expense_date must be a valid date (YYYY-MM-DD)');
  }
  return text;
}

function rowToExpense(db: ReturnType<typeof getDatabase>, row: ExpenseRecord): ExpenseRecord {
  const user = row.created_by
    ? (db.prepare('SELECT name FROM users WHERE id = ?').get(row.created_by) as { name: string } | undefined)
    : undefined;
  return { ...row, created_by_name: user?.name ?? null };
}

export function getExpense(db: ReturnType<typeof getDatabase>, id: string): ExpenseRecord {
  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as ExpenseRecord | undefined;
  if (!row) throw new ExpenseError(404, 'Expense not found');
  return rowToExpense(db, row);
}

export interface ExpenseSummary {
  total: number;
  count: number;
  byCategory: { category: string; total: number; count: number }[];
  byMethod: { payment_method: ExpensePaymentMethod; total: number; count: number }[];
}

function roundMoney(value: unknown): number {
  return Math.round(Number(value) * 100) / 100;
}

/** Date-range totals for a reports/dashboard view. Omit bounds for all time. */
export function getExpenseSummary(
  db: ReturnType<typeof getDatabase>,
  range: { from?: string; to?: string } = {},
): ExpenseSummary {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (range.from) {
    conditions.push('expense_date >= ?');
    params.push(range.from);
  }
  if (range.to) {
    conditions.push('expense_date <= ?');
    params.push(range.to);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const totals = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count FROM expenses ${whereSql}
  `).get(...params) as { total: number; count: number };

  const byCategory = db.prepare(`
    SELECT category, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM expenses ${whereSql}
    GROUP BY category
    ORDER BY total DESC
  `).all(...params) as { category: string; total: number; count: number }[];

  const byMethod = db.prepare(`
    SELECT payment_method, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
    FROM expenses ${whereSql}
    GROUP BY payment_method
    ORDER BY total DESC
  `).all(...params) as { payment_method: ExpensePaymentMethod; total: number; count: number }[];

  return {
    total: roundMoney(totals.total),
    count: Number(totals.count),
    byCategory: byCategory.map((row) => ({ ...row, total: roundMoney(row.total) })),
    byMethod: byMethod.map((row) => ({ ...row, total: roundMoney(row.total) })),
  };
}

export function listExpenses(
  db: ReturnType<typeof getDatabase>,
  filters: {
    category?: string;
    paymentMethod?: ExpensePaymentMethod;
    fromDate?: string;
    toDate?: string;
    search?: string;
    perPage?: number;
    beforeId?: string;
  } = {},
): { expenses: ExpenseRecord[]; nextCursor: string | null } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filters.category) {
    conditions.push('e.category = ?');
    params.push(filters.category);
  }
  if (filters.paymentMethod) {
    conditions.push('e.payment_method = ?');
    params.push(filters.paymentMethod);
  }
  if (filters.fromDate) {
    conditions.push('e.expense_date >= ?');
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    conditions.push('e.expense_date <= ?');
    params.push(filters.toDate);
  }
  if (filters.search) {
    conditions.push('(e.description LIKE ? OR e.category LIKE ? OR e.notes LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }
  if (filters.beforeId !== undefined) {
    // Keyset cursor aligned with ORDER BY expense_date DESC, id DESC.
    conditions.push('(e.expense_date, e.id) < (SELECT expense_date, id FROM expenses WHERE id = ?)');
    params.push(filters.beforeId);
  }
  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const perPage = filters.perPage ?? 50;
  const rows = db.prepare(`
    SELECT e.*, u.name AS created_by_name
    FROM expenses e
    LEFT JOIN users u ON u.id = e.created_by
    ${whereSql}
    ORDER BY e.expense_date DESC, e.id DESC
    LIMIT ?
  `).all(...params, perPage + 1) as ExpenseRecord[];

  const hasMore = rows.length > perPage;
  const expenses = hasMore ? rows.slice(0, perPage) : rows;
  return {
    expenses,
    nextCursor: hasMore ? expenses[expenses.length - 1].id : null,
  };
}

export function createExpense(
  db: ReturnType<typeof getDatabase>,
  input: CreateExpenseInput,
): ExpenseRecord {
  if (!input.actorUserId) throw new ExpenseError(400, 'actor_user_id is required');
  const category = assertCategory(input.category);
  const amount = assertAmount(input.amount);
  const paymentMethod = assertPaymentMethod(input.paymentMethod);
  const expenseDate = assertExpenseDate(input.expenseDate);
  assertNotInClosedPeriod(db, expenseDate);
  const description = trimToNull(input.description);
  if (description && description.length > 200) {
    throw new ExpenseError(400, 'description is too long (max 200 characters)');
  }
  const notes = trimToNull(input.notes);
  if (notes && notes.length > 500) {
    throw new ExpenseError(400, 'notes is too long (max 500 characters)');
  }

  const id = input.id || newId();

  withTxn(() => {
    db.prepare(`
      INSERT INTO expenses (
        id, category, description, amount, payment_method,
        expense_date, created_by, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, category, description, amount, paymentMethod, expenseDate, input.actorUserId, notes, now());
  });

  return getExpense(db, id);
}

/** Deletes an expense row permanently (audit trail lives in the app logs). */
export function deleteExpense(
  db: ReturnType<typeof getDatabase>,
  id: string,
  _actorUserId: string,
): void {
  withTxn(() => {
    const expense = getExpense(db, id);
    assertNotInClosedPeriod(db, expense.expense_date);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  });
}
