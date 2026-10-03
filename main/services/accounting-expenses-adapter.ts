/**
 * Expenses accounting adapter (Milestone F): a post-commit projection of the
 * expense module into the ledger.
 *
 * Ownership boundary (docs/accounting-architecture-plan.md): the expense
 * module stays the source of truth, accounting is derived, and each expense is
 * journalized exactly once under the core identity `source_module + source_id
 * + seq`. An expense is final on creation — there is no draft/posting/approval
 * state — so `POST /api/expenses` is the single financial trigger:
 * `expenses` + expense id + seq 1, dated by `expense_date`, `Dr 5000 Operating
 * Expenses` / `Cr 1000` (cash) or `1010` (card/bank_transfer/cheque) for the
 * authoritative `amount`. `other` has no v1 chart account and is skipped with
 * a logged reason.
 *
 * The source model carries no payable state and no supplier/vendor reference,
 * so an expense is always settled at the payment method; there is no
 * credit/AP mapping in F and no interaction with Stage 6-E supplier payments.
 *
 * Post-commit ordering matches C–E: the source transaction commits first, then
 * the adapter runs its journal in its own transaction. Failures (closed fiscal
 * period, data gap) are logged and left to reconciliation — never rolled back
 * into the source, no pending/queue/retry state.
 *
 * Deleting an expense is a hard delete, so a journalized expense is reversed
 * through the shared core after the source transaction has committed; the
 * journal itself is the reversal source, so no deleted-row data is needed.
 *
 * The F production surface mirrors D/E's discovery + one-event reprocess,
 * scoped to the expense module: `listUnresolvedExpenses` derives unresolved
 * events from source rows and the ledger, and `reprocessExpenseAccounting`
 * completes exactly one missing projection (original journal or missing
 * reversal) under the same server-derived identity.
 */
import { getDatabase, withTxn } from '../db';
import { reverseJournal, createJournal, getAccountByCode, JournalRecord } from './accounting';

type Database = ReturnType<typeof getDatabase>;

/** Confirmed F mapping: cash settles into 1000; the bank family into 1010; `other` has no v1 account. */
const EXPENSE_TENDER_ACCOUNTS: Record<string, string> = {
  cash: '1000',
  card: '1010',
  bank_transfer: '1010',
  cheque: '1010',
};

/** The existing CoA has a single generic expense account; categories are not account-mapped. */
const EXPENSE_ACCOUNT_CODE = '5000';

interface ExpenseRow { id: string; category: string; amount: number; payment_method: string; expense_date: string; }

function skip(reason: string): null {
  console.error(`[Accounting] skipped: ${reason}`);
  return null;
}

function fail(scope: string, error: unknown): null {
  console.error(`[Accounting] ${scope} failed; left to reconciliation:`, error);
  return null;
}

function existingExpenseJournal(db: Database, expenseId: string): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'expenses' AND source_id = ? AND seq = 1",
  ).get(expenseId) as JournalRecord | undefined;
}

function journalHasReversal(db: Database, journalId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM journal_entries WHERE reverses_journal_id = ?').get(journalId));
}

/** Reverses one expense journal; returns null (logged) when the core rejects it. */
function reverseExpenseJournal(journal: JournalRecord, actorUserId: string): JournalRecord | null {
  try {
    return reverseJournal(journal.id, actorUserId, new Date().toISOString().slice(0, 10));
  } catch (error) {
    console.error('[Accounting] expense reversal failed; left to reconciliation:', error);
    return null;
  }
}

/**
 * Expense journal for one expense row: `Dr 5000` / `Cr` the payment tender
 * account per the confirmed mapping, seq 1, dated by `expense_date` (the
 * service already fiscal-gates the row; the journal re-gates through the core
 * on its own date). Idempotent on `expenses + expense id + seq 1`.
 */
export function createExpenseJournal(expenseId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expenseId) as ExpenseRow | undefined;
    if (!expense) return null;
    const existing = existingExpenseJournal(db, String(expense.id));
    if (existing) return existing;
    const accountCode = expense.payment_method ? EXPENSE_TENDER_ACCOUNTS[String(expense.payment_method)] : undefined;
    if (!accountCode) {
      return skip(`expense ${expense.id}: payment_method ${expense.payment_method} has no v1 chart account`);
    }
    const amount = Number(expense.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return skip(`expense ${expense.id}: invalid amount`);
    }
    return withTxn(() => createJournal({
      entryDate: String(expense.expense_date),
      description: `Expense ${expense.category}`,
      sourceModule: 'expenses',
      sourceId: String(expense.id),
      seq: 1,
      reference: String(expense.category),
      actorUserId,
      lines: [
        { accountId: getAccountByCode(EXPENSE_ACCOUNT_CODE).id, direction: 'debit', amount, lineDescription: 'expense' },
        { accountId: getAccountByCode(accountCode).id, direction: 'credit', amount, lineDescription: `expense ${expense.payment_method}` },
      ],
    }));
  } catch (error) {
    return fail(`expense journal for expense ${expenseId}`, error);
  }
}

/** Post-commit hook for the expense create route; never throws. */
export function recordExpenseAccounting(expenseId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (expenseId === undefined || expenseId === null || expenseId === '' || actorUserId === undefined || actorUserId === null) return;
    createExpenseJournal(String(expenseId), actorUserId);
  } catch (error) {
    console.error('[Accounting] expense accounting failed:', error);
  }
}

