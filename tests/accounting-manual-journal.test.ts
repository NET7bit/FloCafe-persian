/**
 * Accounting Milestone B: manual journal vs opening balance boundary.
 *
 * Proves the two operations are independent application-level operations on
 * the shared append-only core: separate source identities, per-operation
 * idempotency, strict opening mapping, closed-period gate, owner-only
 * authorization at the API layer, and shared reversal that preserves the
 * original source identity. No B route or service can mint C–G source
 * modules.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-manual-journal.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-b-service-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters, seedOwnerUser,
} = require('./helpers/test-setup');
const {
  createManualJournal, createOpeningBalance, getJournal, reverseJournal,
  getAccountByCode, AccountingServiceError,
} = require('../main/services/accounting');
const { createFiscalPeriod, closeFiscalPeriod, FiscalPeriodError } = require('../main/services/fiscal-periods');

function expectError(statusCode: number, fn: () => void, message: string): void {
  try {
    fn();
    assert(false, `${message} — expected a ${statusCode} error but none was thrown`);
  } catch (err: any) {
    const isService = err instanceof AccountingServiceError;
    const isFiscal = err instanceof FiscalPeriodError;
    assert(
      (isService || isFiscal) && err.statusCode === statusCode,
      `${message} (got ${err.statusCode}: ${err.message})`,
    );
  }
}

const TODAY = new Date().toISOString().slice(0, 10);
const LAST_MONTH = (() => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.toISOString().slice(0, 10);
})();

async function main() {
  console.log('Accounting manual journal / opening balance test (Milestone B)');
  console.log('='.repeat(50));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);

  const cash = getAccountByCode('1000');
  const bank = getAccountByCode('1010');
  const receivable = getAccountByCode('1100');
  const inventory = getAccountByCode('1200');
  const payable = getAccountByCode('2000');
  const equity = getAccountByCode('3000');
  const revenue = getAccountByCode('4000');

  // ── 1. Manual Journal success: generic adjustment with the manual identity ──
  const manual = createManualJournal({
    entryDate: TODAY,
    description: 'Correction: bank fee not tracked',
    reference: 'ADJ-1',
    actorUserId: owner.userId,
    lines: [
      { accountId: bank.id, direction: 'debit', amount: 25 },
      { accountId: getAccountByCode('5000').id, direction: 'credit', amount: 25 },
    ],
  });
  assert(!!manual.id && manual.status === 'posted', 'manual journal is created posted');
  assertEqual(getJournal(manual.id).source_module, 'manual', 'manual journal carries the manual source identity');
  assertEqual(getJournal(manual.id).source_id, null, 'manual journal without a key keeps NULL source_id');

  // ── 2. Opening Balance success: dedicated deterministic identity ──
  const openingLines = [
    { accountId: cash.id, amount: 500 },
    { accountId: bank.id, amount: 12000 },
    { accountId: receivable.id, amount: 800 },
    { accountId: inventory.id, amount: 2500 },
    { accountId: payable.id, amount: -900 },
    { accountId: equity.id, amount: -14900 },
  ];
  const opening = createOpeningBalance({
    entryDate: TODAY,
    actorUserId: owner.userId,
    lines: openingLines,
  });
  assert(!!opening.id && opening.status === 'posted', 'opening balance is created posted');
  const openingRow = getJournal(opening.id);
  assertEqual(openingRow.source_module, 'opening_balance', 'opening balance carries the dedicated opening identity');
  assert(/^opening-[0-9a-f]{32}$/.test(String(openingRow.source_id)), 'opening source_id is the deterministic opening- hash');
  assertEqual(openingRow.entry_date, TODAY, 'opening uses the caller entry_date (fiscal resolution, no stored period)');
  assertEqual(openingRow.lines.length, 6, 'opening lines persisted');

  // ── 3. Two independent manual journals → two independent events ──
  const manual2 = createManualJournal({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 3 },
      { accountId: getAccountByCode('5900').id, direction: 'credit', amount: 3 },
    ],
  });
  assert(manual2.id !== manual.id, 'two manual journals without keys are independent events');
  assertEqual(
    (db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = 'manual'").get() as any).n,
    2,
    'two manual events exist',
  );

  // ── 4. Manual resubmit: same key → 409, no duplicate event ──
  const keyed = createManualJournal({
    entryDate: TODAY, idempotencyKey: 'client-key-1', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 9 },
      { accountId: revenue.id, direction: 'credit', amount: 9 },
    ],
  });
  expectError(409, () => createManualJournal({
    entryDate: TODAY, idempotencyKey: 'client-key-1', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 9 },
      { accountId: revenue.id, direction: 'credit', amount: 9 },
    ],
  }), 'resubmitting the same manual key is rejected');
  assertEqual(
    (db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = 'manual' AND source_id = ?").get('mje-client-key-1') as any).n,
    1,
    'the keyed manual resubmit created no duplicate event',
  );
  assertEqual(
    (db.prepare('SELECT COUNT(*) AS n FROM journal_entry_lines WHERE journal_id = ?').get(keyed.id) as any).n,
    2,
    'the rejected duplicate left no partial lines',
  );

  // ── 5. Opening resubmit: identical content → same identity, 409, no duplicate ──
  // A 409 here proves the identity collided: a description- or order-dependent
  // hash would have produced a fresh identity and a second event (201).
  expectError(409, () => createOpeningBalance({
    entryDate: TODAY, description: 'Submitted again with different wording', actorUserId: owner.userId,
    lines: [...openingLines].reverse(),
  }), 'resubmitting the same opening (different wording, reversed line order) is rejected');
  assertEqual(
    (db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE source_module = 'opening_balance'").get() as any).n,
    1,
    'the opening resubmit created no duplicate event',
  );
  const otherOpening = createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: inventory.id, amount: 100 },
      { accountId: equity.id, amount: -100 },
    ],
  });
  assert(otherOpening.source_id !== openingRow.source_id, 'a different opening content gets its own identity');

  // ── 6. Manual Journal cannot create an opening balance ──
  assertEqual(getJournal(manual.id).source_module !== 'opening_balance', true, 'a manual journal is never an opening event');
  const manualOnEquity = createManualJournal({
    entryDate: TODAY, description: 'Equity adjustment', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 100 },
      { accountId: equity.id, direction: 'credit', amount: 100 },
    ],
  });
  assertEqual(getJournal(manualOnEquity.id).source_module, 'manual', 'a manual journal touching 3000 stays a manual event, never an opening');
  expectError(400, () => require('../main/services/accounting').createJournal({
    entryDate: TODAY, sourceModule: 'manual', actorUserId: owner.userId, sourceId: 'opening-abc',
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: equity.id, direction: 'credit', amount: 1 },
    ],
  }), 'even the raw core path cannot attach any source_id — opening or otherwise — to a manual journal');
  expectError(400, () => require('../main/services/accounting').createJournal({
    entryDate: TODAY, sourceModule: 'opening_balance', sourceId: 'opening-abc', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: equity.id, direction: 'credit', amount: 1 },
    ],
  }), 'a forged opening identity cannot impersonate the real opening event');
  expectError(400, () => require('../main/services/accounting').createJournal({
    entryDate: TODAY, sourceModule: 'opening_balance', sourceId: `opening-${'a'.repeat(32)}`, actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: equity.id, direction: 'credit', amount: 1 },
    ],
  }), 'a well-formed but foreign opening hash is rejected');

  // ── 7. Opening Balance cannot be registered as a Manual Journal ──
  expectError(400, () => createManualJournal({
    entryDate: TODAY, idempotencyKey: String(openingRow.source_id), actorUserId: owner.userId,
    lines: openingRow.lines.map((l: any) => ({
      accountId: l.account_id, direction: l.direction, amount: l.amount,
    })),
  }), 'the manual path rejects the reserved opening- idempotency prefix');
  expectError(400, () => require('../main/services/accounting').createJournal({
    entryDate: TODAY, sourceModule: 'opening_balance', sourceId: 'not-a-hash', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: equity.id, direction: 'credit', amount: 1 },
    ],
  }), 'the opening module only accepts the service-assigned identity');
  expectError(409, () => require('../main/services/accounting').createJournal({
    entryDate: TODAY, sourceModule: 'opening_balance', sourceId: openingRow.source_id, actorUserId: owner.userId,
    lines: openingRow.lines.map((l: any) => ({
      accountId: l.account_id, direction: l.direction, amount: l.amount,
    })),
  }), 'even the raw core path resubmitting the true identity is an idempotent 409, never a second event');

  // ── 8. No B path mints C–G source modules ──
  for (const sourceModule of ['sales', 'refunds', 'receivables', 'purchases', 'supplier_payments', 'purchase_returns', 'expenses'] as const) {
    expectError(400, () => require('../main/services/accounting').createJournal({
      entryDate: TODAY, sourceModule, actorUserId: owner.userId,
      lines: [
        { accountId: cash.id, direction: 'debit', amount: 1 },
        { accountId: revenue.id, direction: 'credit', amount: 1 },
      ],
    }), `createJournal still requires source_id for ${sourceModule} (module events stay with their milestones)`);
  }
  const keyedWithModuleName = createManualJournal({
    entryDate: TODAY, idempotencyKey: 'sales/x', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  });
  assertEqual(getJournal(keyedWithModuleName.id).source_module, 'manual', 'a client key mentioning a module name never changes the source module');
  const moduleCounts = db.prepare(
    'SELECT source_module, COUNT(*) AS n FROM journal_entries GROUP BY source_module',
  ).all() as any[];
  const countOf = (m: string) => moduleCounts.find((r) => r.source_module === m)?.n ?? 0;
  assertEqual(countOf('manual'), 5, 'only service-created manual events exist (manual, manual2, keyed, equity adjustment, module-named key)');
  assertEqual(countOf('opening_balance'), 2, 'only service-created opening events exist (main + different content)');
  for (const m of ['sales', 'refunds', 'receivables', 'purchases', 'supplier_payments', 'purchase_returns', 'expenses']) {
    assertEqual(countOf(m), 0, `no B path created a ${m} event`);
  }

  // ── Opening mapping: strict semantics, existing CoA only ──
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: revenue.id, amount: 100 },
      { accountId: equity.id, amount: -100 },
    ],
  }), 'opening debit lines must reference asset accounts');
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, amount: 100 },
      { accountId: payable.id, amount: 100 },
    ],
  }), 'opening credit lines must reference liability or equity accounts');
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, amount: 100 },
      { accountId: cash.id, amount: -100 },
    ],
  }), 'opening lines must reference distinct accounts');
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [{ accountId: cash.id, amount: 100 }],
  }), 'opening balances need both sides');
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [{ accountId: cash.id, amount: 0 }],
  }), 'opening amounts must be non-zero');
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId, lines: [],
  }), 'opening needs at least one line');
  expectError(400, () => createOpeningBalance({
    entryDate: TODAY, actorUserId: owner.userId,
    lines: [
      { accountId: 'acct_9999', amount: 100 },
      { accountId: equity.id, amount: -100 },
    ],
  }), 'opening rejects unknown accounts (no account is created)');
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM accounting_accounts').get() as any).n, 12, 'the CoA still holds exactly the 12 seeded accounts');
  expectError(400, () => createManualJournal({
    entryDate: TODAY, idempotencyKey: new Array(129).fill('a').join(''), actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  }), 'oversized manual keys are rejected');
  expectError(400, () => createManualJournal({
    entryDate: TODAY, idempotencyKey: '  ', actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, direction: 'debit', amount: 1 },
      { accountId: revenue.id, direction: 'credit', amount: 1 },
    ],
  }), 'blank manual keys are rejected');

  // ── Fiscal gate: closed period → 409 on both paths ──
  const month = createFiscalPeriod(db, { periodType: 'month', startDate: LAST_MONTH, actorUserId: owner.userId });
  closeFiscalPeriod(db, month.id, owner.userId);
  expectError(409, () => createManualJournal({
    entryDate: LAST_MONTH, actorUserId: owner.userId,
    lines: [
      { accountId: bank.id, direction: 'debit', amount: 1 },
      { accountId: getAccountByCode('5000').id, direction: 'credit', amount: 1 },
    ],
  }), 'manual journal in a closed fiscal period is rejected');
  expectError(409, () => createOpeningBalance({
    entryDate: LAST_MONTH, actorUserId: owner.userId,
    lines: [
      { accountId: cash.id, amount: 10 },
      { accountId: equity.id, amount: -10 },
    ],
  }), 'opening balance in a closed fiscal period is rejected');

  // ── 9. Shared reversal preserves the original source identity ──
  const openingReversal = reverseJournal(opening.id, owner.userId, TODAY);
  assertEqual(openingReversal.source_module, 'opening_balance', 'opening reversal stays on the opening source module');
  assertEqual(openingReversal.source_id, openingRow.source_id, 'opening reversal keeps the deterministic identity (chain seq)');
  assertEqual(openingReversal.reverses_journal_id, opening.id, 'opening reversal links to the original');
  assertEqual(getJournal(opening.id).status, 'reversed', 'reversed opening stays in history');
  assertEqual(openingReversal.seq, 2, 'opening reversal joins the chain at max(seq)+1');

  const manualReversal = reverseJournal(manual.id, owner.userId, TODAY);
  assertEqual(manualReversal.source_module, 'manual', 'manual reversal stays on the manual source module');
  assertEqual(manualReversal.source_id, null, 'unkeyed manual reversal keeps NULL source_id');
  assertEqual(manualReversal.reverses_journal_id, manual.id, 'manual reversal links to the original');
  expectError(409, () => reverseJournal(opening.id, owner.userId, TODAY), 'double reversal of an opening is rejected');
  expectError(409, () => reverseJournal(manualReversal.id, owner.userId, TODAY), 'reversing a reversal is rejected');

  console.log('='.repeat(50));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
