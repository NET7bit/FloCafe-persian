/**
 * Accounting core (Milestone A, migration v102): append-only double-entry
 * ledger. Journals are never edited or deleted; corrections are reversal
 * journals linked via `reverses_journal_id`. Balances are always derived from
 * `journal_entry_lines`; no stored balances exist. Fiscal membership is
 * derived from `journal_entries.entry_date` via the v101 gate — no fiscal FK,
 * no `fiscal_note`. Idempotency is `UNIQUE(source_module, source_id, seq)`.
 */
import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import { assertNotInClosedPeriod } from './fiscal-periods';

export class AccountingServiceError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'AccountingServiceError';
    this.statusCode = statusCode;
  }
}

export interface JournalLineInput {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: number;
  lineDescription?: string | null;
}

export interface CreateJournalInput {
  entryDate: string;
  description?: string | null;
  sourceModule: 'sales' | 'refunds' | 'receivables' | 'purchases' | 'supplier_payments' | 'purchase_returns' | 'expenses' | 'manual';
  sourceId?: string | null;
  seq?: number;
  reference?: string | null;
  actorUserId: string;
  lines: JournalLineInput[];
}

export interface AccountRecord {
  id: string;
  code: string | null;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  normal_side: 'debit' | 'credit';
  is_system: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface JournalRecord {
  id: string;
  entry_date: string;
  description: string | null;
  source_module: CreateJournalInput['sourceModule'];
  source_id: string | null;
  seq: number;
  reference: string | null;
  status: 'posted' | 'reversed';
  reverses_journal_id: string | null;
  created_by: string | null;
  created_at: string;
}

const SOURCE_MODULES = ['sales', 'refunds', 'receivables', 'purchases', 'supplier_payments', 'purchase_returns', 'expenses', 'manual'] as const;

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function assertDate(value: unknown, field: string): string {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new AccountingServiceError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  }
  return text;
}

export function listAccounts(options: { activeOnly?: boolean } = {}): AccountRecord[] {
  const db = getDatabase();
  const rows = (options.activeOnly
    ? db.prepare('SELECT * FROM accounting_accounts WHERE is_active = 1 ORDER BY code')
    : db.prepare('SELECT * FROM accounting_accounts ORDER BY code')).all() as AccountRecord[];
  return rows;
}

export function getAccount(id: string): AccountRecord {
  const row = getDatabase().prepare('SELECT * FROM accounting_accounts WHERE id = ?').get(id) as AccountRecord | undefined;
  if (!row) throw new AccountingServiceError(404, 'Account not found');
  return row;
}

/** Finds an account by its seed code (e.g. '1000') so B–F integrations stay id-free. */
export function getAccountByCode(code: string): AccountRecord {
  const row = getDatabase().prepare('SELECT * FROM accounting_accounts WHERE code = ?').get(code) as AccountRecord | undefined;
  if (!row) throw new AccountingServiceError(404, `Account not found for code ${code}`);
  return row;
}

export type AccountBalance = {
  accountId: string;
  code: string | null;
  name: string;
  type: AccountRecord['type'];
  normal_side: AccountRecord['normal_side'];
  debit_total: number;
  credit_total: number;
  /** Signed balance: positive = debit side, negative = credit side (derived; never stored). */
  balance: number;
};

/**
 * Derived balances: SUM of posted journal lines per account, signed so that a
 * positive `balance` means debit-side and negative means credit-side. Posted
 * means the journal itself is `posted`; a reversed journal's effects are
 * cancelled by its linked reversal journal, so both remain in history and
 * neither is deleted.
 */
