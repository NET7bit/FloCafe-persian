'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { Badge } from '@/components/ui/badge';
import {
  accountingErrorMessage,
  fetchReconciliation,
  type FiscalPeriod,
  type ReconciliationReport,
  type ReconciliationStatus,
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

/** Renders the backend's own domain identifier without inventing a translation. */
function humanizeDomain(domain: string): string {
  return domain.replace(/_/g, ' ');
}

/**
 * Reconciliation, read-only. The backend reuses the same source/ledger pairing
 * rule used elsewhere; the UI surfaces MATCH / MISMATCH / NOT_RECONCILABLE and
 * the backend's stated reason. It never repairs, posts or backfills anything.
 */
export default function ReconciliationTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const [draft, setDraft] = useState<AccountingRange>(emptyRange);
  const [applied, setApplied] = useState<AccountingRange>(emptyRange);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchReconciliation(rangeParams(applied), controller.signal)
      .then(setReport)
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  const statusLabel = (status: ReconciliationStatus): string => {
    if (status === 'MATCH') return t('statusMatch');
    if (status === 'MISMATCH') return t('statusMismatch');
    return t('statusNotReconcilable');
  };

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
      ) : !report || report.results.length === 0 ? (
        <AccountingEmpty message={t('emptyReport')} />
      ) : (
        <>
          <div className="mb-3">
            <StatusBadge tone={report.all_reconciled ? 'ok' : 'bad'}>
              {report.all_reconciled ? t('allReconciled') : t('differencesFound')}
            </StatusBadge>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('domain')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('sourceTotal')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('journalTotal')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('difference')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('statusLabel')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('details')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.results.map((row) => {
                  const label = humanizeDomain(row.domain);
                  const reason = typeof row.details?.reason === 'string' ? row.details.reason : null;
                  return (
                    <tr key={row.domain} className="hover:bg-muted">
                      <td className="p-3 text-sm font-medium text-foreground">{label}</td>
                      <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{String(row.source_total)}</Ltr></td>
                      <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{String(row.journal_total)}</Ltr></td>
                      <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{String(row.difference)}</Ltr></td>
                      <td className="p-3">
                        <Badge variant={row.status === 'MISMATCH' ? 'destructive' : 'outline'}>
                          {statusLabel(row.status)}
                        </Badge>
                      </td>
                      <td className="p-3 text-xs text-muted-foreground">
                        {reason ? reason : <span className="ltr-island"><Ltr>{Object.entries(row.details).map(([key, value]) => `${key}=${String(value)}`).join(', ')}</Ltr></span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
