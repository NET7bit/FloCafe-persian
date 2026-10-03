/**
 * Receivables accounting adapter coverage (Milestone D).
 *
 * Exercises the real write paths (POST /api/receivables create/delete) plus
 * the adapter functions for scenarios that have no runtime trigger (skip
 * policies, reprocess after a period reopen). Proves the ownership boundary:
 * settlements journalize in D under `receivables + entry id + seq 1`; bill
 * mirrored charges and manual rows never do; deletions reverse through the
 * shared core; replays and post-reopen reprocesses never duplicate.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-receivables-adapter.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-receivables-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters, seedOwnerUser, seedManagerUser, now,
} = require('./helpers/test-setup');
const {
  createSettlementJournal, recordReceivableEntryAccounting, recordReceivableEntryDeletionAccounting,
} = require('../main/services/accounting-receivables-adapter');
const {
  createReceivableEntry, deleteReceivableEntry, getCustomerBalance,
} = require('../main/services/receivables');
const { reverseJournal } = require('../main/services/accounting');
const {
  createFiscalPeriod, closeFiscalPeriod, reopenFiscalPeriod, FiscalPeriodError,
} = require('../main/services/fiscal-periods');
const { AccountingServiceError } = require('../main/services/accounting');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    const known = err instanceof AccountingServiceError || err instanceof FiscalPeriodError;
    assert(known && err.statusCode === statusCode, `${message} (got ${err.statusCode}: ${err.message})`);
  }
}

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();

function journalCount(db: any, sourceModule: string, sourceId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = ? AND source_id = ?')
    .get(sourceModule, String(sourceId)) as any).n;
}
function linesOf(db: any, journalId: string): Array<{ code: string; direction: string; amount: number }> {
  return db.prepare(`
    SELECT a.code AS code, l.direction AS direction, l.amount AS amount
    FROM journal_entry_lines l JOIN accounting_accounts a ON a.id = l.account_id
    WHERE l.journal_id = ? ORDER BY l.rowid
  `).all(journalId);
}

async function main() {
  console.log('Receivables accounting adapter test (Milestone D)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);

  db.prepare(`INSERT INTO customers (id, name, is_active) VALUES ('cust-d', 'D Customer', 1)`).run();

  // ── Identity + mapping: settlement → one journal, Dr tender / Cr 1100 ──
  const cash = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 300,
    paymentMethod: 'cash', entryDate: TODAY, actorUserId: owner.userId,
  });
  recordReceivableEntryAccounting(cash.id, owner.userId);
  const cashJournals = db.prepare('SELECT * FROM journal_entries WHERE source_module = ? AND source_id = ? ORDER BY seq')
    .all('receivables', cash.id) as any[];
  assertEqual(cashJournals.length, 1, 'first settlement run creates exactly one journal');
  const cashJournal: any = cashJournals[0];
  assertEqual(cashJournal.seq, 1, 'settlement identity: seq 1');
  assertEqual(cashJournal.reference, 'cust-d', 'settlement reference is the customer id');
  assertEqual(cashJournal.entry_date, TODAY, 'settlement journal is dated by entry_date');
  assertEqual(
    JSON.stringify(linesOf(db, cashJournal.id).map((l) => [l.code, l.direction, l.amount])),
    JSON.stringify([['1000', 'debit', 300], ['1100', 'credit', 300]]),
    'cash settlement maps Dr 1000 / Cr 1100',
  );

  // Bank-family mapping (confirmed decision).
  const transfer = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 450,
    paymentMethod: 'bank_transfer', entryDate: TODAY, actorUserId: owner.userId,
  });
  const transferJournal: any = createSettlementJournal(transfer.id, owner.userId);
  assertEqual(
    JSON.stringify(linesOf(db, transferJournal.id).map((l) => [l.code, l.direction, l.amount])),
    JSON.stringify([['1010', 'debit', 450], ['1100', 'credit', 450]]),
    'bank_transfer settlement maps Dr 1010 / Cr 1100',
  );
  const chequeJournal: any = createSettlementJournal(
    createReceivableEntry(db, {
      customerId: 'cust-d', entryType: 'settlement', amount: 25,
      paymentMethod: 'cheque', entryDate: TODAY, actorUserId: owner.userId,
    }).id, owner.userId,
  );
  assertEqual(linesOf(db, chequeJournal.id)[0].code, '1010', 'cheque settlement maps Dr 1010');

  // Distinct events → distinct journals under their own ids.
  assertEqual(journalCount(db, 'receivables', cash.id), 1, 'distinct events keep their own journals');
  assertEqual(journalCount(db, 'receivables', transfer.id), 1, 'the second event has its own journal');
  assertNotEqualIds(cashJournal.id, transferJournal.id, 'two settlements are two independent journals');

  function assertNotEqualIds(a: string, b: string, message: string): void {
    assert(a !== b, message);
  }

  // ── Ownership boundary: what D must NOT journalize ──
  const mirror = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'charge', amount: 800,
    description: 'Bill mirror', reference: '777', entryDate: TODAY, actorUserId: owner.userId,
  });
  recordReceivableEntryAccounting(mirror.id, owner.userId);
  assertEqual(journalCount(db, 'receivables', mirror.id), 0, 'a bill-mirrored charge creates no journal in D');

  const manualCharge = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'charge', amount: 50,
    description: 'Manual charge', entryDate: TODAY, actorUserId: owner.userId,
  });
  recordReceivableEntryAccounting(manualCharge.id, owner.userId);
  assertEqual(journalCount(db, 'receivables', manualCharge.id), 0, 'a manual charge is outside D (logged skip)');

  const adjustment = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'adjustment', direction: 'credit', amount: 10,
    description: 'Goodwill adjustment', entryDate: TODAY, actorUserId: owner.userId,
  });
  recordReceivableEntryAccounting(adjustment.id, owner.userId);
  assertEqual(journalCount(db, 'receivables', adjustment.id), 0, 'an adjustment is outside D (logged skip)');

  const otherSettlement = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 15,
    paymentMethod: 'other', entryDate: TODAY, actorUserId: owner.userId,
  });
  recordReceivableEntryAccounting(otherSettlement.id, owner.userId);
  assertEqual(journalCount(db, 'receivables', otherSettlement.id), 0, 'settlement with payment_method other has no v1 account: skipped');

  // No C-domain identity can be forged through D paths.
  expectError(400, () => require('../main/services/accounting').createJournal({
    entryDate: TODAY, sourceModule: 'receivables', actorUserId: owner.userId,
    lines: [
      { accountId: require('../main/services/accounting').getAccountByCode('1000').id, direction: 'debit', amount: 1 },
      { accountId: require('../main/services/accounting').getAccountByCode('1100').id, direction: 'credit', amount: 1 },
    ],
  }), 'createJournal still requires a source_id for receivables (identity stays with the source row)');

  // ── Idempotency: replay ──
  recordReceivableEntryAccounting(cash.id, owner.userId);
  recordReceivableEntryAccounting(cash.id, owner.userId);
  createSettlementJournal(cash.id, owner.userId);
  assertEqual(journalCount(db, 'receivables', cash.id), 1, 'replays create no duplicate settlement journal');

  // ── Fiscal: row created while open, adapter blocked by the later close, then reopen/reprocess ──
  const period = createFiscalPeriod(db, { periodType: 'month', startDate: LAST_MONTH, actorUserId: owner.userId });
  const closed = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 120,
    paymentMethod: 'cash', entryDate: LAST_MONTH, actorUserId: owner.userId,
  });
  closeFiscalPeriod(db, period.id, owner.userId);
  recordReceivableEntryAccounting(closed.id, owner.userId);
  assertEqual(journalCount(db, 'receivables', closed.id), 0, 'a settlement dated in a closed period creates no journal');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entry_lines l JOIN journal_entries j ON j.id = l.journal_id WHERE j.source_module = ? AND j.source_id = ?')
      .get('receivables', closed.id) as any).n,
    0,
    'the rejected settlement left no partial lines',
  );

  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(require('bcryptjs').hashSync('1234', 10), owner.userId);
  reopenFiscalPeriod(db, period.id, '1234', owner.userId, owner.userId);

  const reprocessed: any = createSettlementJournal(closed.id, owner.userId);
  assert(!!reprocessed, 'reprocessing after the reopen creates the settlement journal');
  assertEqual(reprocessed.entry_date, LAST_MONTH, 'reprocessed settlement keeps its original entry_date');
  assertEqual(journalCount(db, 'receivables', closed.id), 1, 'reprocess restores the same identity — no double journal');

  // ── Deletion reversal: post-commit, idempotent, identity preserved ──
  const beforeDeletion = getCustomerBalance(db, 'cust-d');
  deleteReceivableEntry(db, cash.id, owner.userId);
  recordReceivableEntryDeletionAccounting(cash.id, owner.userId);
  const reversal = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(cashJournal.id) as any;
  assert(!!reversal, 'deleting a journalized settlement creates the reversal after commit');
  assertEqual(reversal.source_module, 'receivables', 'reversal keeps the receivables source module');
  assertEqual(reversal.source_id, cash.id, 'reversal keeps the settlement source identity');
  assertEqual(reversal.seq, 2, 'reversal joins the event chain at max(seq)+1');
  assertEqual(
    (db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(cashJournal.id) as any).status,
    'reversed',
    'the original settlement journal is marked reversed and stays in history',
  );
  const reversedLines = linesOf(db, reversal.id);
  assertEqual(reversedLines.length, 2, 'reversal mirrors the two lines');
  assert(
    reversedLines.some((l) => l.code === '1100' && l.direction === 'debit') && reversedLines.some((l) => l.code === '1000' && l.direction === 'credit'),
    'reversal swaps the directions (AR restored, cash returned)',
  );
  recordReceivableEntryDeletionAccounting(cash.id, owner.userId);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(cashJournal.id) as any).n,
    1,
    'repeated deletion hook creates no second reversal',
  );
  const afterDeletion = getCustomerBalance(db, 'cust-d');
  assertEqual(Math.round((afterDeletion - beforeDeletion) * 100) / 100, 300, 'removing the credit settlement row raises the sub-ledger balance by 300 (ledger-only bookkeeping)');

  // ── Every journal balanced ──
  const unbalanced = db.prepare(`
    SELECT j.id, COALESCE(SUM(CASE WHEN l.direction = 'debit' THEN l.amount END), 0) AS d,
           COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount END), 0) AS c
    FROM journal_entries j JOIN journal_entry_lines l ON l.journal_id = j.id
    GROUP BY j.id HAVING ABS(d - c) > 1e-9
  `).all();
  assertEqual(unbalanced.length, 0, 'every journal in the ledger is balanced');

  // ── No pending/retry state; D leaves no new tables ──
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => String(r.name));
  assert(!tables.some((t) => ['adapter_failures', 'journal_sync_state', 'accounting_pending', 'accounting_retry'].includes(t)), 'no pending/retry/journal-sync table exists');

  // ── HTTP integration: the real production path ──
  const { receivableRoutes } = require('../main/routes/receivables');
  const { createApp, startServer, api } = require('./helpers/test-setup');
  const app = createApp({ '/api/receivables': receivableRoutes });
  const { baseUrl, server } = await startServer(app);

  const httpCreate = await api(baseUrl, '/api/receivables', {
    method: 'POST', headers: owner.authHeader,
    body: { customer_id: 'cust-d', entry_type: 'settlement', amount: 75, payment_method: 'card' },
  });
  assertEqual(httpCreate.status, 201, 'POST /api/receivables accepts the settlement');
  const httpId = httpCreate.data.entry.id;
  assertEqual(journalCount(db, 'receivables', httpId), 1, 'the post-commit hook journaled the HTTP settlement');
  const httpJournal = db.prepare('SELECT * FROM journal_entries WHERE source_module = ? AND source_id = ?').get('receivables', httpId) as any;
  assertEqual(
    JSON.stringify(linesOf(db, httpJournal.id).map((l: any) => l.code)),
    JSON.stringify(['1010', '1100']),
    'the HTTP card settlement maps Dr 1010 / Cr 1100',
  );

  const httpDelete = await api(baseUrl, `/api/receivables/${httpId}`, { method: 'DELETE', headers: owner.authHeader });
  assertEqual(httpDelete.status, 200, 'DELETE /api/receivables succeeds');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(httpJournal.id) as any).n,
    1,
    'the HTTP delete reversal is journaled post-commit',
  );
  server.close();

  // ── Production surface: read-only discovery + explicit one-event reprocess ──
  const { accountingRoutes } = require('../main/routes/accounting');
  const manager = seedManagerUser(db);
  const accApp = createApp({ '/api/accounting': accountingRoutes });
  const acc = await startServer(accApp);

  // Discovery is derived and read-only.
  const journalsBefore = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n;
  const discovery = await api(acc.baseUrl, '/api/accounting/receivables/unresolved', { method: 'GET', headers: owner.authHeader });
  assertEqual(discovery.status, 200, 'GET unresolved discovery succeeds for owner');
  const discoveredIds = discovery.data.events.map((e: any) => e.entry_id);
  assert(discoveredIds.includes(otherSettlement.id), 'discovery lists the unjournalized `other` settlement (missing journal)');
  assert(!discoveredIds.includes(transfer.id), 'discovery excludes a journalized settlement');
  assert(!discoveredIds.includes(manualCharge.id), 'discovery excludes charge rows (not a D event)');
  assert(!discoveredIds.includes(adjustment.id), 'discovery excludes adjustment rows');
  assertEqual(
    discovery.data.events.find((e: any) => e.entry_id === otherSettlement.id).state,
    'missing_journal',
    'discovered unjournalized settlement reports missing_journal',
  );
  assertEqual(
    discovery.data.events.find((e: any) => e.entry_id === otherSettlement.id).journalizable,
    false,
    '`other` settlement is listed but not journalizable',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n,
    journalsBefore,
    'discovery is read-only (no journal created)',
  );

  // Authorization: reads are ownerManager, reprocess is owner-only.
  assertEqual((await api(acc.baseUrl, '/api/accounting/receivables/unresolved')).status, 401, 'discovery requires authentication');
  assertEqual((await api(acc.baseUrl, '/api/accounting/receivables/unresolved', { headers: manager.authHeader })).status, 200, 'discovery allows manager (ownerManager)');
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${transfer.id}/reprocess`, { method: 'POST', headers: manager.authHeader })).status,
    403,
    'reprocess rejects a manager (owner-only)',
  );
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${transfer.id}/reprocess`, { method: 'POST' })).status,
    401,
    'reprocess requires authentication',
  );

  // Reprocess no-op / skip cases.
  assertEqual(
    (await api(acc.baseUrl, '/api/accounting/receivables/does-not-exist/reprocess', { method: 'POST', headers: owner.authHeader })).data.result.status,
    'nothing_to_do',
    'reprocess of an unknown id is a no-op',
  );
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${transfer.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_journalized',
    'reprocess of an already journalized settlement is a no-op',
  );
  assertEqual(journalCount(db, 'receivables', transfer.id), 1, 'no-op reprocess creates no duplicate journal');
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${manualCharge.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'skipped',
    'reprocess of a non-settlement row is skipped, never journaled',
  );
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${otherSettlement.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'skipped',
    'reprocess of `other` settlement is skipped (no v1 account)',
  );
  assertEqual(journalCount(db, 'receivables', otherSettlement.id), 0, '`other` reprocess left no journal');

  // The client may only name the source row; identity/amount come from the source.
  const overrideSource = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 90,
    paymentMethod: 'cash', entryDate: TODAY, actorUserId: owner.userId,
  });
  const overridden = await api(acc.baseUrl, `/api/accounting/receivables/${overrideSource.id}/reprocess`, {
    method: 'POST', headers: owner.authHeader,
    body: { source_module: 'sales', source_id: 'evil', seq: 99, amount: 999999 },
  });
  assertEqual(overridden.data.result.status, 'journalized', 'reprocess journals a missing settlement projection');
  const overrideJournal: any = db.prepare("SELECT * FROM journal_entries WHERE source_module = 'receivables' AND source_id = ? AND seq = 1").get(overrideSource.id);
  assert(!!overrideJournal, 'client body cannot override identity: journal keeps receivables + entry id + seq 1');
  assertEqual(
    linesOf(db, overrideJournal.id).reduce((s: number, l: any) => s + (l.direction === 'debit' ? l.amount : 0), 0),
    90,
    'client-supplied amount is ignored; the journal uses the source amount',
  );

  // Missing reversal: source deleted but the adapter step never ran.
  const orphanSource = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 210,
    paymentMethod: 'card', entryDate: TODAY, actorUserId: owner.userId,
  });
  recordReceivableEntryAccounting(orphanSource.id, owner.userId);
  const orphanJournal: any = db.prepare('SELECT * FROM journal_entries WHERE source_module = ? AND source_id = ?').get('receivables', orphanSource.id);
  deleteReceivableEntry(db, orphanSource.id, owner.userId);
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(orphanJournal.id) as any).n,
    0,
    'the simulated adapter failure left the posted journal without a reversal',
  );
  const unresolvedAfterDelete = await api(acc.baseUrl, '/api/accounting/receivables/unresolved', { method: 'GET', headers: owner.authHeader });
  const orphanItem = unresolvedAfterDelete.data.events.find((e: any) => e.entry_id === orphanSource.id);
  assert(!!orphanItem && orphanItem.state === 'missing_reversal', 'discovery derives missing_reversal for a deleted source with a posted journal');

  const repaired = await api(acc.baseUrl, `/api/accounting/receivables/${orphanSource.id}/reprocess`, { method: 'POST', headers: owner.authHeader });
  assertEqual(repaired.data.result.status, 'reversal_created', 'reprocess creates the missing reversal');
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(orphanJournal.id) as any).n,
    1,
    'exactly one reversal exists after reprocess',
  );
  const orphanReversal: any = db.prepare('SELECT * FROM journal_entries WHERE reverses_journal_id = ?').get(orphanJournal.id);
  const orphanReversalLines = linesOf(db, orphanReversal.id);
  assert(
    orphanReversalLines.some((l) => l.code === '1100' && l.direction === 'debit')
      && orphanReversalLines.some((l) => l.code === '1010' && l.direction === 'credit'),
    'the missing reversal is the exact inverse of the original (Dr 1100 / Cr 1010)',
  );
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${orphanSource.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'already_reversed',
    'repeated reprocess after repair is a no-op',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?').get(orphanJournal.id) as any).n,
    1,
    'repeated reprocess creates no second reversal',
  );
  assertEqual(journalCount(db, 'receivables', orphanSource.id), 2, 'no resurrection: the original journal is never rebuilt');

  // Deleted + never journalized is a no-op.
  const goneUnjournalized = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 5,
    paymentMethod: 'other', entryDate: TODAY, actorUserId: owner.userId,
  });
  deleteReceivableEntry(db, goneUnjournalized.id, owner.userId);
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${goneUnjournalized.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'nothing_to_do',
    'reprocess of a deleted, never-journalized settlement creates nothing',
  );

  // Closed period stays unresolved; reopen then reprocess creates exactly one journal.
  const OLD_MONTH = (() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 3);
    return d.toISOString().slice(0, 10);
  })();
  const oldPeriod = createFiscalPeriod(db, { periodType: 'month', startDate: OLD_MONTH, actorUserId: owner.userId });
  const closedViaHttp = createReceivableEntry(db, {
    customerId: 'cust-d', entryType: 'settlement', amount: 130,
    paymentMethod: 'cash', entryDate: OLD_MONTH, actorUserId: owner.userId,
  });
  closeFiscalPeriod(db, oldPeriod.id, owner.userId);
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${closedViaHttp.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'skipped',
    'reprocess is blocked by the closed period (fiscal gate)',
  );
  assertEqual(journalCount(db, 'receivables', closedViaHttp.id), 0, 'closed-period reprocess creates no journal');
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(require('bcryptjs').hashSync('1234', 10), owner.userId);
  reopenFiscalPeriod(db, oldPeriod.id, '1234', owner.userId, owner.userId);
  assertEqual(
    (await api(acc.baseUrl, `/api/accounting/receivables/${closedViaHttp.id}/reprocess`, { method: 'POST', headers: owner.authHeader })).data.result.status,
    'journalized',
    'reprocess after reopen creates the pending journal',
  );
  assertEqual(journalCount(db, 'receivables', closedViaHttp.id), 1, 'reopen reprocess creates exactly one journal (no duplicate)');
  acc.server.close();

  console.log('='.repeat(50));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