export function getAccountBalances(): AccountBalance[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      a.id, a.code, a.name, a.type, a.normal_side,
      COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS debit_total,
      COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS credit_total
    FROM accounting_accounts a
    LEFT JOIN journal_entry_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries j ON j.id = l.journal_id AND j.status = 'posted'
    LEFT JOIN journal_entries jr ON jr.reverses_journal_id = j.id
    WHERE a.is_active = 1 AND (j.id IS NULL OR jr.id IS NULL)
    GROUP BY a.id
    ORDER BY a.code
  `).all() as Omit<AccountBalance, 'balance'>[];
  return rows.map((r) => ({ ...r, balance: r.debit_total - r.credit_total }));
}

function insertJournal(
  db: ReturnType<typeof getDatabase>,
  input: CreateJournalInput,
  id: string,
): JournalRecord {
  const entryDate = assertDate(input.entryDate, 'entry_date');
  if (!input.actorUserId) throw new AccountingServiceError(400, 'actor_user_id is required');
  if (!SOURCE_MODULES.includes(input.sourceModule)) {
    throw new AccountingServiceError(400, `source_module must be one of: ${SOURCE_MODULES.join(', ')}`);
  }
  assertNotInClosedPeriod(db, entryDate);

  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new AccountingServiceError(400, 'A journal needs at least two lines');
  }
  let debitTotal = 0;
  let creditTotal = 0;
  const seenAccounts = new Set<string>();
  for (const line of input.lines) {
    if (!line || (line.direction !== 'debit' && line.direction !== 'credit')) {
      throw new AccountingServiceError(400, 'direction must be debit or credit');
    }
    if (!Number.isFinite(line.amount) || line.amount <= 0) {
      throw new AccountingServiceError(400, 'amount must be a positive number');
    }
    const account = db.prepare('SELECT is_active FROM accounting_accounts WHERE id = ?').get(line.accountId) as { is_active: number } | undefined;
    if (!account) throw new AccountingServiceError(400, `Unknown account: ${line.accountId}`);
    if (!account.is_active) throw new AccountingServiceError(400, `Account ${line.accountId} is inactive`);
    if (seenAccounts.has(line.accountId)) {
      throw new AccountingServiceError(400, 'Each line must reference a distinct account');
    }
    seenAccounts.add(line.accountId);
    if (line.direction === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
  }
  if (Math.abs(debitTotal - creditTotal) > 1e-9) {
    throw new AccountingServiceError(400, 'Journal is not balanced: total debit must equal total credit');
  }

  const seq = input.seq ?? 1;
  if (!Number.isInteger(seq) || seq < 1) throw new AccountingServiceError(400, 'seq must be a positive integer');

  // SQLite treats NULLs as distinct in UNIQUE, so manual journals (source_id
  // NULL) would never collide there; enforce it here instead. Distinct
  // source_ids keep schema-level idempotency for module-posted events.
  if (input.sourceModule === 'manual' && input.sourceId) {
    throw new AccountingServiceError(400, 'manual journals do not take a source_id');
  }
  if (input.sourceModule !== 'manual') {
    if (!input.sourceId) throw new AccountingServiceError(400, 'source_id is required for module journals');
    const duplicate = db.prepare(
      'SELECT id FROM journal_entries WHERE source_module = ? AND source_id IS ? AND seq = ?',
    ).get(input.sourceModule, input.sourceId ?? null, seq) as { id: string } | undefined;
    if (duplicate) throw new AccountingServiceError(409, 'An identical journal already exists for this source event');
  }

  const createdAt = now();
  db.prepare(`
    INSERT INTO journal_entries (id, entry_date, description, source_module, source_id, seq, reference, status, reverses_journal_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', NULL, ?, ?)
  `).run(
    id, entryDate, input.description ?? null, input.sourceModule,
    input.sourceId ?? null, seq, input.reference ?? null, input.actorUserId, createdAt,
  );
  const insertLine = db.prepare(`
    INSERT INTO journal_entry_lines (id, journal_id, account_id, direction, amount, line_description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const line of input.lines) {
    insertLine.run(newId('jel'), id, line.accountId, line.direction, line.amount, line.lineDescription ?? null);
  }
  return {
    id,
    entry_date: entryDate,
    description: input.description ?? null,
    source_module: input.sourceModule,
    source_id: input.sourceId ?? null,
    seq,
    reference: input.reference ?? null,
    status: 'posted',
    reverses_journal_id: null,
    created_by: input.actorUserId,
    created_at: createdAt,
  };
}

/** Creates a posted journal atomically; errors roll back the whole insert. */
export function createJournal(input: CreateJournalInput): JournalRecord {
  return withTxn(() => insertJournal(getDatabase(), input, newId('je')));
}

export function getJournal(id: string): (JournalRecord & { lines: Array<{ id: string; account_id: string; direction: 'debit' | 'credit'; amount: number; line_description: string | null }> }) {
  const db = getDatabase();
  const journal = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id) as JournalRecord | undefined;
  if (!journal) throw new AccountingServiceError(404, 'Journal not found');
  const lines = db.prepare('SELECT id, account_id, direction, amount, line_description FROM journal_entry_lines WHERE journal_id = ? ORDER BY rowid').all(id) as any[];
  return { ...journal, lines };
}

