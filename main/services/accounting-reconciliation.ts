/**
 * Accounting reconciliation (Milestone H): compares each business domain's
 * source of truth against the ledger's projection of it, and reports the
 * difference. It detects discrepancies only — it never edits a source row,
 * repairs a journal, backfills, or posts an adjusting entry.
 *
 * The pairing rule is deliberately simple and deterministic: for each domain,
 * `source_total` is the authoritative business amount in the window and
 * `journal_total` is the ledger's net effect on that domain's characteristic
 * control account (or, for sales, the recognized sale journals' own totals).
 * `difference = source_total - journal_total`; a small tolerance absorbs float
 * noise. Domains whose source semantics are not a 1:1 GL basis are reported as
 * `NOT_RECONCILABLE` with the totals still shown, rather than a fabricated
 * number.
 */
import { getDatabase } from '../db';
import { resolveReportRange, ReportRangeInput } from './accounting-reports';
import { fiscalDateForInstant } from './fiscal-periods';
import { getCurrencyMinorUnitFactor, resolveTenantCurrency } from '../countries';
import { COGS_ACCOUNT_CODE } from './accounting-cogs-adapter';
import { ACCOUNTED_TENDER_METHODS } from './accounting-sales-adapter';

type Database = ReturnType<typeof getDatabase>;

const TOLERANCE = 1e-6;

/**
 * Tenders with a v1 chart account for the expense/payment-out/refund domains;
 * their adapters skip everything else (wallet/custom/other). Sales has its own
 * accounted set (`customer_account` → `1100`) and must not use this one.
 */
const ACCOUNTED_TENDERS = new Set(['cash', 'card', 'bank_transfer', 'cheque']);
const RECEIVABLE_SETTLEMENT_TENDERS = new Set([...ACCOUNTED_TENDERS, 'payroll_deduction']);

export type ReconciliationStatus = 'MATCH' | 'MISMATCH' | 'NOT_RECONCILABLE';

export interface ReconciliationDomain {
  domain: string;
  source_total: number;
  journal_total: number;
  difference: number;
  status: ReconciliationStatus;
  details: Record<string, unknown>;
}

export interface ReconciliationReport {
  from: string;
  to: string;
  period_id: string | null;
  results: ReconciliationDomain[];
  /** False only when a reconcilable domain mismatches. */
  all_reconciled: boolean;
}

function statusFor(difference: number): ReconciliationStatus {
  return Math.abs(difference) <= TOLERANCE ? 'MATCH' : 'MISMATCH';
}

function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

function tenantMinorFactor(db: Database): number {
  const currency = resolveTenantCurrency(
    (db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as any)?.value,
    (db.prepare("SELECT value FROM settings WHERE key = 'country'").get() as any)?.value || '',
  );
  return getCurrencyMinorUnitFactor(currency);
}

/** Signed net of one account's lines within one module for the window (positive = debit side). */
function moduleAccountNet(db: Database, sourceModule: string, accountCode: string, from: string, to: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_id
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE j.source_module = ? AND a.code = ? AND j.entry_date >= ? AND j.entry_date <= ?
  `).get(sourceModule, accountCode, from, to) as { net: number };
  return Number(row.net);
}

function accountNetAll(db: Database, accountCode: string, from: string, to: string): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_id
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE a.code = ? AND j.entry_date >= ? AND j.entry_date <= ?
  `).get(accountCode, from, to) as { net: number };
  return Number(row.net);
}

function expenseDomain(db: Database, from: string, to: string): { source: number; count: number } {
  const rows = db.prepare('SELECT payment_method, amount, expense_date FROM expenses').all() as Array<{ payment_method: string | null; amount: number; expense_date: string }>;
  let source = 0;
  let count = 0;
  for (const row of rows) {
    if (!row.payment_method || !ACCOUNTED_TENDERS.has(row.payment_method)) continue;
    if (!inRange(String(row.expense_date).slice(0, 10), from, to)) continue;
    source += Number(row.amount);
    count += 1;
  }
  return { source, count };
}

function supplierPaymentDomain(db: Database, from: string, to: string): { source: number; count: number } {
  const rows = db.prepare('SELECT payment_method, amount, paid_at FROM supplier_payments').all() as Array<{ payment_method: string; amount: number; paid_at: string }>;
  let source = 0;
  let count = 0;
  for (const row of rows) {
    if (!ACCOUNTED_TENDERS.has(String(row.payment_method))) continue;
    if (!inRange(fiscalDateForInstant(row.paid_at), from, to)) continue;
    source += Number(row.amount);
    count += 1;
  }
  return { source, count };
}

