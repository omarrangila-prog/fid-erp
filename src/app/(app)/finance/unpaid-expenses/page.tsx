import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { formatDate, formatMoney } from '@/lib/format';
import { equivalentText } from '@/lib/dual-currency';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { getUnpaidExpenseLedger, getSetOffSources, UNPAID_STATUS_LABEL, type AgeBucket } from '@/lib/services/unpaid-expenses';
import { PageHeader } from '@/components/shared/page-header';
import { PrintButton } from '@/components/shared/print-button';
import { PrintHeader } from '@/components/shared/print-header';
import { Metric, MetricGrid } from '@/components/shared/stat-card';
import { DualAmount } from '@/components/shared/dual-amount';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { UnpaidExpensesClient, type UnpaidRow } from '@/app/(app)/finance/unpaid-expenses/unpaid-client';
import { LedgerReport, type LedgerReportRow } from '@/components/ledger/ledger-report';
import { getLedgerPrefs } from '@/lib/services/ledger-prefs';
import { businessNumber } from '@/lib/short-number';
import { dec, toMoney, type Decimal } from '@/lib/money';
import type { LedgerColumnKey } from '@/lib/ledger-columns';
import { windowLedger } from '@/lib/ledger-window';

const UNPAID_LEDGER_COLUMNS: LedgerColumnKey[] = ['reference', 'type', 'party', 'shipment', 'status', 'createdBy'];

export const metadata: Metadata = { title: 'Unpaid Expenses' };
export const dynamic = 'force-dynamic';

/**
 * Unpaid Expenses — what FID still owes for costs booked now and paid later.
 *
 * Each cost stays its own line, under the name of whoever it is owed to, with
 * what was settled and how. The total at the top is the same money the
 * liability accounts hold, and the reconciliation beneath says so.
 */
