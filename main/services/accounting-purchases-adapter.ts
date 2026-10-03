/**
 * Purchases & suppliers accounting adapter (Milestone E): a post-commit
 * projection of three independent source events into the ledger.
 *
 * Ownership boundary (docs/accounting-architecture-plan.md): the business
 * modules stay the source of truth, accounting is derived, and each event is
 * journalized exactly once under the core identity `source_module + source_id
 * + seq`. E owns exactly three triggers, one per source event:
 * - Purchase invoice posted: `purchases` + invoice id + seq 1, Dr `1200` /
 *   Cr `2000` for the invoice's authoritative `total`. Drafts and cancelled
 *   drafts are never financial events, so they are not journalized; a posted
 *   invoice is terminal and cannot be cancelled (only returned).
 * - Supplier payment created: `supplier_payments` + payment id + seq 1,
 *   Dr `2000` / Cr `1000` (cash) or `1010` (card/bank_transfer/cheque).
 *   `other` has no v1 chart account and is skipped with a logged reason.
 * - Purchase return created: `purchase_returns` + return id + seq 1,
 *   Dr `2000` / Cr `1200` for the authoritative `purchase_returns.total`.
 *   It never reuses the invoice identity and never overwrites the purchase
 *   journal.
 *
 * Post-commit ordering matches C/D: the source transaction commits first,
 * then the adapter runs each journal in its own transaction. Failures
 * (closed fiscal period, data gap) are logged and left to reconciliation —
 * never rolled back into the source, no pending/queue/retry state.
 *
 * Deletions (hard delete for supplier payments, soft delete for purchase
 * returns) reverse through the shared core after the source transaction has
 * committed; the journal itself is the reversal source. The purchase-invoice
 * lifecycle has no accounting cancellation event, so nothing is reversed for
 * it.
 *
 * The E production surface mirrors D's discovery + one-event reprocess, scoped
 * to these three modules: `listUnresolvedPurchaseEvents` derives unresolved
 * events from source rows and the ledger, and `reprocessPurchaseAccounting`
 * completes exactly one missing projection (original journal or missing
 * reversal) under the same server-derived identity. No new source event and
 * no new accounting identity are ever created.
 */
import { getDatabase, withTxn } from '../db';
import { fiscalDateForInstant } from './fiscal-periods';
import { reverseJournal, createJournal, getAccountByCode, JournalRecord } from './accounting';

type Database = ReturnType<typeof getDatabase>;

/** Confirmed E mapping: cash settles into 1000; the bank family into 1010; `other` has no v1 account. */
const PAYMENT_TENDER_ACCOUNTS: Record<string, string> = {
  cash: '1000',
  card: '1010',
  bank_transfer: '1010',
  cheque: '1010',
};

export type PurchaseSourceKind = 'purchase_invoice' | 'supplier_payment' | 'purchase_return';

const SOURCE_MODULE_BY_KIND: Record<PurchaseSourceKind, 'purchases' | 'supplier_payments' | 'purchase_returns'> = {
  purchase_invoice: 'purchases',
  supplier_payment: 'supplier_payments',
  purchase_return: 'purchase_returns',
};

interface PurchaseInvoiceRow { id: string; invoice_number: string; status: string; invoice_date: string; total: number; }
interface SupplierPaymentRow { id: string; supplier_id: string; amount: number; payment_method: string; paid_at: string; }
interface PurchaseReturnRow { id: string; return_number: string; status: string; return_date: string; total: number; }

function skip(reason: string): null {
  console.error(`[Accounting] skipped: ${reason}`);
  return null;
}

function fail(scope: string, error: unknown): null {
  console.error(`[Accounting] ${scope} failed; left to reconciliation:`, error);
  return null;
}

function existingJournal(db: Database, sourceModule: string, sourceId: string): JournalRecord | undefined {
  return db.prepare(
    'SELECT * FROM journal_entries WHERE source_module = ? AND source_id = ? AND seq = 1',
  ).get(sourceModule, sourceId) as JournalRecord | undefined;
}

function journalHasReversal(db: Database, journalId: string): boolean {
  return Boolean(db.prepare('SELECT id FROM journal_entries WHERE reverses_journal_id = ?').get(journalId));
}

