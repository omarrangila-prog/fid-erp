import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { ledgerHref } from '@/lib/ledger-currency';
import { prisma } from '@/lib/db';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { formatMoney, formatDate, titleCase, dayParam, companyToday } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { CustomizePanel } from '@/components/reports/customize-panel';
import { FavouriteStar } from '@/components/reports/report-statement';
import { DateRangePicker } from '@/components/shared/date-range';
import { TrialBalanceFilters } from '@/app/(app)/reports/trial-balance/filters';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ReportShareButton } from '@/components/share/report-share-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { ReportSummary } from '@/components/shared/report-summary';
import { dec, type Decimal } from '@/lib/money';
import { transactionCurrencies } from '@/lib/company-currencies';
import { clientLabel, isUnusedInPeriod } from '@/lib/trial-balance-view';

export const metadata: Metadata = { title: 'Trial Balance' };
export const dynamic = 'force-dynamic';

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{
    asOf?: string;
    from?: string;
    to?: string;
    type?: string;
    currency?: string;
    customer?: string;
    vendor?: string;
    warehouse?: string;
    shipment?: string;
    /** "all" adds the accounts with nothing in them; otherwise they are left out. */
    view?: string;
  }>;
}) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;
  const companyId = user.activeCompany.id;

  // "As at" is the closing date; a start date turns on opening and movement.
  const asOfDate = dayParam(query.to) ?? dayParam(query.asOf) ?? companyToday(user.activeCompany.timezone);
  // The period always has a start, so opening, movement and closing are all
  // shown (the requirements' seven columns). The default is the first of the
  // closing date's month — the same date the period picker shows.
  const fromDate = dayParam(query.from) ?? new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 1));
  const filters = {
    accountType: query.type || null,
    currency: query.currency || null,
    customerId: query.customer || null,
    vendorId: query.vendor || null,
    warehouseId: query.warehouse || null,
    shipmentId: query.shipment || null,
  };
  const filtered = Object.values(filters).some(Boolean);

  const [customers, vendors, shipments, warehouses, ordinals] = await Promise.all([
    prisma.customer.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { customerName: 'asc' }, select: { id: true, customerName: true } }),
    prisma.vendor.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { vendorName: 'asc' }, select: { id: true, vendorName: true } }),
    prisma.shipment.findMany({
      where: { companyId, purchaseContract: { status: 'POSTED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, purchaseContract: { select: { contractReference: true } } },
    }),
    prisma.warehouse.findMany({ where: { companyId, status: 'ACTIVE' }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    getShipmentOrdinals(companyId),
  ]);

  const [trial, accountCurrencies] = await Promise.all([
    getTrialBalanceReport({ companyId, from: fromDate, to: asOfDate, filters }),
    prisma.account.findMany({
      where: { companyId: user.activeCompany.id },
      orderBy: { code: 'asc' },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        currency: true,
        systemKey: true,
        cashBankAccounts: { select: { currency: true }, orderBy: { currency: 'asc' } },
      },
    }),
  ]);
  /*
   * One line per ledger account, under a plain display name where the
   * ledger's is a technical one (the ledger name beneath it). "Show unused
   * accounts" adds the accounts with nothing brought forward, nothing moved
   * and nothing left; an account with any of the three is always listed.
   */
  const showUnused = query.view === 'all';
  const metaById = new Map(accountCurrencies.map((a) => [a.id, { systemKey: a.systemKey }]));
  const zero = dec(0);
  const listed = new Set(trial.rows.map((r) => r.accountId));
  const rows = showUnused && !filtered
    ? [
        ...trial.rows,
        ...accountCurrencies
          .filter((a) => !listed.has(a.id))
          .map((a) => ({
            accountId: a.id, code: a.code, name: a.name, type: a.type as string,
            debitUsd: zero, creditUsd: zero, debitLocal: zero, creditLocal: zero,
            openingDebitUsd: zero, openingCreditUsd: zero, periodDebitUsd: zero, periodCreditUsd: zero,
            openingDebitLocal: zero, openingCreditLocal: zero, periodDebitLocal: zero, periodCreditLocal: zero,
          })),
      ].sort((a, b) => a.code.localeCompare(b.code))
    : trial.rows.filter((r) => !isUnusedInPeriod(r));
  const lines = rows.map((row) => ({
    ...row,
    key: row.accountId,
    label: clientLabel(row, metaById.get(row.accountId)),
    accounts: [{ accountId: row.accountId, code: row.code, name: row.name }],
  }));
  const unusedCount = accountCurrencies.length - listed.size;
  const viewHref = (view: 'all' | null) => {
    const params = new URLSearchParams(
      Object.entries(query).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '' && entry[0] !== 'view'),
    );
    if (view) params.set('view', view);
    const text = params.toString();
    return `/reports/trial-balance${text ? `?${text}` : ''}`;
  };
  const currencyByAccount = new Map(
    accountCurrencies.map((row) => {
      const cash = row.cashBankAccounts.find((d) => d.currency !== 'USD') ?? row.cashBankAccounts[0];
      return [row.id, cash?.currency ?? row.currency ?? null] as const;
    }),
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trial Balance"
        description={`${user.activeCompany.name} · as at ${formatDate(asOfDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Trial Balance' }]}
        meta={
          <Badge tone={trial.isBalanced ? 'success' : 'danger'}>
            {trial.isBalanced ? 'Balanced' : 'Out of balance'}
          </Badge>
        }
        actions={
          <>
            <FavouriteStar href="/reports/trial-balance" label="Trial Balance" />
            <CustomizePanel report="Trial Balance" fields={['period']} />
            <ExportLinks
              href={exportHref('trial-balance', {
                from: fromDate.toISOString().slice(0, 10),
                to: asOfDate.toISOString().slice(0, 10),
                type: query.type,
                currency: query.currency,
                customer: query.customer,
                vendor: query.vendor,
                warehouse: query.warehouse,
                shipment: query.shipment,
                view: query.view,
              })}
            />
            <ReportShareButton report="trial-balance" />
          </>
        }
      />
      <PrintHeader
        title="Trial Balance"
        companyName={user.activeCompany.name} currency={user.activeCompany.localCurrency}
        country={user.activeCompany.country}
      />

      <DateRangePicker
        defaultFrom={(fromDate ?? new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 1))).toISOString().slice(0, 10)}
        defaultTo={asOfDate.toISOString().slice(0, 10)}
      />
      <TrialBalanceFilters
        customers={customers.map((c) => ({ value: c.id, label: c.customerName }))}
        vendors={vendors.map((v) => ({ value: v.id, label: v.vendorName }))}
        shipments={shipments.map((s) => ({
          value: s.id,
          label: `${s.purchaseContract.contractReference} · ${shipmentOrdinalLabel(ordinals.get(s.id))}`,
        }))}
        warehouses={warehouses.map((w) => ({ value: w.id, label: w.name }))}
        currencies={[...new Set(['USD', ...transactionCurrencies(local)])]}
      />
      {filtered ? (
        <p className="text-xs text-ink-muted">
          Narrowed to the lines that match the filters above. A narrowed trial balance need not balance on its own —
          the other side of a customer&rsquo;s entries sits on accounts that are not theirs.
        </p>
      ) : null}

      {/* The three figures the report exists to give, and the verdict. An
          imbalance is never hidden: it is the only thing a trial balance is
          for. */}
      <ReportSummary
        figures={[
          { label: 'Total debits', value: formatMoney(trial.totals.debitLocal, local), hint: `≈ ${formatMoney(trial.totals.debitUsd, 'USD')}` },
          { label: 'Total credits', value: formatMoney(trial.totals.creditLocal, local), hint: `≈ ${formatMoney(trial.totals.creditUsd, 'USD')}` },
          {
            label: 'Difference',
            value: formatMoney(dec(trial.totals.debitLocal).minus(trial.totals.creditLocal), local),
            lead: true,
            tone: trial.isBalancedLocal && trial.isBalanced ? 'default' : 'negative',
            hint: `${lines.length} accounts listed`,
          },
        ]}
        status={
          trial.isBalancedLocal && trial.isBalanced
            ? { label: 'Balanced', ok: true, detail: 'Total debits equal total credits.' }
            : {
                label: 'Attention required',
                ok: false,
                detail:
                  'The posting engine refuses any entry that does not balance, so this points at data written outside the application.',
              }
        }
      />

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Account balances</CardTitle>
              <CardDescription>
                {`Every ledger account: where it stood on ${formatDate(fromDate)}, what moved through it in the period, and where it stood on ${formatDate(asOfDate)}. `}
                {showUnused
                  ? 'Unused accounts — nothing brought forward, nothing moved, nothing left — are included.'
                  : 'Accounts with nothing brought forward, nothing moved and nothing left are left out; an account with any activity is always listed.'}
                {' A system account is shown under a plain name, with its ledger name beneath. Click any account to open its ledger.'}
              </CardDescription>
            </div>
            <Link
              href={viewHref(showUnused ? null : 'all')}
              className="shrink-0 text-sm font-medium text-forest-800 underline-offset-2 hover:underline print:hidden"
              data-testid="tb-view-toggle"
            >
              {showUnused ? 'Hide unused accounts' : `Show unused accounts (${unusedCount})`}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t" data-wide-sheet>
            <Table>
              <THead>
                {/* The requirements' columns: opening balance, debit total, credit total, closing balance. */}
                {trial.hasOpening ? (
                  <TR className="hover:bg-transparent">
                    <TH />
                    <TH numeric colSpan={2} className="text-center">Opening balance</TH>
                    <TH numeric>Debit total</TH>
                    <TH numeric>Credit total</TH>
                    <TH numeric colSpan={2} className="text-center">Closing balance</TH>
                  </TR>
                ) : null}
                <TR className="hover:bg-transparent">
                  <TH>Account</TH>
                  {trial.hasOpening ? (
                    <>
                      <TH numeric>Debit</TH>
                      <TH numeric>Credit</TH>
                      <TH numeric>for the period</TH>
                      <TH numeric>for the period</TH>
                    </>
                  ) : null}
                  <TH numeric>Debit</TH>
                  <TH numeric>Credit</TH>
                </TR>
              </THead>
              <TBody>
                {lines.map((row) => (
                  <TR key={row.key} data-testid="tb-line">
                    <TD>
                      {row.accounts.length === 1 ? (
                        <Link
                          href={ledgerHref(row.accounts[0].accountId, currencyByAccount.get(row.accounts[0].accountId))}
                          className="font-medium text-forest-800 hover:text-gold-700"
                        >
                          {row.label}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{row.label}</span>
                      )}
                      {/* What the line is made of, under the ledger's names. */}
                      {row.accounts.length > 1 || row.accounts[0].name !== row.label ? (
                        <span className="block text-[11px] text-ink-subtle">
                          {row.accounts.map((a, i) => (
                            <span key={a.accountId}>
                              {i > 0 ? ' · ' : ''}
                              <Link
                                href={ledgerHref(a.accountId, currencyByAccount.get(a.accountId))}
                                className="hover:text-gold-700"
                              >
                                Ledger: {a.name}
                              </Link>
                            </span>
                          ))}
                        </span>
                      ) : null}
                      <span className="block text-[11px] text-ink-subtle">{titleCase(row.type)}</span>
                    </TD>
                    {trial.hasOpening ? (
                      <>
                        <TD numeric className="text-ink-muted">
                          <BookSides usd={row.openingDebitUsd} local={row.openingDebitLocal} localCurrency={local} />
                        </TD>
                        <TD numeric className="text-ink-muted">
                          <BookSides usd={row.openingCreditUsd} local={row.openingCreditLocal} localCurrency={local} />
                        </TD>
                        <TD numeric>
                          <BookSides usd={row.periodDebitUsd} local={row.periodDebitLocal} localCurrency={local} />
                        </TD>
                        <TD numeric>
                          <BookSides usd={row.periodCreditUsd} local={row.periodCreditLocal} localCurrency={local} />
                        </TD>
                      </>
                    ) : null}
                    <TD numeric>
                      <BookSides usd={row.debitUsd} local={row.debitLocal} localCurrency={local} />
                    </TD>
                    <TD numeric>
                      <BookSides usd={row.creditUsd} local={row.creditLocal} localCurrency={local} />
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD>Total</TD>
                  {trial.hasOpening ? (
                    <>
                      <TD numeric>
                        <BookSides usd={trial.totals.openingDebitUsd} local={trial.totals.openingDebitLocal} localCurrency={local} always />
                      </TD>
                      <TD numeric>
                        <BookSides usd={trial.totals.openingCreditUsd} local={trial.totals.openingCreditLocal} localCurrency={local} always />
                      </TD>
                      <TD numeric>
                        <BookSides usd={trial.totals.periodDebitUsd} local={trial.totals.periodDebitLocal} localCurrency={local} always />
                      </TD>
                      <TD numeric>
                        <BookSides usd={trial.totals.periodCreditUsd} local={trial.totals.periodCreditLocal} localCurrency={local} always />
                      </TD>
                    </>
                  ) : null}
                  <TD numeric>
                    <BookSides usd={trial.totals.debitUsd} local={trial.totals.debitLocal} localCurrency={local} always />
                  </TD>
                  <TD numeric>
                    <BookSides usd={trial.totals.creditUsd} local={trial.totals.creditLocal} localCurrency={local} always />
                  </TD>
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One side of an account in one cell: the company's own currency — the
 * books' figure — above, and the USD equivalent beneath, each line at its own
 * rate. Both are what the entries stored; neither is a conversion of the
 * other at today's rate.
 */
function BookSides({
  usd,
  local,
  localCurrency,
  always = false,
}: {
  usd: Decimal;
  local: Decimal;
  localCurrency: string;
  always?: boolean;
}) {
  const showLocal = always || local.greaterThan(0);
  const showUsd = localCurrency !== 'USD' && (always || usd.greaterThan(0));
  if (!showLocal && !showUsd) return <>—</>;
  return (
    <span className="inline-block">
      <span className="tnum block">{showLocal ? formatMoney(local, localCurrency) : '—'}</span>
      {showUsd ? (
        <span className="tnum block text-[11px] font-normal text-ink-subtle" title="USD equivalent: each transaction at its own rate">
          ≈ {formatMoney(usd, 'USD')}
        </span>
      ) : null}
    </span>
  );
}
