import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getAgentPositions } from '@/lib/services/agent-ledger';
import { getAgentLedger, AGENT_LEDGER_TABS, isAgentLedgerTab } from '@/lib/services/agent-account';
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
import { AgentOffsetAction } from '@/app/(app)/agents/[id]/offset-action';

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
export default async function AgentLedgerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const tab = isAgentLedgerTab(query.tab) ? query.tab : 'ALL';
  const user = await requirePageAccess(PERMISSIONS.AGENTS_VIEW);
  const companyId = user.activeCompany.id;

  const agent = await prisma.agent.findFirst({
    where: { id, companyId },
    select: { id: true, agentCode: true, agentName: true, contactPerson: true, phone: true, commissionPct: true },
  });
  if (!agent) notFound();

  const [positions, ledger, accounts, rates, asCustomer] = await Promise.all([
    getAgentPositions(companyId, id),
    getAgentLedger({ companyId, agentId: id, tab }),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true },
    }),
    getRateDefaults(companyId),
    // The same man's customer record, where he also buys for himself.
    prisma.customer.findFirst({
      where: { companyId, agentId: id },
      select: { id: true, customerName: true },
    }),
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
        meta={
          asCustomer ? (
            <Link
              href={`/customers/${asCustomer.id}`}
              className="text-xs font-medium text-forest-800 hover:text-gold-700"
              data-testid="agent-as-customer"
            >
              Also a customer — the coffee he buys for himself is on this page too
            </Link>
          ) : undefined
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
                holdingLocal={ledger.summary.holdingLocal.toString()}
                commissionPayableUsd={position?.commissionPayableUsd.toString() ?? '0'}
              />
            ) : null}
            {can(user, PERMISSIONS.ACCOUNTING_POST) ? (
              <AgentOffsetAction
                agentId={agent.id}
                agentName={agent.agentName}
                localCurrency={local}
                holdingLocal={ledger.summary.holdingLocal.toString()}
                loanFromAgentLocal={ledger.summary.loanFromAgentLocal.toString()}
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5" data-print-drop>
        {[
          {
            title: 'Receivable from this agent',
            hint: 'Customers’ money and cheques they collected and have not yet handed over. Part of the Agent Clearing account — not a second asset.',
            value: ledger.summary.holdingLocal,
          },
          {
            title: 'Commission payable to them',
            hint: 'Agreed and not yet paid. Part of the Agent Commission Payable account.',
            value: ledger.summary.commissionLocal,
          },
          {
            title: 'Loan payable to them',
            hint: 'They lent the company money that has not been repaid.',
            value: ledger.summary.loanFromAgentLocal,
          },
          {
            title: 'Loan receivable from them',
            hint: 'The company lent them money that has not come back.',
            value: ledger.summary.loanToAgentLocal,
          },
          {
            title: 'Invoiced to them as a customer',
            hint: 'Coffee they bought for themselves, not collected on the company’s behalf. Trade receivable, a different account again.',
            value: ledger.summary.tradeReceivableLocal,
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
        {formatMoney(ledger.summary.netUsd.abs(), 'USD')} at the rate of each day. The balances above stay in their own
        accounts on the balance sheet — this is one view of all of them, and nothing is set against anything else until
        someone asks for it.
      </Callout>

      <nav className="flex flex-wrap gap-1 rounded-lg border border-line bg-surface-sunken p-1" data-print="hide">
        {Object.entries(AGENT_LEDGER_TABS).map(([key, label]) => (
          <Link
            key={key}
            href={key === 'ALL' ? `/agents/${agent.id}` : `/agents/${agent.id}?tab=${key}`}
            data-testid={`agent-tab-${key.toLowerCase()}`}
            aria-current={tab === key ? 'page' : undefined}
            className={
              tab === key
                ? 'rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-ink shadow-sm'
                : 'rounded-md px-3 py-1.5 text-xs font-medium text-ink-muted hover:text-ink'
            }
          >
            {label}
          </Link>
        ))}
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>Agent ledger — {AGENT_LEDGER_TABS[tab]}</CardTitle>
          <CardDescription>
            Every posting tagged to this agent, oldest first: collections, cheques, settlements, commission, loans,
            his own purchases and journals. Each line says in words which way it moved the account it belongs to.
            {tab === 'ALL' ? null : ' The balance shown runs over this tab only; the figures above cover everything.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {ledger.rows.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState
                title={tab === 'ALL' ? 'Nothing recorded against this agent yet' : 'Nothing under this tab'}
                description={
                  tab === 'ALL'
                    ? 'A payment collected by them, a commission, a settlement or a loan will appear here.'
                    : 'Other activity may still be on the other tabs.'
                }
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
                    <TH>Account</TH>
                    <TH>What it means</TH>
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
                          {businessNumber(row.reference ?? row.entryNumber)}
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
                        <TD className="whitespace-nowrap text-xs text-ink-muted">{row.accountKind}</TD>
                        <TD className="whitespace-nowrap text-xs" data-testid="agent-ledger-direction">
                          {row.direction.replace('He', agent.agentName.split(' ')[0])}
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