/** Reverses one source journal; returns null (logged) when the core rejects it. */
function reverseSourceJournal(journal: JournalRecord, actorUserId: string): JournalRecord | null {
  try {
    return reverseJournal(journal.id, actorUserId, new Date().toISOString().slice(0, 10));
  } catch (error) {
    console.error('[Accounting] source reversal failed; left to reconciliation:', error);
    return null;
  }
}

/**
 * Purchase-invoice journal for a posted invoice: Dr `1200 Inventory` /
 * Cr `2000 Accounts Payable` for `invoice.total`, seq 1, dated by
 * `invoice_date`. Idempotent on `purchases + invoice id + seq 1`.
 */
export function createPurchaseInvoiceJournal(invoiceId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const invoice = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(invoiceId) as PurchaseInvoiceRow | undefined;
    if (!invoice) return null;
    const existing = existingJournal(db, 'purchases', String(invoice.id));
    if (existing) return existing;
    if (!['posted', 'partially_paid', 'paid'].includes(String(invoice.status))) {
      return skip(`purchase invoice ${invoice.id}: status ${invoice.status} is not a posted financial event`);
    }
    const amount = Number(invoice.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return skip(`purchase invoice ${invoice.id}: invalid total`);
    }
    return withTxn(() => createJournal({
      entryDate: String(invoice.invoice_date).slice(0, 10),
      description: `Purchase invoice ${invoice.invoice_number}`,
      sourceModule: 'purchases',
      sourceId: String(invoice.id),
      seq: 1,
      reference: String(invoice.invoice_number),
      actorUserId,
      lines: [
        { accountId: getAccountByCode('1200').id, direction: 'debit', amount, lineDescription: 'purchase inventory' },
        { accountId: getAccountByCode('2000').id, direction: 'credit', amount, lineDescription: 'accounts payable' },
      ],
    }));
  } catch (error) {
    return fail(`purchase journal for invoice ${invoiceId}`, error);
  }
}

/**
 * Supplier-payment journal: Dr `2000 Accounts Payable` / Cr `1000` (cash) or
 * `1010` (card/bank_transfer/cheque) for `payment.amount`, seq 1, dated by the
 * payment's business date. `other` is skipped with a logged reason.
 * Idempotent on `supplier_payments + payment id + seq 1`.
 */
export function createSupplierPaymentJournal(paymentId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const payment = db.prepare('SELECT * FROM supplier_payments WHERE id = ?').get(paymentId) as SupplierPaymentRow | undefined;
    if (!payment) return null;
    const existing = existingJournal(db, 'supplier_payments', String(payment.id));
    if (existing) return existing;
    const accountCode = payment.payment_method ? PAYMENT_TENDER_ACCOUNTS[String(payment.payment_method)] : undefined;
    if (!accountCode) {
      return skip(`supplier payment ${payment.id}: payment_method ${payment.payment_method} has no v1 chart account`);
    }
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return skip(`supplier payment ${payment.id}: invalid amount`);
    }
    return withTxn(() => createJournal({
      entryDate: fiscalDateForInstant(payment.paid_at),
      description: `Supplier payment to ${payment.supplier_id}`,
      sourceModule: 'supplier_payments',
      sourceId: String(payment.id),
      seq: 1,
      reference: String(payment.supplier_id),
      actorUserId,
      lines: [
        { accountId: getAccountByCode('2000').id, direction: 'debit', amount, lineDescription: 'accounts payable' },
        { accountId: getAccountByCode(accountCode).id, direction: 'credit', amount, lineDescription: `supplier payment ${payment.payment_method}` },
      ],
    }));
  } catch (error) {
    return fail(`supplier payment journal for payment ${paymentId}`, error);
  }
}

/**
 * Purchase-return journal for a completed return: Dr `2000 Accounts Payable`
 * / Cr `1200 Inventory` for the authoritative `return.total`, seq 1, dated by
 * `return_date`. Idempotent on `purchase_returns + return id + seq 1`.
 */
