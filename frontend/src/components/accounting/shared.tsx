'use client';

import { Loader2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { Badge } from '@/components/ui/badge';
import type { FiscalPeriod } from '@/lib/accounting';

/** Shared read-state primitives for every accounting report surface. */

export function AccountingLoading() {
  const tCommon = useTranslations('common');
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
      <Loader2 size={16} className="animate-spin" />
      <span className="text-sm">{tCommon('loading')}</span>
    </div>
  );
}

export function AccountingError({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
      {message}
    </p>
  );
}

export function AccountingEmpty({ message }: { message: string }) {
  return <p className="py-12 text-center text-sm text-muted-foreground">{message}</p>;
}

type StatusTone = 'ok' | 'warn' | 'bad' | 'neutral';

export function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const variant = tone === 'bad' ? 'destructive' : tone === 'ok' ? 'default' : 'outline';
  return <Badge variant={variant}>{children}</Badge>;
}

export interface AccountingRange {
  from: string;
  to: string;
  periodId: string;
}

export function emptyRange(): AccountingRange {
  return { from: '', to: '', periodId: '' };
}

/** Range params sent to report endpoints; a selected period takes precedence. */
export function rangeParams(value: AccountingRange): { from?: string; to?: string; period_id?: string } {
  if (value.periodId) return { period_id: value.periodId };
  return { from: value.from || undefined, to: value.to || undefined };
}

interface RangeFiltersProps {
  value: AccountingRange;
  periods: FiscalPeriod[];
  onChange: (next: AccountingRange) => void;
  onApply: () => void;
  onClear: () => void;
}

/** from/to + fiscal period filter row shared by every ranged report. */
export function AccountingRangeFilters({ value, periods, onChange, onApply, onClear }: RangeFiltersProps) {
  const t = useTranslations('accounting');
  const inputClass =
    'w-full px-3 py-2 text-sm border border-border rounded-lg bg-background text-foreground outline-none focus:ring-2 focus:ring-brand/30';

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="accounting-from" className="mb-1 block text-xs text-muted-foreground">{t('fromDate')}</label>
        <input
          id="accounting-from"
          type="date"
          value={value.from}
          disabled={Boolean(value.periodId)}
          onChange={(event) => onChange({ ...value, from: event.target.value })}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="accounting-to" className="mb-1 block text-xs text-muted-foreground">{t('toDate')}</label>
        <input
          id="accounting-to"
          type="date"
          value={value.to}
          disabled={Boolean(value.periodId)}
          onChange={(event) => onChange({ ...value, to: event.target.value })}
          className={inputClass}
        />
      </div>
      <div className="min-w-44">
        <label htmlFor="accounting-period" className="mb-1 block text-xs text-muted-foreground">{t('fiscalPeriod')}</label>
        <select
          id="accounting-period"
          value={value.periodId}
          onChange={(event) => onChange({ ...value, periodId: event.target.value })}
          className={inputClass}
        >
          <option value="">{t('allPeriods')}</option>
          {periods.map((period) => (
            <option key={period.id} value={period.id}>
              {`${period.name || period.period_type} · ${period.start_date} → ${period.end_date}`}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        onClick={onApply}
        className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        {t('apply')}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="h-9 rounded-md border border-border px-4 text-sm font-medium text-foreground hover:bg-muted"
      >
        {t('clear')}
      </button>
    </div>
  );
}

/** Human label for an account type; classification stays backend-owned. */
export function useAccountTypeLabel() {
  const t = useTranslations('accounting');
  return (type: string): string => {
    switch (type) {
      case 'asset': return t('typeAsset');
      case 'liability': return t('typeLiability');
      case 'equity': return t('typeEquity');
      case 'revenue': return t('typeRevenue');
      case 'expense': return t('typeExpense');
      default: return type;
    }
  };
}

/** Human label for a debit/credit normal side. */
export function useNormalSideLabel() {
  const t = useTranslations('accounting');
  return (side: string): string => (side === 'debit' ? t('debit') : t('credit'));
}
