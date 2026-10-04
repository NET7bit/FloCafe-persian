'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import {
  accountingErrorMessage,
  fetchBalanceSheet,
  type BalanceSheetReport,
  type FiscalPeriod,
  type ReportSection,
} from '@/lib/accounting';
import {
  AccountingEmpty,
  AccountingError,
  AccountingLoading,
  AccountingRangeFilters,
  StatusBadge,
  emptyRange,
  rangeParams,
  type AccountingRange,
} from './shared';

function SectionBlock({ title, total, section }: { title: string; total: number; section: ReportSection }) {
  const tCommon = useTranslations('common');
  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <span className="text-sm font-semibold text-foreground ltr-island"><Ltr>{String(total)}</Ltr></span>
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
 * Balance Sheet as of the range end. Equity includes the backend's unclosed
 * current result; the equation verdict is backend-owned.
 */
export default function BalanceSheetTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const [draft, setDraft] = useState<AccountingRange>(emptyRange);
  const [applied, setApplied] = useState<AccountingRange>(emptyRange);
  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchBalanceSheet(rangeParams(applied), controller.signal)
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
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span>{t('asOf')}: <span className="font-medium text-foreground ltr-island"><Ltr>{report.as_of}</Ltr></span></span>
            <StatusBadge tone={report.equation.balanced ? 'ok' : 'bad'}>
              {report.equation.balanced ? t('balanced') : t('unbalanced')}
            </StatusBadge>
            <span>{t('difference')}: <span className="font-medium text-foreground ltr-island"><Ltr>{String(report.equation.difference)}</Ltr></span></span>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <SectionBlock title={t('assets')} total={report.assets.total} section={report.assets} />
            <SectionBlock title={t('liabilities')} total={report.liabilities.total} section={report.liabilities} />
            <SectionBlock title={t('equity')} total={report.equity.total} section={report.equity} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <article className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t('totalAssets')}</p>
              <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{String(report.equation.assets)}</Ltr></p>
            </article>
            <article className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t('currentResult')}</p>
              <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{String(report.current_result)}</Ltr></p>
            </article>
            <article className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{t('liabilitiesAndEquity')}</p>
              <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{String(report.equation.liabilities_and_equity)}</Ltr></p>
            </article>
          </div>
        </div>
      )}
    </div>
  );
}
