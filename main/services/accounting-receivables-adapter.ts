/**
 * Receivables accounting adapter (Milestone D): connects independent
 * customer-account settlement events to the ledger.
 *
 * Ownership boundary (docs/accounting-architecture-plan.md §7.4, Mirror
 * Rule): bill-side receivable activity is owned by the sales adapter — a
 * `charge` mirrored from a bill payment (`reference = bill_id`) is
 * sub-ledger bookkeeping, never a journal. Manual charges and adjustments
 * are out of D by decision and are skipped with a logged reason for future
 * reconciliation. D journalizes exactly one event: `entry_type='settlement'`
 * rows of `receivable_entries`, whose id is the stable identity:
 * `receivables` + entry id + seq 1, Dr the settlement tender account /
 * Cr `1100 Accounts Receivable`, dated by `entry_date`.
 *
 * Deletion of a journalized settlement reverses its journal through the
 * shared core after the delete transaction has committed; the journal is the
 * reversal source, so no deleted-row data is needed. Adapter failures are
 * logged and left to reconciliation — never rolled back into the source
 * transaction, no pending/retry state.
 *
 * The D production surface is discovery + one-event reprocess:
 * `listUnresolvedReceivableSettlements` derives unresolved events from the
 * source rows and the ledger, and `reprocessReceivableAccounting` completes
 * exactly one missing projection (original journal or missing reversal) under
 * the same `receivables + entry id + seq 1` identity. It never creates a new
 * source event and never persists retry state.
 */
import { getDatabase, withTxn } from '../db';
import { reverseJournal, createJournal, getAccountByCode, JournalRecord } from './accounting';

type Database = ReturnType<typeof getDatabase>;

/** Confirmed D mapping: bank-family tenders settle into 1010; `other` has no v1 account. */
const SETTLEMENT_TENDER_ACCOUNTS: Record<string, string> = {
  cash: '1000',
  card: '1010',
  bank_transfer: '1010',
  cheque: '1010',
};

function skip(reason: string): null {
  console.error(`[Accounting] skipped: ${reason}`);
  return null;
}

function fail(scope: string, error: unknown): null {
  console.error(`[Accounting] ${scope} failed; left to reconciliation:`, error);
  return null;
}

function existingSettlementJournal(db: Database, entryId: string): JournalRecord | undefined {
  return db.prepare(
    "SELECT * FROM journal_entries WHERE source_module = 'receivables' AND source_id = ? AND seq = 1",
  ).get(entryId) as JournalRecord | undefined;
}

function journalHasReversal(db: Database, journalId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM journal_entries WHERE reverses_journal_id = ?').get(journalId));
}

/** Reverses one settlement journal; returns null (logged) when the core rejects it. */
function reverseSettlementJournal(journal: JournalRecord, actorUserId: string): JournalRecord | null {
  try {
    return reverseJournal(journal.id, actorUserId, new Date().toISOString().slice(0, 10));
  } catch (error) {
    console.error('[Accounting] settlement reversal failed; left to reconciliation:', error);
    return null;
  }
}

/**
 * Settlement journal for one independent `receivable_entries.settlement` row:
 * Dr the tender account per the confirmed mapping / Cr `1100`, seq 1,
 * dated by the row's `entry_date` (the v99 service already fiscal-gates the
 * row itself; the journal re-gates through the core on its own date).
 * Idempotent on `receivables + entry id + seq 1`.
 */
export function createSettlementJournal(entryId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const entry = db.prepare('SELECT * FROM receivable_entries WHERE id = ?').get(entryId) as any;
    if (!entry) return null;
    const existing = existingSettlementJournal(db, String(entry.id));
    if (existing) return existing;
    if (entry.entry_type !== 'settlement') {
      return skip(`receivable entry ${entry.id}: entry_type ${entry.entry_type} is outside Milestone D`);
    }
    const accountId = entry.payment_method ? SETTLEMENT_TENDER_ACCOUNTS[entry.payment_method] : undefined;
    if (!accountId) {
      return skip(`settlement ${entry.id}: payment_method ${entry.payment_method} has no v1 chart account`);
    }
    const amount = Number(entry.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return skip(`settlement ${entry.id}: invalid amount`);
    }
    return withTxn(() => createJournal({
      entryDate: String(entry.entry_date),
      description: `Settlement for customer ${entry.customer_id}`,
      sourceModule: 'receivables',
      sourceId: String(entry.id),
      seq: 1,
      reference: String(entry.customer_id),
      actorUserId,
      lines: [
        { accountId: getAccountByCode(accountId).id, direction: 'debit', amount, lineDescription: `settlement ${entry.payment_method}` },
        { accountId: getAccountByCode('1100').id, direction: 'credit', amount, lineDescription: 'receivable settled' },
      ],
    }));
  } catch (error) {
    return fail(`settlement journal for entry ${entryId}`, error);
  }
}

/** Post-commit hook for the receivables create route; never throws. */
export function recordReceivableEntryAccounting(entryId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (entryId === undefined || entryId === null || entryId === '' || actorUserId === undefined || actorUserId === null) return;
    createSettlementJournal(String(entryId), actorUserId);
  } catch (error) {
    console.error('[Accounting] receivable entry accounting failed:', error);
  }
}