function purchaseInvoiceDomain(db: Database, from: string, to: string): { source: number; count: number } {
  const rows = db.prepare(`
    SELECT total, invoice_date FROM purchase_invoices
    WHERE status IN ('posted', 'partially_paid', 'paid')
  `).all() as Array<{ total: number; invoice_date: string }>;
  let source = 0;
  let count = 0;
  for (const row of rows) {
    if (!inRange(String(row.invoice_date).slice(0, 10), from, to)) continue;
    if (Number(row.total) <= 0) continue;
    source += Number(row.total);
    count += 1;
  }
  return { source, count };
}

function purchaseReturnDomain(db: Database, from: string, to: string): { source: number; count: number } {
  const rows = db.prepare("SELECT total, return_date FROM purchase_returns WHERE status = 'completed'").all() as Array<{ total: number; return_date: string }>;
  let source = 0;
  let count = 0;
  for (const row of rows) {
    if (!inRange(String(row.return_date).slice(0, 10), from, to)) continue;
    if (Number(row.total) <= 0) continue;
    source += Number(row.total);
    count += 1;
  }
  return { source, count };
}

function receivableDomain(db: Database, from: string, to: string): { source: number; count: number } {
  const rows = db.prepare(`
    SELECT amount, entry_date, payment_method, entry_type, direction, reference FROM receivable_entries
    WHERE entry_type = 'settlement' OR (entry_type = 'adjustment' AND direction = 'debit' AND reference LIKE 'payroll-reversal:%')
  `).all() as Array<{ amount: number; entry_date: string; payment_method: string | null; entry_type: string; direction: string; reference: string | null }>;
  let source = 0;
  let count = 0;
  for (const row of rows) {
    if (row.entry_type === 'adjustment' && row.reference?.startsWith('payroll-reversal:')) {
      if (!inRange(String(row.entry_date).slice(0, 10), from, to)) continue;
      source -= Number(row.amount);
      count += 1;
      continue;
    }
    if (!row.payment_method || !RECEIVABLE_SETTLEMENT_TENDERS.has(row.payment_method)) continue;
    if (!inRange(String(row.entry_date).slice(0, 10), from, to)) continue;
    if (Number(row.amount) <= 0) continue;
    source += Number(row.amount);
    count += 1;
  }
  return { source, count };
}

function refundDomain(db: Database, from: string, to: string, minorFactor: number): { source: number; count: number } {
  const rows = db.prepare('SELECT method, amount_cents, created_at FROM refunds').all() as Array<{ method: string | null; amount_cents: number; created_at: string }>;
  let source = 0;
  let count = 0;
  for (const row of rows) {
    if (!row.method || !ACCOUNTED_TENDERS.has(row.method)) continue;
    if (!inRange(fiscalDateForInstant(row.created_at), from, to)) continue;
    source += Number(row.amount_cents) / minorFactor;
    count += 1;
  }
  return { source, count };
}

/**
 * Sales: a bill is a recognized sale once it carries at least one payment event
 * on a tender the sales adapter can post (`ACCOUNTED_TENDER_METHODS`, which
 * includes `customer_account` → AR). Its authoritative amount is the bill total;
 * the ledger side is the recognized sale journals (seq 1), whose debits sum to
 * the bill total. Both sides must share one recognition rule: the adapter posts
 * a credit sale's AR debit on the same sale journal, so excluding that bill from
 * the source side reports a difference the ledger never created.
 */
function salesDomain(db: Database, from: string, to: string): { source: number; count: number; journal: number; unmatched: number } {
  const bills = db.prepare('SELECT id, total, payment_details, created_at FROM bills').all() as Array<{ id: number; total: number; payment_details: string | null; created_at: string }>;
  let source = 0;
  let count = 0;
  const recognizedIds = new Set<string>();
  for (const bill of bills) {
    if (!inRange(fiscalDateForInstant(bill.created_at), from, to)) continue;
    if (!hasAccountedEvent(bill.payment_details)) continue;
    source += Number(bill.total);
    count += 1;
    recognizedIds.add(String(bill.id));
  }
  const saleJournals = db.prepare(`
    SELECT j.id AS journal_id, j.source_id AS bill_id,
      COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS debit
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_id = j.id
    WHERE j.source_module = 'sales' AND j.seq = 1 AND j.entry_date >= ? AND j.entry_date <= ?
    GROUP BY j.id
  `).all(from, to) as Array<{ journal_id: string; bill_id: string | null; debit: number }>;
  let journal = 0;
  let unmatched = 0;
  for (const row of saleJournals) {
    journal += Number(row.debit);
    if (!row.bill_id || !recognizedIds.has(String(row.bill_id))) unmatched += 1;
  }
  return { source, count, journal, unmatched };
}

function hasAccountedEvent(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return false; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.some((row: any) => row && typeof row === 'object'
    && typeof row.event_id === 'string' && row.event_id.trim() !== ''
    && typeof row.method === 'string' && ACCOUNTED_TENDER_METHODS.has(row.method));
}