export default async function UnpaidExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ settle?: string; view?: string; from?: string; to?: string }>;
}) {
  const { settle, view, from, to } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.EXPENSES_VIEW);
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency;
  const canSettle = can(user, PERMISSIONS.PAYMENTS_POST);

  const ledger = await getUnpaidExpenseLedger(companyId);
  const openCurrencies = [...new Set(ledger.rows.filter((r) => r.status !== 'SETTLED').map((r) => r.currency))];
  const [accounts, rates, sources] = await Promise.all([
    canSettle
      ? prisma.cashBankAccount.findMany({
          where: { companyId, status: 'ACTIVE' },
          orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
          select: { id: true, name: true, currency: true, accountType: true },
        })
      : Promise.resolve([]),
    getRateDefaults(companyId),
    canSettle
      ? Promise.all(openCurrencies.map(async (code) => [code, await getSetOffSources(companyId, code)] as const))
      : Promise.resolve([]),
  ]);

  const rows: UnpaidRow[] = ledger.rows.map((r) => ({
    id: r.expenseId,
    number: r.expenseNumber,
    date: formatDate(r.expenseDate),
    dateIso: r.expenseDate.toISOString().slice(0, 10),
    kind: r.kind === 'SHIPMENT' ? 'Shipment' : 'General',
    shipmentId: r.shipmentId,
    shipmentReference: r.shipmentReference,
    category: r.category,
    memo: r.memo,
    partyKind: r.party.kind,
    partyId: r.party.id,
    partyName: r.party.name,
    control: r.control,
    transferred: r.transferredLocal.greaterThan('0.005')
      ? `${formatMoney(r.transferredLocal, local)} moved to ${r.transferredTo.join(', ') || 'another account'} by a journal entry — still unpaid, owed there`
      : null,
    currency: r.currency,
    rateLocalPerUsd: r.rateLocalPerUsd.toString(),
    gross: formatMoney(r.gross, r.currency),
    grossEquivalent: equivalentText({ amount: r.gross, currency: r.currency, localCurrency: local, amountLocal: r.grossLocal, amountUsd: r.grossUsd }),
    settled: formatMoney(r.settled, r.currency),
    outstanding: formatMoney(r.outstanding, r.currency),
    outstandingRaw: r.outstanding.toFixed(2),
    outstandingLocalSort: Number(r.outstandingLocal),
    outstandingEquivalent: r.outstanding.isZero()
      ? null
      : equivalentText({ amount: r.outstanding, currency: r.currency, localCurrency: local, rateLocalPerUsd: r.rateLocalPerUsd }),
    status: r.status,
    statusLabel: UNPAID_STATUS_LABEL[r.status],
    ageDays: r.ageDays,
    bucket: r.bucket,
    history: r.history.map((h) => ({
      id: h.id,
      href: h.href,
      number: h.number,
      date: formatDate(h.date),
      method: h.method,
      through: h.through,
      amount: formatMoney(h.amount, h.currency),
      memo: h.memo,
      by: h.by,
    })),
  }));

  const t = ledger.totals;
  const buckets: AgeBucket[] = ['0–30 days', '31–60 days', '61–90 days', '90+ days'];
  const totalUsd = ledger.rows
    .filter((r) => r.status !== 'SETTLED' && r.rateLocalPerUsd.greaterThan(0))
    .reduce((sum, r) => sum.plus(r.outstandingLocal.dividedBy(r.rateLocalPerUsd)), dec(0));

  /*
   * The same costs as an accounting ledger: each cost booked is a credit to
   * what is owed, each settlement a debit, and the balance runs to the total
   * still owed. In the company's currency, at each cost's own rate.
   */
  const events: Array<{ order: string; row: LedgerReportRow; movement: Decimal }> = [];
  // Sorted by date; within a day, each cost in the ledger's own order, booked before it is settled.
  for (const [position, r] of ledger.rows.entries()) {
    const seq = String(position).padStart(6, '0');
    const perUnit = r.gross.isZero() ? dec(0) : r.grossLocal.dividedBy(r.gross);
    const party = r.party.name;
    const shipment = r.shipmentReference && r.shipmentId ? { label: r.shipmentReference, href: `/shipments/${r.shipmentId}` } : null;
    const date = r.expenseDate.toISOString().slice(0, 10);
    events.push({
      order: `${date}-0-${seq}`,
      movement: r.grossLocal,
      row: {
        key: `b-${r.expenseId}`,
        date,
        reference: businessNumber(r.expenseNumber),
        referenceHref: `/finance/expenses/${r.expenseId}`,
        type: 'Cost booked',
        memo: [r.category, r.memo].filter(Boolean).join(' — '),
        party,
        shipment,
        status: UNPAID_STATUS_LABEL[r.status],
        debit: '0',
        credit: r.grossLocal.toString(),
        balance: '0',
      },
    });
    let settledHere = dec(0);
    for (const ev of r.history) {
      const amount = toMoney(r.currency === local ? ev.amount : ev.amount.times(perUnit));
      settledHere = settledHere.plus(amount);
      const evDate = ev.date.toISOString().slice(0, 10);
      events.push({
        order: `${evDate}-1-${ev.number}`,
        movement: amount.negated(),
        row: {
          key: `s-${ev.id}-${r.expenseId}`,
          date: evDate,
          reference: businessNumber(ev.number),
          referenceHref: ev.href,
          type: `Settled — ${ev.method}`,
          memo: `${r.category} (${businessNumber(r.expenseNumber)}) settled by ${ev.method.toLowerCase()} · ${ev.through}`,
          party,
          shipment,
          createdBy: ev.by,
          debit: amount.toString(),
          credit: '0',
          balance: '0',
        },
      });
    }
    // Paid by a journal voucher on the account it is held in: it names no cost, so no date of its own here.
    const byJournal = toMoney(r.settledLocal.minus(settledHere));
    if (byJournal.greaterThan('0.005')) {
      events.push({
        order: `${date}-2-${seq}`,
        movement: byJournal.negated(),
        row: {
          key: `j-${r.expenseId}`,
          date,
          reference: businessNumber(r.expenseNumber),
          referenceHref: `/finance/expenses/${r.expenseId}`,
          type: 'Settled — journal entry (JV)',
          memo: `${r.category} settled by a journal entry (JV) on ${r.control}`,
          party,
          shipment,
          debit: byJournal.toString(),
          credit: '0',
          balance: '0',
        },
      });
    }
  }
  events.sort((a, b) => a.order.localeCompare(b.order));
  let running = dec(0);
  const ledgerRows = events.map((e) => {
    running = toMoney(running.plus(e.movement));
    return { ...e.row, balance: running.toString() };
  });
  const unpaidPrefs = await getLedgerPrefs(user.id, 'unpaid-expenses', UNPAID_LEDGER_COLUMNS);
  // The dates asked for, and only the latest entries of them, travel to the browser.
  const sentLedger = windowLedger(ledgerRows, '0', { from, to });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Unpaid Expenses"
        description="Every cost booked now and paid later — who it is owed to, what is left, and how it was settled. Settling never books the cost again."
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Unpaid Expenses' }]}
        actions={<PrintButton />}
      />
      <PrintHeader title="Unpaid Expenses" companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <Card>
        <CardContent className="pt-5">
          <MetricGrid>
            <Metric
              label="Total outstanding"
              value={
                <span data-testid="unpaid-total">
                  <DualAmount
                    amount={t.outstandingLocal}
                    currency={local}
                    localCurrency={local}
                    amountUsd={toMoney(totalUsd).toString()}
                    rateSource="Each cost at its own rate"
                  />
                </span>
              }
              hint={`${t.outstandingCount} ${t.outstandingCount === 1 ? 'cost' : 'costs'} still owed`}
            />
            <Metric label="Shipment expenses" value={formatMoney(t.shipmentLocal, local)} hint="In the shipments' costing already" />
            <Metric label="General expenses" value={formatMoney(t.generalLocal, local)} hint="In the profit and loss already" />
            {buckets.map((b) => (
              <Metric key={b} label={`Aged ${b}`} value={formatMoney(t.byBucket[b], local)} tone={b === '90+ days' && t.byBucket[b].greaterThan(0) ? 'negative' : 'default'} />
            ))}
          </MetricGrid>
        </CardContent>
      </Card>

      <div data-testid="unpaid-schedule">
      <UnpaidExpensesClient
        rows={rows}
        localCurrency={local}
        canSettle={canSettle}
        initialView={view === 'all' ? 'all' : view === 'settled' ? 'settled' : 'outstanding'}
        openSettleFor={settle ?? null}
        accounts={accounts.map((a) => ({ value: a.id, label: a.name, currency: a.currency, accountType: a.accountType }))}
        setOffSources={Object.fromEntries(sources)}
        defaultRates={{ local: rates.local, byCurrency: rates.byCurrency }}
      />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Unpaid expenses ledger</h2>
        <p className="text-xs text-ink-muted">
          The same costs as an accounting ledger: each cost booked is a credit to what is owed, each settlement a debit. The
          balance is what is still owed.
        </p>
        <LedgerReport
          report="unpaid-expenses"
          title="Unpaid expenses ledger"
          subject={user.activeCompany.name}
          currency={local}
          balanceSide="credit"
          opening={sentLedger.opening}
          rows={sentLedger.rows}
          window={sentLedger.window}
          available={UNPAID_LEDGER_COLUMNS}
          initialPrefs={unpaidPrefs}
          companyName={user.activeCompany.name}
          emptyText="No cost has been booked to be paid later."
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Agrees with the books</CardTitle>
          <CardDescription>
            What the schedule says is still owed, against the balance of the liability account that holds it. Settled costs are not
            counted.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table data-testid="unpaid-reconciliation">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Payable to</TH>
                  <TH>Recorded under</TH>
                  <TH numeric>Schedule</TH>
                  <TH numeric>Books</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {ledger.reconciliation.map((rec) => (
                  <TR key={rec.control}>
                    <TD>{rec.party === 'GENERAL' ? 'Nobody named yet' : rec.party === 'AGENT' ? 'Agents' : 'Suppliers'}</TD>
                    <TD className="text-xs text-ink-muted">{rec.control}</TD>
                    <TD numeric>{formatMoney(rec.scheduleLocal, local)}</TD>
                    <TD numeric>{rec.ledgerLocal ? formatMoney(rec.ledgerLocal, local) : '—'}</TD>
                    <TD>
                      {rec.agrees === null ? (
                        <span className="text-xs text-ink-subtle">Part of Accounts Payable, with the purchase orders</span>
                      ) : rec.agrees ? (
                        <Badge tone="success">Agrees</Badge>
                      ) : (
                        <Badge tone="danger">Differs</Badge>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
