'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'use-intl';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Plus, RefreshCw, Check, RotateCcw, Wallet } from 'lucide-react';

type Employee = { id: string; employee_code: string | null; name: string; is_active: number; notes: string | null; customer_id: string | null; customer_name?: string | null };
type Customer = { id: string; name: string };
type RunItem = { id: string; employee_id: string; employee_name: string; gross_amount: number; deductions_amount: number; net_amount: number; purchase_deduction_amount: number; cash_due_amount: number };
type Run = { id: string; period_start: string; period_end: string; status: 'draft' | 'posted' | 'reversed'; employee_count: number; gross_amount: number; deductions_amount: number; net_amount: number; purchase_deduction_amount: number; cash_due_amount: number; paid_amount: number; unpaid_amount: number; withholding_due_amount: number; items?: RunItem[] };
type Payment = { id: string; payroll_run_id: string; payroll_run_item_id: string; employee_name?: string; amount: number; payment_method: string; paid_at: string; deleted_at: string | null };
const today = () => new Date().toISOString().slice(0, 10);
const errorText = (error: unknown, fallback: string) => {
  const message = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  return typeof message === 'string' ? message : fallback;
};

export default function PayrollPage() {
  const locale = useLocale();
  const fa = locale.startsWith('fa');
  const s = (persian: string, english: string) => fa ? persian : english;
  const { currentTenant } = useAuthStore();
  const canView = tenantCan(currentTenant, 'payroll.view') || tenantCan(currentTenant, 'payroll.manage');
  const canManage = tenantCan(currentTenant, 'payroll.manage');
  const formatNumber = useFormatNumber();
  const [tab, setTab] = useState('runs');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState('');
  const [employeeCustomerId, setEmployeeCustomerId] = useState('');
  const [periodStart, setPeriodStart] = useState(today());
  const [periodEnd, setPeriodEnd] = useState(today());
  const [amounts, setAmounts] = useState<Record<string, { earnings: string; deduction: string; deductionLabel: string }>>({});
  const [paying, setPaying] = useState<{ run: Run; item: RunItem } | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentDate, setPaymentDate] = useState(today());

  const refresh = useCallback(async () => {
    if (!canView) return;
    setBusy(true);
    try {
      const [employeeResponse, runResponse, paymentResponse, customerResponse] = await Promise.all([
        api.get('/payroll/employees', { params: { include_inactive: 'true' } }),
        api.get('/payroll/runs'),
        api.get('/payroll/payments'),
        canManage ? api.get('/payroll/customers') : Promise.resolve({ data: { customers: [] } }),
      ]);
      setEmployees(employeeResponse.data.employees || []);
      setRuns(runResponse.data.runs || []);
      setPayments(paymentResponse.data.payments || []);
      setCustomers(customerResponse.data.customers || []);
    } catch (error) { toast.error(errorText(error, s('بارگذاری حقوق انجام نشد', 'Could not load payroll'))); }
    finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, canView, fa]);
  useEffect(() => { const timer = window.setTimeout(() => { void refresh(); }, 0); return () => window.clearTimeout(timer); }, [refresh]);

  const activeEmployees = useMemo(() => employees.filter((employee) => employee.is_active), [employees]);
  const saveEmployee = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/payroll/employees', { name, employee_code: code || null, notes: notes || null, customer_id: employeeCustomerId || null });
      setName(''); setCode(''); setNotes(''); setEmployeeCustomerId(''); toast.success(s('کارمند ثبت شد', 'Employee saved')); await refresh();
    } catch (error) { toast.error(errorText(error, s('ثبت کارمند انجام نشد', 'Could not save employee'))); }
  };
  const toggleEmployee = async (employee: Employee) => {
    try { await api.put(`/payroll/employees/${employee.id}`, { is_active: !employee.is_active }); await refresh(); }
    catch (error) { toast.error(errorText(error, s('تغییر وضعیت انجام نشد', 'Could not update employee'))); }
  };
  const linkCustomer = async (employee: Employee, customerId: string) => {
    try { await api.put(`/payroll/employees/${employee.id}`, { customer_id: customerId }); await refresh(); }
    catch (error) { toast.error(errorText(error, s('اتصال حساب مشتری انجام نشد', 'Could not link customer account'))); }
  };
  const createRun = async (event: React.FormEvent) => {
    event.preventDefault();
    const items = activeEmployees.filter((employee) => Number(amounts[employee.id]?.earnings) > 0).map((employee) => {
      const values = amounts[employee.id];
      const deductionAmount = Number(values?.deduction || 0);
      return { employeeId: employee.id, earnings: [{ label: s('حقوق و مزایای دستی', 'Manual earnings'), amount: Number(values.earnings) }], deductions: deductionAmount > 0 ? [{ label: values.deductionLabel || s('کسورات دستی', 'Manual deduction'), amount: deductionAmount }] : [] };
    });
    if (!items.length) { toast.error(s('برای دست‌کم یک کارمند مبلغ ناخالص وارد کنید', 'Enter gross earnings for at least one employee')); return; }
    try { await api.post('/payroll/runs', { period_start: periodStart, period_end: periodEnd, items }); setAmounts({}); toast.success(s('پیش‌نویس حقوق ساخته شد', 'Payroll draft created')); await refresh(); }
    catch (error) { toast.error(errorText(error, s('ساخت پیش‌نویس انجام نشد', 'Could not create payroll draft'))); }
  };
  const loadRun = async (run: Run) => {
    try { const response = await api.get(`/payroll/runs/${run.id}`); return response.data.run as Run; }
    catch (error) { toast.error(errorText(error, s('جزئیات بارگذاری نشد', 'Could not load run details'))); return null; }
  };
  const postRun = async (run: Run) => {
    if (!window.confirm(s('ثبت نهایی هزینه و بدهی‌های حقوق در دفترکل انجام شود؟', 'Post payroll expense and liabilities to the ledger?'))) return;
    try { await api.post(`/payroll/runs/${run.id}/post`); toast.success(s('حقوق در دفترکل ثبت شد', 'Payroll posted')); await refresh(); }
    catch (error) { toast.error(errorText(error, s('ثبت حقوق انجام نشد', 'Could not post payroll'))); }
  };
  const reverseRun = async (run: Run) => {
    if (!window.confirm(s('سند حقوق معکوس شود؟ ابتدا پرداخت‌ها باید برگشت داده شوند.', 'Reverse this payroll? All payments must be reversed first.'))) return;
    try { await api.post(`/payroll/runs/${run.id}/reverse`, {}); toast.success(s('حقوق معکوس شد', 'Payroll reversed')); await refresh(); }
    catch (error) { toast.error(errorText(error, s('برگشت حقوق انجام نشد', 'Could not reverse payroll'))); }
  };
  const beginPayment = async (run: Run) => {
    const detail = await loadRun(run);
    const item = detail?.items?.find((row) => {
      const paid = payments.filter((payment) => payment.payroll_run_id === run.id && payment.payroll_run_item_id === row.id && !payment.deleted_at)
        .reduce((sum, payment) => sum + payment.amount, 0);
      return row.cash_due_amount - paid > 0;
    });
    if (!detail || !item) { toast.error(s('مورد پرداختی باقی نمانده است', 'No payable employee remains')); return; }
    const paid = payments.filter((payment) => payment.payroll_run_id === run.id && payment.payroll_run_item_id === item.id && !payment.deleted_at).reduce((sum, payment) => sum + payment.amount, 0);
    setPaying({ run: detail, item }); setPaymentAmount(String(Math.max(0, item.cash_due_amount - paid)));
  };
  const savePayment = async (event: React.FormEvent) => {
    event.preventDefault(); if (!paying) return;
    try { await api.post(`/payroll/runs/${paying.run.id}/payments`, { payroll_run_item_id: paying.item.id, amount: Number(paymentAmount), payment_method: paymentMethod, paid_at: paymentDate }); setPaying(null); toast.success(s('پرداخت حقوق ثبت شد', 'Payroll payment recorded')); await refresh(); }
    catch (error) { toast.error(errorText(error, s('پرداخت ثبت نشد', 'Could not record payment'))); }
  };
  const payWithholding = async (run: Run) => {
    const amount = window.prompt(s('مبلغ پرداخت کسورات را وارد کنید', 'Enter withholding remittance amount'), String(run.withholding_due_amount));
    if (!amount) return;
    try { await api.post(`/payroll/runs/${run.id}/withholding-payments`, { amount: Number(amount), payment_method: 'bank_transfer', paid_at: today() }); await refresh(); }
    catch (error) { toast.error(errorText(error, s('پرداخت کسورات ثبت نشد', 'Could not record remittance'))); }
  };

  if (!canView) return <main className="p-6">{s('دسترسی به حقوق و دستمزد ندارید', 'You do not have access to payroll')}</main>;
  return <main className="p-4 md:p-6 space-y-5" dir={fa ? 'rtl' : 'ltr'}>
    <div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">{s('حقوق و دستمزد', 'Payroll')}</h1><p className="text-sm text-muted-foreground mt-1">{s('مبالغ، مزایا و کسورات به‌صورت دستی ثبت می‌شوند؛ مالیات و بیمه خودکار محاسبه نمی‌شوند.', 'Earnings and deductions are entered manually. Tax and insurance are not calculated automatically.')}</p></div><Button variant="outline" onClick={() => void refresh()} disabled={busy}><RefreshCw className="h-4 w-4 me-2" />{s('تازه‌سازی', 'Refresh')}</Button></div>
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList><TabsTrigger value="runs">{s('دوره‌های حقوق', 'Payroll runs')}</TabsTrigger><TabsTrigger value="employees">{s('کارکنان', 'Employees')}</TabsTrigger><TabsTrigger value="payments">{s('پرداخت‌ها', 'Payments')}</TabsTrigger></TabsList>
      <TabsContent value="employees" className="space-y-4">
        {canManage && <form onSubmit={saveEmployee} className="rounded-lg border p-4 grid gap-3 md:grid-cols-5"><input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} placeholder={s('نام کارمند', 'Employee name')} required/><input className="rounded border px-3 py-2" value={code} onChange={(e) => setCode(e.target.value)} placeholder={s('کد کارمند (اختیاری)', 'Employee code (optional)')}/><input className="rounded border px-3 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={s('یادداشت', 'Notes')}/><select className="rounded border px-3 py-2" value={employeeCustomerId} onChange={(event) => setEmployeeCustomerId(event.target.value)}><option value="">{s('ساخت حساب مشتری جدید', 'Create a new customer account')}</option>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><Button type="submit"><Plus className="h-4 w-4 me-1"/>{s('افزودن کارمند', 'Add employee')}</Button></form>}
        <div className="rounded-lg border divide-y">{employees.map((employee) => <div key={employee.id} className="p-3 flex items-center justify-between"><div><strong>{employee.name}</strong><div className="text-sm text-muted-foreground">{employee.employee_code || '—'} · {s('حساب مشتری', 'Customer account')}: {employee.customer_name || s('متصل نیست', 'Not linked')}{employee.notes ? ` · ${employee.notes}` : ''}</div></div><div className="flex items-center gap-2">{canManage && <select aria-label={s(`حساب مشتری ${employee.name}`, `${employee.name} customer account`)} className="rounded border px-2 py-1 text-sm" value={employee.customer_id || ''} onChange={(event) => void linkCustomer(employee, event.target.value)}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select>}{canManage && <Button size="sm" variant="outline" onClick={() => void toggleEmployee(employee)}>{employee.is_active ? s('غیرفعال‌سازی', 'Deactivate') : s('فعال‌سازی', 'Activate')}</Button>}</div></div>)}{!employees.length && <p className="p-5 text-muted-foreground">{s('کارمندی ثبت نشده است', 'No employees yet')}</p>}</div>
      </TabsContent>
      <TabsContent value="runs" className="space-y-4">
        {canManage && <form onSubmit={createRun} className="rounded-lg border p-4 space-y-4"><div className="font-semibold">{s('ساخت پیش‌نویس دوره', 'Create a draft payroll run')}</div><div className="grid gap-3 md:grid-cols-2"><label className="text-sm">{s('از تاریخ', 'Period start')}<input type="date" className="mt-1 w-full rounded border px-3 py-2" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required/></label><label className="text-sm">{s('تا تاریخ', 'Period end')}<input type="date" className="mt-1 w-full rounded border px-3 py-2" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} required/></label></div><div className="space-y-2">{activeEmployees.map((employee) => <div key={employee.id} className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_1fr] items-center"><span>{employee.name}</span><input className="rounded border px-3 py-2" type="number" min="0" step="0.01" placeholder={s('ناخالص / مزایا', 'Gross earnings')} value={amounts[employee.id]?.earnings || ''} onChange={(e) => setAmounts((old) => ({ ...old, [employee.id]: { earnings: e.target.value, deduction: old[employee.id]?.deduction || '', deductionLabel: old[employee.id]?.deductionLabel || '' } }))}/><input className="rounded border px-3 py-2" type="number" min="0" step="0.01" placeholder={s('کسورات', 'Deductions')} value={amounts[employee.id]?.deduction || ''} onChange={(e) => setAmounts((old) => ({ ...old, [employee.id]: { earnings: old[employee.id]?.earnings || '', deduction: e.target.value, deductionLabel: old[employee.id]?.deductionLabel || '' } }))}/><input className="rounded border px-3 py-2" placeholder={s('شرح کسورات', 'Deduction label')} value={amounts[employee.id]?.deductionLabel || ''} onChange={(e) => setAmounts((old) => ({ ...old, [employee.id]: { earnings: old[employee.id]?.earnings || '', deduction: old[employee.id]?.deduction || '', deductionLabel: e.target.value } }))}/></div>)}</div><Button type="submit" disabled={!activeEmployees.length}><Plus className="h-4 w-4 me-1"/>{s('ساخت پیش‌نویس', 'Create draft')}</Button></form>}
        <div className="rounded-lg border divide-y">{runs.map((run) => <div key={run.id} className="p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"><div><div className="font-semibold">{run.period_start} – {run.period_end} <span className="text-xs rounded bg-muted px-2 py-1">{run.status}</span></div><div className="text-sm text-muted-foreground">{s('کارکنان', 'Employees')}: {run.employee_count} · {s('ناخالص', 'Gross')}: {formatNumber(run.gross_amount)} · {s('کسورات دستی', 'Manual deductions')}: {formatNumber(run.deductions_amount)} · {s('بدهی خرید کسرشده', 'Purchase debt deducted')}: {formatNumber(run.purchase_deduction_amount)} · {s('قابل‌پرداخت', 'Cash due')}: {formatNumber(run.cash_due_amount)} · {s('پرداخت‌نشده', 'Unpaid')}: {formatNumber(run.unpaid_amount)}</div></div><div className="flex flex-wrap gap-2">{canManage && run.status === 'draft' && <Button size="sm" onClick={() => void postRun(run)}><Check className="h-4 w-4 me-1"/>{s('ثبت در دفترکل', 'Post')}</Button>}{canManage && run.status === 'posted' && run.unpaid_amount > 0 && <Button size="sm" variant="outline" onClick={() => void beginPayment(run)}><Wallet className="h-4 w-4 me-1"/>{s('پرداخت حقوق', 'Pay employee')}</Button>}{canManage && run.status === 'posted' && run.withholding_due_amount > 0 && <Button size="sm" variant="outline" onClick={() => void payWithholding(run)}>{s('پرداخت کسورات', 'Remit deductions')}</Button>}{canManage && run.status === 'posted' && <Button size="sm" variant="destructive" onClick={() => void reverseRun(run)}><RotateCcw className="h-4 w-4 me-1"/>{s('معکوس', 'Reverse')}</Button>}</div></div>)}{!runs.length && <p className="p-5 text-muted-foreground">{s('دوره‌ای ثبت نشده است', 'No payroll runs')}</p>}</div>
      </TabsContent>
      <TabsContent value="payments"><div className="rounded-lg border divide-y">{payments.filter((payment) => !payment.deleted_at).map((payment) => <div key={payment.id} className="p-3 flex justify-between"><span>{payment.employee_name || payment.payroll_run_id} · {payment.payment_method} · {payment.paid_at}</span><strong>{formatNumber(payment.amount)}</strong></div>)}{!payments.length && <p className="p-5 text-muted-foreground">{s('پرداختی ثبت نشده است', 'No payments recorded')}</p>}</div></TabsContent>
    </Tabs>
    {paying && <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"><form onSubmit={savePayment} className="bg-background rounded-lg border shadow-xl p-5 w-full max-w-md space-y-3"><h2 className="font-semibold">{s('پرداخت به', 'Pay')} {paying.item.employee_name}</h2><input className="w-full rounded border px-3 py-2" type="number" min="0.01" max={paying.item.cash_due_amount} step="0.01" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} required/><select className="w-full rounded border px-3 py-2" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}><option value="cash">{s('نقدی', 'Cash')}</option><option value="bank_transfer">{s('انتقال بانکی', 'Bank transfer')}</option><option value="card">{s('کارت', 'Card')}</option><option value="cheque">{s('چک', 'Cheque')}</option></select><input className="w-full rounded border px-3 py-2" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} required/><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setPaying(null)}>{s('انصراف', 'Cancel')}</Button><Button type="submit">{s('ثبت پرداخت', 'Record payment')}</Button></div></form></div>}
  </main>;
}