export function createPurchaseReturnJournal(returnId: string, actorUserId: string): JournalRecord | null {
  try {
    const db = getDatabase();
    const record = db.prepare('SELECT * FROM purchase_returns WHERE id = ?').get(returnId) as PurchaseReturnRow | undefined;
    if (!record) return null;
    const existing = existingJournal(db, 'purchase_returns', String(record.id));
    if (existing) return existing;
    if (String(record.status) !== 'completed') {
      return skip(`purchase return ${record.id}: status ${record.status} is not a completed financial event`);
    }
    const amount = Number(record.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      return skip(`purchase return ${record.id}: invalid total`);
    }
    return withTxn(() => createJournal({
      entryDate: String(record.return_date).slice(0, 10),
      description: `Purchase return ${record.return_number}`,
      sourceModule: 'purchase_returns',
      sourceId: String(record.id),
      seq: 1,
      reference: String(record.return_number),
      actorUserId,
      lines: [
        { accountId: getAccountByCode('2000').id, direction: 'debit', amount, lineDescription: 'accounts payable' },
        { accountId: getAccountByCode('1200').id, direction: 'credit', amount, lineDescription: 'purchase return inventory' },
      ],
    }));
  } catch (error) {
    return fail(`purchase return journal for return ${returnId}`, error);
  }
}

/** Post-commit hook for the invoice post route; never throws. */
export function recordPurchaseInvoiceAccounting(invoiceId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (invoiceId === undefined || invoiceId === null || invoiceId === '' || actorUserId === undefined || actorUserId === null) return;
    createPurchaseInvoiceJournal(String(invoiceId), actorUserId);
  } catch (error) {
    console.error('[Accounting] purchase invoice accounting failed:', error);
  }
}

/** Post-commit hook for the supplier payment create route; never throws. */
export function recordSupplierPaymentAccounting(paymentId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (paymentId === undefined || paymentId === null || paymentId === '' || actorUserId === undefined || actorUserId === null) return;
    createSupplierPaymentJournal(String(paymentId), actorUserId);
  } catch (error) {
    console.error('[Accounting] supplier payment accounting failed:', error);
  }
}

/**
 * Post-commit hook for the supplier payment delete route: reverses the posted
 * journal through the shared core. Idempotent — a journal already reversed (or
 * never created) yields no new journal.
 */
export function recordSupplierPaymentDeletionAccounting(paymentId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (paymentId === undefined || paymentId === null || paymentId === '' || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const journal = existingJournal(db, 'supplier_payments', String(paymentId));
    if (!journal) return;
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') return;
    reverseSourceJournal(journal, actorUserId);
  } catch (error) {
    console.error('[Accounting] supplier payment deletion accounting failed:', error);
  }
}

/** Post-commit hook for the purchase return create route; never throws. */
export function recordPurchaseReturnAccounting(returnId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (returnId === undefined || returnId === null || returnId === '' || actorUserId === undefined || actorUserId === null) return;
    createPurchaseReturnJournal(String(returnId), actorUserId);
  } catch (error) {
    console.error('[Accounting] purchase return accounting failed:', error);
  }
}

/**
 * Post-commit hook for the purchase return delete route. The business row is
 * soft-deleted, so the original journal is reversed through the shared core.
 * Idempotent.
 */
export function recordPurchaseReturnDeletionAccounting(returnId: string | null | undefined, actorUserId: string | null | undefined): void {
  try {
    if (returnId === undefined || returnId === null || returnId === '' || actorUserId === undefined || actorUserId === null) return;
    const db = getDatabase();
    const journal = existingJournal(db, 'purchase_returns', String(returnId));
    if (!journal) return;
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') return;
    reverseSourceJournal(journal, actorUserId);
  } catch (error) {
    console.error('[Accounting] purchase return deletion accounting failed:', error);
  }
}

export type UnresolvedPurchaseState = 'missing_journal' | 'missing_reversal';

export interface UnresolvedPurchaseEvent {
  kind: PurchaseSourceKind;
  source_module: 'purchases' | 'supplier_payments' | 'purchase_returns';
  event_id: string;
  state: UnresolvedPurchaseState;
  entry_date: string;
  amount: number | null;
  payment_method: string | null;
  /** False when the event has no v1 account (only supplier payment `other`): listed, but reprocess skips it. */
  journalizable: boolean;
}

export type PurchaseReprocessStatus =
  | 'journalized'
  | 'already_journalized'
  | 'reversal_created'
  | 'already_reversed'
  | 'skipped'
  | 'nothing_to_do';

