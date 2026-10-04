/**
 * Accounting reports & reconciliation coverage (Milestone H).
 *
 * Builds one coherent ledger plus its business source rows, then proves the
 * four statements are derived correctly from the CoA (GL filters, trial-balance
 * equality, P&L classification with COGS/Opex split, balance-sheet equation),
 * that integrity checks pass, and that reconciliation pairs each domain's
 * source total with its ledger projection and surfaces mismatches. Also covers
 * the fiscal boundary (reports over a closed period are read-only) and the HTTP
 * report surface with authorization.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/accounting-reports.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-accounting-reports-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, assert, assertEqual, getResults, resetCounters,
  seedOwnerUser, seedManagerUser, createApp, startServer, api, now,
} = require('./helpers/test-setup');
const { createJournal, getAccountByCode } = require('../main/services/accounting');
const {
  getGeneralLedger, getTrialBalance, getProfitAndLoss, getBalanceSheet, getIntegrityChecks,
} = require('../main/services/accounting-reports');
const { getReconciliation } = require('../main/services/accounting-reconciliation');
const { createFiscalPeriod, closeFiscalPeriod, reopenFiscalPeriod } = require('../main/services/fiscal-periods');

const D1 = '2026-01-15';
const WIDE = { from: '2000-01-01', to: '2099-12-31' };

function accountOf(code: string): string {
  return getAccountByCode(code).id;
}
function accountRow(report: any, code: string): any {
  return report.accounts.find((a: any) => a.code === code);
}
function domain(report: any, name: string): any {
  return report.results.find((r: any) => r.domain === name);
}

async function main() {
  console.log('Accounting reports & reconciliation test (Milestone H)');
  console.log('='.repeat(58));
  resetCounters();

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const at = `${D1} 10:00:00`;

  // ── Business source rows (the subledgers reconciliation reads) ──
  db.prepare("INSERT INTO suppliers (id, name, is_active, created_at, updated_at) VALUES ('supp-h1', 'Supplier H', 1, ?, ?)").run(at, at);
  db.prepare("INSERT INTO customers (id, name, is_active, created_at, updated_at) VALUES ('cust-h1', 'Cust H', 1, ?, ?)").run(at, at);
  db.prepare("INSERT INTO orders (order_number, type, status, subtotal, tax_amount, total, created_at, updated_at) VALUES ('ORD-H1', 'takeaway', 'completed', 100, 18, 118, ?, ?)").run(at, at);
  const orderId = Number(db.prepare("SELECT id FROM orders WHERE order_number = 'ORD-H1'").get().id);
  db.prepare(`
    INSERT INTO bills (bill_number, order_id, subtotal, tax_amount, total, paid_amount, balance, payment_status, payment_details, created_at, updated_at)
    VALUES ('B-H1', ?, 100, 18, 118, 118, 0, 'paid', ?, ?, ?)
  `).run(orderId, JSON.stringify([{ method: 'cash', amount: 118, event_id: 'ev-h1', batch_id: 'bt-h1', timestamp: at }]), at, at);
  const billId = Number(db.prepare("SELECT id FROM bills WHERE bill_number = 'B-H1'").get().id);
  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
    VALUES (?, 'prod-h1', 'Latte', 100, 1, 100, 118, 'served', ?, ?)
  `).run(orderId, at, at);
  const orderItemId = Number(db.prepare("SELECT id FROM order_items WHERE order_id = ? AND product_id = 'prod-h1'").get(orderId).id);

  db.prepare("INSERT INTO supplies (id, name, base_unit, stock_quantity, cost_price, is_active, created_at, updated_at) VALUES ('sup-h1', 'Beans', 'g', 25, 1, 1, ?, ?)").run(at, at);
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, actor_user_id, reference_type, reference_id, created_at, unit_cost, total_cost)
    VALUES ('sup-h1', 45, 'receive', 'g', 45, ?, 'purchase_invoice', 'pi1', ?, 1, 45)
  `).run(owner.userId, at);
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, actor_user_id, reference_type, reference_id, created_at, unit_cost, total_cost)
    VALUES ('sup-h1', -20, 'recipe_depletion', 'g', 25, ?, 'order_item', ?, ?, 1, -20)
  `).run(owner.userId, String(orderItemId), at);

  db.prepare("INSERT INTO purchase_invoices (id, invoice_number, supplier_id, invoice_date, total, status) VALUES ('pi1', 'PI-H1', 'supp-h1', ?, 60, 'posted')").run(D1);
  db.prepare("INSERT INTO purchase_returns (id, return_number, purchase_invoice_id, supplier_id, return_date, total, status) VALUES ('pr1', 'PR-H1', 'pi1', 'supp-h1', ?, 15, 'completed')").run(D1);
  db.prepare("INSERT INTO supplier_payments (id, supplier_id, amount, payment_method, paid_at, created_at) VALUES ('sp1', 'supp-h1', 25, 'cash', ?, ?)").run(at, at);
  db.prepare("INSERT INTO expenses (id, category, amount, payment_method, expense_date, created_at) VALUES ('e1', 'Supplies', 30, 'cash', ?, ?)").run(D1, at);
  db.prepare(`
    INSERT INTO receivable_entries (id, customer_id, entry_type, direction, amount, payment_method, reference, entry_date, created_at)
    VALUES ('r1', 'cust-h1', 'settlement', 'credit', 40, 'cash', ?, ?, ?)
  `).run(String(billId), D1, at);
  const refundInfo = db.prepare(
    "INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, approved_by, created_by, created_at) VALUES (?, NULL, 1000, 'cash', ?, ?, ?)",
  ).run(billId, owner.userId, owner.userId, at);
  const refundId = Number(refundInfo.lastInsertRowid);

  // ── The ledger: one balanced journal per domain event ──
  const post = (input: any) => createJournal({ entryDate: D1, actorUserId: owner.userId, ...input });
  post({ description: 'Sale B-H1', sourceModule: 'sales', sourceId: String(billId), seq: 1, reference: 'B-H1', lines: [
    { accountId: accountOf('1000'), direction: 'debit', amount: 118 },
    { accountId: accountOf('4000'), direction: 'credit', amount: 100 },
    { accountId: accountOf('2100'), direction: 'credit', amount: 18 },
  ] });
  post({ description: 'Purchase PI-H1', sourceModule: 'purchases', sourceId: 'pi1', seq: 1, reference: 'PI-H1', lines: [
    { accountId: accountOf('1200'), direction: 'debit', amount: 60 },
    { accountId: accountOf('2000'), direction: 'credit', amount: 60 },
  ] });
  post({ description: 'Expense e1', sourceModule: 'expenses', sourceId: 'e1', seq: 1, reference: 'Supplies', lines: [
    { accountId: accountOf('5000'), direction: 'debit', amount: 30 },
    { accountId: accountOf('1000'), direction: 'credit', amount: 30 },
  ] });
  post({ description: 'COGS item', sourceModule: 'cogs', sourceId: String(orderItemId), seq: 1, reference: String(billId), lines: [
    { accountId: accountOf('5100'), direction: 'debit', amount: 20 },
    { accountId: accountOf('1200'), direction: 'credit', amount: 20 },
  ] });
  post({ description: 'Settlement r1', sourceModule: 'receivables', sourceId: 'r1', seq: 1, reference: 'cust-h1', lines: [
    { accountId: accountOf('1000'), direction: 'debit', amount: 40 },
    { accountId: accountOf('1100'), direction: 'credit', amount: 40 },
  ] });
  post({ description: 'Purchase return PR-H1', sourceModule: 'purchase_returns', sourceId: 'pr1', seq: 1, reference: 'PR-H1', lines: [
    { accountId: accountOf('2000'), direction: 'debit', amount: 15 },
    { accountId: accountOf('1200'), direction: 'credit', amount: 15 },
  ] });
  post({ description: 'Supplier payment sp1', sourceModule: 'supplier_payments', sourceId: 'sp1', seq: 1, reference: 'supp-h1', lines: [
    { accountId: accountOf('2000'), direction: 'debit', amount: 25 },
    { accountId: accountOf('1000'), direction: 'credit', amount: 25 },
  ] });
  post({ description: 'Refund', sourceModule: 'refunds', sourceId: String(refundId), seq: 1, reference: String(billId), lines: [
    { accountId: accountOf('4010'), direction: 'debit', amount: 10 },
    { accountId: accountOf('1000'), direction: 'credit', amount: 10 },
  ] });

  // ── General Ledger ──
  const glAll = getGeneralLedger(WIDE);
  assertEqual(glAll.lines.length, 17, 'GL lists every posted line');
  assertEqual(glAll.totals.difference, 0, 'GL debits equal credits');

  const glCash = getGeneralLedger({ ...WIDE, accountCode: '1000' });
  assertEqual(glCash.lines.length, 5, 'GL account filter returns only the cash lines');
  assertEqual(glCash.totals.debit, 158, 'cash debits (118 sale + 40 settlement)');
  assertEqual(glCash.totals.credit, 65, 'cash credits (30 expense + 25 supplier + 10 refund)');
  assertEqual(glCash.lines[glCash.lines.length - 1].latest_balance, 93, 'GL carries a running balance per account');

  const glCogs = getGeneralLedger({ ...WIDE, sourceModule: 'cogs' });
  assertEqual(glCogs.lines.length, 2, 'GL source-module filter returns the whole COGS journal');
  assert(glCogs.lines.some((l: any) => l.account_code === '5100'), 'COGS line is the COGS account');
  assertEqual(getGeneralLedger({ ...WIDE, reference: 'B-H1' }).lines.length, 3, 'GL reference filter returns the sale lines');

  const glEmpty = getGeneralLedger({ from: '2025-01-01', to: '2025-01-31' });
  assertEqual(glEmpty.lines.length, 0, 'GL date range excludes other periods');

  // ── Trial Balance ──
  const tb = getTrialBalance(WIDE);
  assertEqual(tb.totals.balanced, true, 'trial balance debits equal credits');
  assertEqual(tb.totals.difference, 0, 'trial balance difference is zero');
  assertEqual(accountRow(tb, '5100').balance, 20, 'trial balance includes COGS 5100');
  assertEqual(accountRow(tb, '1200').balance, 25, 'trial balance inventory 1200 nets purchases minus COGS and returns');
  assertEqual(accountRow(tb, '4000').balance, -100, 'trial balance revenue is credit-normal (negative signed balance)');
  assertEqual(accountRow(tb, '1000').balance, 93, 'trial balance cash 1000');
  assertEqual(accountRow(tb, '1100').balance, -40, 'trial balance receivables 1100');

  // ── Profit & Loss ──
  const pl = getProfitAndLoss(WIDE);
  assertEqual(pl.revenue.total, 90, 'P&L revenue nets sales against returns (100 - 10)');
  assertEqual(pl.cogs.total, 20, 'P&L separates COGS (5100) from operating expenses');
  assertEqual(pl.cogs.accounts[0].code, '5100', 'P&L COGS account is 5100');
  assertEqual(pl.operating_expenses.total, 30, 'P&L operating expenses come from the expense accounts');
  assertEqual(pl.operating_expenses.accounts[0].code, '5000', 'P&L operating expense account is 5000');
  assertEqual(pl.total_expenses, 50, 'P&L total expenses = COGS + Opex');
  assertEqual(pl.gross_profit, 70, 'P&L gross profit = revenue - COGS');
  assertEqual(pl.net_profit, 40, 'P&L net profit = revenue - COGS - Opex');

  // ── Balance Sheet ──
  const bs = getBalanceSheet({ to: '2099-12-31' });
  assertEqual(bs.assets.total, 78, 'balance sheet assets (cash 93 + inventory 25 + AR -40)');
  assertEqual(bs.liabilities.total, 38, 'balance sheet liabilities (AP 20 + tax 18)');
  assertEqual(accountRow({ accounts: bs.assets.accounts }, '1200').amount, 25, 'balance sheet shows inventory from the ledger');
  assertEqual(bs.current_result, 40, 'balance sheet carries the unclosed current result');
  assertEqual(bs.equation.balanced, true, 'accounting equation holds (assets = liabilities + equity)');
  assertEqual(bs.equation.difference, 0, 'balance sheet equation difference is zero');

  // ── Integrity ──
  const integrity = getIntegrityChecks();
  assertEqual(integrity.ok, true, 'integrity checks pass on a consistent ledger');
  assertEqual(integrity.journal_balance.unbalanced.length, 0, 'no unbalanced journal');
  assertEqual(integrity.trial_balance.balanced, true, 'integrity trial balance is balanced');
  assertEqual(integrity.duplicate_identities.length, 0, 'no duplicate source identity');
  assertEqual(integrity.orphan_journals.length, 0, 'no orphan journal');
  assertEqual(integrity.orphan_lines.length, 0, 'no orphan line');

  // ── Reconciliation: every reconcilable domain matches ──
  const recon = getReconciliation(WIDE);
  for (const name of ['expenses', 'supplier_payments', 'purchases', 'purchase_returns', 'receivables', 'refunds', 'sales', 'cogs', 'inventory']) {
    assertEqual(domain(recon, name).status, 'MATCH', `reconciliation: ${name} matches`);
    assertEqual(domain(recon, name).difference, 0, `reconciliation: ${name} difference is zero`);
  }
  assertEqual(domain(recon, 'cogs').source_total, 20, 'COGS reconciliation compares frozen consumption');
  assertEqual(domain(recon, 'inventory').source_total, 25, 'inventory reconciliation compares frozen movement valuation');
  assertEqual(domain(recon, 'sales').source_total, 118, 'sales reconciliation uses the bill total');
  assertEqual(domain(recon, 'receivables').journal_total, 40, 'receivables reconciliation reads the GL credit side');
  assertEqual(domain(recon, 'cash').status, 'NOT_RECONCILABLE', 'cash drawer semantics are reported as not reconcilable');
  assertEqual(recon.all_reconciled, true, 'all reconcilable domains match');

  // ── Discrepancy detection: extra journal, missing journal, missing COGS ──
  post({ description: 'Orphan expense', sourceModule: 'expenses', sourceId: 'e-orphan', seq: 1, reference: 'x', lines: [
    { accountId: accountOf('5000'), direction: 'debit', amount: 5 },
    { accountId: accountOf('1000'), direction: 'credit', amount: 5 },
  ] });
  const reconExtra = getReconciliation(WIDE);
  assertEqual(domain(reconExtra, 'expenses').status, 'MISMATCH', 'an unpaired expense journal is flagged');
  assertEqual(domain(reconExtra, 'expenses').difference, -5, 'difference = source - journal');

  db.prepare("INSERT INTO expenses (id, category, amount, payment_method, expense_date, created_at) VALUES ('e2', 'Supplies', 5, 'cash', ?, ?)").run(D1, at);
  assertEqual(domain(getReconciliation(WIDE), 'expenses').status, 'MATCH', 'a matching source row clears the mismatch');

  db.prepare("INSERT INTO expenses (id, category, amount, payment_method, expense_date, created_at) VALUES ('e3', 'Supplies', 7, 'cash', ?, ?)").run(D1, at);
  const reconMissing = getReconciliation(WIDE);
  assertEqual(domain(reconMissing, 'expenses').status, 'MISMATCH', 'a source row without a journal is flagged');
  assertEqual(domain(reconMissing, 'expenses').source_total, 42, 'source total includes the unjournalized row');

  db.prepare(`
    INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
    VALUES (?, 'prod-h2', 'Mocha', 120, 1, 120, 120, 'served', ?, ?)
  `).run(orderId, at, at);
  const item2 = Number(db.prepare("SELECT id FROM order_items WHERE order_id = ? AND product_id = 'prod-h2'").get(orderId).id);
  db.prepare(`
    INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, actor_user_id, reference_type, reference_id, created_at, unit_cost, total_cost)
    VALUES ('sup-h1', -5, 'recipe_depletion', 'g', 20, ?, 'order_item', ?, ?, 1, -5)
  `).run(owner.userId, String(item2), at);
  const reconCogs = getReconciliation(WIDE);
  assertEqual(domain(reconCogs, 'cogs').status, 'MISMATCH', 'a consumed, sale-recognized item without a COGS journal is flagged');
  assertEqual(domain(reconCogs, 'cogs').details.missing_journals, 1, 'reconciliation counts the missing COGS journal');

  // ── Fiscal boundary: reports over a closed period are read-only ──
  const journalsBefore = (db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n;
  const janPeriod = createFiscalPeriod(db, { periodType: 'month', startDate: '2026-01-01', actorUserId: owner.userId });
  closeFiscalPeriod(db, janPeriod.id, owner.userId);
  const closedReport = getTrialBalance({ periodId: janPeriod.id });
  assertEqual(closedReport.from, '2026-01-01', 'period filter uses the period start');
  assertEqual(closedReport.to, '2026-01-31', 'period filter uses the period end');
  assertEqual(closedReport.totals.balanced, true, 'a closed period still reports read-only');
  assertEqual((db.prepare('SELECT COUNT(*) AS n FROM journal_entries').get() as any).n, journalsBefore, 'reporting a closed period creates no journal');
  assertEqual((db.prepare('SELECT status FROM fiscal_periods WHERE id = ?').get(janPeriod.id) as any).status, 'closed', 'reporting never reopens a closed period');

  const febPeriod = createFiscalPeriod(db, { periodType: 'month', startDate: '2026-02-01', actorUserId: owner.userId });
  assertEqual(getTrialBalance({ periodId: febPeriod.id }).accounts.length, 0, 'an empty period reports no accounts (no cross-period leakage)');

  // The fiscal gate still blocks writes into the closed period.
  let gateThrew = false;
  try {
    createJournal({ entryDate: '2026-01-20', sourceModule: 'manual', actorUserId: owner.userId, lines: [
      { accountId: accountOf('1000'), direction: 'debit', amount: 1 },
      { accountId: accountOf('4000'), direction: 'credit', amount: 1 },
    ] });
  } catch { gateThrew = true; }
  assert(gateThrew, 'the closed period still rejects new journals (reports did not unlock it)');

  // ── HTTP surface + authorization ──
  const { accountingRoutes } = require('../main/routes/accounting');
  const app = createApp({ '/api/accounting': accountingRoutes });
  const { baseUrl, server } = await startServer(app);

  assertEqual((await api(baseUrl, '/api/accounting/reports/trial-balance')).status, 401, 'reports require authentication');
  const tbHttp = await api(baseUrl, '/api/accounting/reports/trial-balance', { headers: manager.authHeader });
  assertEqual(tbHttp.status, 200, 'manager (ownerManager) may read reports');
  assertEqual(tbHttp.data.report.totals.balanced, true, 'HTTP trial balance is balanced');

  const glHttp = await api(baseUrl, '/api/accounting/reports/general-ledger?account_code=5100&from=2026-01-01&to=2026-01-31', { headers: owner.authHeader });
  assertEqual(glHttp.status, 200, 'HTTP general-ledger filter succeeds for owner');
  assertEqual(glHttp.data.report.lines.length, 1, 'HTTP GL account filter isolates COGS');

  const expectedPlNet = getProfitAndLoss({ from: '2026-01-01', to: '2026-01-31' }).net_profit;
  assertEqual((await api(baseUrl, '/api/accounting/reports/profit-loss?from=2026-01-01&to=2026-01-31', { headers: owner.authHeader })).data.report.net_profit, expectedPlNet, 'HTTP P&L matches the service result');
  assertEqual((await api(baseUrl, '/api/accounting/reports/balance-sheet', { headers: owner.authHeader })).data.report.equation.balanced, true, 'HTTP balance sheet balances');
  assertEqual((await api(baseUrl, '/api/accounting/reports/reconciliation', { headers: owner.authHeader })).status, 200, 'HTTP reconciliation succeeds');
  assertEqual((await api(baseUrl, '/api/accounting/reports/integrity', { headers: owner.authHeader })).data.report.trial_balance.balanced, true, 'HTTP integrity report succeeds');
  assertEqual((await api(baseUrl, '/api/accounting/reports/trial-balance?from=bad&to=2026-01-31', { headers: owner.authHeader })).status, 400, 'an invalid date is rejected');

  server.close();

  console.log('='.repeat(58));
  const { passed, failed } = getResults();
  console.log(`${passed}/${passed + failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
