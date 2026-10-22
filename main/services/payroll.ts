import { randomBytes } from 'crypto';
import { getDatabase, now, withTxn } from '../db';
import { assertNotInClosedPeriod } from './fiscal-periods';
import { createPayrollDeductionSettlement, getCustomerBalance, getCustomerBalanceAtDate } from './receivables';

type Database = ReturnType<typeof getDatabase>;
export type PayrollComponentType = 'earning' | 'deduction';
export type PayrollPaymentMethod = 'cash' | 'card' | 'bank_transfer' | 'cheque';

export class PayrollError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'PayrollError';
    this.statusCode = statusCode;
  }
}

export interface PayrollEmployee {
  id: string;
  employee_code: string | null;
  name: string;
  is_active: number;
  notes: string | null;
  customer_id: string | null;
  customer_name?: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollComponentInput {
  label: string;
  amount: number;
}

export interface PayrollItemInput {
  employeeId: string;
  earnings: PayrollComponentInput[];
  deductions?: PayrollComponentInput[];
}

export interface PayrollRunInput {
  periodStart: string;
  periodEnd: string;
  items: PayrollItemInput[];
}

export interface PayrollRunSummary {
  id: string;
  period_start: string;
  period_end: string;
  status: 'draft' | 'posted' | 'reversed';
  posted_at: string | null;
  posted_by: string | null;
  reversed_at?: string | null;
  reversed_by?: string | null;
  created_at: string;
  updated_at: string;
  employee_count: number;
  gross_amount: number;
  deductions_amount: number;
  net_amount: number;
  purchase_deduction_amount: number;
  cash_due_amount: number;
  paid_amount: number;
  unpaid_amount: number;
  withholding_paid_amount: number;
  withholding_due_amount: number;
}

export interface PayrollRunItem {
  id: string;
  payroll_run_id: string;
  employee_id: string;
  employee_name: string;
  gross_amount: number;
  deductions_amount: number;
  net_amount: number;
  customer_id: string | null;
  purchase_deduction_amount: number;
  cash_due_amount?: number;
  components?: Array<{ id: string; component_type: PayrollComponentType; label: string; amount: number }>;
}

export interface PayrollPayment {
  id: string;
  payroll_run_id: string;
  payroll_run_item_id: string;
  employee_id: string;
  employee_name: string;
  amount: number;
  payment_method: PayrollPaymentMethod;
  paid_at: string;
  reference: string | null;
  notes: string | null;
  actor_user_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface PayrollWithholdingPayment {
  id: string;
  payroll_run_id: string;
  amount: number;
  payment_method: PayrollPaymentMethod;
  paid_at: string;
  reference: string | null;
  notes: string | null;
  actor_user_id: string | null;
  deleted_at: string | null;
  created_at: string;
}

const PAYMENT_METHODS: readonly PayrollPaymentMethod[] = ['cash', 'card', 'bank_transfer', 'cheque'];
const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const id = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength) throw new PayrollError(400, `${field} must be a non-empty string of at most ${maxLength} characters`);
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) throw new PayrollError(400, `${field} must be at most ${maxLength} characters`);
  return text;
}

function validDate(value: unknown, field: string): string {
  const date = typeof value === 'string' ? value : '';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PayrollError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  }
  return date;
}

function positiveAmount(value: unknown, field: string): number {
  const amount = typeof value === 'string' ? Number(value) : value;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new PayrollError(400, `${field} must be a finite positive amount`);
  }
  const rounded = roundMoney(amount);
  if (rounded <= 0) throw new PayrollError(400, `${field} must be at least 0.01`);
  return rounded;
}

function normalizeComponents(value: unknown, type: PayrollComponentType): PayrollComponentInput[] {
  if (!Array.isArray(value) || value.length > 100) throw new PayrollError(400, `${type}s must be an array of at most 100 items`);
  return value.map((component, index) => {
    const item = component as { label?: unknown; amount?: unknown };
    return {
      label: requiredText(item?.label, `${type}s[${index}].label`, 120),
      amount: positiveAmount(item?.amount, `${type}s[${index}].amount`),
    };
  });
}

