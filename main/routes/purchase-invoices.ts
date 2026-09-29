import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  PurchaseInvoiceStatus,
  cancelPurchaseInvoice,
  createPurchaseInvoice,
  getPurchaseInvoice,
  listPurchaseInvoices,
  postPurchaseInvoice,
  updatePurchaseInvoice,
} from '../services/purchase-invoices';

const router = Router();

const STATUSES: PurchaseInvoiceStatus[] = ['draft', 'posted', 'partially_paid', 'paid', 'cancelled'];

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
    const supplierId = queryString(req.query.supplier_id, 'supplier_id');
    const status = queryString(req.query.status, 'status') as PurchaseInvoiceStatus | undefined;
    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: 'status is invalid' });
    }
    const search = queryString(req.query.search, 'search');
    const rawPerPage = req.query.per_page;
    const requestedPerPage = rawPerPage === undefined ? NaN : Number(rawPerPage);
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 200)
      : 50;
    const beforeId = queryString(req.query.before_id, 'before_id');

    const page = listPurchaseInvoices(getDatabase(), { supplierId, status, search, perPage, beforeId });
    res.json({
      invoices: page.invoices,
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
    const invoice = createPurchaseInvoice(getDatabase(), {
      supplierId: body.supplier_id,
      invoiceDate: body.invoice_date,
      dueDate: body.due_date,
      notes: body.notes,
      items: body.items.map((item: any) => ({
        supplyId: item.supply_id,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unit_price,
        discountAmount: item.discount_amount,
        taxAmount: item.tax_amount,
      })),
      actorUserId: actor,
    });
    res.status(201).json({ invoice });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const invoice = getPurchaseInvoice(getDatabase(), String(req.params.id));
    res.json({ invoice });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body.items)
      ? body.items.map((item: any) => ({
        supplyId: item.supply_id,
        quantity: item.quantity,
        unit: item.unit,
        unitPrice: item.unit_price,
        discountAmount: item.discount_amount,
        taxAmount: item.tax_amount,
      }))
      : undefined;
    const invoice = updatePurchaseInvoice(getDatabase(), String(req.params.id), {
      dueDate: body.due_date,
      notes: body.notes,
      items,
    });
    res.json({ invoice });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/post', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const invoice = postPurchaseInvoice(getDatabase(), String(req.params.id), actor);
    res.json({ invoice });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/cancel', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const invoice = cancelPurchaseInvoice(getDatabase(), String(req.params.id), actor);
    res.json({ invoice });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const purchaseInvoiceRoutes = router;
