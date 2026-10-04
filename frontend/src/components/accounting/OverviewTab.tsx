'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { BookOpen, FileBarChart, Scale, ShieldCheck, CalendarClock, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { businessDateInTimezone } from '@/lib/business-date';
import {
  accountingErrorMessage,
  fetchIntegrity,
  fetchProfitAndLoss,
  fetchReconciliation,
  fetchTrialBalance,
  fetchFiscalPeriods,
  type FiscalPeriod,
  type IntegrityReport,
  type ProfitAndLossReport,
  type ReconciliationReport,
  type TrialBalanceReport,
} from '@/lib/accounting';
import { AccountingError, AccountingLoading, StatusBadge } from './shared';

export interface OverviewData {
  trialBalance: TrialBalanceReport | null;
  reconciliation: ReconciliationReport | null;
  integrity: IntegrityReport | null;
  profitLoss: ProfitAndLossReport | null;
  periods: FiscalPeriod[];
}

interface OverviewTabProps {
  onNavigate: (tab: string) => void;
}

/**
 * Accounting entry point. Shows live status of the read-only checks plus a
 * profit summary, using only existing report endpoints — no new accounting
 * logic and no derived financial state.
 */
export default function OverviewTab({ onNavigate }: OverviewTabProps) {
  const t = useTranslations('accounting');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => {
    setLoading(true);
    setError(null);
    setReloadKey((key) => key + 1);
  };

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetchTrialBalance({}, controller.signal),
      fetchReconciliation({}, controller.signal),
      fetchIntegrity(controller.signal),
      fetchProfitAndLoss({}, controller.signal),
      fetchFiscalPeriods(controller.signal),
    ])
      .then(([trialBalance, reconciliation, integrity, profitLoss, periods]) => {
        setData({ trialBalance, reconciliation, integrity, profitLoss, periods });
      })
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  const businessDate = businessDateInTimezone(
    currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    currentTenant?.business_day_start_time,
  );

  const currentPeriod = data?.periods.find(
    (period) => period.start_date <= businessDate && period.end_date >= businessDate,
  ) || null;

  if (loading) return <AccountingLoading />;
  if (error) return <AccountingError message={error} />;

  const trial = data?.trialBalance;
  const recon = data?.reconciliation;
  const integrity = data?.integrity;
  const pnl = data?.profitLoss;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => onNavigate('accounts')}><BookOpen size={16} /> {t('tabAccounts')}</Button>
        <Button variant="outline" onClick={() => onNavigate('ledger')}><Scale size={16} /> {t('tabLedger')}</Button>
        <Button variant="outline" onClick={() => onNavigate('profit-loss')}><TrendingUp size={16} /> {t('tabProfitLoss')}</Button>
        <Button variant="outline" onClick={() => onNavigate('reconciliation')}><FileBarChart size={16} /> {t('tabReconciliation')}</Button>
        <Button variant="outline" onClick={reload}>{tCommon('update')}</Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <Scale size={14} /> {t('tabTrialBalance')}
            </h3>
            {trial && (
              <StatusBadge tone={trial.totals.balanced ? 'ok' : 'bad'}>
                {trial.totals.balanced ? t('balanced') : t('unbalanced')}
              </StatusBadge>
            )}
          </div>
          {trial && (
            <p className="text-sm text-muted-foreground">
              {t('difference')}: <span className="font-medium text-foreground">{trial.totals.difference}</span>
            </p>
          )}
        </article>

        <article className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <FileBarChart size={14} /> {t('tabReconciliation')}
            </h3>
            {recon && (
              <StatusBadge tone={recon.all_reconciled ? 'ok' : 'bad'}>
                {recon.all_reconciled ? t('allReconciled') : t('differencesFound')}
              </StatusBadge>
            )}
          </div>
          {recon && (
            <p className="text-sm text-muted-foreground">
              {t('domainsChecked')}: <span className="font-medium text-foreground">{recon.results.length}</span>
            </p>
          )}
        </article>

        <article className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <ShieldCheck size={14} /> {t('tabIntegrity')}
            </h3>
            {integrity && (
              <StatusBadge tone={integrity.ok ? 'ok' : 'bad'}>
                {integrity.ok ? t('integrityOk') : t('integrityIssues')}
              </StatusBadge>
            )}
          </div>
          {integrity && (
            <p className="text-sm text-muted-foreground">
              {t('trialBalanceCheck')}: {integrity.trial_balance.balanced ? t('balanced') : t('unbalanced')}
            </p>
          )}
        </article>

        <article className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <CalendarClock size={14} /> {t('tabFiscalPeriods')}
            </h3>
            {currentPeriod ? (
              <StatusBadge tone={currentPeriod.status === 'open' ? 'ok' : 'bad'}>
                {currentPeriod.status === 'open' ? t('statusOpen') : t('statusClosed')}
              </StatusBadge>
            ) : (
              <StatusBadge tone="neutral">{tCommon('notAvailable')}</StatusBadge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('businessDate')}: <span className="font-medium text-foreground">{businessDate}</span>
          </p>
        </article>
      </div>

      <article className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">{t('profitSummary')}</h3>
          <Button variant="ghost" size="sm" onClick={() => onNavigate('profit-loss')}>{t('tabProfitLoss')}</Button>
        </div>
        {pnl ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">{t('revenue')}</dt>
              <dd className="text-lg font-semibold text-foreground">{pnl.revenue.total}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('totalExpenses')}</dt>
              <dd className="text-lg font-semibold text-foreground">{pnl.total_expenses}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('netProfit')}</dt>
              <dd className="text-lg font-semibold text-foreground">{pnl.net_profit}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{tCommon('notAvailable')}</p>
        )}
      </article>
    </div>
  );
}
