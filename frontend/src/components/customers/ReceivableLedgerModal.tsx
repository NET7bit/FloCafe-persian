'use client';

import { useCallback, useEffect, useState } from 'react';
import { X, TrendingUp, TrendingDown, BookUser, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { useLocale, useTranslations } from 'use-intl';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import { PAYMENT_METHODS } from '@/lib/payment-methods';

interface Props {
  customer: { id: string | number; name: string };
  onClose: () => void;
}

interface Entry {
  id: string;
  entry_type: 'charge' | 'settlement' | 'adjustment';
  direction: 'debit' | 'credit';
  amount: number;
  payment_method: string | null;
  reference: string | null;
  description: string | null;
  entry_date: string;
}

interface Statement {
  customer: { id: string; name: string };
  balance: number;
  entries: Entry[];
}

const TYPE_LABEL_KEYS = {
  charge: 'charge',
  settlement: 'settlement',
  adjustment: 'adjustment',
} as const;

export default function ReceivableLedgerModal({ customer, onClose }: Props) {
  const t = useTranslations('customers');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const locale = useLocale();
  const fmt = useFormatCurrency();
  const { formatDate } = useFormatDate();

  const [statement, setStatement] = useState<Statement | null>(null);
  const tCustomers = useTranslations('customers');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [entryType, setEntryType] = useState<'settlement' | 'charge' | 'adjustment'>('settlement');
  const [direction, setDirection] = useState<'debit' | 'credit'>('debit');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');

  const loadStatement = useCallback(() => {
    api.get('/receivables/statement', { params: { customer_id: customer.id } })
      .then(({ data }) => setStatement(data.statement))
      .catch(() => toast.error(t('accountLoadFailed')))
      .finally(() => setLoading(false));
  }, [customer.id, t]);

  useEffect(() => {
    Promise.resolve().then(loadStatement);
  }, [loadStatement]);

  const balance = statement?.balance ?? 0;

  const submitEntry = async () => {
    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) return;
    if (entryType !== 'settlement' && !description.trim()) {
      toast.error(t('chargeDescription'));
      return;
    }
    setSaving(true);
    try {
      await api.post('/receivables', {
        customer_id: customer.id,
        entry_type: entryType,
        ...(entryType === 'adjustment' ? { direction } : {}),
        amount: parsed,
        ...(entryType === 'settlement' ? { payment_method: paymentMethod } : {}),
        ...(entryType !== 'settlement' ? { description: description.trim() } : {}),
      });
      toast.success(t('saved'));
      setAmount('');
      setDescription('');
      loadStatement();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (id: string) => {
    try {
      await api.delete(`/receivables/${id}`);
      loadStatement();
    } catch {
      toast.error(t('saveFailed'));
    }
  };

  const typeLabel = (entry: Entry) => {
    const key = TYPE_LABEL_KEYS[entry.entry_type];
    const method = entry.payment_method === 'payroll_deduction'
      ? (locale.startsWith('fa') ? 'کسر از حقوق' : 'Payroll deduction')
      : entry.payment_method;
    return `${t(key)}${entry.entry_type === 'settlement' && method ? ` · ${method}` : ''}`;
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border">
          <div className="flex items-center gap-2">
            <BookUser size={18} className="text-brand" />
            <div>
              <h2 className="text-lg font-bold text-foreground">{t('receivableLedger')}</h2>
              <p className="text-sm text-muted-foreground">{customer.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full bg-muted hover:bg-muted">
            <X size={16} className="text-muted-foreground" />
          </button>
        </div>

        {/* Balance banner */}
        <div className="px-6 py-4 bg-muted border-b border-border flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{balance < 0 ? t('prepaid') : t('amountDue')}</span>
          <span className={`text-xl font-bold tabular-nums ${balance > 0 ? 'text-red-600' : balance < 0 ? 'text-green-600' : 'text-foreground'}`}>
            {fmt(Math.abs(balance))}
          </span>
        </div>

        {/* New entry form */}
        <div className="px-6 py-4 border-b border-border space-y-3">
          <div className="flex gap-2">
            {(['settlement', 'charge', 'adjustment'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => { setEntryType(type); setAmount(''); }}
                className={`flex-1 py-2 text-sm font-semibold rounded-lg border transition-colors ${entryType === type ? 'bg-brand text-white border-brand' : 'bg-muted text-foreground border-border hover:border-brand'}`}
              >
                {t(TYPE_LABEL_KEYS[type])}
              </button>
            ))}
          </div>
          {entryType === 'adjustment' && (
            <div className="flex gap-2">
              {(['debit', 'credit'] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setDirection(dir)}
                  className={`flex-1 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${direction === dir ? 'bg-brand text-white border-brand' : 'bg-muted text-foreground border-border'}`}
                >
                  {dir === 'debit' ? '+' : '−'}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={entryType === 'settlement' ? t('settlementAmount') : '0.00'}
              min="0"
              inputMode="decimal"
              className="w-36 px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
            />
            {entryType === 'settlement' ? (
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="flex-1 px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              >
                {PAYMENT_METHODS.filter((m) => m.key !== 'customer_account').map((m) => (
                  <option key={m.key} value={m.key}>{tPos(m.labelKey.split('.')[1] as never)}</option>
                ))}
                <option value="other">{t('adjustment')}</option>
              </select>
            ) : (
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('chargeDescription')}
                className="flex-1 px-3 py-2 text-sm border border-border rounded-lg outline-none focus:ring-2 focus:ring-brand bg-card"
              />
            )}
            <Button onClick={submitEntry} disabled={saving || !parseFloat(amount)}>
              {saving ? '…' : tCommon('save')}
            </Button>
          </div>
        </div>

        {/* Entries */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-center text-gray-400 py-12 text-sm">…</p>
          ) : !statement || statement.entries.length === 0 ? (
            <p className="text-center text-gray-400 py-12 text-sm">{t('noAccountEntries')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted sticky top-0">
                <tr>
                  <th className="text-start px-6 py-2.5 text-xs font-medium text-muted-foreground">{tCustomers('columnDate')}</th>
                  <th className="text-start px-4 py-2.5 text-xs font-medium text-muted-foreground">{t('chargeDescription')}</th>
                  <th className="text-end px-4 py-2.5 text-xs font-medium text-muted-foreground">{tCommon('amount')}</th>
                  <th className="text-end px-6 py-2.5 text-xs font-medium text-muted-foreground">{tCommon('delete')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {statement.entries.map((entry) => (
                  <tr key={entry.id} className="hover:bg-muted">
                    <td className="px-6 py-3 text-muted-foreground whitespace-nowrap">{formatDate(entry.entry_date)}</td>
                    <td className="px-4 py-3">
                      <span className="text-foreground">{typeLabel(entry)}</span>
                      {entry.description && <span className="text-xs text-muted-foreground block">{entry.description}</span>}
                    </td>
                    <td className="px-4 py-3 text-end font-semibold whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 ${entry.direction === 'debit' ? 'text-red-600' : 'text-green-600'}`}>
                        {entry.direction === 'debit' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                        {fmt(entry.amount)}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-end">
                      {entry.payment_method !== 'payroll_deduction' && !entry.reference?.startsWith('payroll-reversal:') && <Button variant="ghost" size="sm" onClick={() => deleteEntry(entry.id)} title={tCommon('delete')}>
                        <Trash2 size={13} className="text-muted-foreground" />
                      </Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-6 py-3 border-t border-border text-xs text-muted-foreground" dir="ltr">
          {formatDate(new Date().toISOString())}
        </div>
      </div>
    </div>
  );
}