/**
 * Post-commit hook for the receivables delete route: reverses the settled
 * journal through the shared core (mirrored lines, link via
 * `reverses_journal_id`, source identity preserved). Idempotent — a journal
 * that is already reversed (or never existed) yields no new journal.
 */
export function recordReceivableEntryDeletionAccounting(entryId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (entryId === undefined || entryId === null || entryId === '' || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const journal = existingSettlementJournal(db, String(entryId));
    if (!journal) return;
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') return;
    reverseSettlementJournal(journal, actorUserId);
  } catch (error) {
    console.error('[Accounting] receivable entry deletion accounting failed:', error);
  }
}

export type UnresolvedReceivableState = 'missing_journal' | 'missing_reversal';

export interface UnresolvedReceivableEvent {
  entry_id: string;
  state: UnresolvedReceivableState;
  customer_id: string | null;
  entry_date: string;
  amount: number | null;
  payment_method: string | null;
  /** False when the tender has no v1 account (`other`): listed, but reprocess skips it. */
  journalizable: boolean;
}

export type ReceivableReprocessStatus =
  | 'journalized'
  | 'already_journalized'
  | 'reversal_created'
  | 'already_reversed'
  | 'skipped'
  | 'nothing_to_do';

export interface ReceivableReprocessResult {
  entry_id: string;
  status: ReceivableReprocessStatus;
  journal_id?: string;
}

/**
 * Read-only discovery of unresolved D events, derived from state (no stored
 * status): settlements with no original journal, and posted settlement
 * journals whose source row is gone without a reversal. Never mutates.
 */
export function listUnresolvedReceivableSettlements(): UnresolvedReceivableEvent[] {
  const db = getDatabase();
  const missingJournals = db.prepare(`
    SELECT e.id, e.customer_id, e.entry_date, e.amount, e.payment_method
    FROM receivable_entries e
    WHERE e.entry_type = 'settlement'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries j
        WHERE j.source_module = 'receivables' AND j.source_id = e.id AND j.seq = 1
      )
    ORDER BY e.entry_date DESC, e.id DESC
  `).all() as Array<{ id: string; customer_id: string | null; entry_date: string; amount: number; payment_method: string | null }>;

  const missingReversals = db.prepare(`
    SELECT j.id AS journal_id, j.source_id AS entry_id, j.entry_date, j.reference
    FROM journal_entries j
    WHERE j.source_module = 'receivables' AND j.seq = 1 AND j.status = 'posted'
      AND NOT EXISTS (SELECT 1 FROM receivable_entries e WHERE e.id = j.source_id)
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_journal_id = j.id)
    ORDER BY j.entry_date DESC
  `).all() as Array<{ journal_id: string; entry_id: string; entry_date: string; reference: string | null }>;

  const debitTotal = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0) AS amount
    FROM journal_entry_lines WHERE journal_id = ?
  `);

  return [
    ...missingJournals.map((row) => ({
      entry_id: String(row.id),
      state: 'missing_journal' as const,
      customer_id: row.customer_id ?? null,
      entry_date: String(row.entry_date),
      amount: Number(row.amount),
      payment_method: row.payment_method ?? null,
      journalizable: Boolean(row.payment_method && SETTLEMENT_TENDER_ACCOUNTS[row.payment_method]),
    })),
    ...missingReversals.map((row) => ({
      entry_id: String(row.entry_id),
      state: 'missing_reversal' as const,
      customer_id: row.reference ?? null,
      entry_date: String(row.entry_date),
      amount: Number((debitTotal.get(row.journal_id) as { amount: number }).amount),
      payment_method: null,
      journalizable: true,
    })),
  ];
}

/**
 * Completes exactly one missing projection for a settlement source event:
 * original journal when the source exists without one, else the missing
 * reversal when the source is gone but its posted journal is not reversed.
 * Everything else is a no-op. Identity is always `receivables + entry id +
 * seq 1`; no new source event and no new accounting identity are created.
 */
export function reprocessReceivableAccounting(entryId: string, actorUserId: string): ReceivableReprocessResult {
  try {
    const db = getDatabase();
    const entry = db.prepare('SELECT id FROM receivable_entries WHERE id = ?').get(entryId) as { id: string } | undefined;
    const journal = existingSettlementJournal(db, entryId);

    if (entry) {
      if (journal) return { entry_id: entryId, status: 'already_journalized', journal_id: journal.id };
      const created = createSettlementJournal(entryId, actorUserId);
      return created
        ? { entry_id: entryId, status: 'journalized', journal_id: created.id }
        : { entry_id: entryId, status: 'skipped' };
    }

    // Source is gone: only a missing reversal is actionable, never a new journal.
    if (!journal) return { entry_id: entryId, status: 'nothing_to_do' };
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') {
      return { entry_id: entryId, status: 'already_reversed', journal_id: journal.id };
    }
    const reversal = reverseSettlementJournal(journal, actorUserId);
    return reversal
      ? { entry_id: entryId, status: 'reversal_created', journal_id: reversal.id }
      : { entry_id: entryId, status: 'skipped' };
  } catch (error) {
    console.error('[Accounting] receivable reprocess failed; left to reconciliation:', error);
    return { entry_id: entryId, status: 'skipped' };
  }
}
