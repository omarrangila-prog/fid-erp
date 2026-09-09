import { companyFlag } from '@/lib/format';

/**
 * The masthead that appears only on paper. On screen the company and period are
 * already in the page header and the topbar; on a printed statement that
 * context has to travel with the document.
 */
export function PrintHeader({
  title,
  companyName,
  country,
  period,
}: {
  title: string;
  companyName: string;
  country?: string | null;
  period?: string;
}) {
  return (
    <div data-print="only" className="mb-4 border-b border-line pb-3">
      <p className="text-base font-semibold text-ink">
        {companyFlag(country)} {companyName}
      </p>
      <p className="text-sm text-ink">{title}</p>
      {period ? <p className="text-xs text-ink-muted">{period}</p> : null}
      <p className="mt-1 text-[10px] text-ink-subtle">
        Generated {new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC
      </p>
    </div>
  );
}