/**
 * COGS: the frozen consumption of every recognized order item that is not
 * refunded, against the ledger's net on the COGS account across all cogs
 * journals (a reversed recognition nets to zero through its reversal).
 */
function cogsSource(db: Database, from: string, to: string): { source: number; count: number; missing: number } {
  const rows = db.prepare(`
    SELECT oi.id AS order_item_id, oi.status AS status, b.created_at AS bill_created,
      COALESCE((
        SELECT -SUM(m.total_cost) FROM supply_movements m
        WHERE m.reference_type = 'order_item'
          AND (m.reference_id = CAST(oi.id AS TEXT) OR m.reference_id GLOB CAST(oi.id AS TEXT) || ':*')
      ), 0) AS consumption
    FROM order_items oi
    JOIN bills b ON b.order_id = oi.order_id
    JOIN journal_entries j ON j.source_module = 'sales' AND j.source_id = b.id AND j.seq = 1
    WHERE (b.split_group_id IS NULL OR EXISTS (
      SELECT 1 FROM bill_items bi WHERE bi.bill_id = b.id AND bi.order_item_id = oi.id
    ))
    GROUP BY oi.id
  `).all() as Array<{ order_item_id: number; status: string | null; bill_created: string; consumption: number }>;

  const activeJournalItems = new Set(
    (db.prepare(`
      SELECT DISTINCT source_id FROM journal_entries
      WHERE source_module = 'cogs' AND status = 'posted' AND reverses_journal_id IS NULL AND source_id IS NOT NULL
    `).all() as Array<{ source_id: string }>).map((row) => String(row.source_id)),
  );

  let source = 0;
  let count = 0;
  let missing = 0;
  for (const row of rows) {
    if (String(row.status) === 'refunded') continue;
    if (!inRange(fiscalDateForInstant(row.bill_created), from, to)) continue;
    const consumption = Number(row.consumption);
    if (Math.abs(consumption) <= TOLERANCE) continue;
    source += consumption;
    count += 1;
    if (!activeJournalItems.has(String(row.order_item_id))) missing += 1;
  }
  return { source, count, missing };
}

/** Inventory valuation (as of `to`): frozen movement value vs the 1200 balance. */
function inventoryDomain(db: Database, to: string): { source: number; counted: number } {
  const row = db.prepare(`
    SELECT COALESCE(SUM(total_cost), 0) AS valuation, COUNT(*) AS counted
    FROM supply_movements WHERE substr(created_at, 1, 10) <= ?
  `).get(to) as { valuation: number; counted: number };
  return { source: Number(row.valuation), counted: Number(row.counted) };
}

/**
 * Read-only reconciliation across every business domain. Detects missing,
 * duplicated or mis-amounted projections; never repairs them.
 */