function normalizeItems(db: Database, value: unknown, periodEnd: string): Array<{
  employeeId: string;
  employeeName: string;
  earnings: PayrollComponentInput[];
  deductions: PayrollComponentInput[];
  gross: number;
  deductionsTotal: number;
  net: number;
  customerId: string | null;
  purchaseDeduction: number;
}> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new PayrollError(400, 'items must contain between 1 and 500 employees');
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    const item = raw as { employeeId?: unknown; earnings?: unknown; deductions?: unknown };
    const employeeId = requiredText(item?.employeeId, 'employee_id', 128);
    if (seen.has(employeeId)) throw new PayrollError(400, 'an employee can appear only once in a payroll run');
    seen.add(employeeId);
    const employee = db.prepare('SELECT id, name, customer_id FROM payroll_employees WHERE id = ? AND is_active = 1').get(employeeId) as
      | { id: string; name: string; customer_id: string | null }
      | undefined;
    if (!employee) throw new PayrollError(400, `active payroll employee ${employeeId} does not exist`);
    const earnings = normalizeComponents(item.earnings, 'earning');
    if (!earnings.length) throw new PayrollError(400, `employee ${employeeId} requires at least one earning component`);
    const deductions = item.deductions === undefined ? [] : normalizeComponents(item.deductions, 'deduction');
    const gross = roundMoney(earnings.reduce((sum, component) => sum + component.amount, 0));
    const deductionsTotal = roundMoney(deductions.reduce((sum, component) => sum + component.amount, 0));
    if (deductionsTotal > gross) throw new PayrollError(400, `deductions exceed gross pay for employee ${employeeId}`);
    const net = roundMoney(gross - deductionsTotal);
    const customerId = employee.customer_id;
    const purchaseDeduction = customerId ? Math.min(net, Math.max(0, getCustomerBalanceAtDate(db, customerId, periodEnd))) : 0;
    return { employeeId, employeeName: employee.name, earnings, deductions, gross, deductionsTotal, net, customerId, purchaseDeduction: roundMoney(purchaseDeduction) };
  });
}

function insertRunItems(db: Database, runId: string, items: PayrollItemInput[], periodEnd: string): void {
  const normalized = normalizeItems(db, items, periodEnd);
  const insertItem = db.prepare(`
    INSERT INTO payroll_run_items (id, payroll_run_id, employee_id, employee_name, gross_amount, deductions_amount, net_amount, customer_id, purchase_deduction_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertComponent = db.prepare(`
    INSERT INTO payroll_components (id, payroll_run_item_id, component_type, label, amount)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const item of normalized) {
    const itemId = id('prit');
    insertItem.run(itemId, runId, item.employeeId, item.employeeName, item.gross, item.deductionsTotal, item.net, item.customerId, item.purchaseDeduction);
    for (const component of item.earnings) insertComponent.run(id('pcmp'), itemId, 'earning', component.label, component.amount);
    for (const component of item.deductions) insertComponent.run(id('pcmp'), itemId, 'deduction', component.label, component.amount);
  }
}

export function listPayrollEmployees(db: Database, includeInactive = false): PayrollEmployee[] {
  return db.prepare(`SELECT e.*, c.name AS customer_name FROM payroll_employees e LEFT JOIN customers c ON c.id = e.customer_id ${includeInactive ? '' : 'WHERE e.is_active = 1'} ORDER BY e.is_active DESC, e.name COLLATE NOCASE`).all() as PayrollEmployee[];
}

