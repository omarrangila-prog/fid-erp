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
      <div data-print="only" className="print-letterhead">
        <div className="lh-row">
          <div>
            <p className="lh-company">
              {companyFlag(country)} {companyName}
            </p>
            <p className="lh-title">{title}</p>
          </div>
          <div className="lh-side">
            {period ? <p>{period}</p> : null}
            {currency ? <p>Reporting currency: {currency}</p> : null}
            <p>Generated {generated}</p>
          </div>
        </div>
        {filters?.length ? <p className="lh-filters">{filters.join(' · ')}</p> : null}
      </div>
    </>
  );
}
