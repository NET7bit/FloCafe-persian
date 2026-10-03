import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  ExpensePaymentMethod,
  createExpense,
  deleteExpense,
  getExpense,
  getExpenseSummary,
  listExpenses,
} from '../services/expenses';
import {
  recordExpenseAccounting,
  recordExpenseDeletionAccounting,
} from '../services/accounting-expenses-adapter';

const router = Router();

const PAYMENT_METHODS: ExpensePaymentMethod[] = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
  if (statusCode >= 500) console.error('[API] Internal error:', error);
  res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw Object.assign(new Error(`${field} must be a non-empty string of at most 128 characters`), { statusCode: 400 });
  }
  return value.trim();
}

function actorId(req: Request): string {
  return String((req as Request & { user?: { userId?: string } }).user?.userId || '');
}

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const category = queryString(req.query.category, 'category');
    const paymentMethod = queryString(req.query.payment_method, 'payment_method') as ExpensePaymentMethod | undefined;
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'payment_method is invalid' });
    }
    const fromDate = queryString(req.query.from_date, 'from_date');
    const toDate = queryString(req.query.to_date, 'to_date');
    const search = queryString(req.query.search, 'search');
    const rawPerPage = req.query.per_page;
    const requestedPerPage = rawPerPage === undefined ? NaN : Number(rawPerPage);
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 200)
      : 50;
    const beforeId = queryString(req.query.before_id, 'before_id');

    const page = listExpenses(getDatabase(), {
      category, paymentMethod, fromDate, toDate, search, perPage, beforeId,
    });
    res.json({
      expenses: page.expenses,
      ...(page.nextCursor !== null && { nextCursor: page.nextCursor }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/summary', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const fromDate = queryString(req.query.from_date, 'from_date');
    const toDate = queryString(req.query.to_date, 'to_date');
    const summary = getExpenseSummary(getDatabase(), { from: fromDate, to: toDate });
    res.json({ summary });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const body = req.body || {};
    const expense = createExpense(getDatabase(), {
      category: body.category,
      description: body.description,
      amount: body.amount,
      paymentMethod: body.payment_method,
      expenseDate: body.expense_date,
      notes: body.notes,
      actorUserId: actor,
    });
    recordExpenseAccounting(expense.id, actor);
    res.status(201).json({ expense });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const expense = getExpense(getDatabase(), String(req.params.id));
    res.json({ expense });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    deleteExpense(getDatabase(), String(req.params.id), actor);
    recordExpenseDeletionAccounting(String(req.params.id), actor);
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const expenseRoutes = router;
