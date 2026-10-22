import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireAnyPermission, requirePermission } from '../services/authorization';
import {
  createPayrollEmployee,
  createPayrollPayment,
  createPayrollRun,
  createWithholdingPayment,
  deletePayrollPayment,
  deleteWithholdingPayment,
  getPayrollRun,
  listPayrollEmployees,
  listPayrollPayments,
  listPayrollRuns,
  listWithholdingPayments,
  postPayrollRun,
  reversePayrollRun,
  updatePayrollEmployee,
  updatePayrollRun,
} from '../services/payroll';
import {
  recordPayrollPaymentAccounting,
  recordPayrollPaymentDeletion,
  recordPayrollRunAccounting,
  recordPayrollRunReversal,
  recordPayrollWithholdingAccounting,
  recordPayrollWithholdingDeletion,
} from '../services/accounting-payroll-adapter';

const router = Router();
const requirePayrollAccess = requireAnyPermission('payroll.view', 'payroll.manage');

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
  if (statusCode >= 500) console.error('[API] Payroll error:', error);
  res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
}

function actorId(req: Request): string {
  return String((req as Request & { user?: { userId?: string } }).user?.userId || '');
}

function requireActor(req: Request, res: Response): string | null {
  const actor = actorId(req);
  if (!actor) res.status(403).json({ error: 'Authentication required' });
  return actor || null;
}

function queryId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw Object.assign(new Error('run_id must be a non-empty string of at most 128 characters'), { statusCode: 400 });
  }
  return value.trim();
}

router.get('/employees', requirePayrollAccess, (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
    res.json({ employees: listPayrollEmployees(getDatabase(), includeInactive) });
  } catch (error: unknown) { sendError(res, error); }
});

router.get('/customers', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const customers = getDatabase().prepare(`
      SELECT DISTINCT c.id, c.name
      FROM customers c
      LEFT JOIN payroll_employees e ON e.customer_id = c.id
      WHERE (c.is_active = 1 OR e.id IS NOT NULL) AND (? = '' OR c.name LIKE ?)
      ORDER BY c.name COLLATE NOCASE LIMIT 500
    `).all(search, `%${search}%`);
    res.json({ customers });
  } catch (error: unknown) { sendError(res, error); }
});

router.post('/employees', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    res.status(201).json({ employee: createPayrollEmployee(getDatabase(), {
      name: body.name, employeeCode: body.employee_code, notes: body.notes, customerId: body.customer_id,
    }, actor) });
  }
  catch (error: unknown) { sendError(res, error); }
});

router.put('/employees/:id', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    res.json({ employee: updatePayrollEmployee(getDatabase(), String(req.params.id), {
      name: body.name, employeeCode: body.employee_code, notes: body.notes, isActive: body.is_active, customerId: body.customer_id,
    }, actor) });
  } catch (error: unknown) { sendError(res, error); }
});

router.get('/runs', requirePayrollAccess, (_req: Request, res: Response) => {
  try { res.json({ runs: listPayrollRuns(getDatabase()) }); }
  catch (error: unknown) { sendError(res, error); }
});

router.post('/runs', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    const run = createPayrollRun(getDatabase(), { periodStart: body.period_start, periodEnd: body.period_end, items: body.items }, actor);
    res.status(201).json({ run });
  } catch (error: unknown) { sendError(res, error); }
});

router.get('/runs/:id', requirePayrollAccess, (req: Request, res: Response) => {
  try { res.json({ run: getPayrollRun(getDatabase(), String(req.params.id)) }); }
  catch (error: unknown) { sendError(res, error); }
});

router.put('/runs/:id', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    const run = updatePayrollRun(getDatabase(), String(req.params.id), { periodStart: body.period_start, periodEnd: body.period_end, items: body.items }, actor);
    res.json({ run });
  } catch (error: unknown) { sendError(res, error); }
});

router.post('/runs/:id/post', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const run = postPayrollRun(getDatabase(), String(req.params.id), actor);
    recordPayrollRunAccounting(run.id, actor);
    res.json({ run: getPayrollRun(getDatabase(), run.id) });
  } catch (error: unknown) { sendError(res, error); }
});

router.post('/runs/:id/reverse', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    const date = typeof body.entry_date === 'string' ? body.entry_date : new Date().toISOString().slice(0, 10);
    const run = reversePayrollRun(getDatabase(), String(req.params.id), date, actor);
    recordPayrollRunReversal(run.id, actor, date);
    res.json({ run: getPayrollRun(getDatabase(), run.id) });
  } catch (error: unknown) { sendError(res, error); }
});

router.get('/payments', requirePayrollAccess, (req: Request, res: Response) => {
  try { res.json({ payments: listPayrollPayments(getDatabase(), queryId(req.query.run_id)) }); }
  catch (error: unknown) { sendError(res, error); }
});

router.post('/runs/:id/payments', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    const payment = createPayrollPayment(getDatabase(), {
      runId: String(req.params.id), itemId: body.payroll_run_item_id, amount: body.amount,
      paymentMethod: body.payment_method, paidAt: body.paid_at, reference: body.reference, notes: body.notes, actorUserId: actor,
    });
    recordPayrollPaymentAccounting(payment.id, actor);
    res.status(201).json({ payment });
  } catch (error: unknown) { sendError(res, error); }
});

router.delete('/payments/:id', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const date = typeof req.body?.entry_date === 'string' ? req.body.entry_date : new Date().toISOString().slice(0, 10);
    const payment = deletePayrollPayment(getDatabase(), String(req.params.id), actor, date, req.body?.deletion_reason);
    recordPayrollPaymentDeletion(payment.id, actor, date);
    res.json({ payment });
  } catch (error: unknown) { sendError(res, error); }
});

router.get('/withholding-payments', requirePayrollAccess, (req: Request, res: Response) => {
  try { res.json({ payments: listWithholdingPayments(getDatabase(), queryId(req.query.run_id)) }); }
  catch (error: unknown) { sendError(res, error); }
});

router.post('/runs/:id/withholding-payments', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const body = req.body || {};
    const payment = createWithholdingPayment(getDatabase(), {
      runId: String(req.params.id), amount: body.amount, paymentMethod: body.payment_method,
      paidAt: body.paid_at, reference: body.reference, notes: body.notes, actorUserId: actor,
    });
    recordPayrollWithholdingAccounting(payment.id, actor);
    res.status(201).json({ payment });
  } catch (error: unknown) { sendError(res, error); }
});

router.delete('/withholding-payments/:id', requirePermission('payroll.manage'), (req: Request, res: Response) => {
  try {
    const actor = requireActor(req, res);
    if (!actor) return;
    const date = typeof req.body?.entry_date === 'string' ? req.body.entry_date : new Date().toISOString().slice(0, 10);
    const payment = deleteWithholdingPayment(getDatabase(), String(req.params.id), actor, date, req.body?.deletion_reason);
    recordPayrollWithholdingDeletion(payment.id, actor, date);
    res.json({ payment });
  } catch (error: unknown) { sendError(res, error); }
});

export const payrollRoutes = router;