export function createPayrollEmployee(db: Database, input: { name: unknown; employeeCode?: unknown; notes?: unknown; customerId?: unknown }, actorUserId: string): PayrollEmployee {
  const name = requiredText(input.name, 'name', 200);
  const employeeCode = optionalText(input.employeeCode, 'employee_code', 64);
  const notes = optionalText(input.notes, 'notes', 1000);
  const employeeId = id('pemp');
  const customerId = input.customerId === undefined || input.customerId === null || input.customerId === '' ? id('cust') : requiredText(input.customerId, 'customer_id', 128);
  try {
    withTxn(() => {
      if (!input.customerId) db.prepare('INSERT INTO customers (id, name) VALUES (?, ?)').run(customerId, name);
      else if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new PayrollError(404, 'customer not found');
      db.prepare('INSERT INTO payroll_employees (id, employee_code, name, notes, customer_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(employeeId, employeeCode, name, notes, customerId, actorUserId, actorUserId);
    });
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new PayrollError(409, 'employee_code or customer link already exists');
    throw error;
  }
  return getPayrollEmployee(db, employeeId);
}

export function getPayrollEmployee(db: Database, employeeId: string): PayrollEmployee {
  const employee = db.prepare('SELECT * FROM payroll_employees WHERE id = ?').get(employeeId) as PayrollEmployee | undefined;
  if (!employee) throw new PayrollError(404, 'payroll employee not found');
  return employee;
}

export function updatePayrollEmployee(db: Database, employeeId: string, input: { name?: unknown; employeeCode?: unknown; notes?: unknown; isActive?: unknown; customerId?: unknown }, actorUserId: string): PayrollEmployee {
  const current = getPayrollEmployee(db, employeeId);
  const name = input.name === undefined ? current.name : requiredText(input.name, 'name', 200);
  const employeeCode = input.employeeCode === undefined ? current.employee_code : optionalText(input.employeeCode, 'employee_code', 64);
  const notes = input.notes === undefined ? current.notes : optionalText(input.notes, 'notes', 1000);
  const customerId = input.customerId === undefined ? current.customer_id : input.customerId === null || input.customerId === '' ? null : requiredText(input.customerId, 'customer_id', 128);
  if (customerId && !db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId)) throw new PayrollError(404, 'customer not found');
  const isActive = input.isActive === undefined ? current.is_active : input.isActive === true || input.isActive === 1 ? 1 : input.isActive === false || input.isActive === 0 ? 0 : null;
  if (isActive === null) throw new PayrollError(400, 'is_active must be a boolean');
  try {
    db.prepare('UPDATE payroll_employees SET name = ?, employee_code = ?, notes = ?, is_active = ?, customer_id = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(name, employeeCode, notes, isActive, customerId, now(), actorUserId, employeeId);
  } catch (error) {
    if (String(error).includes('UNIQUE')) throw new PayrollError(409, 'employee_code or customer link already exists');
    throw error;
  }
  return getPayrollEmployee(db, employeeId);
}

function runSummary(db: Database, run: Omit<PayrollRunSummary, 'employee_count' | 'gross_amount' | 'deductions_amount' | 'net_amount' | 'purchase_deduction_amount' | 'cash_due_amount' | 'paid_amount' | 'unpaid_amount' | 'withholding_paid_amount' | 'withholding_due_amount'>): PayrollRunSummary {
  const totals = db.prepare(`
    SELECT COUNT(*) AS employee_count, COALESCE(SUM(gross_amount), 0) AS gross_amount,
      COALESCE(SUM(deductions_amount), 0) AS deductions_amount, COALESCE(SUM(net_amount), 0) AS net_amount
    FROM payroll_run_items WHERE payroll_run_id = ?
  `).get(run.id) as { employee_count: number; gross_amount: number; deductions_amount: number; net_amount: number };
  const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS amount FROM payroll_payments WHERE payroll_run_id = ? AND deleted_at IS NULL').get(run.id) as { amount: number };
  const purchase = db.prepare('SELECT COALESCE(SUM(purchase_deduction_amount), 0) AS amount FROM payroll_run_items WHERE payroll_run_id = ?').get(run.id) as { amount: number };
  const withheld = db.prepare('SELECT COALESCE(SUM(amount), 0) AS amount FROM payroll_withholding_payments WHERE payroll_run_id = ? AND deleted_at IS NULL').get(run.id) as { amount: number };
  return {
    ...run,
    employee_count: Number(totals.employee_count),
    gross_amount: roundMoney(Number(totals.gross_amount)),
    deductions_amount: roundMoney(Number(totals.deductions_amount)),
    net_amount: roundMoney(Number(totals.net_amount)),
    paid_amount: roundMoney(Number(paid.amount)),
    purchase_deduction_amount: roundMoney(Number(purchase.amount)),
    cash_due_amount: roundMoney(Number(totals.net_amount) - Number(purchase.amount)),
    unpaid_amount: roundMoney(Math.max(0, Number(totals.net_amount) - Number(purchase.amount) - Number(paid.amount))),
    withholding_paid_amount: roundMoney(Number(withheld.amount)),
    withholding_due_amount: roundMoney(Math.max(0, Number(totals.deductions_amount) - Number(withheld.amount))),
  };
}

export function listPayrollRuns(db: Database): PayrollRunSummary[] {
  const rows = db.prepare('SELECT * FROM payroll_runs ORDER BY period_start DESC, created_at DESC').all() as Array<Omit<PayrollRunSummary, 'employee_count' | 'gross_amount' | 'deductions_amount' | 'net_amount' | 'purchase_deduction_amount' | 'cash_due_amount' | 'paid_amount' | 'unpaid_amount' | 'withholding_paid_amount' | 'withholding_due_amount'>>;
  return rows.map((row) => runSummary(db, row));
}

export function getPayrollRun(db: Database, runId: string): PayrollRunSummary & { items: PayrollRunItem[] } {
  const row = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId) as Omit<PayrollRunSummary, 'employee_count' | 'gross_amount' | 'deductions_amount' | 'net_amount' | 'purchase_deduction_amount' | 'cash_due_amount' | 'paid_amount' | 'unpaid_amount' | 'withholding_paid_amount' | 'withholding_due_amount'> | undefined;
  if (!row) throw new PayrollError(404, 'payroll run not found');
  const items = db.prepare('SELECT * FROM payroll_run_items WHERE payroll_run_id = ? ORDER BY employee_name COLLATE NOCASE').all(runId) as PayrollRunItem[];
  const components = db.prepare(`
    SELECT c.id, c.payroll_run_item_id, c.component_type, c.label, c.amount
    FROM payroll_components c JOIN payroll_run_items i ON i.id = c.payroll_run_item_id
    WHERE i.payroll_run_id = ? ORDER BY c.created_at, c.id
  `).all(runId) as Array<{ id: string; payroll_run_item_id: string; component_type: PayrollComponentType; label: string; amount: number }>;
  const componentsByItem = new Map<string, PayrollRunItem['components']>();
  for (const component of components) {
    const list = componentsByItem.get(component.payroll_run_item_id) || [];
    list.push({ id: component.id, component_type: component.component_type, label: component.label, amount: Number(component.amount) });
    componentsByItem.set(component.payroll_run_item_id, list);
  }
  return { ...runSummary(db, row), items: items.map((item) => ({ ...item, cash_due_amount: roundMoney(item.net_amount - item.purchase_deduction_amount), components: componentsByItem.get(item.id) || [] })) };
}

