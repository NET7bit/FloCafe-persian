import { Router, Request, Response } from 'express';
import { getDatabase } from '../db';
import { requireRole } from '../middleware/security';
import { ROLE_ACCESS } from '../../shared/role-permissions';
import {
  createSupplier,
  getSupplier,
  listSuppliers,
  softDeleteSupplier,
  updateSupplier,
} from '../services/suppliers';

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

router.get('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const includeInactive = req.query.include_inactive === 'true' || req.query.include_inactive === '1';
    const search = queryString(req.query.search, 'search');
    const suppliers = listSuppliers(getDatabase(), { includeInactive, search });
    res.json({ suppliers });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.post('/', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const actorId = String((req as Request & { user?: { userId?: string } }).user?.userId || '');
    if (!actorId) return res.status(403).json({ error: 'Authentication required' });
    const supplier = createSupplier(getDatabase(), {
      name: body.name,
      code: body.code,
      phone: body.phone,
      mobile: body.mobile,
      nationalId: body.national_id,
      economicCode: body.economic_code,
      address: body.address,
      notes: body.notes,
      isActive: body.is_active,
    });
    res.status(201).json({ supplier });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.get('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const supplier = getSupplier(getDatabase(), String(req.params.id));
    res.json({ supplier });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.put('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const supplier = updateSupplier(getDatabase(), String(req.params.id), {
      name: body.name,
      code: body.code,
      phone: body.phone,
      mobile: body.mobile,
      nationalId: body.national_id,
      economicCode: body.economic_code,
      address: body.address,
      notes: body.notes,
      isActive: body.is_active,
    });
    res.json({ supplier });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

router.delete('/:id', requireRole(...ROLE_ACCESS.ownerManager), (req: Request, res: Response) => {
  try {
    softDeleteSupplier(getDatabase(), String(req.params.id));
    res.json({ success: true });
  } catch (error: unknown) {
    sendError(res, error);
  }
});

export const supplierRoutes = router;
