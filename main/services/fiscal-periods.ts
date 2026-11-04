/**
 * Fiscal periods: month/year lock windows for financial documents.
 * Period membership is derived from document business dates via the tenant's
 * configured calendar (business_day_start_time + timezone) — no per-document
 * FK, no stored totals. Closed periods reject new or edited documents;
 * reopening requires an active owner's override PIN.
 */
import { Database } from 'better-sqlite3';
import { randomBytes } from 'crypto';
import {
  getSettingValue, now, withTxn, verifyPin,
  localDateInTimezone, tenantBusinessDayStartTime, parseDbTimestamp,
} from '../db';
import { ROLE_ACCESS } from '../../shared/role-permissions';

export class FiscalPeriodError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_TYPES = ['month', 'year'];
const NAME_MAX = 60;

export interface FiscalPeriodRecord {
  id: string;
  period_type: 'month' | 'year';
  start_date: string;
  end_date: string;
  status: 'open' | 'closed';
  closed_at: string | null;
  closed_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  name: string | null;
  created_at: string;
}

function newId(): string {
  return `fp_${randomBytes(12).toString('hex')}`;
}

function assertPeriodDate(date: unknown, field: string): string {
  const value = String(date ?? '');
  if (!DATE_RE.test(value)) throw new FiscalPeriodError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  return value;
}

/** The inclusive end date implied by a period's type and start date. */
function periodEndDateFor(periodType: 'month' | 'year', startDate: string): string {
  const [year, month] = startDate.split('-').map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new FiscalPeriodError(400, 'start_date is invalid');
  }
  if (periodType === 'year') {
    if (month !== 1 || startDate.slice(5) !== '01-01') {
      throw new FiscalPeriodError(400, 'Year periods must start on January 1');
    }
    return `${year}-12-31`;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${startDate.slice(0, 8)}${String(lastDay).padStart(2, '0')}`;
}

/** The tenant's business-local calendar date for a stored instant. */
export function fiscalDateForInstant(instant: string | null | undefined): string {
  if (!instant) return '';
  const timezone = getSettingValue('timezone') || 'UTC';
  return localDateInTimezone(parseDbTimestamp(instant), timezone, tenantBusinessDayStartTime());
}

/** Document business date: explicit doc date when valid, else the instant's business date. */
export function resolveDocumentBusinessDate(docDate: string | null | undefined, createdAt: string | null | undefined): string {
  if (docDate && DATE_RE.test(docDate)) return docDate;
  return fiscalDateForInstant(createdAt);
}

/** 409 if the given business date falls inside a closed period. */
export function assertNotInClosedPeriod(db: Database, docDate: string): void {
  if (!docDate) return;
  const closed = db.prepare(`
    SELECT period_type, start_date, end_date FROM fiscal_periods
    WHERE status = 'closed' AND start_date <= ? AND end_date >= ?
    LIMIT 1
  `).get(docDate, docDate) as { period_type: string; start_date: string; end_date: string } | undefined;
  if (closed) {
    throw new FiscalPeriodError(409, `Fiscal period is closed (${closed.period_type}: ${closed.start_date} → ${closed.end_date})`);
  }
}

export function getFiscalPeriod(db: Database, id: string): FiscalPeriodRecord {
  const row = db.prepare('SELECT * FROM fiscal_periods WHERE id = ?').get(id) as FiscalPeriodRecord | undefined;
  if (!row) throw new FiscalPeriodError(404, 'Fiscal period not found');
  return row;
}

export function listFiscalPeriods(db: Database, status?: 'open' | 'closed'): FiscalPeriodRecord[] {
  if (status) {
    return db.prepare('SELECT * FROM fiscal_periods WHERE status = ? ORDER BY start_date DESC').all(status) as FiscalPeriodRecord[];
  }
  return db.prepare('SELECT * FROM fiscal_periods ORDER BY start_date DESC').all() as FiscalPeriodRecord[];
}

export function createFiscalPeriod(
  db: Database,
  input: { periodType: 'month' | 'year'; startDate: string; name?: string | null; actorUserId: string },
): FiscalPeriodRecord {
  if (!input.actorUserId) throw new FiscalPeriodError(400, 'actor_user_id is required');
  const startDate = assertPeriodDate(input.startDate, 'start_date');
  if (!PERIOD_TYPES.includes(input.periodType)) {
    throw new FiscalPeriodError(400, 'period_type must be month or year');
  }
  const endDate = periodEndDateFor(input.periodType, startDate);
  const name = input.name ? String(input.name).trim().slice(0, NAME_MAX) || null : null;

  return withTxn(() => {
    const overlap = db.prepare(`
      SELECT period_type FROM fiscal_periods
      WHERE start_date <= ? AND end_date >= ?
      LIMIT 1
    `).get(endDate, startDate) as { period_type: string } | undefined;
    if (overlap) {
      throw new FiscalPeriodError(409, `Period overlaps an existing ${overlap.period_type} period`);
    }
    const id = newId();
    db.prepare(`
      INSERT INTO fiscal_periods (id, period_type, start_date, end_date, status, name, created_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(id, input.periodType, startDate, endDate, name, now());
    return getFiscalPeriod(db, id);
  });
}