function validPeriod(input: PayrollRunInput): { periodStart: string; periodEnd: string } {
  const periodStart = validDate(input.periodStart, 'period_start');
  const periodEnd = validDate(input.periodEnd, 'period_end');
  if (periodStart > periodEnd) throw new PayrollError(400, 'period_start must not be after period_end');
  return { periodStart, periodEnd };
}

export function createPayrollRun(db: Database, input: PayrollRunInput, actorUserId: string): PayrollRunSummary & { items: PayrollRunItem[] } {
  const { periodStart, periodEnd } = validPeriod(input);
  const runId = id('prun');
  withTxn(() => {
    db.prepare('INSERT INTO payroll_runs (id, period_start, period_end, created_by, updated_by) VALUES (?, ?, ?, ?, ?)').run(runId, periodStart, periodEnd, actorUserId, actorUserId);
    insertRunItems(db, runId, input.items, periodEnd);
  });
  return getPayrollRun(db, runId);
}

export function updatePayrollRun(db: Database, runId: string, input: PayrollRunInput, actorUserId: string): PayrollRunSummary & { items: PayrollRunItem[] } {
  const run = getPayrollRun(db, runId);
  if (run.status !== 'draft') throw new PayrollError(409, 'only draft payroll runs can be edited');
  const { periodStart, periodEnd } = validPeriod(input);
  withTxn(() => {
    db.prepare('UPDATE payroll_runs SET period_start = ?, period_end = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = \'draft\'')
      .run(periodStart, periodEnd, now(), actorUserId, runId);
    db.prepare('DELETE FROM payroll_run_items WHERE payroll_run_id = ?').run(runId);
    insertRunItems(db, runId, input.items, periodEnd);
  });
  return getPayrollRun(db, runId);
}

