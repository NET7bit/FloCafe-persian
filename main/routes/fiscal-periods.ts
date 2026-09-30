/**
 * Fiscal periods API: month/year lock windows with owner-PIN reopen.
 * All routes are owner/manager; reopening additionally requires an owner PIN.
 */
import { Router, Request, Response } from 'express';
import { getDatabase, withTxn } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import { checkPinRateLimit } from './orders';
import {
  FiscalPeriodError,
  listFiscalPeriods,
  createFiscalPeriod,
  closeFiscalPeriod,
  reopenFiscalPeriod,
  deleteFiscalPeriod,
} from '../services/fiscal-periods';

function clientIpOf(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

const router = Router();

function sendError(res: Response, error: unknown): void {
  if (error instanceof FiscalPeriodError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: 'Unable to process fiscal period request' });
}

function actorId(req: Request): string | null {
  const actor = (req as unknown as { user?: { userId?: unknown } }).user?.userId;
  return actor === undefined || actor === null ? null : String(actor);
}

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const status = req.query.status === 'open' || req.query.status === 'closed' ? req.query.status : undefined;
    res.json({ periods: listFiscalPeriods(getDatabase(), status) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    res.json({ period: requirePeriod(getDatabase(), String(req.params.id)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const body = req.body || {};
    const period = createFiscalPeriod(getDatabase(), {
      periodType: body.period_type,
      startDate: body.start_date,
      name: body.name ?? null,
      actorUserId: actor,
    });
    res.status(201).json({ period });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/close', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const period = closeFiscalPeriod(getDatabase(), String(req.params.id), actor);
    res.json({ period });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/:id/reopen', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const body = req.body || {};
    // Override PINs are brute-force sensitive; reuse the refund PIN limiter.
    if (!checkPinRateLimit(`pin:${clientIpOf(req)}:fiscal-reopen`)) {
      return res.status(429).json({ error: 'Too many PIN attempts. Try again in 15 minutes.' });
    }
    const period = reopenFiscalPeriod(getDatabase(), String(req.params.id), body.override_pin, body.approver_id, actor);
    res.json({ period });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    deleteFiscalPeriod(getDatabase(), String(req.params.id), actor);
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

function requirePeriod(db: ReturnType<typeof getDatabase>, id: string) {
  const row = db.prepare('SELECT * FROM fiscal_periods WHERE id = ?').get(id);
  if (!row) throw new FiscalPeriodError(404, 'Fiscal period not found');
  return row;
}

export { router as fiscalPeriodRoutes };
