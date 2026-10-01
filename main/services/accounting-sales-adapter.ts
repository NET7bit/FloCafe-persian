/**
 * Sales accounting adapter (Milestone C): a post-commit projection of the
 * untouched sales core (bills, payment lines, refunds) into the ledger.
 *
 * Ordering is mandatory: the source transaction commits first, then the
 * adapter runs, then each journal is created in its own transaction. The
 * adapter never throws and never touches the source documents: a failed
 * attempt (closed fiscal period, data gap) is logged and left to future
 * reconciliation. No pending/queue/retry state exists anywhere.
 *
 * Identities follow the core contract `source_module + source_id + seq`:
 * - Sale:       `sales`   + bill id   + seq 1
 * - Collection: `sales`   + bill id   + seq max+1, reference = payment event_id
 * - Refund:     `refunds` + refund id + seq 1
 *
 * Each `applyPaymentBatch` call stamps its lines with one shared `batch_id`
 * (the first batch is the sale); tenders aggregate per account so the core's
 * one-line-per-account rule holds. Every projection function is idempotent on
 * its own identity, so replays and post-reopen reprocessing are safe.
 *
 * Wallet (OQ5) and custom tenders have no v1 chart account, so documents
 * touched by them are skipped with a logged reason instead of misposting.
 */
import { getDatabase, withTxn } from '../db';
import { fiscalDateForInstant } from './fiscal-periods';
import { createJournal, getAccountByCode, JournalRecord } from './accounting';
import { getCurrencyMinorUnitFactor, resolveTenantCurrency } from '../countries';

type Database = ReturnType<typeof getDatabase>;

interface ParsedPaymentLine {
  eventId: string | null;
  /** One applyPaymentBatch call shares one batch_id; the earliest batch is the sale. */
  batchId: string | null;
  method: string | null;
  amount: number | null;
  timestamp: string | null;
}

function parsePaymentLines(raw: unknown): ParsedPaymentLine[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row: any) => ({
      eventId: typeof row.event_id === 'string' && row.event_id.trim() !== '' ? row.event_id.trim() : null,
      batchId: typeof row.batch_id === 'string' && row.batch_id.trim() !== '' ? row.batch_id.trim() : null,
      method: typeof row.method === 'string' ? row.method : null,
      amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
      timestamp: typeof row.timestamp === 'string' ? row.timestamp : null,
    }));
}

/** Tenders with a v1 chart account; anything else (wallet/custom) is skipped. */
const ACCOUNTED_TENDER_METHODS = new Set(['cash', 'card', 'customer_account']);

function tenderAccountCode(method: string): string {
  if (method === 'card') return '1010';
  if (method === 'customer_account') return '1100';
  return '1000';
}

function tenantMinorFactor(db: Database): number {
  const currency = resolveTenantCurrency(
    (db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as any)?.value,
    (db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any)?.value || '',
  );
  return getCurrencyMinorUnitFactor(currency);
}

function skip(reason: string): null {
  console.error(`[Accounting] skipped: ${reason}`);
  return null;
}

function fail(scope: string, error: unknown): null {
  console.error(`[Accounting] ${scope} failed; left to reconciliation:`, error);
  return null;
}

function existingSaleJournal(db: Database, billId: string | number): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'sales' AND source_id = ? AND seq = 1",
  ).get(String(billId)) as JournalRecord | undefined;
}

function existingCollectionJournal(db: Database, billId: string | number, eventId: string): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'sales' AND source_id = ? AND reference = ? AND seq > 1",
  ).get(String(billId), eventId) as JournalRecord | undefined;
}

function existingRefundJournal(db: Database, refundId: string | number): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'refunds' AND source_id = ?",
  ).get(String(refundId)) as JournalRecord | undefined;
}

function nextEventSeq(db: Database, billId: string | number): number {
  const row = db.prepare(
    "SELECT MAX(seq) AS m FROM journal_entries WHERE source_module = 'sales' AND source_id = ?",
  ).get(String(billId)) as { m: number | null };
  return (row.m ?? 1) + 1;
}

/** Debit tender minors aggregated per account (exact integer arithmetic). */
function tenderDebitMinors(lines: ParsedPaymentLine[], minorFactor: number): Map<string, number> {
  const sums = new Map<string, number>();
  for (const line of lines) {
    const accountId = getAccountByCode(tenderAccountCode(line.method!)).id;
    sums.set(accountId, (sums.get(accountId) ?? 0) + Math.round(Number(line.amount) * minorFactor));
  }
  return sums;
}