export function postPayrollRun(db: Database, runId: string, actorUserId: string): PayrollRunSummary & { items: PayrollRunItem[] } {
  const run = getPayrollRun(db, runId);
  if (run.status !== 'draft') throw new PayrollError(409, 'only draft payroll runs can be posted');
  if (run.employee_count === 0 || run.gross_amount <= 0) throw new PayrollError(400, 'payroll run must contain positive earnings');
  assertNotInClosedPeriod(db, run.period_end);
  withTxn(() => {
    const items = db.prepare('SELECT id, customer_id, purchase_deduction_amount FROM payroll_run_items WHERE payroll_run_id = ? AND purchase_deduction_amount > 0').all(runId) as Array<{ id: string; customer_id: string | null; purchase_deduction_amount: number }>;
    for (const item of items) {
      if (!item.customer_id || getCustomerBalance(db, item.customer_id) < Number(item.purchase_deduction_amount)) {
        throw new PayrollError(409, 'employee customer balance changed; edit the payroll draft before posting');
      }
    }
    db.prepare('UPDATE payroll_runs SET status = \'posted\', posted_at = ?, posted_by = ?, updated_at = ? WHERE id = ? AND status = \'draft\'')
      .run(now(), actorUserId, now(), runId);
    for (const item of items) {
      createPayrollDeductionSettlement(db, {
        id: `rcv_payroll_${item.id}`, customerId: String(item.customer_id), amount: Number(item.purchase_deduction_amount),
        entryDate: run.period_end, payrollRunId: runId, actorUserId,
      });
    }
  });
  return getPayrollRun(db, runId);
}

export function reversePayrollRun(db: Database, runId: string, reversalDate: string, actorUserId: string): PayrollRunSummary & { items: PayrollRunItem[] } {
  const run = getPayrollRun(db, runId);
  if (run.status !== 'posted') throw new PayrollError(409, 'only posted payroll runs can be reversed');
  if (run.paid_amount > 0 || run.withholding_paid_amount > 0) throw new PayrollError(409, 'reverse all payroll and withholding payments before reversing the run');
  assertNotInClosedPeriod(db, validDate(reversalDate, 'entry_date'));
  withTxn(() => {
    db.prepare('UPDATE payroll_runs SET status = \'reversed\', reversed_at = ?, reversed_by = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = \'posted\'')
      .run(reversalDate, actorUserId, now(), actorUserId, runId);
  });
  return getPayrollRun(db, runId);
}

function paymentMethod(value: unknown): PayrollPaymentMethod {
  if (typeof value !== 'string' || !PAYMENT_METHODS.includes(value as PayrollPaymentMethod)) {
    throw new PayrollError(400, `payment_method must be one of: ${PAYMENT_METHODS.join(', ')}`);
  }
  return value as PayrollPaymentMethod;
}

