'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale } from 'use-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useFormatDate } from '@/hooks/useFormatDate';
import { Plus, RefreshCw, Truck, FileText, RotateCcw, Wallet, Pencil, Trash2, Check, X } from 'lucide-react';

type Supplier = { id: string; name: string; code: string | null; phone: string | null; mobile: string | null; national_id: string | null; economic_code: string | null; address: string | null; notes: string | null; is_active: number };
type Supply = { id: string; name: string; base_unit: string; is_active?: number };
type InvoiceItem = { id: string; supply_id: string; supply_name: string | null; quantity: number; unit: string; unit_price: number; total: number };
type Invoice = { id: string; invoice_number: string; supplier_id: string; supplier_name: string | null; invoice_date: string; due_date: string | null; total: number; paid_amount: number; balance: number; status: string; notes?: string | null; items?: InvoiceItem[] };
type PurchaseReturn = { id: string; return_number: string; invoice_number: string | null; supplier_name: string | null; return_date: string; total: number; status: string };
type Payment = { id: string; supplier_name: string | null; invoice_number: string | null; amount: number; payment_method: string; reference: string | null; paid_at: string; created_by_name: string | null };
type DraftLine = { supply_id: string; quantity: string; unit: string; unit_price: string };

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const apiErrorMessage = (error: unknown, fallback: string): string => {
  const responseError = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof responseError === 'string' ? responseError : fallback;
};

