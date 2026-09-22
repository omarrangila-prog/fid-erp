import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getAgentSummaries, getAgentControlTotals, type AgentLedgerSummary } from '@/lib/services/agent-account';
import { formatMoney } from '@/lib/format';
import { RowActions } from '@/components/shared/row-actions';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { dec, type Decimal } from '@/lib/money';

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
  const [agents, control] = await Promise.all([
    getAgentSummaries(user.activeCompany.id),
    getAgentControlTotals(user.activeCompany.id),
  ]);

  const total = (pick: (s: AgentLedgerSummary) => Decimal) =>
    agents.reduce((sum, a) => sum.plus(pick(a.summary)), dec(0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Balances"
        description={`What each agent holds for the company, is owed in commission, and has lent or borrowed — in ${local}.`}
        breadcrumbs={[{ label: 'Agents' }, { label: 'Agent Balances' }]}
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
        title="Agent Balances"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      {agents.length === 0 ? (
        <EmptyState
          title="No agents yet"
          description="An agent who collects from customers on the company's behalf will appear here with their balance."
        />
      ) : (
        <>
          <Callout tone="info" title={`Every figure is in ${local}`}>
            Each balance sits in its own account — money held for the company is an asset, commission and a loan from
            the agent are liabilities — and is shown once. The net says who owes whom overall; its USD equivalent is
            given beside it at the rate of each day.
          </Callout>

          {/*
            The agents explain the control account; they do not add to it.
            Somebody reading "Agent Clearing 46,000" on the balance sheet and
            "Ridwan Mohammad 46,000" here has to be able to see that those are
            the same money, which is what this states and proves.
          */}
          <Card>
            <CardContent className="space-y-2 pt-5" data-testid="agent-clearing-reconciliation">
              <p className="text-sm font-semibold text-ink">Agent Clearing, and who is holding it</p>
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">Agent Clearing account (balance sheet)</dt>
                  <dd className="tnum font-semibold">{formatMoney(control.clearingLocal, local)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">Held by the agents below</dt>
                  <dd className="tnum font-semibold">{formatMoney(control.clearingTaggedLocal, local)}</dd>
                </div>
              </dl>
              <p className="text-xs text-ink-muted">
                {control.untaggedLocal.isZero() ? (
                  <>
                    The two agree, so every dirham in the control account is accounted for by name. This is one
                    balance seen twice — the account on the balance sheet, the agents who hold it here. It is never
                    counted twice.
                  </>
                ) : (
                  <>
                    {formatMoney(control.untaggedLocal, local)} sits in the control account without an agent&rsquo;s
                    name on it. That is a gap in the subledger, not extra money: find the posting and tag it to the
                    agent who holds it.
                  </>
                )}
              </p>
            </CardContent>
          </Card>

          <TableWrap>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Agent</TH>
                  <TH numeric>Holding for us</TH>
                  <TH numeric>Commission owed</TH>
                  <TH numeric>Loan from agent</TH>
                  <TH numeric>Loan to agent</TH>
                  <TH numeric>Net position</TH>
                  <TH numeric>USD Eq.</TH>
                  <TH className="text-right">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {agents.map(({ agentId, agentName, summary }) => (
                  <TR key={agentId}>
                    <TD>
                      <Link href={`/agents/${agentId}`} className="font-medium text-forest-800 hover:text-gold-700">
                        {agentName}
                      </Link>
                    </TD>
                    <TD numeric className={summary.holdingLocal.greaterThan(0) ? 'font-semibold text-ink' : ''}>
                      {formatMoney(summary.holdingLocal, local)}
                    </TD>
                    <TD numeric>{formatMoney(summary.commissionLocal, local)}</TD>
                    <TD numeric>{formatMoney(summary.loanFromAgentLocal, local)}</TD>
                    <TD numeric>{formatMoney(summary.loanToAgentLocal, local)}</TD>
                    <TD numeric className="font-medium">
                      {formatMoney(summary.netLocal.abs(), local)}
                      <span className="block text-[11px] font-normal text-ink-subtle">
                        {summary.netLocal.isZero() ? 'settled' : summary.netLocal.isPositive() ? 'agent owes us' : 'we owe agent'}
                      </span>
                    </TD>
                    <TD numeric className="text-xs text-ink-muted">
                      {local === 'USD' ? '—' : formatMoney(summary.netUsd.abs(), 'USD')}
                    </TD>
                    <TD className="text-right">
                      <RowActions
                        actions={[
                          { label: 'Open ledger', href: `/agents/${agentId}`, icon: 'view' },
                          {
                            label: 'Receive from agent',
                            href: `/agents/${agentId}`,
                            icon: 'moneyIn',
                          },
                        ]}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <TR className="hover:bg-transparent">
                  <TD>Total</TD>
                  <TD numeric>{formatMoney(total((s) => s.holdingLocal), local)}</TD>
                  <TD numeric>{formatMoney(total((s) => s.commissionLocal), local)}</TD>
                  <TD numeric>{formatMoney(total((s) => s.loanFromAgentLocal), local)}</TD>
                  <TD numeric>{formatMoney(total((s) => s.loanToAgentLocal), local)}</TD>
                  <TD numeric>{formatMoney(total((s) => s.netLocal), local)}</TD>
                  <TD numeric className="text-xs text-ink-muted">
                    {local === 'USD' ? '—' : formatMoney(total((s) => s.netUsd), 'USD')}
                  </TD>
                  <TD />
                </TR>
              </TFoot>
            </Table>
          </TableWrap>
        </>
      )}
    </div>
  );
}
