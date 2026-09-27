import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getAgentPositions } from '@/lib/services/agent-ledger';
import { getAgentStatement, AGENT_EVENT_FILTERS, isAgentEventFilter } from '@/lib/services/agent-statement';
import { equivalentText } from '@/lib/dual-currency';
import { shortDocumentNumber } from '@/lib/short-number';
import { AgentStatementClient, type StatementRow } from '@/app/(app)/agents/[id]/agent-statement-client';
import Link from 'next/link';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Callout } from '@/components/ui/feedback';
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
  const filter = isAgentEventFilter(query.tab) ? query.tab : 'ALL';
  const user = await requirePageAccess(PERMISSIONS.AGENTS_VIEW);
  const companyId = user.activeCompany.id;

  const agent = await prisma.agent.findFirst({
    where: { id, companyId },
    select: { id: true, agentCode: true, agentName: true, contactPerson: true, phone: true, commissionPct: true },
  });
  if (!agent) notFound();

  const [positions, statement, accounts, rates, asCustomer] = await Promise.all([
    getAgentPositions(companyId, id),
    getAgentStatement({ companyId, agentId: id }),
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
  const ledger = statement;
  const firstName = agent.agentName.split(/\s+/)[0] ?? agent.agentName;
  const rows: StatementRow[] = statement.events.map((e) => ({
    id: e.journalEntryId,
    journalNumber: e.journalNumber,
    documentNumber: e.documentNumber,
    date: formatDate(e.date),
    dateIso: e.date.toISOString().slice(0, 10),
    typeLabel: e.typeLabel,
    filters: e.filters,
    shipment: e.shipment,
    customerName: e.customerName,
    documents: e.documents.map((d) => ({ id: d.id, number: shortDocumentNumber(d.number) })),
    memo: e.memo,
    amount: formatMoney(e.amount, e.currency),
    amountEquivalent: equivalentText({
      amount: e.amount,
      currency: e.currency,
      localCurrency: user.activeCompany.localCurrency,
      amountLocal: e.currency === user.activeCompany.localCurrency ? null : e.amountLocal,
      rateLocalPerUsd: e.lines[0]?.debitLocal.plus(e.lines[0].creditLocal).isZero() || e.lines[0]?.usd.isZero()
        ? null
        : e.lines[0].debitLocal.plus(e.lines[0].creditLocal).dividedBy(e.lines[0].usd),
    }),
    receivableChange: Number(e.receivableChangeLocal),
    payableChange: Number(e.payableChangeLocal),
    netChange: Number(e.receivableChangeLocal.minus(e.payableChangeLocal)),
    runningNet: Number(e.runningNetLocal),
    status: e.status,
    createdBy: e.createdBy,
    sourceHref: e.sourceHref,
    lines: e.lines.map((l) => ({
      account: l.accountName,
      kind: l.accountKind,
      currency: l.currency,
      debit: l.debit.greaterThan(0) ? formatMoney(l.debit, l.currency) : '—',
      credit: l.credit.greaterThan(0) ? formatMoney(l.credit, l.currency) : '—',
      debitLocal: l.debitLocal.greaterThan(0) ? formatMoney(l.debitLocal, user.activeCompany.localCurrency) : '—',
      creditLocal: l.creditLocal.greaterThan(0) ? formatMoney(l.creditLocal, user.activeCompany.localCurrency) : '—',
      rate:
        l.currency !== user.activeCompany.localCurrency && l.debit.plus(l.credit).greaterThan(0)
          ? l.debitLocal.plus(l.creditLocal).dividedBy(l.debit.plus(l.credit)).toFixed(4)
          : null,
    })),
  }));
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
                commissionLocal={ledger.summary.commissionLocal.toString()}
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

      <div className="grid gap-4 lg:grid-cols-3" data-print-drop data-testid="agent-position">
        <Card>
          <CardHeader>
            <CardTitle>{firstName} owes FID</CardTitle>
            <CardDescription>Customer money he holds, loans FID gave him, and coffee he bought himself.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <p className="tnum text-2xl font-semibold text-ink">{formatMoney(ledger.summary.owesFidLocal, local)}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-ink-muted">Collections held</dt>
              <dd className="tnum text-right">{formatMoney(ledger.summary.holdingLocal, local)}</dd>
              <dt className="text-ink-muted">Loan receivable</dt>
              <dd className="tnum text-right">{formatMoney(ledger.summary.loanToAgentLocal, local)}</dd>
              <dt className="text-ink-muted">Trade receivable</dt>
              <dd className="tnum text-right">{formatMoney(ledger.summary.tradeReceivableLocal, local)}</dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>FID owes {firstName}</CardTitle>
            <CardDescription>Commission not yet paid, and money he lent FID.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <p className="tnum text-2xl font-semibold text-ink">{formatMoney(ledger.summary.fidOwesLocal, local)}</p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-ink-muted">Commission payable</dt>
              <dd className="tnum text-right">{formatMoney(ledger.summary.commissionLocal, local)}</dd>
              <dt className="text-ink-muted">of which unpaid expenses</dt>
              <dd className="tnum text-right">{formatMoney(ledger.summary.unpaidExpensesLocal, local)}</dd>
              <dt className="text-ink-muted">Loan payable</dt>
              <dd className="tnum text-right">{formatMoney(ledger.summary.loanFromAgentLocal, local)}</dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Operational net position</CardTitle>
            <CardDescription>The two sides together — a view only; nothing is set off by it.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="tnum text-2xl font-semibold text-ink">{formatMoney(ledger.summary.netLocal.abs(), local)}</p>
            <p className="text-xs text-ink-muted">
              {ledger.summary.netLocal.isZero()
                ? 'Nothing outstanding either way'
                : ledger.summary.netLocal.isPositive()
                  ? `${firstName} owes FID`
                  : `FID owes ${firstName}`}
            </p>
          </CardContent>
        </Card>
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

      <Card>
        <CardHeader>
          <CardTitle>{agent.agentName} — agent ledger</CardTitle>
          <CardDescription>
            Every business event with {firstName}, oldest first — collections, commission, loans, settlements, set-offs,
            shipment costs and journals — one line each, from the entries tagged to him. Each line says how it moved what he
            owes FID and what FID owes him; the running position is the two together.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AgentStatementClient
            rows={rows}
            filters={AGENT_EVENT_FILTERS}
            initialFilter={filter}
            localCurrency={local}
            agentFirstName={firstName}
          />
        </CardContent>
      </Card>
    </div>
  );
}
