'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import {
  accountingErrorMessage,
  fetchProfitAndLoss,
  type FiscalPeriod,
  type ProfitAndLossReport,
  type ReportSection,
} from '@/lib/accounting';
import {
  AccountingEmpty,
  AccountingError,
  AccountingLoading,
  AccountingRangeFilters,
  emptyRange,
  rangeParams,
  type AccountingRange,
} from './shared';

function SectionBlock({ title, section }: { title: string; section: ReportSection }) {
  const tCommon = useTranslations('common');
  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <span className="text-sm font-semibold text-foreground ltr-island"><Ltr>{String(section.total)}</Ltr></span>
      </div>
      {section.accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tCommon('notAvailable')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {section.accounts.map((account) => (
            <li key={account.account_id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="text-muted-foreground">
                {account.code ? `${account.code} · ` : ''}{account.name}
              </span>
              <span className="font-medium text-foreground ltr-island"><Ltr>{String(account.amount)}</Ltr></span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/**
 * Profit & Loss. Account classification (revenue vs expense, and the single
 * COGS account) is decided entirely by the backend; the UI only lays the
 * returned sections out.
 */
export default function ProfitLossTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const [draft, setDraft] = useState<AccountingRange>(emptyRange);
  const [applied, setApplied] = useState<AccountingRange>(emptyRange);
  const [report, setReport] = useState<ProfitAndLossReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchProfitAndLoss(rangeParams(applied), controller.signal)
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
      ) : !report ? (
        <AccountingEmpty message={t('emptyReport')} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <article className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t('grossProfit')}</p>
              <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{String(report.gross_profit)}</Ltr></p>
            </article>
            <article className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t('totalExpenses')}</p>
              <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{String(report.total_expenses)}</Ltr></p>
            </article>
            <article className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t('netProfit')}</p>
              <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{String(report.net_profit)}</Ltr></p>
            </article>
          </div>

          <SectionBlock title={t('revenue')} section={report.revenue} />
          <SectionBlock title={t('cogs')} section={report.cogs} />
          <SectionBlock title={t('operatingExpenses')} section={report.operating_expenses} />
        </div>
      )}
    </div>
  );
}
