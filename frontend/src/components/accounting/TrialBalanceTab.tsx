'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import {
  accountingErrorMessage,
  fetchTrialBalance,
  type FiscalPeriod,
  type TrialBalanceReport,
} from '@/lib/accounting';
import {
  AccountingEmpty,
  AccountingError,
  AccountingLoading,
  AccountingRangeFilters,
  StatusBadge,
  emptyRange,
  rangeParams,
  useAccountTypeLabel,
  type AccountingRange,
} from './shared';

/**
 * Trial Balance. `balance` is the backend's signed debit − credit figure, and
 * the balanced verdict is the backend's own tolerance check.
 */
export default function TrialBalanceTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const typeLabel = useAccountTypeLabel();
  const [draft, setDraft] = useState<AccountingRange>(emptyRange);
  const [applied, setApplied] = useState<AccountingRange>(emptyRange);
  const [report, setReport] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchTrialBalance(rangeParams(applied), controller.signal)
      .then(setReport)
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  const clearRange = () => {
    setLoading(true);
    setError(null);
    setDraft(emptyRange());
    setApplied(emptyRange());
  };

  return (
    <div>
      <AccountingRangeFilters
        value={draft}
        periods={periods}
        onChange={setDraft}
        onApply={() => { setLoading(true); setError(null); setApplied(draft); }}
        onClear={clearRange}
      />

      {loading ? (
        <AccountingLoading />
      ) : error ? (
        <AccountingError message={error} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge tone="neutral">{t('totalDebit')}: {report?.totals.debit ?? 0}</StatusBadge>
            <StatusBadge tone="neutral">{t('totalCredit')}: {report?.totals.credit ?? 0}</StatusBadge>
            <StatusBadge tone={report?.totals.balanced ? 'ok' : 'bad'}>
              {report?.totals.balanced ? t('balanced') : t('unbalanced')}
            </StatusBadge>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('code')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('accountName')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('accountType')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('debit')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('credit')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('balance')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(report?.accounts ?? []).map((row) => (
                  <tr key={row.account_id} className="hover:bg-muted">
                    <td className="p-3 text-sm text-muted-foreground ltr-island">{row.code ? <Ltr>{row.code}</Ltr> : '—'}</td>
                    <td className="p-3 text-sm font-medium text-foreground">{row.name}</td>
                    <td className="p-3 text-sm text-muted-foreground">{typeLabel(row.type)}</td>
                    <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{String(row.debit)}</Ltr></td>
                    <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{String(row.credit)}</Ltr></td>
                    <td className="p-3 text-sm font-medium text-foreground ltr-island"><Ltr>{String(row.balance)}</Ltr></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(report?.accounts ?? []).length === 0 && <AccountingEmpty message={t('emptyTrialBalance')} />}
          </div>
        </>
      )}
    </div>
  );
}