export function closeFiscalPeriod(db: Database, id: string, actorUserId: string): FiscalPeriodRecord {
  if (!actorUserId) throw new FiscalPeriodError(400, 'actor_user_id is required');
  return withTxn(() => {
    const period = getFiscalPeriod(db, id);
    if (period.status === 'closed') throw new FiscalPeriodError(409, 'Period is already closed');
    if (period.end_date >= fiscalDateForInstant(now())) {
      throw new FiscalPeriodError(409, 'Cannot close a period that has not ended');
    }
    db.prepare("UPDATE fiscal_periods SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?")
      .run(now(), actorUserId, id);
    return getFiscalPeriod(db, id);
  });
}

/** Reopen approver must be an active owner with a real PIN hash. */
function resolveOwnerApprover(db: Database, overridePin: string, approverId: string | null | undefined): { id: string } | null {
  const allowedRoles = ROLE_ACCESS.owner;
  const placeholders = allowedRoles.map(() => '?').join(', ');
  if (!approverId) return null;
  const candidate = db.prepare(
    `SELECT * FROM users WHERE id = ? AND pin_hash IS NOT NULL AND role IN (${placeholders}) AND is_active = 1`,
  ).get(approverId, ...allowedRoles) as { id: string; pin_hash: string } | undefined;
  return candidate && verifyPin(candidate.pin_hash, overridePin) ? { id: candidate.id } : null;
}

export function reopenFiscalPeriod(
  db: Database,
  id: string,
  overridePin: string,
  approverId: string | null | undefined,
  actorUserId: string,
): FiscalPeriodRecord {
  if (!actorUserId) throw new FiscalPeriodError(400, 'actor_user_id is required');
  if (!overridePin) throw new FiscalPeriodError(400, 'override_pin is required');
  return withTxn(() => {
    const period = getFiscalPeriod(db, id);
    if (period.status === 'open') throw new FiscalPeriodError(409, 'Period is already open');
    const approver = resolveOwnerApprover(db, overridePin, approverId);
    if (!approver) throw new FiscalPeriodError(403, 'Invalid owner PIN');
    db.prepare("UPDATE fiscal_periods SET status = 'open', reopened_at = ?, reopened_by = ? WHERE id = ?")
      .run(now(), approver.id, id);
    return getFiscalPeriod(db, id);
  });
}

export function deleteFiscalPeriod(db: Database, id: string, actorUserId: string): void {
  if (!actorUserId) throw new FiscalPeriodError(400, 'actor_user_id is required');
  withTxn(() => {
    const period = getFiscalPeriod(db, id);
    if (period.status === 'closed') {
      throw new FiscalPeriodError(409, 'Closed periods cannot be deleted; reopen first');
    }
    db.prepare('DELETE FROM fiscal_periods WHERE id = ?').run(id);
  });
}
