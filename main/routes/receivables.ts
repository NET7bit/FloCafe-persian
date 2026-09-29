import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  ReceivableEntryType,
  createReceivableEntry,
  deleteReceivableEntry,
  getCustomerStatement,
  getReceivableEntry,
  listCustomerBalances,
  listReceivableEntries,
} from '../services/receivables';

const router = Router();

const ENTRY_TYPES: ReceivableEntryType[] = ['charge', 'settlement', 'adjustment'];

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
    const customerId = queryString(req.query.customer_id, 'customer_id');
    const entryType = queryString(req.query.type, 'type') as ReceivableEntryType | undefined;
    if (entryType && !ENTRY_TYPES.includes(entryType)) {
      return res.status(400).json({ error: 'type is invalid' });
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

    const page = listReceivableEntries(getDatabase(), {
      customerId, entryType, fromDate, toDate, search, perPage, beforeId,
    });
    res.json({
      entries: page.entries,
      ...(page.nextCursor !== null && { nextCursor: page.nextCursor }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/balances', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const balances = listCustomerBalances(getDatabase());
    res.json({ balances });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/summary', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const customerId = queryString(req.query.customer_id, 'customer_id');
    const fromDate = queryString(req.query.from_date, 'from_date');
    const toDate = queryString(req.query.to_date, 'to_date');

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (customerId) {
      conditions.push('customer_id = ?');
      params.push(customerId);
    }
    if (fromDate) {
      conditions.push('entry_date >= ?');
      params.push(fromDate);
    }
    if (toDate) {
      conditions.push('entry_date <= ?');
      params.push(toDate);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const db = getDatabase();
    const totals = db.prepare(`
      SELECT
        ROUND(COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0), 2) AS charged,
        ROUND(COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount END), 0), 2) AS settled
      FROM receivable_entries ${whereSql}
    `).get(...params) as { charged: number; settled: number };

    res.json({
      summary: {
        charged: totals.charged,
        settled: totals.settled,
        net: Math.round((totals.charged - totals.settled) * 100) / 100,
      },
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/statement', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const customerId = queryString(req.query.customer_id, 'customer_id');
    if (!customerId) return res.status(400).json({ error: 'customer_id is required' });
    const fromDate = queryString(req.query.from_date, 'from_date');
    const toDate = queryString(req.query.to_date, 'to_date');
    const rawPerPage = req.query.per_page;
    const requestedPerPage = rawPerPage === undefined ? NaN : Number(rawPerPage);
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 200)
      : 50;
    const statement = getCustomerStatement(getDatabase(), customerId, { fromDate, toDate, perPage });
    res.json({ statement });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const body = req.body || {};
    const entry = createReceivableEntry(getDatabase(), {
      customerId: body.customer_id,
      entryType: body.entry_type,
      direction: body.direction,
      amount: body.amount,
      paymentMethod: body.payment_method,
      reference: body.reference,
      description: body.description,
      entryDate: body.entry_date,
      notes: body.notes,
      actorUserId: actor,
    });
    res.status(201).json({ entry });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const entry = getReceivableEntry(getDatabase(), String(req.params.id));
    res.json({ entry });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    deleteReceivableEntry(getDatabase(), String(req.params.id), actor);
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const receivableRoutes = router;
