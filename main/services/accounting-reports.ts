/**
 * Accounting reports (Milestone H): read-only projections of the append-only
 * ledger into the four primary statements plus integrity checks.
 *
 * Every figure is derived from `journal_entries` / `journal_entry_lines` and the
 * Chart of Accounts; no balance is ever stored or cached. Account classification
 * comes from the CoA itself (`type` for Asset/Liability/Equity/Revenue/Expense,
 * `normal_side` for presentation), except the Cost-of-Goods-Sold split, which
 * reuses the single COGS account identity already owned by the G adapter
 * (`COGS_ACCOUNT_CODE`) rather than re-hardcoding a code list. Reports never
 * mutate the ledger, never touch fiscal periods, and add no schema of their own.
 */
import { getDatabase } from '../db';
import { AccountingServiceError } from './accounting';
import { getFiscalPeriod } from './fiscal-periods';
import { COGS_ACCOUNT_CODE } from './accounting-cogs-adapter';

type Database = ReturnType<typeof getDatabase>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_DATE = '1970-01-01';
const MAX_DATE = '9999-12-31';
const TOLERANCE = 1e-6;

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

export interface ReportRangeInput {
  from?: string | null;
  to?: string | null;
  periodId?: string | null;
}

export interface ResolvedRange { from: string; to: string; periodId: string | null; }

interface AccountRow {
  id: string;
  code: string | null;
  name: string;
  type: AccountType;
  normal_side: 'debit' | 'credit';
  is_active: number;
}

function assertReportDate(value: unknown, field: string): string {
  const text = String(value ?? '');
  if (!DATE_RE.test(text)) throw new AccountingServiceError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  return text;
}

/**
 * Resolves a report window. A fiscal period takes precedence and uses the
 * period's own inclusive boundaries; otherwise explicit from/to (or the full
 * history) apply. No timezone conversion happens here — journal dates are
 * already business-local `YYYY-MM-DD`.
 */
export function resolveReportRange(input: ReportRangeInput): ResolvedRange {
  if (input.periodId !== undefined && input.periodId !== null && String(input.periodId) !== '') {
    const period = getFiscalPeriod(getDatabase(), String(input.periodId));
    return { from: period.start_date, to: period.end_date, periodId: period.id };
  }
  const from = input.from ? assertReportDate(input.from, 'from') : MIN_DATE;
  const to = input.to ? assertReportDate(input.to, 'to') : MAX_DATE;
  return { from, to, periodId: null };
}

function listAccounts(db: Database): AccountRow[] {
  return db.prepare('SELECT id, code, name, type, normal_side, is_active FROM accounting_accounts ORDER BY code').all() as AccountRow[];
}

// ── General Ledger ──────────────────────────────────────────────────────────

export interface GeneralLedgerFilters extends ReportRangeInput {
  accountCode?: string | null;
  accountId?: string | null;
  sourceModule?: string | null;
  sourceId?: string | null;
  reference?: string | null;
}

export interface GeneralLedgerLine {
  entry_date: string;
  journal_id: string;
  journal_status: 'posted' | 'reversed';
  account_id: string;
  account_code: string | null;
  account_name: string;
  direction: 'debit' | 'credit';
  amount: number;
  debit: number;
  credit: number;
  latest_balance: number;
  reference: string | null;
  source_module: string;
  source_id: string | null;
  description: string | null;
}

export interface GeneralLedgerReport {
  from: string;
  to: string;
  period_id: string | null;
  lines: GeneralLedgerLine[];
  totals: { debit: number; credit: number; difference: number };
}

/**
 * Journal lines in the window, newest last, with running balance per account.
 * Ordering is deterministic: entry_date, journal created_at, journal id, then
 * the line's insertion order.
 */
