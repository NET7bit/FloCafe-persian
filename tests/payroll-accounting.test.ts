const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-payroll-'));
Module._load = function (request: string) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const { initTestDb, assertEqual, assert, getResults, resetCounters, seedOwnerUser } = require('./helpers/test-setup');
const payroll = require('../main/services/payroll');
const adapter = require('../main/services/accounting-payroll-adapter');
const receivables = require('../main/services/receivables');
const receivableAdapter = require('../main/services/accounting-receivables-adapter');

async function main() {
  resetCounters();
  const db = initTestDb();
  const actor = seedOwnerUser(db).userId;
  const employee = payroll.createPayrollEmployee(db, { name: 'Payroll employee', employeeCode: 'P-1' }, actor);
  assertEqual(employee.created_by, actor, 'employee creation records actor');
  assertEqual(employee.updated_by, actor, 'employee update actor initialized');
  const run = payroll.createPayrollRun(db, {
    periodStart: '2026-10-01', periodEnd: '2026-10-31',
    items: [{ employeeId: employee.id, earnings: [{ label: 'Base pay', amount: 1000 }, { label: 'Allowance', amount: 100 }], deductions: [{ label: 'Manual deduction', amount: 100 }] }],
  }, actor);
  assertEqual(run.gross_amount, 1100, 'earnings total to gross');
  assertEqual(run.deductions_amount, 100, 'manual deductions total');
  assertEqual(run.net_amount, 1000, 'net equals gross less deductions');
  assertEqual(run.items[0].employee_name, 'Payroll employee', 'run keeps employee name snapshot');
  const posted = payroll.postPayrollRun(db, run.id, actor);
  adapter.recordPayrollRunAccounting(posted.id, actor);
  const journal = db.prepare("SELECT id FROM journal_entries WHERE source_module = 'payroll' AND source_id = ?").get(run.id);
  assert(Boolean(journal), 'posting creates payroll journal');
  const lines = db.prepare(`SELECT a.code, l.direction, l.amount FROM journal_entry_lines l JOIN accounting_accounts a ON a.id = l.account_id WHERE l.journal_id = ? ORDER BY a.code`).all(journal.id);
  assertEqual(JSON.stringify(lines), JSON.stringify([
    { code: '2010', direction: 'credit', amount: 1000 },
    { code: '2020', direction: 'credit', amount: 100 },
    { code: '5010', direction: 'debit', amount: 1100 },
  ]), 'accrual posts gross expense and net/deduction liabilities');
  const pay = payroll.createPayrollPayment(db, { runId: run.id, itemId: run.items[0].id, amount: 400, paymentMethod: 'bank_transfer', paidAt: '2026-11-01', actorUserId: actor });
  adapter.recordPayrollPaymentAccounting(pay.id, actor);
  assertEqual(payroll.getPayrollRun(db, run.id).unpaid_amount, 600, 'partial payment leaves derived balance');
  const withholding = payroll.createWithholdingPayment(db, { runId: run.id, amount: 50, paymentMethod: 'bank_transfer', paidAt: '2026-11-02', actorUserId: actor });
  adapter.recordPayrollWithholdingAccounting(withholding.id, actor);
  assertEqual(payroll.getPayrollRun(db, run.id).withholding_due_amount, 50, 'remittance settles withholding liability separately');
  payroll.deleteWithholdingPayment(db, withholding.id, actor, '2026-11-03', 'test reversal');
  adapter.recordPayrollWithholdingDeletion(withholding.id, actor, '2026-11-03');
  assertEqual(payroll.getPayrollRun(db, run.id).withholding_due_amount, 100, 'remittance reversal restores liability');
  payroll.deletePayrollPayment(db, pay.id, actor, '2026-11-03', 'test reversal');
  adapter.recordPayrollPaymentDeletion(pay.id, actor, '2026-11-03');
  assertEqual(payroll.getPayrollRun(db, run.id).unpaid_amount, 1000, 'payment reversal restores net payable');
  payroll.reversePayrollRun(db, run.id, '2026-11-04', actor);
  adapter.recordPayrollRunReversal(run.id, actor, '2026-11-04');
  assertEqual(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE reverses_journal_id = ?").get(journal.id).n, 1, 'run reversal appends a reversal journal');
  const reconciliation = require('../main/services/accounting-reconciliation').getReconciliation;
  const october = reconciliation({ from: '2026-10-01', to: '2026-10-31' }).results.find((row: any) => row.domain === 'payroll');
  const november = reconciliation({ from: '2026-11-01', to: '2026-11-30' }).results.find((row: any) => row.domain === 'payroll');
  assertEqual(october.status, 'MATCH', 'reversed run remains reconciled in original accrual period');
  assertEqual(november.status, 'MATCH', 'reversal reconciles in its own period');

  const staffBuyer = payroll.createPayrollEmployee(db, { name: 'Staff buyer', employeeCode: 'P-2' }, actor);
  assert(Boolean(staffBuyer.customer_id), 'new payroll employee receives a linked customer account');
  receivables.createReceivableEntry(db, {
    customerId: staffBuyer.customer_id, entryType: 'charge', amount: 1400,
    description: 'Restaurant purchases', entryDate: '2026-10-20', actorUserId: actor,
  });
  const buyerRun = payroll.createPayrollRun(db, {
    periodStart: '2026-10-01', periodEnd: '2026-10-31',
    items: [{ employeeId: staffBuyer.id, earnings: [{ label: 'Base pay', amount: 1100 }], deductions: [{ label: 'Manual deduction', amount: 100 }] }],
  }, actor);
  assertEqual(buyerRun.items[0].purchase_deduction_amount, 1000, 'employee account debt is capped at net salary after manual deductions');
  assertEqual(buyerRun.cash_due_amount, 0, 'purchase deduction lowers amount payable to employee');
  const postedBuyerRun = payroll.postPayrollRun(db, buyerRun.id, actor);
  adapter.recordPayrollRunAccounting(postedBuyerRun.id, actor);
  assertEqual(receivables.getCustomerBalance(db, staffBuyer.customer_id), 400, 'payroll posting settles only the capped amount and leaves excess debt');
  const deductionEntry = db.prepare("SELECT id FROM receivable_entries WHERE payment_method = 'payroll_deduction' AND reference = ?").get(buyerRun.id);
  assert(Boolean(deductionEntry), 'payroll deduction appears in customer receivable statement');
  const deductionJournal = db.prepare("SELECT id FROM journal_entries WHERE source_module = 'receivables' AND source_id = ?").get(deductionEntry.id);
  assert(Boolean(deductionJournal), 'purchase deduction creates the AR and payroll payable journal');
  payroll.reversePayrollRun(db, buyerRun.id, '2026-11-05', actor);
  adapter.recordPayrollRunReversal(buyerRun.id, actor, '2026-11-05');
  const balanceAfterReversal = receivables.getCustomerBalance(db, staffBuyer.customer_id);
  assertEqual(balanceAfterReversal, 1400, 'reversing payroll restores customer purchase debt with a compensating entry');
  receivableAdapter.recordReceivableEntryAccounting(
    db.prepare("SELECT id FROM receivable_entries WHERE reference = ? AND entry_type = 'adjustment'").get(`payroll-reversal:${buyerRun.id}`).id,
    actor,
  );
  const receivablesReconciliation = reconciliation({ from: '2026-10-01', to: '2026-11-30' }).results.find((row: any) => row.domain === 'receivables');
  assertEqual(receivablesReconciliation.status, 'MATCH', 'purchase deduction and its payroll reversal reconcile to the receivable control account');
  try {
    payroll.createPayrollRun(db, { periodStart: '2026-02-31', periodEnd: '2026-03-01', items: [{ employeeId: employee.id, earnings: [{ label: 'Pay', amount: 1 }] }] }, actor);
    assert(false, 'invalid calendar date is rejected');
  } catch (error: any) { assertEqual(error.statusCode, 400, 'invalid calendar date returns validation error'); }
  const results = getResults();
  console.log(`Payroll accounting: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed) process.exitCode = 1;
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });

// This suite runs itself on require. The export marker keeps its top-level
// declarations module-scoped so they do not collide with the other self-running
// test scripts that share the tests/tsconfig.json program.
export {};
