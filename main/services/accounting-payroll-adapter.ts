/** Projects posted payroll runs and their settlements into the append-only ledger. */
import { getDatabase, withTxn } from '../db';
import { createJournal, getAccountByCode, JournalRecord, reverseJournal } from './accounting';
import { createPayrollDeductionReversal } from './receivables';
import { recordReceivableEntryAccounting } from './accounting-receivables-adapter';

type PayrollEventKind = 'run' | 'payment' | 'withholding';
type Database = ReturnType<typeof getDatabase>;

export interface UnresolvedPayrollEvent {
  event_id: string;
  kind: PayrollEventKind;
  state: 'missing_journal' | 'missing_reversal';
  event_date: string;
  amount: number;
}

function existingJournal(db: Database, sourceId: string): JournalRecord | undefined {
  return db.prepare("SELECT * FROM journal_entries WHERE source_module = 'payroll' AND source_id = ? AND seq = 1")
    .get(sourceId) as JournalRecord | undefined;
}

function reversed(db: Database, journalId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM journal_entries WHERE reverses_journal_id = ?').get(journalId));
}

function amount(value: unknown): number | null {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) && result > 0 ? Math.round(result * 100) / 100 : null;
}

function tenderAccount(method: string): string | null {
  if (method === 'cash') return '1000';
  if (['card', 'bank_transfer', 'cheque'].includes(method)) return '1010';
  return null;
}

function skip(reason: string): null {
  console.error(`[Accounting] skipped payroll: ${reason}`);
  return null;
}

function fail(scope: string, error: unknown): null {
  console.error(`[Accounting] ${scope} failed; left to reconciliation:`, error);
  return null;
}

export function createPayrollRunJournal(runId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId) as
      | { id: string; period_end: string; status: string }
      | undefined;
    if (!run || run.status !== 'posted') return null;
    const existing = existingJournal(db, runId);
    if (existing) return existing;
    const totals = db.prepare(`
      SELECT COALESCE(SUM(gross_amount), 0) AS gross, COALESCE(SUM(deductions_amount), 0) AS deductions,
        COALESCE(SUM(net_amount), 0) AS net
      FROM payroll_run_items WHERE payroll_run_id = ?
    `).get(runId) as { gross: number; deductions: number; net: number };
    const gross = amount(Number(totals.gross));
    if (gross === null) return skip(`run ${runId}: gross earnings are zero or invalid`);
    const deductions = Math.round(Number(totals.deductions) * 100) / 100;
    const net = Math.round(Number(totals.net) * 100) / 100;
    if (Math.abs(gross - deductions - net) > 0.01) return skip(`run ${runId}: payroll totals do not balance`);
    return withTxn(() => createJournal({
      entryDate: run.period_end,
      description: `Payroll ${run.period_end}`,
      sourceModule: 'payroll',
      sourceId: runId,
      seq: 1,
      reference: runId,
      actorUserId,
      lines: [
        { accountId: getAccountByCode('5010').id, direction: 'debit', amount: gross, lineDescription: 'gross payroll expense' },
        ...(net > 0 ? [{ accountId: getAccountByCode('2010').id, direction: 'credit' as const, amount: net, lineDescription: 'net payroll payable' }] : []),
        ...(deductions > 0 ? [{ accountId: getAccountByCode('2020').id, direction: 'credit' as const, amount: deductions, lineDescription: 'payroll withholdings payable' }] : []),
      ],
    }));
  } catch (error) {
    return fail(`payroll run journal for ${runId}`, error);
  }
}