export function getGeneralLedger(filters: GeneralLedgerFilters = {}): GeneralLedgerReport {
  const db = getDatabase();
  const range = resolveReportRange(filters);
  const where: string[] = ['j.entry_date >= ?', 'j.entry_date <= ?'];
  const params: unknown[] = [range.from, range.to];
  if (filters.accountCode) {
    where.push('a.code = ?');
    params.push(String(filters.accountCode));
  }
  if (filters.accountId) {
    where.push('a.id = ?');
    params.push(String(filters.accountId));
  }
  if (filters.sourceModule) {
    where.push('j.source_module = ?');
    params.push(String(filters.sourceModule));
  }
  if (filters.sourceId) {
    where.push('j.source_id = ?');
    params.push(String(filters.sourceId));
  }
  if (filters.reference) {
    where.push('j.reference = ?');
    params.push(String(filters.reference));
  }

  const rows = db.prepare(`
    SELECT
      j.entry_date AS entry_date, j.id AS journal_id, j.status AS journal_status,
      a.id AS account_id, a.code AS account_code, a.name AS account_name,
      l.direction AS direction, l.amount AS amount,
      j.reference AS reference, j.source_module AS source_module,
      j.source_id AS source_id, j.description AS description
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_id
    JOIN accounting_accounts a ON a.id = l.account_id
    WHERE ${where.join(' AND ')}
    ORDER BY j.entry_date, j.created_at, j.id, l.rowid
  `).all(...params) as Array<Omit<GeneralLedgerLine, 'debit' | 'credit' | 'latest_balance'>>;

  const running = new Map<string, number>();
  let debitTotal = 0;
  let creditTotal = 0;
  const lines: GeneralLedgerLine[] = rows.map((row) => {
    const debit = row.direction === 'debit' ? Number(row.amount) : 0;
    const credit = row.direction === 'credit' ? Number(row.amount) : 0;
    debitTotal += debit;
    creditTotal += credit;
    const balance = (running.get(row.account_id) ?? 0) + debit - credit;
    running.set(row.account_id, balance);
    return { ...row, amount: Number(row.amount), debit, credit, latest_balance: balance };
  });

  return {
    from: range.from,
    to: range.to,
    period_id: range.periodId,
    lines,
    totals: { debit: debitTotal, credit: creditTotal, difference: debitTotal - creditTotal },
  };
}

// ── Trial Balance ───────────────────────────────────────────────────────────

export interface TrialBalanceRow {
  account_id: string;
  code: string | null;
  name: string;
  type: AccountType;
  normal_side: 'debit' | 'credit';
  debit: number;
  credit: number;
  balance: number;
}

export interface TrialBalanceReport {
  from: string;
  to: string;
  period_id: string | null;
  accounts: TrialBalanceRow[];
  totals: { debit: number; credit: number; difference: number; balanced: boolean };
}

/**
 * Per-account debit/credit totals in the window. `balance` follows the core's
 * convention: signed, positive = debit side (debit − credit). Only accounts
 * with activity are listed; the ledger's own debits and credits must tie.
 */
export function getTrialBalance(input: ReportRangeInput = {}): TrialBalanceReport {
  const db = getDatabase();
  const range = resolveReportRange(input);
  const rows = db.prepare(`
    SELECT a.id, a.code, a.name, a.type, a.normal_side,
      COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS debit,
      COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS credit
    FROM accounting_accounts a
    JOIN journal_entry_lines l ON l.account_id = a.id
    JOIN journal_entries j ON j.id = l.journal_id AND j.entry_date >= ? AND j.entry_date <= ?
    GROUP BY a.id
    ORDER BY a.code
  `).all(range.from, range.to) as Array<Omit<TrialBalanceRow, 'balance'>>;

  let debitTotal = 0;
  let creditTotal = 0;
  const accounts = rows.map((row) => {
    const debit = Number(row.debit);
    const credit = Number(row.credit);
    debitTotal += debit;
    creditTotal += credit;
    return { ...row, debit, credit, balance: debit - credit };
  });

  return {
    from: range.from,
    to: range.to,
    period_id: range.periodId,
    accounts,
    totals: {
      debit: debitTotal,
      credit: creditTotal,
      difference: debitTotal - creditTotal,
      balanced: Math.abs(debitTotal - creditTotal) <= TOLERANCE,
    },
  };
}

// ── Profit & Loss ───────────────────────────────────────────────────────────

export interface ProfitAndLossSection {
  accounts: Array<{ account_id: string; code: string | null; name: string; amount: number }>;
  total: number;
}

export interface ProfitAndLossReport {
  from: string;
  to: string;
  period_id: string | null;
  revenue: ProfitAndLossSection;
  cogs: ProfitAndLossSection;
  operating_expenses: ProfitAndLossSection;
  total_expenses: number;
  gross_profit: number;
  net_profit: number;
}

/**
 * Income statement derived from CoA classification: `revenue` accounts are
 * income (credit-normal), and `expense` accounts split into COGS (the single
 * account owned by the G adapter) and operating expenses. Amounts are shown in
 * their natural positive direction.
 */
