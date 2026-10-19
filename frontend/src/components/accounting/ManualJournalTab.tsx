'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth';
import { ROLE_ACCESS, hasRole } from '@shared/role-permissions';
import { businessDateForInstant } from '@shared/business-date';
import {
  accountingErrorMessage,
  createManualJournal,
  fetchAccountingAccounts,
  type AccountingAccount,
  type FiscalPeriod,
  type JournalDirection,
} from '@/lib/accounting';
import { AccountingError } from './shared';

interface LineDraft {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
}

function emptyLine(): LineDraft {
  return { accountId: '', debit: '', credit: '', description: '' };
}

const TOLERANCE = 1e-6;

/** Per-form dedupe key; LAN clients on insecure origins lack crypto.randomUUID. */
function newIdempotencyKey(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Manual journal entry. All posting rules — balance, account validity, fiscal
 * gate — stay backend-owned; the form's own checks are only affordances and
 * the closed-period state disables submit instead of bypassing the gate.
 */
export default function ManualJournalTab({ periods }: { periods: FiscalPeriod[] }) {
  const t = useTranslations('accounting');
  const tCommon = useTranslations('common');
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
  const idempotencyKey = useRef<string>(newIdempotencyKey());

  useEffect(() => {
    const controller = new AbortController();
    fetchAccountingAccounts(controller.signal).then(setAccounts).catch(() => { });
    return () => controller.abort();
  }, []);

  const closedPeriod = useMemo(
    () => periods.find((period) => period.status === 'closed' && period.start_date <= entryDate && period.end_date >= entryDate) || null,
    [periods, entryDate],
  );

  const debitTotal = lines.reduce((sum, line) => sum + (Number(line.debit) || 0), 0);
  const creditTotal = lines.reduce((sum, line) => sum + (Number(line.credit) || 0), 0);
  const difference = Number((debitTotal - creditTotal).toFixed(6));

  if (!canPost) {
    return <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">{t('ownerOnly')}</p>;
  }

  const updateLine = (index: number, patch: Partial<LineDraft>) => {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const resolvePayloadLines = () => {
    const payload: Array<{ account_id: string; direction: JournalDirection; amount: number; line_description?: string }> = [];
    for (const line of lines) {
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      if (!line.accountId && debit === 0 && credit === 0) continue;
      payload.push({
        account_id: line.accountId,
        direction: debit > 0 ? 'debit' : 'credit',
        amount: debit > 0 ? debit : credit,
        line_description: line.description || undefined,
      });
    }
    return payload;
  };

  const validate = (): string | null => {
    const payload = resolvePayloadLines();
    if (payload.length < 2) return t('unbalancedError');
    if (payload.some((line) => !line.account_id)) return t('accountRequiredError');
    if (payload.some((line) => !Number.isFinite(line.amount) || line.amount <= 0)) return t('amountRequiredError');
    if (Math.abs(difference) > TOLERANCE) return t('unbalancedError');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return t('dateRequiredError');
    return null;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const invalid = validate();
    setValidationError(invalid);
    if (invalid || closedPeriod) return;
    setSubmitting(true);
    try {
      await createManualJournal({
        entry_date: entryDate,
        description,
        reference: reference || undefined,
        idempotency_key: idempotencyKey.current,
        lines: resolvePayloadLines(),
      });
      toast.success(t('journalPosted'));
      setLines([emptyLine(), emptyLine()]);
      setDescription('');
      setReference('');
      setValidationError(null);
      // Rotate the key so the next entry is a distinct event, not a duplicate.
      idempotencyKey.current = newIdempotencyKey();
    } catch (err: unknown) {
      const message = accountingErrorMessage(err, t('postFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30';

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor="mj-date" className="mb-1 block text-xs text-muted-foreground">{t('entryDate')}</label>
          <input
            id="mj-date"
            type="date"
            value={entryDate}
            onChange={(event) => setEntryDate(event.target.value)}
            className={inputClass}
            required
          />
        </div>
        <div>
          <label htmlFor="mj-description" className="mb-1 block text-xs text-muted-foreground">{t('description')}</label>
          <input
            id="mj-description"
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="mj-reference" className="mb-1 block text-xs text-muted-foreground">{t('reference')}</label>
          <input
            id="mj-reference"
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
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('debit')}</th>
              <th className="p-3 text-start text-xs font-medium uppercase text-muted-foreground">{t('credit')}</th>
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
                      <option key={account.id} value={account.id}>{`${account.code || ''} ${account.name}`.trim()}</option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <input
                    aria-label={t('debit')}
                    type="number"
                    step="any"
                    min="0"
                    value={line.debit}
                    onChange={(event) => updateLine(index, { debit: event.target.value, credit: '' })}
                    className={inputClass}
                  />
                </td>
                <td className="p-2">
                  <input
                    aria-label={t('credit')}
                    type="number"
                    step="any"
                    min="0"
                    value={line.credit}
                    onChange={(event) => updateLine(index, { credit: event.target.value, debit: '' })}
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
          <span className="text-muted-foreground">{t('debit')}: <span className="font-medium text-foreground">{debitTotal}</span></span>
          <span className="text-muted-foreground">{t('credit')}: <span className="font-medium text-foreground">{creditTotal}</span></span>
          <span className="text-muted-foreground">{t('difference')}: <span className="font-medium text-foreground">{difference}</span></span>
        </div>
      </div>

      {validationError && <AccountingError message={validationError} />}
      {error && <AccountingError message={error} />}

      <div className="flex justify-end">
        <Button type="submit" disabled={submitting || Boolean(closedPeriod)}>
          {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
          {t('submitJournal')}
        </Button>
      </div>
    </form>
  );
}
