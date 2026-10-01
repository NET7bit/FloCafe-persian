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
    const reversed = db.prepare(
      'SELECT id FROM journal_entries WHERE reverses_journal_id = ?',
    ).get(journal.id) as { id: string } | undefined;
    if (reversed || journal.status === 'reversed') return;
    reverseJournal(journal.id, actorUserId, new Date().toISOString().slice(0, 10));
  } catch (error) {
    console.error('[Accounting] receivable entry deletion accounting failed:', error);
  }
}
