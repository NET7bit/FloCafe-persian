import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  SupplierPaymentMethod,
  createSupplierPayment,
  deleteSupplierPayment,
  getSupplierPaidTotal,
  getSupplierPayment,
  listSupplierPayments,
} from '../services/supplier-payments';
import {
  recordSupplierPaymentAccounting,
  recordSupplierPaymentDeletionAccounting,
} from '../services/accounting-purchases-adapter';

const router = Router();

const PAYMENT_METHODS: SupplierPaymentMethod[] = ['cash', 'card', 'bank_transfer', 'cheque', 'other'];

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
    const purchaseInvoiceId = queryString(req.query.purchase_invoice_id, 'purchase_invoice_id');
    const paymentMethod = queryString(req.query.payment_method, 'payment_method') as SupplierPaymentMethod | undefined;
    if (paymentMethod && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ error: 'payment_method is invalid' });
    }
    const search = queryString(req.query.search, 'search');
    const rawPerPage = req.query.per_page;
    const requestedPerPage = rawPerPage === undefined ? NaN : Number(rawPerPage);
    const perPage = Number.isInteger(requestedPerPage) && requestedPerPage > 0
      ? Math.min(requestedPerPage, 200)
      : 50;
    const beforeId = queryString(req.query.before_id, 'before_id');

    const page = listSupplierPayments(getDatabase(), { supplierId, purchaseInvoiceId, paymentMethod, search, perPage, beforeId });
    res.json({
      payments: page.payments,
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
    const payment = createSupplierPayment(getDatabase(), {
      supplierId: body.supplier_id,
      purchaseInvoiceId: body.purchase_invoice_id,
      amount: body.amount,
      paymentMethod: body.payment_method,
      reference: body.reference,
      paidAt: body.paid_at,
      notes: body.notes,
      actorUserId: actor,
    });
    recordSupplierPaymentAccounting(payment.id, actor);
    res.status(201).json({ payment });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/supplier-totals/:supplierId', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const total = getSupplierPaidTotal(getDatabase(), String(req.params.supplierId));
    res.json({ total });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const payment = getSupplierPayment(getDatabase(), String(req.params.id));
    res.json({ payment });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    deleteSupplierPayment(getDatabase(), String(req.params.id), actor);
    recordSupplierPaymentDeletionAccounting(String(req.params.id), actor);
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const supplierPaymentRoutes = router;