export function getProfitAndLoss(input: ReportRangeInput = {}): ProfitAndLossReport {
  const db = getDatabase();
  const range = resolveReportRange(input);
  const accounts = listAccounts(db);
  const cogsAccountId = (db.prepare('SELECT id FROM accounting_accounts WHERE code = ?').get(COGS_ACCOUNT_CODE) as { id: string } | undefined)?.id ?? null;

  const netDebit = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_id AND j.entry_date >= ? AND j.entry_date <= ?
    WHERE l.account_id = ?
  `);

  const revenueAccounts: ProfitAndLossSection['accounts'] = [];
  const cogsAccounts: ProfitAndLossSection['accounts'] = [];
  const expenseAccounts: ProfitAndLossSection['accounts'] = [];

  for (const account of accounts) {
    if (account.type !== 'revenue' && account.type !== 'expense') continue;
    const net = Number((netDebit.get(range.from, range.to, account.id) as { net: number }).net);
    const amount = account.type === 'revenue' ? -net : net;
    if (Math.abs(amount) <= TOLERANCE) continue;
    const entry = { account_id: account.id, code: account.code, name: account.name, amount };
    if (account.type === 'revenue') revenueAccounts.push(entry);
    else if (account.id === cogsAccountId) cogsAccounts.push(entry);
    else expenseAccounts.push(entry);
  }

  const sum = (rows: ProfitAndLossSection['accounts']) => Number(rows.reduce((total, row) => total + row.amount, 0).toFixed(6));
  const revenueTotal = sum(revenueAccounts);
  const cogsTotal = sum(cogsAccounts);
  const expenseTotal = sum(expenseAccounts);
  const totalExpenses = Number((cogsTotal + expenseTotal).toFixed(6));
  return {
    from: range.from,
    to: range.to,
    period_id: range.periodId,
    revenue: { accounts: revenueAccounts, total: revenueTotal },
    cogs: { accounts: cogsAccounts, total: cogsTotal },
    operating_expenses: { accounts: expenseAccounts, total: expenseTotal },
    total_expenses: totalExpenses,
    gross_profit: Number((revenueTotal - cogsTotal).toFixed(6)),
    net_profit: Number((revenueTotal - totalExpenses).toFixed(6)),
  };
}

// ── Balance Sheet ───────────────────────────────────────────────────────────

export interface BalanceSheetSection {
  accounts: Array<{ account_id: string; code: string | null; name: string; amount: number }>;
  total: number;
}

export interface BalanceSheetReport {
  as_of: string;
  assets: BalanceSheetSection;
  liabilities: BalanceSheetSection;
  equity: BalanceSheetSection;
  /** Revenue − expenses accumulated to `as_of`: the unclosed current result. */
  current_result: number;
  equity_total: number;
  equation: { assets: number; liabilities_and_equity: number; difference: number; balanced: boolean };
}

/**
 * Position statement as of a date derived from CoA classification. Equity
 * includes the unclosed current-period result (revenue − expenses), so the
 * accounting equation holds by double-entry algebra without inventing a
 * retained-earnings account.
 */
export function getBalanceSheet(input: ReportRangeInput = {}): BalanceSheetReport {
  const db = getDatabase();
  const asOf = resolveReportRange(input).to;
  const accounts = listAccounts(db);

  const netDebit = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount ELSE -l.amount END), 0) AS net
    FROM journal_entry_lines l
    JOIN journal_entries j ON j.id = l.journal_id AND j.entry_date >= ? AND j.entry_date <= ?
    WHERE l.account_id = ?
  `);

  const assets: BalanceSheetSection['accounts'] = [];
  const liabilities: BalanceSheetSection['accounts'] = [];
  const equity: BalanceSheetSection['accounts'] = [];
  let currentResult = 0;

  for (const account of accounts) {
    const net = Number((netDebit.get(MIN_DATE, asOf, account.id) as { net: number }).net);
    if (account.type === 'asset') {
      if (Math.abs(net) > TOLERANCE) assets.push({ account_id: account.id, code: account.code, name: account.name, amount: net });
    } else if (account.type === 'liability') {
      if (Math.abs(net) > TOLERANCE) liabilities.push({ account_id: account.id, code: account.code, name: account.name, amount: -net });
    } else if (account.type === 'equity') {
      if (Math.abs(net) > TOLERANCE) equity.push({ account_id: account.id, code: account.code, name: account.name, amount: -net });
    } else if (account.type === 'revenue') {
      // Revenue − expenses: the unclosed current result carried into equity.
      currentResult -= net;
    } else if (account.type === 'expense') {
      currentResult -= net;
    }
  }

  const sum = (rows: BalanceSheetSection['accounts']) => Number(rows.reduce((total, row) => total + row.amount, 0).toFixed(6));
  const assetsTotal = sum(assets);
  const liabilitiesTotal = sum(liabilities);
  const equityBase = sum(equity);
  const equityTotal = Number((equityBase + currentResult).toFixed(6));
  const liabilitiesAndEquity = Number((liabilitiesTotal + equityTotal).toFixed(6));
  return {
    as_of: asOf,
    assets: { accounts: assets, total: assetsTotal },
    liabilities: { accounts: liabilities, total: liabilitiesTotal },
    equity: { accounts: equity, total: equityBase },
    current_result: Number(currentResult.toFixed(6)),
    equity_total: equityTotal,
    equation: {
      assets: assetsTotal,
      liabilities_and_equity: liabilitiesAndEquity,
      difference: Number((assetsTotal - liabilitiesAndEquity).toFixed(6)),
      balanced: Math.abs(assetsTotal - liabilitiesAndEquity) <= TOLERANCE,
    },
  };
}