export default function PurchasesPage() {
  const locale = useLocale();
  const fa = locale.startsWith('fa');
  const s = (persian: string, english: string) => fa ? persian : english;
  const { currentTenant } = useAuthStore();
  const canManage = tenantCan(currentTenant, 'supplies.manage');
  const fmt = useFormatNumber();
  const { formatDate } = useFormatDate();
  const [tab, setTab] = useState('invoices');
  const [busy, setBusy] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplies, setSupplies] = useState<Supply[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [returns, setReturns] = useState<PurchaseReturn[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [supplierForm, setSupplierForm] = useState({ name: '', code: '', phone: '', mobile: '', national_id: '', economic_code: '', address: '', notes: '' });
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [showInvoiceForm, setShowInvoiceForm] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<Invoice | null>(null);
  const [invoiceForm, setInvoiceForm] = useState({ supplier_id: '', invoice_date: today(), due_date: '', notes: '' });
  const [lines, setLines] = useState<DraftLine[]>([{ supply_id: '', quantity: '', unit: 'each', unit_price: '' }]);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ supplier_id: '', purchase_invoice_id: '', amount: '', payment_method: 'cash', reference: '', paid_at: today(), notes: '' });
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnInvoice, setReturnInvoice] = useState<Invoice | null>(null);
  const [returnLines, setReturnLines] = useState<Record<string, string>>({});
  const [returnForm, setReturnForm] = useState({ invoice_id: '', reason: '', notes: '' });

  const refresh = useCallback(async () => {
    if (!canManage) return;
    setBusy(true);
    try {
      const [supplierRes, suppliesRes, invoiceRes, returnRes, paymentRes] = await Promise.all([
        api.get('/suppliers', { params: { include_inactive: 'true' } }),
        api.get('/supplies', { params: { include_inactive: 'true' } }),
        api.get('/purchase-invoices', { params: { per_page: 100 } }),
        api.get('/purchase-returns', { params: { per_page: 100 } }),
        api.get('/supplier-payments', { params: { per_page: 100 } }),
      ]);
      setSuppliers(supplierRes.data.suppliers || []);
      setSupplies(suppliesRes.data.supplies || []);
      setInvoices(invoiceRes.data.invoices || []);
      setReturns(returnRes.data.returns || []);
      setPayments(paymentRes.data.payments || []);
    } catch (err: unknown) {
      toast.error(apiErrorMessage(err, s('بارگذاری اطلاعات خرید انجام نشد', 'Could not load purchasing data')));
    } finally { setBusy(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, fa]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const activeSuppliers = useMemo(() => suppliers.filter((x) => x.is_active), [suppliers]);
  const activeSupplies = useMemo(() => supplies.filter((x) => x.is_active !== 0), [supplies]);
  const openInvoices = useMemo(() => invoices.filter((x) => ['posted', 'partially_paid', 'paid'].includes(x.status)), [invoices]);
  const closeSupplier = () => { setShowSupplierForm(false); setEditing(null); setSupplierForm({ name: '', code: '', phone: '', mobile: '', national_id: '', economic_code: '', address: '', notes: '' }); };
  const editSupplier = (supplier: Supplier) => {
    setEditing(supplier);
    setSupplierForm({ name: supplier.name, code: supplier.code || '', phone: supplier.phone || '', mobile: supplier.mobile || '', national_id: supplier.national_id || '', economic_code: supplier.economic_code || '', address: supplier.address || '', notes: supplier.notes || '' });
    setShowSupplierForm(true);
  };
  const saveSupplier = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const body = { ...supplierForm, is_active: editing ? !!editing.is_active : true };
      if (editing) await api.put(`/suppliers/${editing.id}`, body); else await api.post('/suppliers', body);
      toast.success(s('تأمین‌کننده ذخیره شد', 'Supplier saved'));
      closeSupplier(); await refresh();
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('ذخیره انجام نشد', 'Could not save'))); }
  };
  const toggleSupplier = async (supplier: Supplier) => {
    try {
      await api.put(`/suppliers/${supplier.id}`, { is_active: !supplier.is_active });
      await refresh();
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('وضعیت تغییر نکرد', 'Could not update status'))); }
  };
  const saveInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    const validLines = lines.filter((line) => line.supply_id && Number(line.quantity) > 0 && line.unit_price.trim() !== '' && Number(line.unit_price) >= 0);
    if (!invoiceForm.supplier_id || validLines.length === 0) { toast.error(s('تأمین‌کننده و دست‌کم یک ردیف معتبر لازم است', 'Select a supplier and add at least one valid line')); return; }
    try {
      const body = { ...invoiceForm, due_date: invoiceForm.due_date || null, items: validLines.map((line) => ({ supply_id: line.supply_id, quantity: Number(line.quantity), unit: line.unit, unit_price: Number(line.unit_price) })) };
      if (editingInvoice) await api.put(`/purchase-invoices/${editingInvoice.id}`, body);
      else await api.post('/purchase-invoices', body);
      toast.success(editingInvoice ? s('پیش‌نویس فاکتور ویرایش شد', 'Invoice draft updated') : s('پیش‌نویس فاکتور ساخته شد', 'Invoice draft created'));
      setShowInvoiceForm(false); setEditingInvoice(null); setLines([{ supply_id: '', quantity: '', unit: 'each', unit_price: '' }]); await refresh();
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('ساخت فاکتور انجام نشد', 'Could not create invoice'))); }
  };
  const editInvoice = async (invoice: Invoice) => {
    try {
      const { data } = await api.get(`/purchase-invoices/${invoice.id}`);
      const detail = data.invoice as Invoice;
      setEditingInvoice(detail);
      setInvoiceForm({ supplier_id: detail.supplier_id, invoice_date: detail.invoice_date.slice(0, 10), due_date: detail.due_date?.slice(0, 10) || '', notes: detail.notes || '' });
      setLines((detail.items || []).map((line) => ({ supply_id: line.supply_id, quantity: String(line.quantity), unit: line.unit, unit_price: String(line.unit_price) })));
      setShowInvoiceForm(true);
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('فاکتور بارگذاری نشد', 'Could not load invoice'))); }
  };
  const postInvoice = async (invoice: Invoice) => {
    if (!window.confirm(s(`فاکتور ${invoice.invoice_number} ثبت و موجودی مواد افزایش می‌یابد. ادامه می‌دهید؟`, `Post ${invoice.invoice_number}? This will receive its items into inventory.`))) return;
    try { await api.post(`/purchase-invoices/${invoice.id}/post`); toast.success(s('فاکتور ثبت شد', 'Invoice posted')); await refresh(); }
    catch (err: unknown) { toast.error(apiErrorMessage(err, s('ثبت فاکتور انجام نشد', 'Could not post invoice'))); }
  };
  const cancelInvoice = async (invoice: Invoice) => {
    if (!window.confirm(s(`پیش‌نویس ${invoice.invoice_number} لغو شود؟`, `Cancel draft ${invoice.invoice_number}?`))) return;
    try { await api.post(`/purchase-invoices/${invoice.id}/cancel`); toast.success(s('پیش‌نویس لغو شد', 'Draft cancelled')); await refresh(); }
    catch (err: unknown) { toast.error(apiErrorMessage(err, s('لغو فاکتور انجام نشد', 'Could not cancel invoice'))); }
  };
  const beginReturn = async () => {
    if (!returnForm.invoice_id) { toast.error(s('فاکتور را انتخاب کنید', 'Choose an invoice')); return; }
    try {
      const { data } = await api.get(`/purchase-invoices/${returnForm.invoice_id}`);
      const invoice = data.invoice as Invoice;
      if (!invoice.items?.length) { toast.error(s('ردیف‌های فاکتور در دسترس نیست', 'Invoice lines are unavailable')); return; }
      setReturnInvoice(invoice); setReturnLines({}); setShowReturnForm(true);
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('فاکتور بارگذاری نشد', 'Could not load invoice'))); }
  };
  const saveReturn = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!returnInvoice) return;
    const items = (returnInvoice.items || []).filter((line) => Number(returnLines[line.id]) > 0).map((line) => ({ purchase_invoice_item_id: line.id, quantity: Number(returnLines[line.id]) }));
    if (!items.length) { toast.error(s('مقدار برگشت را وارد کنید', 'Enter a return quantity')); return; }
    try {
      await api.post('/purchase-returns', { purchase_invoice_id: returnInvoice.id, return_date: today(), reason: returnForm.reason || null, notes: returnForm.notes || null, items });
      toast.success(s('برگشت خرید ثبت شد', 'Purchase return recorded')); setShowReturnForm(false); setReturnInvoice(null); await refresh();
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('ثبت برگشت انجام نشد', 'Could not record return'))); }
  };
  const deleteReturn = async (record: PurchaseReturn) => {
    if (!window.confirm(s(`برگشت ${record.return_number} با سند جبرانی حذف شود؟`, `Reverse and delete return ${record.return_number}?`))) return;
    try { await api.delete(`/purchase-returns/${record.id}`, { data: { deletion_reason: 'Deleted from purchasing dashboard' } }); toast.success(s('برگشت حذف شد', 'Return reversed')); await refresh(); }
    catch (err: unknown) { toast.error(apiErrorMessage(err, s('حذف برگشت انجام نشد', 'Could not reverse return'))); }
  };
  const savePayment = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await api.post('/supplier-payments', { ...paymentForm, purchase_invoice_id: paymentForm.purchase_invoice_id || null, amount: Number(paymentForm.amount) });
      toast.success(s('پرداخت ثبت شد', 'Payment recorded')); setShowPaymentForm(false); setPaymentForm({ supplier_id: '', purchase_invoice_id: '', amount: '', payment_method: 'cash', reference: '', paid_at: today(), notes: '' }); await refresh();
    } catch (err: unknown) { toast.error(apiErrorMessage(err, s('ثبت پرداخت انجام نشد', 'Could not record payment'))); }
  };
  const deletePayment = async (payment: Payment) => {
    if (!window.confirm(s('پرداخت حذف و سند حسابداری آن معکوس شود؟', 'Delete this payment and reverse its accounting entry?'))) return;
    try { await api.delete(`/supplier-payments/${payment.id}`); toast.success(s('پرداخت حذف شد', 'Payment reversed')); await refresh(); }
    catch (err: unknown) { toast.error(apiErrorMessage(err, s('حذف پرداخت انجام نشد', 'Could not reverse payment'))); }
  };

  if (!canManage) return <main className="p-6"><p className="text-muted-foreground">{s('دسترسی مدیریت خرید ندارید.', 'You do not have permission to manage purchasing.')}</p></main>;

  const money = (value: number) => fmt(value);
  const statusLabel = (status: string) => ({ draft: s('پیش‌نویس', 'Draft'), posted: s('ثبت‌شده', 'Posted'), partially_paid: s('پرداخت ناقص', 'Partially paid'), paid: s('پرداخت‌شده', 'Paid'), cancelled: s('لغوشده', 'Cancelled'), active: s('فعال', 'Active'), deleted: s('باطل‌شده', 'Reversed') }[status] || status);
  const inputClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
  const fieldLabel = 'mb-1 block text-sm font-medium';
  const tableWrap = 'overflow-x-auto rounded-lg border';
  const td = 'px-3 py-2.5 text-sm';
  const th = 'px-3 py-2 text-start text-xs font-semibold text-muted-foreground';

  return <main className="space-y-5 p-4 md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">{s('خرید و تأمین‌کنندگان', 'Purchases & suppliers')}</h1><p className="mt-1 text-sm text-muted-foreground">{s('ثبت فاکتور خرید، دریافت موجودی، برگشت و پرداخت تأمین‌کنندگان', 'Manage supplier records, purchase invoices, returns and payments')}</p></div><Button variant="outline" onClick={() => void refresh()} disabled={busy}><RefreshCw className={`me-2 size-4 ${busy ? 'animate-spin' : ''}`} />{s('به‌روزرسانی', 'Refresh')}</Button></header>
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="h-auto flex-wrap justify-start"><TabsTrigger value="invoices"><FileText className="me-2 size-4" />{s('فاکتورهای خرید', 'Invoices')}</TabsTrigger><TabsTrigger value="suppliers"><Truck className="me-2 size-4" />{s('تأمین‌کنندگان', 'Suppliers')}</TabsTrigger><TabsTrigger value="returns"><RotateCcw className="me-2 size-4" />{s('برگشت خرید', 'Returns')}</TabsTrigger><TabsTrigger value="payments"><Wallet className="me-2 size-4" />{s('پرداخت‌ها', 'Payments')}</TabsTrigger></TabsList>
      <TabsContent value="suppliers" className="space-y-4"><div className="flex justify-end"><Button onClick={() => { setEditing(null); setSupplierForm({ name: '', code: '', phone: '', mobile: '', national_id: '', economic_code: '', address: '', notes: '' }); setShowSupplierForm(true); }}><Plus className="me-2 size-4" />{s('تأمین‌کننده جدید', 'New supplier')}</Button></div>
        {showSupplierForm && <form onSubmit={saveSupplier} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3"><label><span className={fieldLabel}>{s('نام *', 'Name *')}</span><input className={inputClass} required maxLength={200} value={supplierForm.name} onChange={(e) => setSupplierForm({ ...supplierForm, name: e.target.value })} /></label><label><span className={fieldLabel}>{s('کد', 'Code')}</span><input className={inputClass} value={supplierForm.code} onChange={(e) => setSupplierForm({ ...supplierForm, code: e.target.value })} /></label><label><span className={fieldLabel}>{s('تلفن', 'Phone')}</span><input className={inputClass} value={supplierForm.phone} onChange={(e) => setSupplierForm({ ...supplierForm, phone: e.target.value })} /></label><label><span className={fieldLabel}>{s('همراه', 'Mobile')}</span><input className={inputClass} value={supplierForm.mobile} onChange={(e) => setSupplierForm({ ...supplierForm, mobile: e.target.value })} /></label><label><span className={fieldLabel}>{s('شناسه ملی', 'National ID')}</span><input className={inputClass} value={supplierForm.national_id} onChange={(e) => setSupplierForm({ ...supplierForm, national_id: e.target.value })} /></label><label><span className={fieldLabel}>{s('شناسه اقتصادی', 'Economic code')}</span><input className={inputClass} value={supplierForm.economic_code} onChange={(e) => setSupplierForm({ ...supplierForm, economic_code: e.target.value })} /></label><label className="sm:col-span-2"><span className={fieldLabel}>{s('نشانی', 'Address')}</span><input className={inputClass} value={supplierForm.address} onChange={(e) => setSupplierForm({ ...supplierForm, address: e.target.value })} /></label><label className="sm:col-span-2 lg:col-span-3"><span className={fieldLabel}>{s('یادداشت', 'Notes')}</span><input className={inputClass} value={supplierForm.notes} onChange={(e) => setSupplierForm({ ...supplierForm, notes: e.target.value })} /></label><div className="flex gap-2 sm:col-span-2 lg:col-span-3"><Button type="submit"><Check className="me-2 size-4" />{s('ذخیره', 'Save')}</Button><Button type="button" variant="outline" onClick={closeSupplier}><X className="me-2 size-4" />{s('انصراف', 'Cancel')}</Button></div></form>}
        <div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{s('نام', 'Name')}</th><th className={th}>{s('کد', 'Code')}</th><th className={th}>{s('تماس', 'Contact')}</th><th className={th}>{s('وضعیت', 'Status')}</th><th className={th}>{s('عملیات', 'Actions')}</th></tr></thead><tbody>{suppliers.map((supplier) => <tr key={supplier.id} className="border-t"><td className={td}>{supplier.name}</td><td className={td}>{supplier.code || '—'}</td><td className={td}>{supplier.mobile || supplier.phone || '—'}</td><td className={td}><Badge variant={supplier.is_active ? 'default' : 'secondary'}>{statusLabel(supplier.is_active ? 'active' : 'deleted')}</Badge></td><td className={td}><div className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => editSupplier(supplier)} aria-label={s('ویرایش', 'Edit')}><Pencil className="size-4" /></Button><Button size="sm" variant="ghost" onClick={() => void toggleSupplier(supplier)}>{supplier.is_active ? s('غیرفعال‌سازی', 'Deactivate') : s('فعال‌سازی', 'Activate')}</Button></div></td></tr>)}</tbody></table>{suppliers.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{s('تأمین‌کننده‌ای ثبت نشده است', 'No suppliers yet')}</p>}</div>
      </TabsContent>
      <TabsContent value="invoices" className="space-y-4"><div className="flex justify-end"><Button onClick={() => { setEditingInvoice(null); setInvoiceForm({ supplier_id: '', invoice_date: today(), due_date: '', notes: '' }); setLines([{ supply_id: '', quantity: '', unit: 'each', unit_price: '' }]); setShowInvoiceForm(true); }}><Plus className="me-2 size-4" />{s('فاکتور خرید جدید', 'New purchase invoice')}</Button></div>
        {showInvoiceForm && <form onSubmit={saveInvoice} className="space-y-4 rounded-lg border p-4"><h2 className="font-semibold">{editingInvoice ? s('ویرایش پیش‌نویس', 'Edit invoice draft') : s('پیش‌نویس فاکتور', 'Invoice draft')}</h2><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label><span className={fieldLabel}>{s('تأمین‌کننده *', 'Supplier *')}</span><select className={inputClass} required disabled={!!editingInvoice} value={invoiceForm.supplier_id} onChange={(e) => setInvoiceForm({ ...invoiceForm, supplier_id: e.target.value })}><option value="">—</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label><label><span className={fieldLabel}>{s('تاریخ فاکتور *', 'Invoice date *')}</span><input className={inputClass} type="date" required disabled={!!editingInvoice} value={invoiceForm.invoice_date} onChange={(e) => setInvoiceForm({ ...invoiceForm, invoice_date: e.target.value })} /></label><label><span className={fieldLabel}>{s('سررسید', 'Due date')}</span><input className={inputClass} type="date" value={invoiceForm.due_date} onChange={(e) => setInvoiceForm({ ...invoiceForm, due_date: e.target.value })} /></label><label><span className={fieldLabel}>{s('یادداشت', 'Notes')}</span><input className={inputClass} value={invoiceForm.notes} onChange={(e) => setInvoiceForm({ ...invoiceForm, notes: e.target.value })} /></label></div><div className="space-y-2">{lines.map((line, index) => <div className="grid gap-2 sm:grid-cols-4" key={index}><select className={inputClass} aria-label={s('ماده اولیه', 'Supply')} value={line.supply_id} onChange={(e) => setLines(lines.map((x, i) => i === index ? { ...x, supply_id: e.target.value, unit: activeSupplies.find((supply) => supply.id === e.target.value)?.base_unit || 'each' } : x))}><option value="">{s('انتخاب ماده اولیه', 'Select supply')}</option>{activeSupplies.map((supply) => <option key={supply.id} value={supply.id}>{supply.name}</option>)}</select><input className={inputClass} aria-label={s('مقدار', 'Quantity')} type="number" min="0.0001" step="any" placeholder={s('مقدار', 'Quantity')} value={line.quantity} onChange={(e) => setLines(lines.map((x, i) => i === index ? { ...x, quantity: e.target.value } : x))} /><div className="flex gap-2"><input className={inputClass} aria-label={s('واحد', 'Unit')} value={line.unit} onChange={(e) => setLines(lines.map((x, i) => i === index ? { ...x, unit: e.target.value } : x))} /><input className={inputClass} aria-label={s('قیمت واحد', 'Unit price')} type="number" min="0" step="any" placeholder={s('قیمت واحد', 'Unit price')} value={line.unit_price} onChange={(e) => setLines(lines.map((x, i) => i === index ? { ...x, unit_price: e.target.value } : x))} /></div><Button type="button" variant="ghost" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, i) => i !== index))}><Trash2 className="size-4" />{s('حذف ردیف', 'Remove line')}</Button></div>)}</div><Button type="button" variant="outline" onClick={() => setLines([...lines, { supply_id: '', quantity: '', unit: 'each', unit_price: '' }])}><Plus className="me-2 size-4" />{s('افزودن ردیف', 'Add line')}</Button><div className="flex gap-2"><Button type="submit">{s('ذخیره پیش‌نویس', 'Save draft')}</Button><Button type="button" variant="outline" onClick={() => { setShowInvoiceForm(false); setEditingInvoice(null); }}>{s('انصراف', 'Cancel')}</Button></div></form>}
        <div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{s('شماره', 'Number')}</th><th className={th}>{s('تأمین‌کننده', 'Supplier')}</th><th className={th}>{s('تاریخ', 'Date')}</th><th className={th}>{s('مبلغ', 'Total')}</th><th className={th}>{s('مانده', 'Balance')}</th><th className={th}>{s('وضعیت', 'Status')}</th><th className={th}>{s('عملیات', 'Actions')}</th></tr></thead><tbody>{invoices.map((invoice) => <tr key={invoice.id} className="border-t"><td className={td}>{invoice.invoice_number}</td><td className={td}>{invoice.supplier_name || '—'}</td><td className={td}>{formatDate(invoice.invoice_date)}</td><td className={td}>{money(invoice.total)}</td><td className={td}>{money(invoice.balance)}</td><td className={td}><Badge variant={invoice.status === 'draft' ? 'secondary' : 'default'}>{statusLabel(invoice.status)}</Badge></td><td className={td}>{invoice.status === 'draft' && <div className="flex gap-1"><Button size="sm" variant="outline" onClick={() => void editInvoice(invoice)}>{s('ویرایش', 'Edit')}</Button><Button size="sm" onClick={() => void postInvoice(invoice)}>{s('ثبت و دریافت', 'Post & receive')}</Button><Button size="sm" variant="outline" onClick={() => void cancelInvoice(invoice)}>{s('لغو', 'Cancel')}</Button></div>}</td></tr>)}</tbody></table>{invoices.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{s('فاکتوری وجود ندارد', 'No invoices')}</p>}</div>
      </TabsContent>
      <TabsContent value="returns" className="space-y-4"><div className="flex flex-wrap justify-end gap-2"><select className={`${inputClass} max-w-sm`} value={returnForm.invoice_id} onChange={(e) => setReturnForm({ ...returnForm, invoice_id: e.target.value })}><option value="">{s('فاکتور ثبت‌شده برای برگشت را انتخاب کنید', 'Select a posted invoice to return')}</option>{openInvoices.map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} — {invoice.supplier_name}</option>)}</select><Button onClick={() => void beginReturn()}><Plus className="me-2 size-4" />{s('ثبت برگشت', 'Record return')}</Button></div>
        {showReturnForm && returnInvoice && <form onSubmit={saveReturn} className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">{s('برگشت از فاکتور', 'Return from invoice')} {returnInvoice.invoice_number}</h2>{returnInvoice.items?.map((line) => <div className="grid items-center gap-2 sm:grid-cols-3" key={line.id}><span className="text-sm">{line.supply_name} ({line.quantity} {line.unit})</span><span className="text-sm text-muted-foreground">{money(line.unit_price)} / {s('واحد', 'unit')}</span><input className={inputClass} aria-label={`${s('مقدار برگشت', 'Return quantity')} ${line.supply_name}`} type="number" min="0" max={line.quantity} step="any" placeholder={s('مقدار برگشت', 'Return quantity')} value={returnLines[line.id] || ''} onChange={(e) => setReturnLines({ ...returnLines, [line.id]: e.target.value })} /></div>)}<input className={inputClass} placeholder={s('علت برگشت', 'Return reason')} value={returnForm.reason} onChange={(e) => setReturnForm({ ...returnForm, reason: e.target.value })} /><input className={inputClass} placeholder={s('یادداشت', 'Notes')} value={returnForm.notes} onChange={(e) => setReturnForm({ ...returnForm, notes: e.target.value })} /><div className="flex gap-2"><Button type="submit">{s('ثبت برگشت', 'Record return')}</Button><Button type="button" variant="outline" onClick={() => { setShowReturnForm(false); setReturnInvoice(null); }}>{s('انصراف', 'Cancel')}</Button></div><p className="text-xs text-muted-foreground">{s('مقدار مجاز با احتساب برگشت‌های قبلی در سرور بررسی می‌شود.', 'The server validates quantities against previous returns.')}</p></form>}
        <div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{s('شماره', 'Number')}</th><th className={th}>{s('فاکتور', 'Invoice')}</th><th className={th}>{s('تأمین‌کننده', 'Supplier')}</th><th className={th}>{s('تاریخ', 'Date')}</th><th className={th}>{s('مبلغ', 'Total')}</th><th className={th}>{s('عملیات', 'Actions')}</th></tr></thead><tbody>{returns.map((record) => <tr key={record.id} className="border-t"><td className={td}>{record.return_number}</td><td className={td}>{record.invoice_number || '—'}</td><td className={td}>{record.supplier_name || '—'}</td><td className={td}>{formatDate(record.return_date)}</td><td className={td}>{money(record.total)}</td><td className={td}>{record.status !== 'deleted' && <Button variant="ghost" size="sm" onClick={() => void deleteReturn(record)}><Trash2 className="me-1 size-4" />{s('برگشت/ابطال', 'Reverse')}</Button>}</td></tr>)}</tbody></table>{returns.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{s('برگشتی ثبت نشده است', 'No purchase returns')}</p>}</div>
      </TabsContent>
      <TabsContent value="payments" className="space-y-4"><div className="flex justify-end"><Button onClick={() => setShowPaymentForm(true)}><Plus className="me-2 size-4" />{s('پرداخت جدید', 'New payment')}</Button></div>
        {showPaymentForm && <form onSubmit={savePayment} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2 lg:grid-cols-3"><label><span className={fieldLabel}>{s('تأمین‌کننده *', 'Supplier *')}</span><select className={inputClass} required value={paymentForm.supplier_id} onChange={(e) => setPaymentForm({ ...paymentForm, supplier_id: e.target.value, purchase_invoice_id: '' })}><option value="">—</option>{activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label><label><span className={fieldLabel}>{s('فاکتور مرتبط', 'Related invoice')}</span><select className={inputClass} value={paymentForm.purchase_invoice_id} onChange={(e) => setPaymentForm({ ...paymentForm, purchase_invoice_id: e.target.value })}><option value="">{s('بدون اتصال به فاکتور', 'Unallocated')}</option>{openInvoices.filter((invoice) => invoice.supplier_id === paymentForm.supplier_id && invoice.balance > 0).map((invoice) => <option key={invoice.id} value={invoice.id}>{invoice.invoice_number} · {money(invoice.balance)}</option>)}</select></label><label><span className={fieldLabel}>{s('مبلغ *', 'Amount *')}</span><input className={inputClass} required type="number" min="0.01" step="any" value={paymentForm.amount} onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })} /></label><label><span className={fieldLabel}>{s('روش پرداخت', 'Payment method')}</span><select className={inputClass} value={paymentForm.payment_method} onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}>{[['cash', s('نقدی', 'Cash')], ['card', s('کارت', 'Card')], ['bank_transfer', s('انتقال بانکی', 'Bank transfer')], ['cheque', s('چک', 'Cheque')], ['other', s('سایر', 'Other')]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span className={fieldLabel}>{s('شناسه/مرجع', 'Reference')}</span><input className={inputClass} value={paymentForm.reference} onChange={(e) => setPaymentForm({ ...paymentForm, reference: e.target.value })} /></label><label><span className={fieldLabel}>{s('تاریخ پرداخت *', 'Payment date *')}</span><input className={inputClass} required type="date" value={paymentForm.paid_at} onChange={(e) => setPaymentForm({ ...paymentForm, paid_at: e.target.value })} /></label><label><span className={fieldLabel}>{s('یادداشت', 'Notes')}</span><input className={inputClass} value={paymentForm.notes} onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })} /></label><div className="flex gap-2 sm:col-span-2 lg:col-span-3"><Button type="submit">{s('ثبت پرداخت', 'Record payment')}</Button><Button type="button" variant="outline" onClick={() => setShowPaymentForm(false)}>{s('انصراف', 'Cancel')}</Button></div></form>}
        <div className={tableWrap}><table className="w-full"><thead><tr><th className={th}>{s('تأمین‌کننده', 'Supplier')}</th><th className={th}>{s('فاکتور', 'Invoice')}</th><th className={th}>{s('مبلغ', 'Amount')}</th><th className={th}>{s('روش', 'Method')}</th><th className={th}>{s('مرجع', 'Reference')}</th><th className={th}>{s('تاریخ', 'Date')}</th><th className={th}>{s('ثبت‌کننده', 'Recorded by')}</th><th className={th}>{s('عملیات', 'Actions')}</th></tr></thead><tbody>{payments.map((payment) => <tr key={payment.id} className="border-t"><td className={td}>{payment.supplier_name || '—'}</td><td className={td}>{payment.invoice_number || '—'}</td><td className={td}>{money(payment.amount)}</td><td className={td}>{payment.payment_method}</td><td className={td}>{payment.reference || '—'}</td><td className={td}>{formatDate(payment.paid_at)}</td><td className={td}>{payment.created_by_name || '—'}</td><td className={td}><Button variant="ghost" size="sm" onClick={() => void deletePayment(payment)}><Trash2 className="me-1 size-4" />{s('ابطال', 'Reverse')}</Button></td></tr>)}</tbody></table>{payments.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">{s('پرداختی ثبت نشده است', 'No supplier payments')}</p>}</div>
      </TabsContent>
    </Tabs>
  </main>;
}
