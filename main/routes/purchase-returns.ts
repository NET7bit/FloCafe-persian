import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  createPurchaseReturn,
  deletePurchaseReturn,
  getPurchaseReturn,
  listPurchaseReturns,
} from '../services/purchase-returns';

const router = Router();

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
    const purchaseInvoiceId = queryString(req.query.purchase_invoice_id, 'purchase_invoice_id');
    const supplierId = queryString(req.query.supplier_id, 'supplier_id');
    const search = queryString(req.query.search, 'search');
    const rawPerPage = req.query.per_page;
    const requestedPerPage = rawPerPage === undefined ? NaN : Number(rawPerPage);
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 200)
      : 50;
    const beforeId = queryString(req.query.before_id, 'before_id');

    const page = listPurchaseReturns(getDatabase(), { purchaseInvoiceId, supplierId, search, perPage, beforeId });
    res.json({
      returns: page.returns,
      ...(page.nextCursor !== null && { nextCursor: page.nextCursor }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const body = req.body || {};
    if (!Array.isArray(body.items)) {
      return res.status(400).json({ error: 'items must be an array' });
    }
    const record = createPurchaseReturn(getDatabase(), {
      purchaseInvoiceId: body.purchase_invoice_id,
      returnDate: body.return_date,
      reason: body.reason,
      notes: body.notes,
      items: body.items.map((item: any) => ({
        purchaseInvoiceItemId: item.purchase_invoice_item_id,
        quantity: item.quantity,
      })),
      actorUserId: actor,
    });
    res.status(201).json({ return: record });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const record = getPurchaseReturn(getDatabase(), String(req.params.id));
    res.json({ return: record });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const record = deletePurchaseReturn(getDatabase(), String(req.params.id), actor, req.body?.deletion_reason);
    res.json({ return: record });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const purchaseReturnRoutes = router;
