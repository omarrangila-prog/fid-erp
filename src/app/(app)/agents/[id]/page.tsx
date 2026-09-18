import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getAgentPositions, getAgentStatement } from '@/lib/services/agent-ledger';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { AgentSettlementActions } from '@/app/(app)/agents/[id]/settlement-actions';

export const metadata: Metadata = { title: 'Agent Ledger' };
export const dynamic = 'force-dynamic';

/**
 * One agent's ledger.
 *
 * Two balances and the movements behind them. What the agent is holding —
 * money customers have paid him that has not reached the company — and what
 * the company owes him in commission. They are separate accounts and are
 * deliberately not netted: an agent can be holding the company's money while
 * the company owes him commission, and offsetting the two would hide both.
 */
export default async function AgentLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.AGENTS_VIEW);
  const companyId = user.activeCompany.id;

  const agent = await prisma.agent.findFirst({
    where: { id, companyId },
    select: { id: true, agentCode: true, agentName: true, contactPerson: true, phone: true, commissionPct: true },
  });
  if (!agent) notFound();

  const [positions, statement, accounts, rates] = await Promise.all([
    getAgentPositions(companyId, id),
    getAgentStatement({ companyId, agentId: id }),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true },
    }),
    getRateDefaults(companyId),
  ]);

  const position = positions[0];
  const local = user.activeCompany.localCurrency;
  const canSettle = can(user, PERMISSIONS.RECEIPTS_POST);

  return (
    <div className="space-y-6">
      <PageHeader
        title={agent.agentName}
        description={
          [agent.contactPerson, agent.phone].filter(Boolean).join(' · ') || undefined
        }
        breadcrumbs={[{ label: 'Contacts' }, { label: 'Agents', href: '/agents' }, { label: agent.agentName }]}
        actions={
          <>
            {canSettle ? (
              <AgentSettlementActions
                agentId={agent.id}
                agentName={agent.agentName}
                accounts={accounts}
                localCurrency={local}
                defaultLocalRate={rates.local}
                holdingUsd={position?.holdingUsd.toString() ?? '0'}
                commissionPayableUsd={position?.commissionPayableUsd.toString() ?? '0'}
              />
            ) : null}
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title={`Agent ledger — ${agent.agentName}`}
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Holding for the company</CardTitle>
            <CardDescription>
              Collected from customers and not yet handed over. The customers are settled; this money is not yet in
              the bank.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="tnum text-2xl font-semibold text-ink">
              {formatMoney(position?.holdingUsd ?? 0, 'USD')}
            </p>
            <p className="tnum mt-1 text-xs text-ink-subtle">
              {formatMoney(position?.holdingLocal ?? 0, local)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Commission owed to them</CardTitle>
            <CardDescription>
              Agreed on shipments and not yet paid. Already counted as a cost of those shipments.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="tnum text-2xl font-semibold text-ink">
              {formatMoney(position?.commissionPayableUsd ?? 0, 'USD')}
            </p>
            <p className="tnum mt-1 text-xs text-ink-subtle">
              {formatMoney(position?.commissionPayableLocal ?? 0, local)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Callout tone="info" title="Why these are not netted">
        An agent can be holding the company&rsquo;s money at the same time as the company owes them commission. They
        are two separate balances with two different people waiting on them, and offsetting one against the other
        would hide both.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>Movements</CardTitle>
          <CardDescription>Every posting on this agent&rsquo;s two accounts, oldest first.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {statement.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState
                title="Nothing recorded against this agent yet"
                description="A receipt collected by them, or a commission owed to them, will appear here."
              />
            </div>
          ) : (
            <TableWrap data-wide-sheet className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Entry</TH>
                    <TH>What happened</TH>
                    <TH>Customer</TH>
                    <TH numeric>Debit USD</TH>
                    <TH numeric>Credit USD</TH>
                    <TH numeric>Holding USD</TH>
                    <TH numeric>Commission owed USD</TH>
                  </TR>
                </THead>
                <TBody>
                  {statement.map((row, index) => (
                    <TR key={`${row.entryNumber}-${index}`}>
                      <TD className="whitespace-nowrap">{formatDate(row.entryDate)}</TD>
                      <TD>{row.entryNumber}</TD>
                      <TD>
                        <span className="block">{row.description}</span>
                        <Badge tone={row.account === 'CLEARING' ? 'info' : 'warning'}>
                          {row.account === 'CLEARING' ? 'Collections' : 'Commission'}
                        </Badge>
                        <span className="ml-1 text-xs text-ink-subtle">{titleCase(row.sourceType)}</span>
                      </TD>
                      <TD>{row.customerName ?? '—'}</TD>
                      <TD numeric>{formatMoney(row.debitUsd, 'USD')}</TD>
                      <TD numeric>{formatMoney(row.creditUsd, 'USD')}</TD>
                      <TD numeric className="font-medium">{formatMoney(row.holdingUsd, 'USD')}</TD>
                      <TD numeric className="font-medium">{formatMoney(row.commissionPayableUsd, 'USD')}</TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
