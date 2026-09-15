import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getAgentPositions } from '@/lib/services/agent-ledger';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Button } from '@/components/ui/button';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { dec } from '@/lib/money';

export const metadata: Metadata = { title: 'Agent Ledgers' };
export const dynamic = 'force-dynamic';

/**
 * How much is sitting with whom.
 *
 * The one question management asks about collection agents, and before the
 * agent clearing account existed there was nowhere to ask it: an agent's
 * cheque went straight into the bank and the fact that the money was still
 * with him left no trace at all.
 */
export default async function AgentLedgersPage() {
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const local = user.activeCompany.localCurrency;
  const positions = await getAgentPositions(user.activeCompany.id);

  const holding = positions.reduce((sum, p) => sum.plus(p.holdingUsd), dec(0));
  const commission = positions.reduce((sum, p) => sum.plus(p.commissionPayableUsd), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Ledgers"
        description="Money collected by agents and not yet handed over, and commission owed to them."
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Agent Ledgers' }]}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/finance/agent-commission">Commission register</Link>
            </Button>
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Agent Ledgers"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      {positions.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="An agent who collects from customers on the company's behalf will appear here with their balance."
        />
      ) : (
        <>
          <Callout tone="info" title="These are two separate balances">
            What an agent is holding is money the company owns and has not received. What it owes them in commission
            is a cost already charged to the shipments. An agent can be on both sides at once, so they are never
            offset against each other.
          </Callout>

          <TableWrap>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Agent</TH>
                  <TH>Code</TH>
                  <TH numeric>Holding for us (USD)</TH>
                  <TH numeric>Holding ({local})</TH>
                  <TH numeric>Commission owed (USD)</TH>
                  <TH numeric>Net (USD)</TH>
                </TR>
              </THead>
              <TBody>
                {positions.map((position) => (
                  <TR key={position.agentId}>
                    <TD>
                      <Link
                        href={`/agents/${position.agentId}`}
                        className="font-medium text-forest-800 hover:text-gold-700"
                      >
                        {position.agentName}
                      </Link>
                    </TD>
                    <TD>{position.agentCode}</TD>
                    <TD numeric className={dec(position.holdingUsd).greaterThan(0) ? 'font-semibold text-ink' : ''}>
                      {formatMoney(position.holdingUsd, 'USD')}
                    </TD>
                    <TD numeric>{formatMoney(position.holdingLocal, local)}</TD>
                    <TD numeric>{formatMoney(position.commissionPayableUsd, 'USD')}</TD>
                    <TD numeric>{formatMoney(position.netUsd, 'USD')}</TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <TR className="hover:bg-transparent">
                  <TD colSpan={2}>Total</TD>
                  <TD numeric>{formatMoney(holding, 'USD')}</TD>
                  <TD />
                  <TD numeric>{formatMoney(commission, 'USD')}</TD>
                  <TD numeric>{formatMoney(holding.minus(commission), 'USD')}</TD>
                </TR>
              </TFoot>
            </Table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
