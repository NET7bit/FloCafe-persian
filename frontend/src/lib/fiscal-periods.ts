/**
 * Projection of the backend fiscal gate (`main/services/fiscal-periods.ts`).
 * Posting is blocked only while a `closed` period covers the business date; a
 * date with no covering period stays postable.
 */
export interface FiscalPeriodWindow {
  status: 'open' | 'closed';
  start_date: string;
  end_date: string;
}

export function isDateInClosedPeriod(periods: FiscalPeriodWindow[], businessDate: string): boolean {
  return periods.some(
    (period) => period.status === 'closed' && period.start_date <= businessDate && period.end_date >= businessDate,
  );
}
