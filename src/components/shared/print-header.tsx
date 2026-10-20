import { companyFlag } from '@/lib/format';

/**
 * The report's context: company, title, period, filters, reporting currency
 * and when it was generated (§22.1). On screen a single quiet line under the
 * page header, so a screenshot or a shared screen still says what it is; on
 * paper the full masthead, since a printed statement has nothing else to
 * carry it.
 */
export function PrintHeader({
  title,
  companyName,
  country,
  period,
  currency,
  filters,
}: {
  title: string;
  companyName: string;
  country?: string | null;
  period?: string;
  /** The currency the report's figures are stated in. */
  currency?: string;
  /** The filters in force, in words. */
  filters?: string[];
}) {
  const generated = `${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const context = [companyName.toUpperCase(), title, period, filters?.length ? filters.join(' · ') : null, currency ? `Reporting currency ${currency}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <p data-print="hide" className="-mt-2 text-[11px] text-ink-subtle" data-testid="report-context">
        {context} · Generated {generated}
      </p>
      <div data-print="only" className="mb-4 border-b border-line pb-3">
        <p className="text-base font-semibold text-ink">
          {companyFlag(country)} {companyName}
        </p>
        <p className="text-sm text-ink">{title}</p>
        {period ? <p className="text-xs text-ink-muted">{period}</p> : null}
        {filters?.length ? <p className="text-xs text-ink-muted">{filters.join(' · ')}</p> : null}
        {currency ? <p className="text-xs text-ink-muted">Reporting currency: {currency}</p> : null}
        <p className="mt-1 text-[10px] text-ink-subtle">Generated {generated}</p>
      </div>
    </>
  );
}
