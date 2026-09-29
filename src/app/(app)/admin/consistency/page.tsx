import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { formatMoney, formatQuantityKg } from '@/lib/format';
import type { Decimal } from '@/lib/money';

/** A money figure in its currency, or a plain count for a check that counts things. */
const figure = (value: Decimal, unit: string) =>
  unit === 'entries' ? value.toFixed(0) : unit === 'KG' ? formatQuantityKg(value) : formatMoney(value, unit);
import { runConsistencyChecks, type ConsistencyCheck } from '@/lib/services/consistency';
import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Callout } from '@/components/ui/feedback';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';

export const metadata: Metadata = { title: 'Consistency checks' };
export const dynamic = 'force-dynamic';

/**
 * Does every screen tell the same story? Each figure the dashboard shows,
 * beside the ledger it summarises — worked out afresh on every visit.
 */
export default async function ConsistencyPage() {
  const user = await requirePageAccess(PERMISSIONS.AUDIT_VIEW);
  const { checks, failures } = await runConsistencyChecks(user.activeCompany.id);
  const areas = [...new Set(checks.map((c) => c.area))];
  const notes = checks.filter((c) => !c.ok && c.severity === 'info').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Consistency checks"
        description={`${user.activeCompany.name}: every dashboard figure against the ledger it comes from. Read-only — nothing is changed by opening this page.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Consistency checks' }]}
      />
      <div data-testid="consistency-summary">
        {failures === 0 ? (
          <Callout tone="info" title={`All ${checks.length} checks agree`}>
            The dashboard, the ledgers and the lists show the same figures.
            {notes ? ` ${notes} informational comparison${notes === 1 ? '' : 's'} differ for the reasons given beside them.` : ''}
          </Callout>
        ) : (
          <Callout tone="danger" title={`${failures} difference${failures === 1 ? '' : 's'} found`}>
            Each is shown below with both figures. A difference means two screens disagree about the same money — find the
            posting behind it before relying on either.
          </Callout>
        )}
      </div>

      {areas.map((area) => (
        <section key={area} className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{area}</h2>
          <TableWrap>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Check</TH>
                  <TH numeric>Shows</TH>
                  <TH numeric>Should equal</TH>
                  <TH numeric>Difference</TH>
                  <TH>Result</TH>
                </TR>
              </THead>
              <TBody>
                {checks
                  .filter((c) => c.area === area)
                  .map((c, i) => (
                    <CheckRow key={`${area}-${i}`} check={c} />
                  ))}
              </TBody>
            </Table>
          </TableWrap>
        </section>
      ))}
    </div>
  );
}

function CheckRow({ check }: { check: ConsistencyCheck }) {
  return (
    <TR data-testid="consistency-check" data-ok={check.ok ? 'true' : 'false'}>
      <TD>
        <span className="block text-sm font-medium">{check.label}</span>
        {check.note ? <span className="block max-w-xl text-xs text-ink-subtle">{check.note}</span> : null}
      </TD>
      <TD numeric>
        <span className="block text-[11px] text-ink-subtle">{check.left.label}</span>
        <span className="tnum">{figure(check.left.value, check.currency)}</span>
      </TD>
      <TD numeric>
        <span className="block text-[11px] text-ink-subtle">{check.right.label}</span>
        <span className="tnum">{figure(check.right.value, check.currency)}</span>
      </TD>
      <TD numeric className={check.ok ? 'text-ink-subtle' : 'font-semibold text-red-700'}>
        {check.ok ? '—' : figure(check.difference, check.currency)}
      </TD>
      <TD>
        {check.ok ? (
          <Badge tone="success">Agrees</Badge>
        ) : check.severity === 'error' ? (
          <Badge tone="danger">Difference</Badge>
        ) : (
          <Badge tone="warning">Look</Badge>
        )}
      </TD>
    </TR>
  );
}
