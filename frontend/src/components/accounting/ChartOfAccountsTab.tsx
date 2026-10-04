'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  accountingErrorMessage,
  fetchAccountingAccounts,
  type AccountingAccount,
} from '@/lib/accounting';
import {
  AccountingEmpty,
  AccountingError,
  AccountingLoading,
  useAccountTypeLabel,
  useNormalSideLabel,
} from './shared';

/**
 * Chart of Accounts, rendered straight from `accounting_accounts`. The table
 * has no parent/child column because the schema has no hierarchy — the CoA is
 * a flat, seeded list and the UI invents no structure of its own.
 */
export default function ChartOfAccountsTab() {
  const t = useTranslations('accounting');
  const tCommon = useTranslations('common');
  const typeLabel = useAccountTypeLabel();
  const sideLabel = useNormalSideLabel();
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAccountingAccounts(controller.signal)
      .then(setAccounts)
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <AccountingLoading />;
  if (error) return <AccountingError message={error} />;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <table className="w-full">
        <thead className="bg-muted">
          <tr>
            <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('code')}</th>
            <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('accountName')}</th>
            <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('accountType')}</th>
            <th className="p-4 text-start text-xs font-medium uppercase text-muted-foreground">{t('normalSide')}</th>
            <th className="p-4 text-center text-xs font-medium uppercase text-muted-foreground">{tCommon('active')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {accounts.map((account) => (
            <tr key={account.id} className="hover:bg-muted">
              <td className="p-4 text-sm text-muted-foreground ltr-island">{account.code || '—'}</td>
              <td className="p-4 text-sm font-medium text-foreground">{account.name}</td>
              <td className="p-4 text-sm text-muted-foreground">{typeLabel(account.type)}</td>
              <td className="p-4 text-sm text-muted-foreground">{sideLabel(account.normal_side)}</td>
              <td className="p-4 text-center text-sm text-muted-foreground">
                {account.is_active === 1 ? tCommon('active') : tCommon('inactive')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {accounts.length === 0 && <AccountingEmpty message={t('emptyAccounts')} />}
    </div>
  );
}
