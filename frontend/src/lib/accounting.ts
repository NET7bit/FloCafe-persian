import api from '@/lib/api';

/**
 * Accounting UI data layer. Every call maps 1:1 onto an existing Milestone
 * A–H endpoint; the frontend never derives a balance, journal or financial
 * figure of its own — it only renders what the ledger services return.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type NormalSide = 'debit' | 'credit';
export type JournalDirection = 'debit' | 'credit';
export type ReconciliationStatus = 'MATCH' | 'MISMATCH' | 'NOT_RECONCILABLE';

/** Source modules the ledger accepts (mirrors accounting.ts SOURCE_MODULES). */
export const ACCOUNTING_SOURCE_MODULES = [
  'sales',
  'refunds',
  'receivables',
  'purchases',
  'supplier_payments',
  'purchase_returns',
  'expenses',
  'cogs',
  'manual',
  'opening_balance',
] as const;
export type AccountingSourceModule = (typeof ACCOUNTING_SOURCE_MODULES)[number];

export interface AccountingAccount {
  id: string;
  code: string | null;
  name: string;
  type: AccountType;
  normal_side: NormalSide;
  is_system: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface FiscalPeriod {
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

export interface ReportRangeParams {
  from?: string;
  to?: string;
  period_id?: string;
}

export interface GeneralLedgerFilters extends ReportRangeParams {
  account_code?: string;
  account_id?: string;
  source_module?: string;
  source_id?: string;
  reference?: string;
}

export interface GeneralLedgerLine {
  entry_date: string;
  journal_id: string;
  journal_status: 'posted' | 'reversed';
  account_id: string;
  account_code: string | null;
  account_name: string;
  direction: JournalDirection;
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

export interface TrialBalanceRow {
  account_id: string;
  code: string | null;
  name: string;
  type: AccountType;
  normal_side: NormalSide;
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

export interface ReportSection {
  accounts: Array<{ account_id: string; code: string | null; name: string; amount: number }>;
  total: number;
}

export interface ProfitAndLossReport {
  from: string;
  to: string;
  period_id: string | null;
  revenue: ReportSection;
  cogs: ReportSection;
  operating_expenses: ReportSection;
  total_expenses: number;
  gross_profit: number;
  net_profit: number;
}

export interface BalanceSheetReport {
  as_of: string;
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection;
  current_result: number;
  equity_total: number;
  equation: { assets: number; liabilities_and_equity: number; difference: number; balanced: boolean };
}

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
  all_reconciled: boolean;
}

export interface IntegrityReport {
  ok: boolean;
  journal_balance: { unbalanced: Array<{ journal_id: string; debit: number; credit: number; difference: number }> };
  trial_balance: { debit: number; credit: number; difference: number; balanced: boolean };
  orphan_lines: Array<{ line_id: string; journal_id: string }>;
  orphan_journals: Array<{ journal_id: string; source_module: string }>;
  duplicate_identities: Array<{ source_module: string; source_id: string | null; seq: number; count: number }>;
}

export interface ManualJournalLine {
  account_id: string;
  direction: JournalDirection;
  amount: number;
  line_description?: string;
}

export interface ManualJournalInput {
  entry_date: string;
  description: string;
  reference?: string;
  idempotency_key: string;
  lines: ManualJournalLine[];
}

function compact(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = String(value);
  }
  return out;
}

/** Backend error message when present, otherwise the caller's fallback label. */
export function accountingErrorMessage(error: unknown, fallback: string): string {
  const response = (error as { response?: { data?: { error?: unknown } } } | undefined)?.response;
  const message = response?.data?.error;
  return typeof message === 'string' && message.trim() !== '' ? message : fallback;
}

export async function fetchAccountingAccounts(signal?: AbortSignal): Promise<AccountingAccount[]> {
  const { data } = await api.get('/accounting/accounts', { signal });
  return (data?.accounts ?? []) as AccountingAccount[];
}

export async function fetchFiscalPeriods(signal?: AbortSignal): Promise<FiscalPeriod[]> {
  const { data } = await api.get('/fiscal-periods', { signal });
  return (data?.periods ?? []) as FiscalPeriod[];
}

export async function fetchGeneralLedger(
  filters: GeneralLedgerFilters,
  signal?: AbortSignal,
): Promise<GeneralLedgerReport> {
  const { data } = await api.get('/accounting/reports/general-ledger', { params: compact({ ...filters }), signal });
  return data.report as GeneralLedgerReport;
}

export async function fetchTrialBalance(
  range: ReportRangeParams,
  signal?: AbortSignal,
): Promise<TrialBalanceReport> {
  const { data } = await api.get('/accounting/reports/trial-balance', { params: compact({ ...range }), signal });
  return data.report as TrialBalanceReport;
}

export async function fetchProfitAndLoss(
  range: ReportRangeParams,
  signal?: AbortSignal,
): Promise<ProfitAndLossReport> {
  const { data } = await api.get('/accounting/reports/profit-loss', { params: compact({ ...range }), signal });
  return data.report as ProfitAndLossReport;
}

export async function fetchBalanceSheet(
  range: ReportRangeParams,
  signal?: AbortSignal,
): Promise<BalanceSheetReport> {
  const { data } = await api.get('/accounting/reports/balance-sheet', { params: compact({ ...range }), signal });
  return data.report as BalanceSheetReport;
}

export async function fetchReconciliation(
  range: ReportRangeParams,
  signal?: AbortSignal,
): Promise<ReconciliationReport> {
  const { data } = await api.get('/accounting/reports/reconciliation', { params: compact({ ...range }), signal });
  return data.report as ReconciliationReport;
}

export async function fetchIntegrity(signal?: AbortSignal): Promise<IntegrityReport> {
  const { data } = await api.get('/accounting/reports/integrity', { signal });
  return data.report as IntegrityReport;
}

export async function createManualJournal(input: ManualJournalInput): Promise<void> {
  await api.post('/accounting/manual-journal', input);
}
