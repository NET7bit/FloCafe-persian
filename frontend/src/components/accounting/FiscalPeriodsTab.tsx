'use client';

import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import { useAuthStore } from '@/store/auth';
import { businessDateForInstant } from '@shared/business-date';
import { isDateInClosedPeriod } from '@/lib/fiscal-periods';
import type { FiscalPeriod } from '@/lib/accounting';
import { AccountingEmpty, AccountingError, AccountingLoading, StatusBadge } from './shared';

interface FiscalPeriodsTabProps {
  periods: FiscalPeriod[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/**
 * Fiscal-period view for accounting. Strictly informational: it reports the
 * period covering the current business date and whether posting is allowed.
 * Close/reopen stay in the existing fiscal-period settings surface — this view
 * adds no lifecycle action and never unlocks a closed period.
 */
export default function FiscalPeriodsTab({ periods, loading, error, onRefresh }: FiscalPeriodsTabProps) {
  const t = useTranslations('accounting');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();

  const businessDate = businessDateForInstant({
    instant: new Date(),
    timezone: currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    startTime: currentTenant?.business_day_start_time,
  });

  const currentPeriod = periods.find(
    (period) => period.start_date <= businessDate && period.end_date >= businessDate,
  ) || null;
  const postable = !isDateInClosedPeriod(periods, businessDate);

  if (loading) return <AccountingLoading />;
  if (error) return <AccountingError message={error} />;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-border bg-card p-4">
          <p className="mb-1 text-xs text-muted-foreground">{t('businessDate')}</p>
          <p className="text-lg font-semibold text-foreground ltr-island"><Ltr>{businessDate}</Ltr></p>
        </article>
        <article className="rounded-xl border border-border bg-card p-4">
          <p className="mb-1 text-xs text-muted-foreground">{t('currentPeriod')}</p>
          {currentPeriod ? (
            <>
              <p className="text-sm font-medium text-foreground">
                {currentPeriod.name || t(currentPeriod.period_type === 'year' ? 'periodYear' : 'periodMonth')}
              </p>
              <p className="text-xs text-muted-foreground ltr-island">
                <Ltr>{`${currentPeriod.start_date} → ${currentPeriod.end_date}`}</Ltr>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{tCommon('notAvailable')}</p>
          )}
        </article>
        <article className="rounded-xl border border-border bg-card p-4">
          <p className="mb-1 text-xs text-muted-foreground">{t('postable')}</p>
          <StatusBadge tone={postable ? 'ok' : 'bad'}>
            {postable ? t('postableYes') : t('postableNo')}
          </StatusBadge>
        </article>
      </div>

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onRefresh}>{tCommon('update')}</Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('periodName')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('periodType')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('startDate')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('endDate')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('statusLabel')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {periods.map((period) => (
              <tr key={period.id} className="hover:bg-muted">
                <td className="p-3 text-sm font-medium text-foreground">{period.name || '—'}</td>
                <td className="p-3 text-sm text-muted-foreground">
                  {t(period.period_type === 'year' ? 'periodYear' : 'periodMonth')}
                </td>
                <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{period.start_date}</Ltr></td>
                <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{period.end_date}</Ltr></td>
                <td className="p-3">
                  <StatusBadge tone={period.status === 'open' ? 'ok' : 'neutral'}>
                    {period.status === 'open' ? t('statusOpen') : t('statusClosed')}
                  </StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {periods.length === 0 && <AccountingEmpty message={t('emptyPeriods')} />}
      </div>
    </div>
  );
}