export function getReconciliation(input: ReportRangeInput = {}): ReconciliationReport {
  const db = getDatabase();
  const range = resolveReportRange(input);
  const { from, to } = range;
  const minorFactor = tenantMinorFactor(db) || 1;

  const results: ReconciliationDomain[] = [];

  const expenses = expenseDomain(db, from, to);
  const expensesJournal = moduleAccountNet(db, 'expenses', '5000', from, to);
  results.push({
    domain: 'expenses',
    source_total: round(expenses.source),
    journal_total: round(expensesJournal),
    difference: round(expenses.source - expensesJournal),
    status: statusFor(expenses.source - expensesJournal),
    details: { source_events: expenses.count, control_account: '5000' },
  });

  const supplierPayments = supplierPaymentDomain(db, from, to);
  const supplierPaymentsJournal = moduleAccountNet(db, 'supplier_payments', '2000', from, to);
  results.push({
    domain: 'supplier_payments',
    source_total: round(supplierPayments.source),
    journal_total: round(supplierPaymentsJournal),
    difference: round(supplierPayments.source - supplierPaymentsJournal),
    status: statusFor(supplierPayments.source - supplierPaymentsJournal),
    details: { source_events: supplierPayments.count, control_account: '2000' },
  });

  const purchases = purchaseInvoiceDomain(db, from, to);
  const purchasesJournal = moduleAccountNet(db, 'purchases', '1200', from, to);
  results.push({
    domain: 'purchases',
    source_total: round(purchases.source),
    journal_total: round(purchasesJournal),
    difference: round(purchases.source - purchasesJournal),
    status: statusFor(purchases.source - purchasesJournal),
    details: { source_events: purchases.count, control_account: '1200' },
  });

  const purchaseReturns = purchaseReturnDomain(db, from, to);
  const purchaseReturnsJournal = moduleAccountNet(db, 'purchase_returns', '2000', from, to);
  results.push({
    domain: 'purchase_returns',
    source_total: round(purchaseReturns.source),
    journal_total: round(purchaseReturnsJournal),
    difference: round(purchaseReturns.source - purchaseReturnsJournal),
    status: statusFor(purchaseReturns.source - purchaseReturnsJournal),
    details: { source_events: purchaseReturns.count, control_account: '2000' },
  });

  const receivables = receivableDomain(db, from, to);
  const receivablesJournal = -moduleAccountNet(db, 'receivables', '1100', from, to);
  results.push({
    domain: 'receivables',
    source_total: round(receivables.source),
    journal_total: round(receivablesJournal),
    difference: round(receivables.source - receivablesJournal),
    status: statusFor(receivables.source - receivablesJournal),
    details: { source_events: receivables.count, control_account: '1100' },
  });

  const refunds = refundDomain(db, from, to, minorFactor);
  const refundsJournal = moduleAccountNet(db, 'refunds', '4010', from, to);
  results.push({
    domain: 'refunds',
    source_total: round(refunds.source),
    journal_total: round(refundsJournal),
    difference: round(refunds.source - refundsJournal),
    status: statusFor(refunds.source - refundsJournal),
    details: { source_events: refunds.count, control_account: '4010' },
  });

  const sales = salesDomain(db, from, to);
  results.push({
    domain: 'sales',
    source_total: round(sales.source),
    journal_total: round(sales.journal),
    difference: round(sales.source - sales.journal),
    status: statusFor(sales.source - sales.journal),
    details: { source_events: sales.count, unmatched_sale_journals: sales.unmatched },
  });

  const cogs = cogsSource(db, from, to);
  const cogsJournal = moduleAccountNet(db, 'cogs', COGS_ACCOUNT_CODE, from, to);
  results.push({
    domain: 'cogs',
    source_total: round(cogs.source),
    journal_total: round(cogsJournal),
    difference: round(cogs.source - cogsJournal),
    status: statusFor(cogs.source - cogsJournal),
    details: { source_events: cogs.count, missing_journals: cogs.missing, control_account: COGS_ACCOUNT_CODE },
  });

  const payrollSource = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS gross, COALESCE(SUM(event_count), 0) AS count FROM (
      SELECT r.period_end AS event_date, SUM(i.gross_amount) AS amount, COUNT(DISTINCT r.id) AS event_count
      FROM payroll_runs r JOIN payroll_run_items i ON i.payroll_run_id = r.id
      WHERE r.status IN ('posted', 'reversed') GROUP BY r.id
      UNION ALL
      SELECT r.reversed_at AS event_date, -SUM(i.gross_amount) AS amount, 0 AS event_count
      FROM payroll_runs r JOIN payroll_run_items i ON i.payroll_run_id = r.id
      WHERE r.status = 'reversed' AND r.reversed_at IS NOT NULL GROUP BY r.id
    ) WHERE event_date >= ? AND event_date <= ?
  `).get(from, to) as { gross: number; count: number };
  const payrollJournal = moduleAccountNet(db, 'payroll', '5010', from, to);
  results.push({
    domain: 'payroll',
    source_total: round(Number(payrollSource.gross)),
    journal_total: round(payrollJournal),
    difference: round(Number(payrollSource.gross) - payrollJournal),
    status: statusFor(Number(payrollSource.gross) - payrollJournal),
    details: { source_events: Number(payrollSource.count), control_account: '5010' },
  });

  const inventory = inventoryDomain(db, to);
  const inventoryJournal = accountNetAll(db, '1200', '1970-01-01', to);
  results.push({
    domain: 'inventory',
    source_total: round(inventory.source),
    journal_total: round(inventoryJournal),
    difference: round(inventory.source - inventoryJournal),
    status: statusFor(inventory.source - inventoryJournal),
    details: { movements: inventory.counted, control_account: '1200', as_of: to },
  });

  // Cash drawer semantics (opening float, count timing) are not a 1:1 GL basis,
  // so the totals are surfaced for visibility but never asserted as equal.
  const cashRow = db.prepare(`
    SELECT COALESCE(SUM(net_collected_cents), 0) AS cents, COUNT(*) AS closures
    FROM cash_closures WHERE business_date >= ? AND business_date <= ?
  `).get(from, to) as { cents: number; closures: number };
  const cashSource = Number(cashRow.cents) / minorFactor;
  const cashJournal = accountNetAll(db, '1000', from, to);
  results.push({
    domain: 'cash',
    source_total: round(cashSource),
    journal_total: round(cashJournal),
    difference: round(cashSource - cashJournal),
    status: 'NOT_RECONCILABLE',
    details: {
      closures: Number(cashRow.closures),
      reason: 'cash closure drawer semantics (opening float, count timing) are not a 1:1 GL basis',
      cash_account: '1000',
      over_short_account: '5900',
    },
  });

  return {
    from,
    to,
    period_id: range.periodId,
    results,
    all_reconciled: results.every((entry) => entry.status !== 'MISMATCH'),
  };
}