/**
 * Creates a new reversal journal mirroring the original's lines (directions
 * swapped) and links it via `reverses_journal_id`; the original stays in
 * history with status flipped to `reversed`. The reversal's entry date is the
 * caller-supplied current business date and passes the same fiscal gate.
 */
export function reverseJournal(id: string, actorUserId: string, reversalEntryDate: string): JournalRecord {
  return withTxn(() => {
    const db = getDatabase();
    const journal = db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id) as JournalRecord | undefined;
    if (!journal) throw new AccountingServiceError(404, 'Journal not found');
    if (journal.status === 'reversed') throw new AccountingServiceError(409, 'Journal has already been reversed');
    if (journal.reverses_journal_id) throw new AccountingServiceError(409, 'A reversal journal cannot itself be reversed');
    const existingReversal = db.prepare('SELECT id FROM journal_entries WHERE reverses_journal_id = ?').get(id) as { id: string } | undefined;
    if (existingReversal) throw new AccountingServiceError(409, 'Journal has already been reversed');

    const lines = db.prepare('SELECT account_id, direction, amount, line_description FROM journal_entry_lines WHERE journal_id = ? ORDER BY rowid').all(id) as Array<{ account_id: string; direction: 'debit' | 'credit'; amount: number; line_description: string | null }>;
    const entryDate = assertDate(reversalEntryDate, 'reversal entry_date');
    assertNotInClosedPeriod(db, entryDate);

    // The reversal joins its document's event chain after every existing
    // event (sale=1, later payments, prior reversals), so it can never
    // collide with a legitimate module event under the UNIQUE constraint.
    const maxSeqRow = db.prepare(
      'SELECT MAX(seq) AS max_seq FROM journal_entries WHERE source_module = ? AND source_id IS ?',
    ).get(journal.source_module, journal.source_id) as { max_seq: number | null };
    const reversalSeq = (maxSeqRow.max_seq ?? journal.seq) + 1;

    const reversalId = newId('je');
    db.prepare(`
      INSERT INTO journal_entries (id, entry_date, description, source_module, source_id, seq, reference, status, reverses_journal_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?)
    `).run(
      reversalId, entryDate, journal.description ? `Reversal: ${journal.description}` : 'Reversal',
      journal.source_module, journal.source_id, reversalSeq, journal.reference,
      id, actorUserId, now(),
    );
    const insertLine = db.prepare(`
      INSERT INTO journal_entry_lines (id, journal_id, account_id, direction, amount, line_description)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const line of lines) {
      insertLine.run(
        newId('jel'), reversalId, line.account_id,
        line.direction === 'debit' ? 'credit' : 'debit',
        line.amount, line.line_description,
      );
    }
    db.prepare("UPDATE journal_entries SET status = 'reversed' WHERE id = ?").run(id);
    return {
      id: reversalId,
      entry_date: entryDate,
      description: journal.description ? `Reversal: ${journal.description} (${journal.id})` : `Reversal (${journal.id})`,
      source_module: journal.source_module,
      source_id: journal.source_id,
      seq: reversalSeq,
      reference: journal.reference,
      status: 'posted',
      reverses_journal_id: id,
      created_by: actorUserId,
      created_at: now(),
    };
  });
}
