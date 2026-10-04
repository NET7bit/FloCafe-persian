'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/store/auth';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';
import { accountingErrorMessage, fetchFiscalPeriods, type FiscalPeriod } from '@/lib/accounting';
import OverviewTab from '@/components/accounting/OverviewTab';
import ChartOfAccountsTab from '@/components/accounting/ChartOfAccountsTab';
import GeneralLedgerTab from '@/components/accounting/GeneralLedgerTab';
import TrialBalanceTab from '@/components/accounting/TrialBalanceTab';
import ProfitLossTab from '@/components/accounting/ProfitLossTab';
import BalanceSheetTab from '@/components/accounting/BalanceSheetTab';
import ReconciliationTab from '@/components/accounting/ReconciliationTab';
import IntegrityTab from '@/components/accounting/IntegrityTab';
import ManualJournalTab from '@/components/accounting/ManualJournalTab';
import FiscalPeriodsTab from '@/components/accounting/FiscalPeriodsTab';
import { AccountingError } from '@/components/accounting/shared';

const TABS = [
  { value: 'overview', labelKey: 'tabOverview' },
  { value: 'accounts', labelKey: 'tabAccounts' },
  { value: 'ledger', labelKey: 'tabLedger' },
  { value: 'trial-balance', labelKey: 'tabTrialBalance' },
  { value: 'profit-loss', labelKey: 'tabProfitLoss' },
  { value: 'balance-sheet', labelKey: 'tabBalanceSheet' },
  { value: 'reconciliation', labelKey: 'tabReconciliation' },
  { value: 'integrity', labelKey: 'tabIntegrity' },
  { value: 'manual-journal', labelKey: 'tabManualJournal' },
  { value: 'fiscal-periods', labelKey: 'tabFiscalPeriods' },
] as const;

type TabValue = (typeof TABS)[number]['value'];

/**
 * Accounting surface. A single entry point (matching the app's tab-based
 * settings/inventory pattern) that renders the existing Milestone H reports,
 * the Chart of Accounts and the fiscal-period view. It introduces no new
 * financial state and calls only pre-existing endpoints.
 */
export default function AccountingPage() {
  const t = useTranslations('accounting');
  const tNav = useTranslations('nav');
  const { currentTenant } = useAuthStore();
  const canView = hasRole(currentTenant?.role, ROLE_ACCESS.ownerManager);

  const [tab, setTab] = useState<TabValue>('overview');
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [periodsError, setPeriodsError] = useState<string | null>(null);
  const [periodsKey, setPeriodsKey] = useState(0);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    fetchFiscalPeriods(controller.signal)
      .then(setPeriods)
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setPeriodsError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setPeriodsLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, periodsKey]);

  const reloadPeriods = useCallback(() => {
    setPeriodsLoading(true);
    setPeriodsError(null);
    setPeriodsKey((key) => key + 1);
  }, []);

  if (!canView) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h1 className="mb-2 text-xl font-bold text-foreground">{tNav('accounting')}</h1>
        <p className="text-muted-foreground">{t('noAccess')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">{tNav('accounting')}</h1>
      </div>

      {periodsError && <div className="mb-4"><AccountingError message={periodsError} /></div>}

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabValue)}>
        <TabsList className="mb-4 flex-wrap">
          {TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>{t(item.labelKey)}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab onNavigate={(next) => setTab(next as TabValue)} />
        </TabsContent>
        <TabsContent value="accounts">
          <ChartOfAccountsTab />
        </TabsContent>
        <TabsContent value="ledger">
          <GeneralLedgerTab periods={periods} />
        </TabsContent>
        <TabsContent value="trial-balance">
          <TrialBalanceTab periods={periods} />
        </TabsContent>
        <TabsContent value="profit-loss">
          <ProfitLossTab periods={periods} />
        </TabsContent>
        <TabsContent value="balance-sheet">
          <BalanceSheetTab periods={periods} />
        </TabsContent>
        <TabsContent value="reconciliation">
          <ReconciliationTab periods={periods} />
        </TabsContent>
        <TabsContent value="integrity">
          <IntegrityTab />
        </TabsContent>
        <TabsContent value="manual-journal">
          <ManualJournalTab periods={periods} />
        </TabsContent>
        <TabsContent value="fiscal-periods">
          <FiscalPeriodsTab
            periods={periods}
            loading={periodsLoading}
            error={periodsError}
            onRefresh={reloadPeriods}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