export function createPayrollPaymentJournal(paymentId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const payment = db.prepare(`SELECT * FROM payroll_payments WHERE id = ? AND deleted_at IS NULL`).get(paymentId) as
      | { id: string; amount: number; payment_method: string; paid_at: string }
      | undefined;
    if (!payment) return null;
    const existing = existingJournal(db, paymentId);
    if (existing) return existing;
    const value = amount(Number(payment.amount));
    const accountCode = tenderAccount(payment.payment_method);
    if (value === null || !accountCode) return skip(`employee payment ${paymentId}: unsupported amount or tender`);
    return withTxn(() => createJournal({
      entryDate: payment.paid_at.slice(0, 10),
      description: 'Payroll payment',
      sourceModule: 'payroll',
      sourceId: paymentId,
      seq: 1,
      reference: paymentId,
      actorUserId,
      lines: [
        { accountId: getAccountByCode('2010').id, direction: 'debit', amount: value, lineDescription: 'payroll payable settlement' },
        { accountId: getAccountByCode(accountCode).id, direction: 'credit', amount: value, lineDescription: `payroll payment ${payment.payment_method}` },
      ],
    }));
  } catch (error) {
    return fail(`payroll payment journal for ${paymentId}`, error);
  }
}

export function createPayrollWithholdingJournal(paymentId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const payment = db.prepare(`SELECT * FROM payroll_withholding_payments WHERE id = ? AND deleted_at IS NULL`).get(paymentId) as
      | { id: string; amount: number; payment_method: string; paid_at: string }
      | undefined;
    if (!payment) return null;
    const existing = existingJournal(db, paymentId);
    if (existing) return existing;
    const value = amount(Number(payment.amount));
    const accountCode = tenderAccount(payment.payment_method);
    if (value === null || !accountCode) return skip(`withholding payment ${paymentId}: unsupported amount or tender`);
    return withTxn(() => createJournal({
      entryDate: payment.paid_at.slice(0, 10),
      description: 'Payroll withholding payment',
      sourceModule: 'payroll',
      sourceId: paymentId,
      seq: 1,
      reference: paymentId,
      actorUserId,
      lines: [
        { accountId: getAccountByCode('2020').id, direction: 'debit', amount: value, lineDescription: 'payroll withholdings settlement' },
        { accountId: getAccountByCode(accountCode).id, direction: 'credit', amount: value, lineDescription: `withholding payment ${payment.payment_method}` },
      ],
    }));
  } catch (error) {
    return fail(`payroll withholding journal for ${paymentId}`, error);
  }
}

function reversePayrollJournal(eventId: string, actorUserId: string, reversalDate: string): JournalRecord | null {
  const journal = existingJournal(getDatabase(), eventId);
  if (!journal || journalHasReversal(getDatabase(), journal.id)) return null;
  try {
    return reverseJournal(journal.id, actorUserId, reversalDate);
  } catch (error) {
    return fail(`payroll journal reversal for ${eventId}`, error);
  }
}

function journalHasReversal(db: Database, journalId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM journal_entries WHERE reverses_journal_id = ?').get(journalId));
}

export function recordPayrollRunAccounting(runId: string, actorUserId: string): void {
  createPayrollRunJournal(runId, actorUserId);
  const db = getDatabase();
  const entries = db.prepare("SELECT id FROM receivable_entries WHERE entry_type = 'settlement' AND payment_method = 'payroll_deduction' AND reference = ?").all(runId) as Array<{ id: string }>;
  for (const entry of entries) recordReceivableEntryAccounting(entry.id, actorUserId);
}

export function recordPayrollRunReversal(runId: string, actorUserId: string, reversalDate: string): void {
  reversePayrollJournal(runId, actorUserId, reversalDate);
  const db = getDatabase();
  const entries = db.prepare("SELECT id, customer_id, amount FROM receivable_entries WHERE entry_type = 'settlement' AND payment_method = 'payroll_deduction' AND reference = ?").all(runId) as Array<{ id: string; customer_id: string; amount: number }>;
  for (const entry of entries) {
    const reversalId = `${entry.id}_rev`;
    const exists = db.prepare('SELECT id FROM receivable_entries WHERE id = ?').get(reversalId);
    if (!exists) {
      const reversal = createPayrollDeductionReversal(db, {
        id: reversalId,
        customerId: entry.customer_id,
        amount: Number(entry.amount),
        entryDate: reversalDate,
        payrollRunId: runId,
        actorUserId,
      });
      recordReceivableEntryAccounting(reversal.id, actorUserId);
    }
  }
}