/**
 * Sale journal at the first payment batch: debits every accounted tender of
 * that batch, debits the unpaid remainder to AR, credits revenue
 * (`total - tax_amount`) and tax. Deterministic from the bill row plus the
 * batch's own lines, so reprocessing after a period reopen rebuilds the same
 * journal under the same identity.
 */
export function createSaleJournal(billId: string | number, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    if (!bill) return null;
    const existing = existingSaleJournal(db, bill.id);
    if (existing) return existing;
    const lines = parsePaymentLines(bill.payment_details);
    if (lines.some((line) => line.method && !ACCOUNTED_TENDER_METHODS.has(line.method))) {
      return skip(`sale journal for bill ${bill.id}: unaccounted tender (wallet/custom)`);
    }
    const saleBatchId = lines
      .map((line) => line.batchId)
      .filter((id): id is string => id !== null)
      .sort()[0] ?? null;
    const saleTenders = lines.filter((line) => line.batchId !== null && line.batchId === saleBatchId);
    if (saleTenders.length === 0) return null;
    const minorFactor = tenantMinorFactor(db);
    const totalMinor = Math.round(Number(bill.total || 0) * minorFactor);
    const taxMinor = Math.round(Number(bill.tax_amount || 0) * minorFactor);
    const revenueMinor = totalMinor - taxMinor;
    const tenderSumMinor = saleTenders.reduce((sum, line) => sum + Math.round(Number(line.amount) * minorFactor), 0);
    const arMinor = totalMinor - tenderSumMinor;
    if (revenueMinor <= 0 || tenderSumMinor <= 0 || arMinor < 0) {
      return skip(`sale journal for bill ${bill.id}: inconsistent bill totals`);
    }
    const debitMinors = tenderDebitMinors(saleTenders, minorFactor);
    if (arMinor > 0) {
      // The unpaid remainder joins the same AR total (one line per account).
      const arAccountId = getAccountByCode('1100').id;
      debitMinors.set(arAccountId, (debitMinors.get(arAccountId) ?? 0) + arMinor);
    }
    const debitLines = Array.from(debitMinors.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([accountId, minor]) => ({ accountId, amount: minor / minorFactor, lineDescription: 'tender' }));
    const creditLines = [
      { accountId: getAccountByCode('4000').id, amount: revenueMinor / minorFactor, lineDescription: 'sales revenue' },
      ...(taxMinor > 0 ? [{ accountId: getAccountByCode('2100').id, amount: taxMinor / minorFactor, lineDescription: 'sales tax payable' }] : []),
    ];
    return withTxn(() => createJournal({
      entryDate: fiscalDateForInstant(bill.created_at),
      description: `Sale ${bill.bill_number}`,
      sourceModule: 'sales',
      sourceId: String(bill.id),
      seq: 1,
      reference: bill.bill_number,
      actorUserId,
      lines: [
        ...debitLines.map((line) => ({ accountId: line.accountId, direction: 'debit' as const, amount: line.amount, lineDescription: line.lineDescription })),
        ...creditLines.map((line) => ({ accountId: line.accountId, direction: 'credit' as const, amount: line.amount, lineDescription: line.lineDescription })),
      ],
    }));
  } catch (error) {
    return fail(`sale journal for bill ${billId}`, error);
  }
}

/** Collection journal for one later payment event: Dr tender / Cr AR. */
export function createCollectionJournal(
  billId: string | number,
  eventId: string,
  actorUserId: string,
): JournalRecord | null {
  try {
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    if (!bill) return null;
    const existing = existingCollectionJournal(db, bill.id, eventId);
    if (existing) return existing;
    if (!existingSaleJournal(db, bill.id)) {
      return skip(`collection journal for bill ${bill.id} event ${eventId}: the bill has no sale journal yet`);
    }
    const event = parsePaymentLines(bill.payment_details).find((line) => line.eventId === eventId);
    if (!event || !event.method || !ACCOUNTED_TENDER_METHODS.has(event.method) || !event.amount || event.amount <= 0) {
      return skip(`collection journal for bill ${bill.id} event ${eventId}: no accounted tender line`);
    }
    return withTxn(() => createJournal({
      entryDate: fiscalDateForInstant(event.timestamp || bill.paid_at),
      description: `Collection on ${bill.bill_number}`,
      sourceModule: 'sales',
      sourceId: String(bill.id),
      seq: nextEventSeq(db, bill.id),
      reference: event.eventId,
      actorUserId,
      lines: [
        {
          accountId: getAccountByCode(tenderAccountCode(event.method!)).id,
          direction: 'debit' as const,
          amount: event.amount!,
          lineDescription: `collection ${event.method}`,
        },
        {
          accountId: getAccountByCode('1100').id,
          direction: 'credit' as const,
          amount: event.amount!,
          lineDescription: 'receivable settled',
        },
      ],
    }));
  } catch (error) {
    return fail(`collection journal for bill ${billId} event ${eventId}`, error);
  }
}