export interface PurchaseReprocessResult {
  kind: PurchaseSourceKind;
  event_id: string;
  status: PurchaseReprocessStatus;
  journal_id?: string;
}

export function isPurchaseSourceKind(value: unknown): value is PurchaseSourceKind {
  return value === 'purchase_invoice' || value === 'supplier_payment' || value === 'purchase_return';
}

/**
 * Read-only discovery of unresolved E events, derived from state (no stored
 * status). Per module:
 * - purchase invoice: posted/partially_paid/paid rows with no original journal.
 * - supplier payment: rows with no original journal, or posted journals whose
 *   source row was hard-deleted without a reversal.
 * - purchase return: completed rows with no original journal, or posted
 *   journals whose source row is soft-deleted without a reversal.
 * Never mutates.
 */
export function listUnresolvedPurchaseEvents(): UnresolvedPurchaseEvent[] {
  const db = getDatabase();
  const journalizableEvents: UnresolvedPurchaseEvent[] = [];
  const missingReversalEvents: UnresolvedPurchaseEvent[] = [];

  const missingInvoices = db.prepare(`
    SELECT i.id, i.invoice_date, i.total
    FROM purchase_invoices i
    WHERE i.status IN ('posted', 'partially_paid', 'paid')
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries j
        WHERE j.source_module = 'purchases' AND j.source_id = i.id AND j.seq = 1
      )
    ORDER BY i.invoice_date DESC, i.id DESC
  `).all() as Array<{ id: string; invoice_date: string; total: number }>;
  for (const row of missingInvoices) {
    journalizableEvents.push({
      kind: 'purchase_invoice',
      source_module: 'purchases',
      event_id: String(row.id),
      state: 'missing_journal',
      entry_date: String(row.invoice_date).slice(0, 10),
      amount: Number(row.total),
      payment_method: null,
      journalizable: true,
    });
  }

  const missingPayments = db.prepare(`
    SELECT p.id, p.paid_at, p.amount, p.payment_method
    FROM supplier_payments p
    WHERE NOT EXISTS (
      SELECT 1 FROM journal_entries j
      WHERE j.source_module = 'supplier_payments' AND j.source_id = p.id AND j.seq = 1
    )
    ORDER BY p.paid_at DESC, p.id DESC
  `).all() as Array<{ id: string; paid_at: string; amount: number; payment_method: string | null }>;
  for (const row of missingPayments) {
    journalizableEvents.push({
      kind: 'supplier_payment',
      source_module: 'supplier_payments',
      event_id: String(row.id),
      state: 'missing_journal',
      entry_date: fiscalDateForInstant(row.paid_at),
      amount: Number(row.amount),
      payment_method: row.payment_method ?? null,
      journalizable: Boolean(row.payment_method && PAYMENT_TENDER_ACCOUNTS[row.payment_method]),
    });
  }

  const missingReturns = db.prepare(`
    SELECT r.id, r.return_date, r.total
    FROM purchase_returns r
    WHERE r.status = 'completed'
      AND NOT EXISTS (
        SELECT 1 FROM journal_entries j
        WHERE j.source_module = 'purchase_returns' AND j.source_id = r.id AND j.seq = 1
      )
    ORDER BY r.return_date DESC, r.id DESC
  `).all() as Array<{ id: string; return_date: string; total: number }>;
  for (const row of missingReturns) {
    journalizableEvents.push({
      kind: 'purchase_return',
      source_module: 'purchase_returns',
      event_id: String(row.id),
      state: 'missing_journal',
      entry_date: String(row.return_date).slice(0, 10),
      amount: Number(row.total),
      payment_method: null,
      journalizable: true,
    });
  }

  const debitTotal = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount END), 0) AS amount
    FROM journal_entry_lines WHERE journal_id = ?
  `);

  const orphanPayments = db.prepare(`
    SELECT j.id AS journal_id, j.source_id AS event_id, j.entry_date
    FROM journal_entries j
    WHERE j.source_module = 'supplier_payments' AND j.seq = 1 AND j.status = 'posted'
      AND NOT EXISTS (SELECT 1 FROM supplier_payments p WHERE p.id = j.source_id)
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_journal_id = j.id)
    ORDER BY j.entry_date DESC
  `).all() as Array<{ journal_id: string; event_id: string; entry_date: string }>;
  for (const row of orphanPayments) {
    missingReversalEvents.push({
      kind: 'supplier_payment',
      source_module: 'supplier_payments',
      event_id: String(row.event_id),
      state: 'missing_reversal',
      entry_date: String(row.entry_date),
      amount: Number((debitTotal.get(row.journal_id) as { amount: number }).amount),
      payment_method: null,
      journalizable: true,
    });
  }

  const orphanReturns = db.prepare(`
    SELECT j.id AS journal_id, j.source_id AS event_id, j.entry_date
    FROM journal_entries j
    WHERE j.source_module = 'purchase_returns' AND j.seq = 1 AND j.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM purchase_returns r WHERE r.id = j.source_id AND r.status <> 'deleted'
      )
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_journal_id = j.id)
    ORDER BY j.entry_date DESC
  `).all() as Array<{ journal_id: string; event_id: string; entry_date: string }>;
  for (const row of orphanReturns) {
    missingReversalEvents.push({
      kind: 'purchase_return',
      source_module: 'purchase_returns',
      event_id: String(row.event_id),
      state: 'missing_reversal',
      entry_date: String(row.entry_date),
      amount: Number((debitTotal.get(row.journal_id) as { amount: number }).amount),
      payment_method: null,
      journalizable: true,
    });
  }

  return [...journalizableEvents, ...missingReversalEvents];
}

/** True when the source row still represents an event that should carry an original journal. */
function isSourceJournalizable(db: Database, kind: PurchaseSourceKind, eventId: string): boolean {
  if (kind === 'purchase_invoice') {
    const row = db.prepare('SELECT status FROM purchase_invoices WHERE id = ?').get(eventId) as { status: string } | undefined;
    return Boolean(row && ['posted', 'partially_paid', 'paid'].includes(row.status));
  }
  if (kind === 'supplier_payment') {
    return Boolean(db.prepare('SELECT id FROM supplier_payments WHERE id = ?').get(eventId));
  }
  const row = db.prepare('SELECT status FROM purchase_returns WHERE id = ?').get(eventId) as { status: string } | undefined;
  return Boolean(row && row.status === 'completed');
}

/**
 * Completes exactly one missing projection for a Stage 6-E source event:
 * the original journal when an eligible source row exists without one, else
 * the missing reversal when the source is gone/soft-deleted but its posted
 * journal is not reversed. Everything else is a no-op. Identity is always the
 * source module + event id + seq 1; no new source event and no new accounting
 * identity are created. The client may only name the kind and the source id.
 */
export function reprocessPurchaseAccounting(
  kind: PurchaseSourceKind,
  eventId: string,
  actorUserId: string,
): PurchaseReprocessResult {
  try {
    const db = getDatabase();
    const sourceModule = SOURCE_MODULE_BY_KIND[kind];
    const journal = existingJournal(db, sourceModule, eventId);

    if (isSourceJournalizable(db, kind, eventId)) {
      if (journal) return { kind, event_id: eventId, status: 'already_journalized', journal_id: journal.id };
      const created = kind === 'purchase_invoice'
        ? createPurchaseInvoiceJournal(eventId, actorUserId)
        : kind === 'supplier_payment'
          ? createSupplierPaymentJournal(eventId, actorUserId)
          : createPurchaseReturnJournal(eventId, actorUserId);
      return created
        ? { kind, event_id: eventId, status: 'journalized', journal_id: created.id }
        : { kind, event_id: eventId, status: 'skipped' };
    }

    // Source is no longer an original-journal event: only a missing reversal is actionable.
    if (!journal) return { kind, event_id: eventId, status: 'nothing_to_do' };
    if (journalHasReversal(db, journal.id) || journal.status === 'reversed') {
      return { kind, event_id: eventId, status: 'already_reversed', journal_id: journal.id };
    }
    const reversal = reverseSourceJournal(journal, actorUserId);
    return reversal
      ? { kind, event_id: eventId, status: 'reversal_created', journal_id: reversal.id }
      : { kind, event_id: eventId, status: 'skipped' };
  } catch (error) {
    console.error('[Accounting] purchase reprocess failed; left to reconciliation:', error);
    return { kind, event_id: eventId, status: 'skipped' };
  }
}
