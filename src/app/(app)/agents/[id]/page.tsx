import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getAgentPositions } from '@/lib/services/agent-ledger';
import { getAgentLedger } from '@/lib/services/agent-account';
import { businessNumber, shortDocumentNumber } from '@/lib/short-number';
import { MemoCell } from '@/components/shared/memo-cell';
import { JournalSourceActions } from '@/components/shared/journal-source-actions';
import Link from 'next/link';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Callout, EmptyState } from '@/components/ui/feedback';
import { AgentSettlementActions } from '@/app/(app)/agents/[id]/settlement-actions';

export const metadata: Metadata = { title: 'Agent Ledger' };
export const dynamic = 'force-dynamic';

/**
 * One agent's ledger, in the company's own currency.
 *
 * Everything the agent does with the company's money in one statement —
 * collections, cheques, settlements, commission, loans both ways and
 * journals — with each balance still shown separately above it, because the
 * accounts behind them are different: money the agent holds is an asset,
 * commission and a loan from them are liabilities.
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

  const [positions, ledger, accounts, rates] = await Promise.all([
    getAgentPositions(companyId, id),
    getAgentLedger({ companyId, agentId: id }),
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
            {can(user, PERMISSIONS.ACCOUNTING_POST) ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/finance/loans/new?agent=${agent.id}`}>Loan with this agent</Link>
              </Button>
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-print-drop>
        {[
          {
            title: 'Holding for the company',
            hint: 'Customers’ money and cheques collected and not yet handed over.',
            value: ledger.summary.holdingLocal,
          },
          {
            title: 'Commission owed to them',
            hint: 'Agreed and not yet paid.',
            value: ledger.summary.commissionLocal,
          },
          {
            title: 'Loan from the agent',
            hint: 'Lent to the company and not yet repaid.',
            value: ledger.summary.loanFromAgentLocal,
          },
          {
            title: 'Loan to the agent',
            hint: 'Lent by the company and not yet returned.',
            value: ledger.summary.loanToAgentLocal,
          },
        ].map((card) => (
          <Card key={card.title}>
            <CardHeader>
              <CardTitle>{card.title}</CardTitle>
              <CardDescription>{card.hint}</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="tnum text-xl font-semibold text-ink">{formatMoney(card.value, local)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Callout
        tone={ledger.summary.netLocal.isZero() ? 'info' : ledger.summary.netLocal.isPositive() ? 'warning' : 'info'}
        title={
          ledger.summary.netLocal.isZero()
            ? 'Nothing outstanding either way'
            : ledger.summary.netLocal.isPositive()
              ? `${agent.agentName} owes the company ${formatMoney(ledger.summary.netLocal, local)}`
              : `The company owes ${agent.agentName} ${formatMoney(ledger.summary.netLocal.abs(), local)}`
        }
      >
        Kept in {local}, the currency the agent is paid and owed in. Equivalent{' '}
        {formatMoney(ledger.summary.netUsd.abs(), 'USD')} at the rate of each day. The four balances above stay in their own accounts on the balance sheet — this is one
        view of all of them.
      </Callout>

      <Card>
        <CardHeader>
          <CardTitle>Agent ledger</CardTitle>
          <CardDescription>
            Every posting tagged to this agent, oldest first: collections, cheques, settlements, commission, loans and
            journals. Debit means the agent owes the company more; credit means the company owes the agent more.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {ledger.rows.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState
                title="Nothing recorded against this agent yet"
                description="A payment collected by them, a commission, a settlement or a loan will appear here."
              />
            </div>
          ) : (
            <TableWrap data-wide-sheet className="rounded-none border-0 border-t">
              <Table data-testid="agent-ledger">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Date</TH>
                    <TH>Reference</TH>
                    <TH>Type</TH>
                    <TH>Customer</TH>
                    <TH>Invoice</TH>
                    <TH>Memo</TH>
                    <TH>Currency</TH>
                    <TH numeric>Debit</TH>
                    <TH numeric>Credit</TH>
                    <TH numeric>Balance {local}</TH>
                    <TH numeric>USD Eq.</TH>
                    <TH>Status</TH>
                    <TH className="text-right" data-print="hide">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {ledger.rows.map((row, index) => {
                    const foreign = row.currency !== local;
                    return (
                      <TR key={`${row.journalEntryId}-${index}`}>
                        <TD className="whitespace-nowrap">{formatDate(row.entryDate)}</TD>
                        <TD className="whitespace-nowrap text-xs">
                          {businessNumber(row.sourceType === 'MANUAL' || !row.reference ? row.entryNumber : row.reference)}
                        </TD>
                        <TD className="whitespace-nowrap text-xs font-medium" data-testid="agent-ledger-type">
                          {row.typeLabel}
                          <span className="block text-[11px] font-normal text-ink-subtle">{row.accountName}</span>
                        </TD>
                        <TD className="text-xs">{row.customerName ?? '—'}</TD>
                        <TD className="whitespace-nowrap text-xs">
                          {row.documents.length === 0
                            ? '—'
                            : row.documents.map((doc, i) => (
                                <span key={doc.id}>
                                  {i > 0 ? ', ' : ''}
                                  <Link href={`/sales/${doc.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                                    {shortDocumentNumber(doc.number)}
                                  </Link>
                                </span>
                              ))}
                        </TD>
                        <TD>
                          <MemoCell memo={row.memo} />
                        </TD>
                        <TD className="text-xs">{row.currency}</TD>
                        <TD numeric>
                          {row.debit.greaterThan(0) ? (
                            <>
                              {formatMoney(row.debit, row.currency)}
                              {foreign ? (
                                <span className="block text-[11px] text-ink-subtle">{formatMoney(row.debitLocal, local)}</span>
                              ) : null}
                            </>
                          ) : (
                            '—'
                          )}
                        </TD>
                        <TD numeric>
                          {row.credit.greaterThan(0) ? (
                            <>
                              {formatMoney(row.credit, row.currency)}
                              {foreign ? (
                                <span className="block text-[11px] text-ink-subtle">{formatMoney(row.creditLocal, local)}</span>
                              ) : null}
                            </>
                          ) : (
                            '—'
                          )}
                        </TD>
                        <TD numeric className="font-medium">
                          {formatMoney(row.balanceLocal, local)}
                        </TD>
                        <TD numeric className="text-xs text-ink-muted">
                          {row.currency === 'USD' ? '—' : formatMoney(row.usd, 'USD')}
                        </TD>
                        <TD className="whitespace-nowrap text-xs">{row.status}</TD>
                        <TD data-print="hide">
                          <JournalSourceActions
                            sourceType={row.sourceType}
                            sourceId={row.sourceId}
                            entryNumber={row.entryNumber}
                          />
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