/** Refund journal: Dr 4010 Sales Returns / Cr the real tender account. */
export function createRefundJournal(refundId: string | number, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const refund = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId) as any;
    if (!refund) return null;
    const existing = existingRefundJournal(db, refund.id);
    if (existing) return existing;
    if (!refund.method || !ACCOUNTED_TENDER_METHODS.has(refund.method)) {
      return skip(`refund journal for refund ${refund.id}: unaccounted method (wallet/custom)`);
    }
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(refund.bill_id) as any;
    if (!bill) return null;
    if (!existingSaleJournal(db, bill.id)) {
      return skip(`refund journal for refund ${refund.id}: bill ${bill.id} has no sale journal to reverse`);
    }
    const minorFactor = tenantMinorFactor(db);
    const amount = Number(refund.amount_cents) / minorFactor;
    if (!Number.isFinite(amount) || amount <= 0) {
      return skip(`refund journal for refund ${refund.id}: invalid amount`);
    }
    return withTxn(() => createJournal({
      entryDate: fiscalDateForInstant(refund.created_at),
      description: `Refund on ${bill.bill_number}`,
      sourceModule: 'refunds',
      sourceId: String(refund.id),
      seq: 1,
      reference: String(bill.id),
      actorUserId,
      lines: [
        { accountId: getAccountByCode('4010').id, direction: 'debit' as const, amount, lineDescription: 'sales returns' },
        {
          accountId: getAccountByCode(tenderAccountCode(refund.method)).id,
          direction: 'credit' as const,
          amount,
          lineDescription: `refund ${refund.method}`,
        },
      ],
    }));
  } catch (error) {
    return fail(`refund journal for refund ${refundId}`, error);
  }
}

/**
 * Post-commit hook for both payment endpoints. Idempotent by construction:
 * the sale journal is created once per bill (first batch), and each later
 * payment event is projected exactly once (its own `event_id` is the
 * identity reference). Timestamps are never compared: two separate calls can
 * land in the same second.
 */
export function recordBillPaymentAccounting(billId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (billId === undefined || billId === null || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    if (!bill) return;
    const lines = parsePaymentLines(bill.payment_details);
    if (lines.length === 0) return;
    if (lines.some((line) => line.method && !ACCOUNTED_TENDER_METHODS.has(line.method))) {
      skip(`bill ${bill.id} projection: unaccounted tender (wallet/custom)`);
      return;
    }
    const accounted = lines.filter((line) => line.eventId);
    if (accounted.length === 0) return;
    // The earliest batch is the sale; its tenders live inside the sale
    // journal, so only later batches can become collections. Ordering is
    // deterministic: earliest timestamp, then smallest batch id.
    const saleBatchId = accounted
      .slice()
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '') || (a.batchId ?? '').localeCompare(b.batchId ?? ''))
      .map((line) => line.batchId)
      .find((id): id is string => id !== null) ?? null;
    if (!existingSaleJournal(db, bill.id)) {
      createSaleJournal(bill.id, actorUserId);
      return;
    }
    for (const line of accounted) {
      if (line.batchId !== null && line.batchId === saleBatchId) continue;
      if (existingCollectionJournal(db, bill.id, line.eventId!)) continue;
      createCollectionJournal(bill.id, line.eventId!, actorUserId);
    }
  } catch (error) {
    console.error('[Accounting] bill payment accounting failed:', error);
  }
}

/** Post-commit hook for the refund endpoint; never throws. */
export function recordRefundAccounting(refundId: string | number | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (refundId === undefined || refundId === null || actorUserId === undefined || actorUserId === null) return;
    createRefundJournal(refundId, actorUserId);
  } catch (error) {
    console.error('[Accounting] refund accounting failed:', error);
  }
}
