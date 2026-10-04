'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';
import {
  ACCOUNTING_SOURCE_MODULES,
  accountingErrorMessage,
  fetchAccountingAccounts,
  fetchGeneralLedger,
  type AccountingAccount,
  type FiscalPeriod,
  type GeneralLedgerReport,
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

interface GlFilters {
  range: AccountingRange;
  accountId: string;
  sourceModule: string;
  sourceId: string;
  reference: string;
}

function emptyFilters(): GlFilters {
  return { range: emptyRange(), accountId: '', sourceModule: '', sourceId: '', reference: '' };
}

/**
 * General Ledger. Filters map exactly onto the backend's supported query
 * params; the running balance shown is the backend's `latest_balance`, never a
 * frontend recomputation.
 */
export default function GeneralLedgerTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [draft, setDraft] = useState<GlFilters>(emptyFilters);
  const [applied, setApplied] = useState<GlFilters>(emptyFilters);
  const [report, setReport] = useState<GeneralLedgerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAccountingAccounts(controller.signal).then(setAccounts).catch(() => { });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchGeneralLedger(
      {
        ...rangeParams(applied.range),
        account_id: applied.accountId || undefined,
        source_module: applied.sourceModule || undefined,
        source_id: applied.sourceId || undefined,
        reference: applied.reference || undefined,
      },
      controller.signal,
    )
      .then(setReport)
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError')) return;
        setError(accountingErrorMessage(err, t('loadFailed')));
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applied]);

  const clearFilters = () => {
    setLoading(true);
    setError(null);
    setDraft(emptyFilters());
    setApplied(emptyFilters());
  };

  const inputClass =
    'w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30';

  return (
    <div>
      <AccountingRangeFilters
        value={draft.range}
        periods={periods}
        onChange={(range) => setDraft({ ...draft, range })}
        onApply={() => { setLoading(true); setError(null); setApplied({ ...draft }); }}
        onClear={clearFilters}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="gl-account" className="mb-1 block text-xs text-muted-foreground">{t('account')}</label>
          <select
            id="gl-account"
            value={draft.accountId}
            onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}
            className={inputClass}
          >
            <option value="">{t('allAccounts')}</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>{`${account.code || ''} ${account.name}`.trim()}</option>
            ))}
          </select>
        </div>
        <div className="min-w-40 flex-1">
          <label htmlFor="gl-source" className="mb-1 block text-xs text-muted-foreground">{t('sourceModule')}</label>
          <select
            id="gl-source"
            value={draft.sourceModule}
            onChange={(event) => setDraft({ ...draft, sourceModule: event.target.value })}
            className={inputClass}
          >
            <option value="">{t('allSources')}</option>
            {ACCOUNTING_SOURCE_MODULES.map((module) => (
              <option key={module} value={module}>{module}</option>
            ))}
          </select>
        </div>
        <div className="min-w-40 flex-1">
          <label htmlFor="gl-source-id" className="mb-1 block text-xs text-muted-foreground">{t('sourceId')}</label>
          <input
            id="gl-source-id"
            type="text"
            value={draft.sourceId}
            onChange={(event) => setDraft({ ...draft, sourceId: event.target.value })}
            className={inputClass}
          />
        </div>
        <div className="min-w-40 flex-1">
          <label htmlFor="gl-reference" className="mb-1 block text-xs text-muted-foreground">{t('reference')}</label>
          <input
            id="gl-reference"
            type="text"
            value={draft.reference}
            onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
            className={inputClass}
          />
        </div>
        <Button type="button" variant="outline" onClick={clearFilters}>{t('clear')}</Button>
      </div>

      {loading ? (
        <AccountingLoading />
      ) : error ? (
        <AccountingError message={error} />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <StatusBadge tone="neutral">
              {t('debit')}: {report?.totals.debit ?? 0}
            </StatusBadge>
            <StatusBadge tone="neutral">
              {t('credit')}: {report?.totals.credit ?? 0}
            </StatusBadge>
            <StatusBadge tone={Math.abs(report?.totals.difference ?? 0) < 1e-6 ? 'ok' : 'bad'}>
              {t('difference')}: {report?.totals.difference ?? 0}
            </StatusBadge>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('date')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('journal')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('account')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('description')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('debit')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('credit')}</th>
                  <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('balance')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(report?.lines ?? []).map((line, index) => (
                  <tr key={`${line.journal_id}-${line.account_id}-${index}`} className="hover:bg-muted">
                    <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{line.entry_date}</Ltr></td>
                    <td className="p-3 text-sm text-muted-foreground ltr-island"><Ltr>{line.journal_id}</Ltr></td>
                    <td className="p-3 text-sm text-foreground">{line.account_code ? `${line.account_code} · ` : ''}{line.account_name}</td>
                    <td className="p-3 text-sm text-muted-foreground">{line.description || '—'}</td>
                    <td className="p-3 text-sm text-muted-foreground ltr-island">{line.debit ? <Ltr>{String(line.debit)}</Ltr> : '—'}</td>
                    <td className="p-3 text-sm text-muted-foreground ltr-island">{line.credit ? <Ltr>{String(line.credit)}</Ltr> : '—'}</td>
                    <td className="p-3 text-sm font-medium text-foreground ltr-island"><Ltr>{String(line.latest_balance)}</Ltr></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(report?.lines ?? []).length === 0 && <AccountingEmpty message={t('emptyLedger')} />}
          </div>
        </>
      )}
    </div>
  );
}
