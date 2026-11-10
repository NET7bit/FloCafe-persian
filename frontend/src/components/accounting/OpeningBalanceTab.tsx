'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';
import { businessDateForInstant } from '@shared/business-date';
import {
  accountingErrorMessage,
  createOpeningBalance,
  fetchAccountingAccounts,
  fetchJournal,
  type AccountingAccount,
  type AccountingJournal,
  type FiscalPeriod,
} from '@/lib/accounting';
import { isDateInClosedPeriod } from '@/lib/fiscal-periods';
import { AccountingError, useAccountTypeLabel } from './shared';

interface LineDraft {
  accountId: string;
  amount: string;
  description: string;
}

function emptyLine(): LineDraft {
  return { accountId: '', amount: '', description: '' };
}

const TOLERANCE = 1e-6;

/**
 * Opening balance entry. Positive amounts open asset balances; negative
 * amounts carry the offsetting liability/equity balances. Account type,
 * distinct accounts, balance and the fiscal gate stay backend-owned; the
 * form's checks are affordances and the backend remains the final authority.
 */
export default function OpeningBalanceTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const tCommon = useTranslations('common');
  const typeLabel = useAccountTypeLabel();
  const { currentTenant } = useAuthStore();
  const canPost = hasRole(currentTenant?.role, ROLE_ACCESS.owner);

  const businessDate = businessDateForInstant({
    instant: new Date(),
    timezone: currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    startTime: currentTenant?.business_day_start_time,
  });

  const [accounts, setAccounts] = useState<AccountingAccount[]>([]);
  const [entryDate, setEntryDate] = useState(businessDate);
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [posted, setPosted] = useState<AccountingJournal | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAccountingAccounts(controller.signal).then(setAccounts).catch(() => {});
    return () => controller.abort();
  }, []);

  const closedPeriod = useMemo(
    () => isDateInClosedPeriod(periods, entryDate),
    [periods, entryDate],
  );

  const total = lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const difference = Number(total.toFixed(6));

  if (!canPost) {
    return <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">{t('ownerOnly')}</p>;
  }

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const resolvePayloadLines = () => {
    const payload: Array<{ account_id: string; amount: number; line_description?: string }> = [];
    for (const line of lines) {
      const amount = Number(line.amount) || 0;
      if (!line.accountId && amount === 0) continue;
      payload.push({
        account_id: line.accountId,
        amount,
        line_description: line.description || undefined,
      });
    }
    return payload;
  };

  const validate = (): string | null => {
    const payload = resolvePayloadLines();
    if (payload.length < 2) return t('openingBalanceMinLinesError');
    if (payload.some((line) => !line.account_id)) return t('accountRequiredError');
    if (payload.some((line) => !Number.isFinite(line.amount) || line.amount === 0)) return t('amountRequiredError');
    const ids = payload.map((line) => line.account_id);
    if (new Set(ids).size !== ids.length) return t('openingBalanceDuplicateAccountError');
    const hasDebit = payload.some((line) => line.amount > 0);
    const hasCredit = payload.some((line) => line.amount < 0);
    if (!hasDebit || !hasCredit) return t('openingBalanceBothSidesError');
    for (const line of payload) {
      const account = accounts.find((item) => item.id === line.account_id);
      if (!account) return t('accountRequiredError');
      if (line.amount > 0 && account.type !== 'asset') return t('openingBalanceAssetOnlyError');
      if (line.amount < 0 && account.type !== 'liability' && account.type !== 'equity') {
        return t('openingBalanceLiabilityEquityOnlyError');
      }
    }
    if (Math.abs(difference) > TOLERANCE) return t('unbalancedError');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return t('dateRequiredError');
    if (closedPeriod) return t('closedPeriodNotice');
    return null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setPosted(null);
    const invalid = validate();
    setValidationError(invalid);
    if (invalid || closedPeriod) return;
    setSubmitting(true);
    try {
      const journal = await createOpeningBalance({
        entry_date: entryDate,
        description: description || undefined,
        reference: reference || undefined,
        lines: resolvePayloadLines(),
      });
      toast.success(t('openingBalancePosted'));
      setLines([emptyLine(), emptyLine()]);
      setDescription('');
      setReference('');
      setValidationError(null);
      setPosted(journal);
      try {
        setPosted(await fetchJournal(journal.id));
      } catch (err: unknown) {
        setError(accountingErrorMessage(err, t('openingBalanceRetrieveFailed')));
      }
    } catch (err: unknown) {
      const message = accountingErrorMessage(err, t('openingBalancePostFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30';

  const accountLabel = (account?: AccountingAccount): string =>
    account ? `${account.code || ''} ${account.name}`.trim() : '';

  const statusLabel = (status: string): string =>
    status === 'reversed' ? t('statusReversed') : t('statusPosted');

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        {t('openingBalanceHint')}
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="ob-date" className="mb-1 block text-xs text-muted-foreground">{t('entryDate')}</label>
          <input
            id="ob-date"
            type="date"
            value={entryDate}
            onChange={(event) => setEntryDate(event.target.value)}
            className={inputClass}
            required
          />
        </div>
        <div>
          <label htmlFor="ob-description" className="mb-1 block text-xs text-muted-foreground">{t('description')}</label>
          <input
            id="ob-description"
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="ob-reference" className="mb-1 block text-xs text-muted-foreground">{t('reference')}</label>
          <input
            id="ob-reference"
            type="text"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {closedPeriod && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          {t('closedPeriodNotice')}
        </p>
      )}

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full">
          <thead className="bg-muted">
            <tr>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('account')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('openingBalanceAmount')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('lineDescription')}</th>
              <th className="w-10 p-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.map((line, index) => (
              <tr key={index}>
                <td className="p-2">
                  <select
                    aria-label={t('account')}
                    value={line.accountId}
                    onChange={(event) => updateLine(index, { accountId: event.target.value })}
                    className={inputClass}
                  >
                    <option value="">{t('accountPlaceholder')}</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {`${accountLabel(account)} · ${typeLabel(account.type)}`}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    aria-label={t('openingBalanceAmount')}
                    type="number"
                    step="any"
                    value={line.amount}
                    onChange={(event) => updateLine(index, { amount: event.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <input
                    aria-label={t('lineDescription')}
                    type="text"
                    value={line.description}
                    onChange={(event) => updateLine(index, { description: event.target.value })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2 text-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={tCommon('remove')}
                    disabled={lines.length <= 2}
                    onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                  >
                    <X size={14} />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setLines((current) => [...current, emptyLine()])}>
          <Plus size={14} /> {t('addLine')}
        </Button>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {t('difference')}: <span className="font-medium text-foreground">{difference}</span>
          </span>
        </div>
      </div>

      {validationError && <AccountingError message={validationError} />}
      {error && <AccountingError message={error} />}

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting || closedPeriod}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {t('openingBalanceSubmit')}
        </Button>
      </div>

      {posted && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h2 className="mb-2 text-sm font-semibold text-foreground">{t('openingBalanceSuccess')}</h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">{t('openingBalanceJournalId')}</dt>
              <dd className="font-medium text-foreground ltr-island">{posted.id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('openingBalanceJournalStatus')}</dt>
              <dd className="font-medium text-foreground">{statusLabel(posted.status)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('entryDate')}</dt>
              <dd className="font-medium text-foreground ltr-island">{posted.entry_date}</dd>
            </div>
          </dl>
          {posted.lines && posted.lines.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="p-2 text-start text-xs font-medium uppercase text-muted-foreground">{t('account')}</th>
                    <th className="p-2 text-start text-xs font-medium uppercase text-muted-foreground">{t('debit')} / {t('credit')}</th>
                    <th className="p-2 text-start text-xs font-medium uppercase text-muted-foreground">{t('openingBalanceAmount')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {posted.lines.map((line) => (
                    <tr key={line.id}>
                      <td className="p-2">{accountLabel(accounts.find((account) => account.id === line.account_id))}</td>
                      <td className="p-2">{line.direction === 'debit' ? t('debit') : t('credit')}</td>
                      <td className="p-2 ltr-island">{line.amount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
