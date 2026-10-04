'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import { accountingErrorMessage, fetchIntegrity, type IntegrityReport } from '@/lib/accounting';
import { AccountingError, AccountingLoading, StatusBadge } from './shared';

function CheckRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground">{children}</span>
    </li>
  );
}

/**
 * Integrity diagnostics. Strictly read-only: it renders the ledger's own
 * structural invariants and never repairs, backfills or mutates anything.
 */
export default function IntegrityTab() {
  const t = useTranslations('accounting');
  const tCommon = useTranslations('common');
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchIntegrity(controller.signal)
      .then(setReport)
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (loading) return <AccountingLoading />;
  if (error) return <AccountingError message={error} />;
  if (!report) return null;

  const countOrNone = (count: number) => (count === 0 ? tCommon('notAvailable') : String(count));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={report.ok ? 'ok' : 'bad'}>
          {report.ok ? t('integrityOk') : t('integrityIssues')}
        </StatusBadge>
        <Button variant="outline" size="sm" onClick={refresh}>{tCommon('update')}</Button>
      </div>

      <article className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-medium text-foreground">{t('journalBalanceCheck')}</h3>
        {report.journal_balance.unbalanced.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tCommon('notAvailable')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {report.journal_balance.unbalanced.map((row) => (
              <li key={row.journal_id} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span className="ltr-island"><Ltr>{row.journal_id}</Ltr></span>
                <span className="text-muted-foreground ltr-island">
                  <Ltr>{`${t('debit')}=${row.debit} ${t('credit')}=${row.credit} ${t('difference')}=${row.difference}`}</Ltr>
                </span>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="rounded-xl border border-border bg-card p-4">
        <h3 className="mb-2 text-sm font-medium text-foreground">{t('trialBalanceCheck')}</h3>
        <ul>
          <CheckRow label={t('totalDebit')}><span className="ltr-island"><Ltr>{String(report.trial_balance.debit)}</Ltr></span></CheckRow>
          <CheckRow label={t('totalCredit')}><span className="ltr-island"><Ltr>{String(report.trial_balance.credit)}</Ltr></span></CheckRow>
          <CheckRow label={t('difference')}><span className="ltr-island"><Ltr>{String(report.trial_balance.difference)}</Ltr></span></CheckRow>
          <CheckRow label={t('statusLabel')}>{report.trial_balance.balanced ? t('balanced') : t('unbalanced')}</CheckRow>
        </ul>
      </article>

      <div className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-1 text-sm font-medium text-foreground">{t('orphanJournals')}</h3>
          <p className="text-lg font-semibold text-foreground">{countOrNone(report.orphan_journals.length)}</p>
        </article>
        <article className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-1 text-sm font-medium text-foreground">{t('orphanLines')}</h3>
          <p className="text-lg font-semibold text-foreground">{countOrNone(report.orphan_lines.length)}</p>
        </article>
        <article className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-1 text-sm font-medium text-foreground">{t('duplicateIdentities')}</h3>
          <p className="text-lg font-semibold text-foreground">{countOrNone(report.duplicate_identities.length)}</p>
        </article>
      </div>
    </div>
  );
}
