import { Router, Request, Response } from 'express';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  createManualJournal,
  createOpeningBalance,
  getJournal,
  listAccounts,
  reverseJournal,
} from '../services/accounting';

const router = Router();

function sendError(res: Response, error: unknown): void {
  const details = error as { statusCode?: unknown; message?: unknown };
  const statusCode = Number.isInteger(details.statusCode) ? details.statusCode as number : 500;
  if (statusCode >= 500) console.error('[API] Internal error:', error);
  res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : details.message });
}

function actorId(req: Request): string {
  return String((req as Request & { user?: { userId?: string } }).user?.userId || '');
}

function linePayload(value: unknown): Array<{ account_id?: unknown; direction?: unknown; amount?: unknown; line_description?: unknown }> {
  return Array.isArray(value) ? value : [];
}

function reversalDate(req: Request): string {
  const body = (req.body || {}) as { entry_date?: unknown };
  return typeof body.entry_date === 'string' && body.entry_date.trim().length > 0
    ? body.entry_date.trim()
    : new Date().toISOString().slice(0, 10);
}

router.get('/accounts', requireRole(...ROLE_ACCESS.ownerManager), (_req: Request, res: Response) => {
  try {
    res.json({ accounts: listAccounts({ activeOnly: true }) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Generic manual adjustment — never an opening balance or a module event.
router.post('/manual-journal', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const journal = createManualJournal({
      entryDate: body.entry_date,
      description: body.description,
      reference: body.reference,
      idempotencyKey: body.idempotency_key,
      actorUserId: actorId(req),
      lines: linePayload(body.lines).map((l: any) => ({
        accountId: l?.account_id,
        direction: l?.direction,
        amount: l?.amount,
        lineDescription: l?.line_description,
      })),
    });
    res.status(201).json({ journal });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Initial-balance transfer only — not a day-to-day adjustment surface.
router.post('/opening-balance', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const journal = createOpeningBalance({
      entryDate: body.entry_date,
      description: body.description,
      reference: body.reference,
      actorUserId: actorId(req),
      lines: linePayload(body.lines).map((l: any) => ({
        accountId: l?.account_id,
        amount: l?.amount,
        lineDescription: l?.line_description,
      })),
    });
    res.status(201).json({ journal });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/journals/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    res.json({ journal: getJournal(String(req.params.id)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/journals/:id/reverse', requireRole(...ROLE_ACCESS.owner), (req: Request, res: Response) => {
  try {
    const journal = reverseJournal(String(req.params.id), actorId(req), reversalDate(req));
    res.status(201).json({ journal });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const accountingRoutes = router;