export function recordPayrollPaymentAccounting(paymentId: string, actorUserId: string): void {
  createPayrollPaymentJournal(paymentId, actorUserId);
}

export function recordPayrollPaymentDeletion(paymentId: string, actorUserId: string, reversalDate: string): void {
  reversePayrollJournal(paymentId, actorUserId, reversalDate);
}

export function recordPayrollWithholdingAccounting(paymentId: string, actorUserId: string): void {
  createPayrollWithholdingJournal(paymentId, actorUserId);
}

export function recordPayrollWithholdingDeletion(paymentId: string, actorUserId: string, reversalDate: string): void {
  reversePayrollJournal(paymentId, actorUserId, reversalDate);
}

export function listUnresolvedPayrollEvents(): UnresolvedPayrollEvent[] {
  const db = getDatabase();
  const events: UnresolvedPayrollEvent[] = [];
  const add = (kind: PayrollEventKind, row: { event_id: string; event_date: string; amount: number }, state: UnresolvedPayrollEvent['state']) => {
    events.push({ event_id: row.event_id, kind, state, event_date: row.event_date.slice(0, 10), amount: Number(row.amount || 0) });
  };
  const runs = db.prepare(`SELECT id AS event_id, period_end AS event_date, 0 AS amount FROM payroll_runs WHERE status = 'posted'`).all() as Array<{ event_id: string; event_date: string; amount: number }>;
  for (const run of runs) if (!existingJournal(db, run.event_id)) add('run', run, 'missing_journal');
  const reversedRuns = db.prepare(`SELECT id AS event_id, updated_at AS event_date, 0 AS amount FROM payroll_runs WHERE status = 'reversed'`).all() as Array<{ event_id: string; event_date: string; amount: number }>;
  for (const run of reversedRuns) {
    const journal = existingJournal(db, run.event_id);
    if (journal && !journalHasReversal(db, journal.id)) add('run', run, 'missing_reversal');
  }
  const paymentSets: Array<{ kind: 'payment' | 'withholding'; table: string }> = [
    { kind: 'payment', table: 'payroll_payments' },
    { kind: 'withholding', table: 'payroll_withholding_payments' },
  ];
  for (const { kind, table } of paymentSets) {
    const active = db.prepare(`SELECT id AS event_id, paid_at AS event_date, amount FROM ${table} WHERE deleted_at IS NULL`).all() as Array<{ event_id: string; event_date: string; amount: number }>;
    const deleted = db.prepare(`SELECT id AS event_id, deleted_at AS event_date, amount FROM ${table} WHERE deleted_at IS NOT NULL`).all() as Array<{ event_id: string; event_date: string; amount: number }>;
    for (const row of active) if (!existingJournal(db, row.event_id)) add(kind, row, 'missing_journal');
    for (const row of deleted) {
      const journal = existingJournal(db, row.event_id);
      if (journal && !journalHasReversal(db, journal.id)) add(kind, row, 'missing_reversal');
    }
  }
  return events.sort((a, b) => a.event_date.localeCompare(b.event_date) || a.event_id.localeCompare(b.event_id));
}

export function reprocessPayrollAccounting(kind: PayrollEventKind, eventId: string, actorUserId: string): 'journalized' | 'reversal_created' | 'already_complete' | 'skipped' {
  const event = listUnresolvedPayrollEvents().find((item) => item.kind === kind && item.event_id === eventId);
  if (!event) return 'already_complete';
  if (event.state === 'missing_reversal') {
    return reversePayrollJournal(eventId, actorUserId, new Date().toISOString().slice(0, 10)) ? 'reversal_created' : 'skipped';
  }
  const result = kind === 'run'
    ? createPayrollRunJournal(eventId, actorUserId)
    : kind === 'payment'
      ? createPayrollPaymentJournal(eventId, actorUserId)
      : createPayrollWithholdingJournal(eventId, actorUserId);
  return result ? 'journalized' : 'skipped';
}