export function createPayrollPayment(db: Database, input: {
  runId: string; itemId: string; amount: unknown; paymentMethod: unknown; paidAt: unknown;
  reference?: unknown; notes?: unknown; actorUserId: string;
}): PayrollPayment {
  const run = getPayrollRun(db, input.runId);
  if (run.status !== 'posted') throw new PayrollError(409, 'payroll payments require a posted run');
  const paidAt = validDate(input.paidAt, 'paid_at');
  assertNotInClosedPeriod(db, paidAt);
  const amount = positiveAmount(input.amount, 'amount');
  const method = paymentMethod(input.paymentMethod);
  const item = db.prepare('SELECT id, net_amount, purchase_deduction_amount FROM payroll_run_items WHERE id = ? AND payroll_run_id = ?').get(input.itemId, input.runId) as { id: string; net_amount: number; purchase_deduction_amount: number } | undefined;
  if (!item) throw new PayrollError(404, 'payroll employee entry not found');
  const paid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS amount FROM payroll_payments WHERE payroll_run_item_id = ? AND deleted_at IS NULL').get(input.itemId) as { amount: number };
  const remaining = roundMoney(Number(item.net_amount) - Number(item.purchase_deduction_amount) - Number(paid.amount));
  if (amount > remaining) throw new PayrollError(409, `payment exceeds employee net balance (${remaining})`);
  const paymentId = id('ppay');
  withTxn(() => {
    db.prepare(`INSERT INTO payroll_payments (id, payroll_run_id, payroll_run_item_id, amount, payment_method, paid_at, reference, notes, actor_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      paymentId, input.runId, input.itemId, amount, method, paidAt,
      optionalText(input.reference, 'reference', 128), optionalText(input.notes, 'notes', 1000), input.actorUserId,
    );
  });
  return getPayrollPayment(db, paymentId);
}

export function getPayrollPayment(db: Database, paymentId: string): PayrollPayment {
  const payment = db.prepare(`
    SELECT p.*, i.employee_id, i.employee_name FROM payroll_payments p
    JOIN payroll_run_items i ON i.id = p.payroll_run_item_id WHERE p.id = ?
  `).get(paymentId) as PayrollPayment | undefined;
  if (!payment) throw new PayrollError(404, 'payroll payment not found');
  return payment;
}

export function listPayrollPayments(db: Database, runId?: string): PayrollPayment[] {
  return db.prepare(`
    SELECT p.*, i.employee_id, i.employee_name FROM payroll_payments p
    JOIN payroll_run_items i ON i.id = p.payroll_run_item_id
    WHERE (? IS NULL OR p.payroll_run_id = ?) ORDER BY p.paid_at DESC, p.created_at DESC
  `).all(runId || null, runId || null) as PayrollPayment[];
}

export function deletePayrollPayment(db: Database, paymentId: string, actorUserId: string, reversalDate: string, reason?: unknown): PayrollPayment {
  const payment = getPayrollPayment(db, paymentId);
  if (payment.deleted_at) throw new PayrollError(409, 'payroll payment is already deleted');
  assertNotInClosedPeriod(db, validDate(reversalDate, 'entry_date'));
  const currentPaid = db.prepare('SELECT COALESCE(SUM(amount), 0) AS amount FROM payroll_payments WHERE payroll_run_item_id = ? AND deleted_at IS NULL').get(payment.payroll_run_item_id) as { amount: number };
  if (Number(currentPaid.amount) - payment.amount < 0) throw new PayrollError(409, 'payroll payment balance is invalid');
  withTxn(() => {
    db.prepare('UPDATE payroll_payments SET deleted_at = ?, deleted_by = ?, deletion_reason = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now(), actorUserId, optionalText(reason, 'deletion_reason', 500) || 'Reversed from payroll management', paymentId);
  });
  return getPayrollPayment(db, paymentId);
}

export function createWithholdingPayment(db: Database, input: {
  runId: string; amount: unknown; paymentMethod: unknown; paidAt: unknown;
  reference?: unknown; notes?: unknown; actorUserId: string;
}): PayrollWithholdingPayment {
  const run = getPayrollRun(db, input.runId);
  if (run.status !== 'posted') throw new PayrollError(409, 'withholding payments require a posted run');
  const paidAt = validDate(input.paidAt, 'paid_at');
  assertNotInClosedPeriod(db, paidAt);
  const amount = positiveAmount(input.amount, 'amount');
  const method = paymentMethod(input.paymentMethod);
  if (amount > run.withholding_due_amount) throw new PayrollError(409, `payment exceeds withholding balance (${run.withholding_due_amount})`);
  const paymentId = id('pwhp');
  withTxn(() => {
    db.prepare(`INSERT INTO payroll_withholding_payments (id, payroll_run_id, amount, payment_method, paid_at, reference, notes, actor_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      paymentId, input.runId, amount, method, paidAt,
      optionalText(input.reference, 'reference', 128), optionalText(input.notes, 'notes', 1000), input.actorUserId,
    );
  });
  return getWithholdingPayment(db, paymentId);
}

export function getWithholdingPayment(db: Database, paymentId: string): PayrollWithholdingPayment {
  const payment = db.prepare('SELECT * FROM payroll_withholding_payments WHERE id = ?').get(paymentId) as PayrollWithholdingPayment | undefined;
  if (!payment) throw new PayrollError(404, 'withholding payment not found');
  return payment;
}

export function listWithholdingPayments(db: Database, runId?: string): PayrollWithholdingPayment[] {
  return db.prepare(`SELECT * FROM payroll_withholding_payments WHERE (? IS NULL OR payroll_run_id = ?) ORDER BY paid_at DESC, created_at DESC`)
    .all(runId || null, runId || null) as PayrollWithholdingPayment[];
}

export function deleteWithholdingPayment(db: Database, paymentId: string, actorUserId: string, reversalDate: string, reason?: unknown): PayrollWithholdingPayment {
  const payment = getWithholdingPayment(db, paymentId);
  if (payment.deleted_at) throw new PayrollError(409, 'withholding payment is already deleted');
  assertNotInClosedPeriod(db, validDate(reversalDate, 'entry_date'));
  withTxn(() => {
    db.prepare('UPDATE payroll_withholding_payments SET deleted_at = ?, deleted_by = ?, deletion_reason = ? WHERE id = ? AND deleted_at IS NULL')
      .run(now(), actorUserId, optionalText(reason, 'deletion_reason', 500) || 'Reversed from payroll management', paymentId);
  });
  return getWithholdingPayment(db, paymentId);
}
