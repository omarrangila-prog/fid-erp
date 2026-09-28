import { cn } from '@/lib/utils';
import type { ShareRowKind, ShareSnapshot } from '@/lib/share/model';
import { SharedPdfButton } from '@/components/share/shared-pdf-button';

/**
 * One shared report, read-only, as the recipient sees it: the letterhead,
 * the figures and the tables exactly as they were shared, and nothing else —
 * no menu, no links into the ERP, no other data.
 */

const ROW_CLASS: Partial<Record<ShareRowKind, string>> = {
  opening: 'grid-total',
  subtotal: 'grid-total',
  total: 'grid-total',
  closing: 'grid-total grid-final',
  heading: 'grid-total',
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

function Lines({ text }: { text: string }) {
  const parts = text.split('\n');
  return (
    <>
      {parts.map((part, i) => (
        <span key={i} className={cn('block', i > 0 && 'text-[11px] text-ink-muted')}>
          {part}
        </span>
      ))}
    </>
  );
}

export function SharedReportView({ snapshot, expiresAt }: { snapshot: ShareSnapshot; expiresAt: string | null }) {
  return (
    <article className="mx-auto max-w-5xl space-y-5 px-4 py-6 sm:px-8" data-testid="shared-report">
      <header className="space-y-1 border-b border-grid pb-4">
        <p className="text-sm font-semibold text-ink-muted">{snapshot.company}</p>
        <h1 className="text-xl font-bold text-ink" data-testid="shared-title">
          {snapshot.title}
        </h1>
        {snapshot.subject ? (
          <p className="text-base font-semibold text-ink" data-testid="shared-subject">
            {snapshot.subject}
          </p>
        ) : null}
        {snapshot.period ? (
          <p className="text-sm text-ink-muted" data-testid="shared-period">
            {snapshot.period}
          </p>
        ) : null}
        {snapshot.filters.length ? (
          <p className="text-xs text-ink-muted" data-testid="shared-filters">
            Filters: {snapshot.filters.join(' · ')}
          </p>
        ) : null}
        <p className="text-xs text-ink-subtle">
          {snapshot.scope} · Generated {when(snapshot.generatedAt)}
          {snapshot.generatedBy ? ` by ${snapshot.generatedBy}` : ''}
        </p>
        <div className="flex flex-wrap gap-2 pt-2 print:hidden">
          <SharedPdfButton snapshot={snapshot} />
        </div>
      </header>

      {snapshot.facts.length ? (
        <dl className="grid gap-px overflow-hidden rounded-lg border border-grid bg-grid text-sm sm:grid-cols-2 lg:grid-cols-4" data-testid="shared-facts">
          {snapshot.facts.map((fact, i) => (
            <div key={`${fact.label}-${i}`} className="bg-surface px-3 py-2">
              <dt className="text-xs text-ink-muted">{fact.label}</dt>
              <dd className="tnum font-semibold text-ink">
                <Lines text={fact.value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {snapshot.sections.map((section, s) => (
        <section key={s} className="space-y-2">
          {section.heading ? <h2 className="text-sm font-bold uppercase tracking-wide text-ink">{section.heading}</h2> : null}
          <div className="relative overflow-x-auto rounded-lg border border-grid">
            <table className="data-grid w-full min-w-max text-sm" data-testid="shared-table">
              <thead>
                <tr>
                  {section.columns.map((column, i) => (
                    <th key={i} className={cn('px-3 py-2 text-left', column.numeric && 'text-right')}>
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, r) => {
                  let pos = 0;
                  return (
                    <tr key={r} className={ROW_CLASS[row.kind ?? 'row']} data-kind={row.kind ?? 'row'}>
                      {row.cells.map((cell, c) => {
                        const at = pos;
                        pos += cell.span ?? 1;
                        const numeric = (cell.span ?? 1) === 1 && section.columns[at]?.numeric;
                        return (
                          <td
                            key={c}
                            colSpan={cell.span}
                            className={cn('px-3 py-1.5 align-top', numeric && 'tnum whitespace-nowrap text-right', row.kind && row.kind !== 'row' && 'font-semibold')}
                          >
                            <Lines text={cell.text} />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <footer className="border-t border-grid pt-3 text-[11px] text-ink-subtle">
        Shared from FID Trading ERP · A read-only copy of the report as it was shared
        {expiresAt ? ` · This link expires ${when(expiresAt)}` : ''}
      </footer>
    </article>
  );
}
