import { Router, Request, Response } from 'express';
import { requirePermission } from '../services/authorization';
import {
  createManualJournal,
  createOpeningBalance,
  getJournal,
  listAccounts,
  reverseJournal,
} from '../services/accounting';
import {
  listUnresolvedReceivableSettlements,
  reprocessReceivableAccounting,
} from '../services/accounting-receivables-adapter';
import {
  isPurchaseSourceKind,
  listUnresolvedPurchaseEvents,
  reprocessPurchaseAccounting,
} from '../services/accounting-purchases-adapter';
import {
  listUnresolvedExpenses,
  reprocessExpenseAccounting,
} from '../services/accounting-expenses-adapter';
import {
  listUnresolvedCogsEvents,
  reprocessCogsAccounting,
} from '../services/accounting-cogs-adapter';
import {
  getGeneralLedger,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getIntegrityChecks,
} from '../services/accounting-reports';
import { getReconciliation } from '../services/accounting-reconciliation';

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

router.get('/accounts', requirePermission('accounting.view'), (_req: Request, res: Response) => {
  try {
    res.json({ accounts: listAccounts({ activeOnly: true }) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Generic manual adjustment — never an opening balance or a module event.
router.post('/manual-journal', requirePermission('accounting.manage'), (req: Request, res: Response) => {
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
router.post('/opening-balance', requirePermission('accounting.manage'), (req: Request, res: Response) => {
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

router.get('/journals/:id', requirePermission('accounting.view'), (req: Request, res: Response) => {
  try {
    res.json({ journal: getJournal(String(req.params.id)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/journals/:id/reverse', requirePermission('accounting.manage'), (req: Request, res: Response) => {
  try {
    const journal = reverseJournal(String(req.params.id), actorId(req), reversalDate(req));
    res.status(201).json({ journal });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Read-only, derived list of receivable settlements whose accounting
// projection is missing (no journal) or incomplete (no reversal).
router.get('/receivables/unresolved', requirePermission('accounting.view'), (_req: Request, res: Response) => {
  try {
    res.json({ events: listUnresolvedReceivableSettlements() });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Explicitly completes the accounting projection for one receivable source
// event; the event id is the only client input, identity is server-derived.
router.post('/receivables/:id/reprocess', requirePermission('accounting.manage'), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    res.json({ result: reprocessReceivableAccounting(String(req.params.id), actor) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Read-only, derived list of purchase-invoice, supplier-payment and
// purchase-return events whose accounting projection is missing or incomplete.
router.get('/purchases/unresolved', requirePermission('accounting.view'), (_req: Request, res: Response) => {
  try {
    res.json({ events: listUnresolvedPurchaseEvents() });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Explicitly completes the accounting projection for one purchase-side source
// event; kind + source id identify the row, identity is server-derived.
router.post('/purchases/:kind/:id/reprocess', requirePermission('accounting.manage'), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    const kind = String(req.params.kind);
    if (!isPurchaseSourceKind(kind)) {
      return res.status(400).json({ error: 'kind is invalid' });
    }
    res.json({ result: reprocessPurchaseAccounting(kind, String(req.params.id), actor) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Read-only, derived list of expenses whose accounting projection is missing
// (no journal) or incomplete (no reversal).
router.get('/expenses/unresolved', requirePermission('accounting.view'), (_req: Request, res: Response) => {
  try {
    res.json({ events: listUnresolvedExpenses() });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Explicitly completes the accounting projection for one expense source
// event; the expense id is the only client input, identity is server-derived.
router.post('/expenses/:id/reprocess', requirePermission('accounting.manage'), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    res.json({ result: reprocessExpenseAccounting(String(req.params.id), actor) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Read-only, derived list of order items whose COGS projection is missing or
// incomplete (consumed without a journal, or refunded without a reversal).
router.get('/cogs/unresolved', requirePermission('accounting.view'), (_req: Request, res: Response) => {
  try {
    res.json({ events: listUnresolvedCogsEvents() });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Explicitly completes the accounting projection for one order item; the item
// id is the only client input, identity is server-derived.
router.post('/cogs/:id/reprocess', requirePermission('accounting.manage'), (req: Request, res: Response) => {
  try {
    const actor = actorId(req);
    if (!actor) return res.status(403).json({ error: 'Authentication required' });
    res.json({ result: reprocessCogsAccounting(String(req.params.id), actor) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// ── Reports (Milestone H): read-only projections of the ledger ──

function queryString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

function reportRange(req: Request): { from: string | null; to: string | null; periodId: string | null } {
  return {
    from: queryString(req.query.from),
    to: queryString(req.query.to),
    periodId: queryString(req.query.period_id),
  };
}

router.get('/reports/general-ledger', requirePermission('accounting.view'), (req: Request, res: Response) => {
  try {
    res.json({
      report: getGeneralLedger({
        ...reportRange(req),
        accountCode: queryString(req.query.account_code),
        accountId: queryString(req.query.account_id),
        sourceModule: queryString(req.query.source_module),
        sourceId: queryString(req.query.source_id),
        reference: queryString(req.query.reference),
      }),
    });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/reports/trial-balance', requirePermission('accounting.view'), (req: Request, res: Response) => {
  try {
    res.json({ report: getTrialBalance(reportRange(req)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/reports/profit-loss', requirePermission('accounting.view'), (req: Request, res: Response) => {
  try {
    res.json({ report: getProfitAndLoss(reportRange(req)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/reports/balance-sheet', requirePermission('accounting.view'), (req: Request, res: Response) => {
  try {
    res.json({ report: getBalanceSheet(reportRange(req)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/reports/reconciliation', requirePermission('accounting.view'), (req: Request, res: Response) => {
  try {
    res.json({ report: getReconciliation(reportRange(req)) });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

// Structural ledger invariants; read-only.
router.get('/reports/integrity', requirePermission('accounting.view'), (_req: Request, res: Response) => {
  try {
    res.json({ report: getIntegrityChecks() });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const accountingRoutes = router;