// ── Integrity Checks ────────────────────────────────────────────────────────

export interface IntegrityReport {
  ok: boolean;
  journal_balance: { unbalanced: Array<{ journal_id: string; debit: number; credit: number; difference: number }> };
  trial_balance: { debit: number; credit: number; difference: number; balanced: boolean };
  orphan_lines: Array<{ line_id: string; journal_id: string }>;
  orphan_journals: Array<{ journal_id: string; source_module: string }>;
  duplicate_identities: Array<{ source_module: string; source_id: string | null; seq: number; count: number }>;
}

/** Structural ledger invariants; read-only and derived from state, never stored. */
export function getIntegrityChecks(): IntegrityReport {
  const db = getDatabase();
  const unbalanced = db.prepare(`
    SELECT j.id AS journal_id,
      COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS debit,
      COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS credit
    FROM journal_entries j
    JOIN journal_entry_lines l ON l.journal_id = j.id
    GROUP BY j.id
    HAVING ABS(debit - credit) > ?
  `).all(TOLERANCE) as Array<{ journal_id: string; debit: number; credit: number }>;

  const totals = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0) AS debit,
           COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount END), 0) AS credit
    FROM journal_entry_lines
  `).get() as { debit: number; credit: number };

  const orphanLines = db.prepare(`
    SELECT l.id AS line_id, l.journal_id AS journal_id
    FROM journal_entry_lines l
    LEFT JOIN journal_entries j ON j.id = l.journal_id
    WHERE j.id IS NULL
  `).all() as Array<{ line_id: string; journal_id: string }>;

  const orphanJournals = db.prepare(`
    SELECT id AS journal_id, source_module
    FROM journal_entries
    WHERE source_module <> 'manual' AND (source_id IS NULL OR source_id = '')
  `).all() as Array<{ journal_id: string; source_module: string }>;

  const duplicates = db.prepare(`
    SELECT source_module, source_id, seq, COUNT(*) AS count
    FROM journal_entries
    WHERE source_id IS NOT NULL
    GROUP BY source_module, source_id, seq
    HAVING COUNT(*) > 1
  `).all() as Array<{ source_module: string; source_id: string | null; seq: number; count: number }>;

  const trialBalanced = Math.abs(Number(totals.debit) - Number(totals.credit)) <= TOLERANCE;
  return {
    ok: unbalanced.length === 0 && trialBalanced && orphanLines.length === 0 && orphanJournals.length === 0 && duplicates.length === 0,
    journal_balance: {
      unbalanced: unbalanced.map((row) => ({
        journal_id: row.journal_id,
        debit: Number(row.debit),
        credit: Number(row.credit),
        difference: Number((Number(row.debit) - Number(row.credit)).toFixed(6)),
      })),
    },
    trial_balance: {
      debit: Number(totals.debit),
      credit: Number(totals.credit),
      difference: Number((Number(totals.debit) - Number(totals.credit)).toFixed(6)),
      balanced: trialBalanced,
    },
    orphan_lines: orphanLines,
    orphan_journals: orphanJournals,
    duplicate_identities: duplicates,
  };
}