/**
 * Post-commit hook for the expense delete route: reverses the posted journal
 * through the shared core. Idempotent — a journal already reversed (or never
 * created) yields no new journal.
 */
export function recordExpenseDeletionAccounting(expenseId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (expenseId === undefined || expenseId === null || expenseId === '' || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const journal = existingExpenseJournal(db, String(expenseId));
    if (!journal) return;
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') return;
    reverseExpenseJournal(journal, actorUserId);
  } catch (error) {
    console.error('[Accounting] expense deletion accounting failed:', error);
  }
}

export type UnresolvedExpenseState = 'missing_journal' | 'missing_reversal';

export interface UnresolvedExpenseEvent {
  event_id: string;
  state: UnresolvedExpenseState;
  expense_date: string;
  amount: number | null;
  category: string | null;
  payment_method: string | null;
  /** False when the tender has no v1 account (`other`): listed, but reprocess skips it. */
  journalizable: boolean;
}

export type ExpenseReprocessStatus =
  | 'journalized'
  | 'already_journalized'
  | 'reversal_created'
  | 'already_reversed'
  | 'skipped'
  | 'nothing_to_do';

export interface ExpenseReprocessResult {
  expense_id: string;
  status: ExpenseReprocessStatus;
  journal_id?: string;
}

/**
 * Read-only discovery of unresolved F events, derived from state (no stored
 * status): expense rows with no original journal, and posted expense journals
 * whose source row is gone without a reversal. Never mutates.
 */
export function listUnresolvedExpenses(): UnresolvedExpenseEvent[] {
  const db = getDatabase();
  const missingJournals = db.prepare(`
    SELECT e.id, e.expense_date, e.amount, e.category, e.payment_method
    FROM expenses e
    WHERE NOT EXISTS (
      SELECT 1 FROM journal_entries j
      WHERE j.source_module = 'expenses' AND j.source_id = e.id AND j.seq = 1
    )
    ORDER BY e.expense_date DESC, e.id DESC
  `).all() as Array<{ id: string; expense_date: string; amount: number; category: string; payment_method: string | null }>;

  const missingReversals = db.prepare(`
    SELECT j.id AS journal_id, j.source_id AS event_id, j.entry_date, j.reference
    FROM journal_entries j
    WHERE j.source_module = 'expenses' AND j.seq = 1 AND j.status = 'posted'
      AND NOT EXISTS (SELECT 1 FROM expenses e WHERE e.id = j.source_id)
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_journal_id = j.id)
    ORDER BY j.entry_date DESC
  `).all() as Array<{ journal_id: string; event_id: string; entry_date: string; reference: string | null }>;

  const debitTotal = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0) AS amount
    FROM journal_entry_lines WHERE journal_id = ?
  `);

  return [
    ...missingJournals.map((row) => ({
      event_id: String(row.id),
      state: 'missing_journal' as const,
      expense_date: String(row.expense_date),
      amount: Number(row.amount),
      category: row.category ?? null,
      payment_method: row.payment_method ?? null,
      journalizable: Boolean(row.payment_method && EXPENSE_TENDER_ACCOUNTS[row.payment_method]),
    })),
    ...missingReversals.map((row) => ({
      event_id: String(row.event_id),
      state: 'missing_reversal' as const,
      expense_date: String(row.entry_date),
      amount: Number((debitTotal.get(row.journal_id) as { amount: number }).amount),
      category: row.reference ?? null,
      payment_method: null,
      journalizable: true,
    })),
  ];
}

/**
 * Completes exactly one missing projection for an expense source event: the
 * original journal when the source exists without one, else the missing
 * reversal when the source is gone but its posted journal is not reversed.
 * Everything else is a no-op. Identity is always `expenses + expense id +
 * seq 1`; no new source event and no new accounting identity are created.
 */
export function reprocessExpenseAccounting(expenseId: string, actorUserId: string): ExpenseReprocessResult {
  try {
    const db = getDatabase();
    const expense = db.prepare('SELECT id FROM expenses WHERE id = ?').get(expenseId) as { id: string } | undefined;
    const journal = existingExpenseJournal(db, expenseId);

    if (expense) {
      if (journal) return { expense_id: expenseId, status: 'already_journalized', journal_id: journal.id };
      const created = createExpenseJournal(expenseId, actorUserId);
      return created
        ? { expense_id: expenseId, status: 'journalized', journal_id: created.id }
        : { expense_id: expenseId, status: 'skipped' };
    }

    // Source is gone: only a missing reversal is actionable, never a new journal.
    if (!journal) return { expense_id: expenseId, status: 'nothing_to_do' };
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') {
      return { expense_id: expenseId, status: 'already_reversed', journal_id: journal.id };
    }
    const reversal = reverseExpenseJournal(journal, actorUserId);
    return reversal
      ? { expense_id: expenseId, status: 'reversal_created', journal_id: reversal.id }
      : { expense_id: expenseId, status: 'skipped' };
  } catch (error) {
    console.error('[Accounting] expense reprocess failed; left to reconciliation:', error);
    return { expense_id: expenseId, status: 'skipped' };
  }
}
