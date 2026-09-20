import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { ledgerHref } from '@/lib/ledger-currency';
import { prisma } from '@/lib/db';
import { getTrialBalanceReport } from '@/lib/services/reports';
import { formatMoney, formatDate, titleCase } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { DateRangePicker } from '@/components/shared/date-range';
import { TrialBalanceFilters } from '@/app/(app)/reports/trial-balance/filters';
import { getShipmentOrdinals, shipmentOrdinalLabel } from '@/lib/services/shipment';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { ReportSummary } from '@/components/shared/report-summary';
import { dec } from '@/lib/money';

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
  }>;
}) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;
  const companyId = user.activeCompany.id;

  // "As at" is the closing date; a start date turns on opening and movement.
  const asOfDate = query.to
    ? new Date(`${query.to}T00:00:00.000Z`)
    : query.asOf
      ? new Date(`${query.asOf}T00:00:00.000Z`)
      : new Date();
  const fromDate = query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined;
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
      select: {
        id: true,
        currency: true,
        cashBankAccounts: { select: { currency: true }, orderBy: { currency: 'asc' } },
      },
    }),
  ]);
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
            <ExportLinks href={exportHref('trial-balance', { asOf: asOfDate.toISOString().slice(0, 10) })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Trial Balance"
        companyName={user.activeCompany.name}
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
        currencies={[...new Set(['USD', local, 'AED', 'MAD'])]}
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
          { label: 'Total debit', value: formatMoney(trial.totals.debitUsd, 'USD'), hint: formatMoney(trial.totals.debitLocal, local) },
          { label: 'Total credit', value: formatMoney(trial.totals.creditUsd, 'USD'), hint: formatMoney(trial.totals.creditLocal, local) },
          {
            label: 'Difference',
            value: formatMoney(dec(trial.totals.debitUsd).minus(trial.totals.creditUsd), 'USD'),
            lead: true,
            tone: trial.isBalanced ? 'default' : 'negative',
            hint: `${trial.rows.length} accounts with a balance`,
          },
        ]}
        status={
          trial.isBalanced
            ? { label: 'Balanced', ok: true, detail: 'Every debit has a matching credit.' }
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
          <CardTitle>Account balances</CardTitle>
          <CardDescription>
            {trial.hasOpening
              ? 'Where each account stood when the period opened, what moved through it, and where it stands now. Only accounts with a balance or a movement are listed.'
              : 'From the first entry to the date chosen, so the opening is nil and the movement is the whole history. Only accounts with a balance are listed.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Account</TH>
                  <TH>Type</TH>
                  {trial.hasOpening ? (
                    <>
                      <TH numeric>Opening debit</TH>
                      <TH numeric>Opening credit</TH>
                      <TH numeric>Debit movement</TH>
                      <TH numeric>Credit movement</TH>
                    </>
                  ) : null}
                  <TH numeric>{trial.hasOpening ? 'Closing debit' : 'Debit USD'}</TH>
                  <TH numeric>{trial.hasOpening ? 'Closing credit' : 'Credit USD'}</TH>
                  <TH numeric>Debit {local}</TH>
                  <TH numeric>Credit {local}</TH>
                </TR>
              </THead>
              <TBody>
                {trial.rows.map((row) => (
                  <TR key={row.accountId}>
                    <TD>
                      <Link
                        href={ledgerHref(row.accountId, currencyByAccount.get(row.accountId))}
                        className="font-medium text-forest-800 hover:text-gold-700"
                      >
                        {row.name}
                      </Link>
                    </TD>
                    <TD className="text-xs">{titleCase(row.type)}</TD>
                    {trial.hasOpening ? (
                      <>
                        <TD numeric className="text-ink-muted">
                          {row.openingDebitUsd.greaterThan(0) ? formatMoney(row.openingDebitUsd, 'USD') : '—'}
                        </TD>
                        <TD numeric className="text-ink-muted">
                          {row.openingCreditUsd.greaterThan(0) ? formatMoney(row.openingCreditUsd, 'USD') : '—'}
                        </TD>
                        <TD numeric>{row.periodDebitUsd.greaterThan(0) ? formatMoney(row.periodDebitUsd, 'USD') : '—'}</TD>
                        <TD numeric>{row.periodCreditUsd.greaterThan(0) ? formatMoney(row.periodCreditUsd, 'USD') : '—'}</TD>
                      </>
                    ) : null}
                    <TD numeric>{row.debitUsd.greaterThan(0) ? formatMoney(row.debitUsd, 'USD') : '—'}</TD>
                    <TD numeric>{row.creditUsd.greaterThan(0) ? formatMoney(row.creditUsd, 'USD') : '—'}</TD>
                    <TD numeric className="text-ink-muted">
                      {row.debitLocal.greaterThan(0) ? formatMoney(row.debitLocal, local) : '—'}
                    </TD>
                    <TD numeric className="text-ink-muted">
                      {row.creditLocal.greaterThan(0) ? formatMoney(row.creditLocal, local) : '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
              <TFoot>
                <tr>
                  <TD colSpan={2}>Total</TD>
                  {trial.hasOpening ? (
                    <>
                      <TD numeric>{formatMoney(trial.totals.openingDebitUsd, 'USD')}</TD>
                      <TD numeric>{formatMoney(trial.totals.openingCreditUsd, 'USD')}</TD>
                      <TD numeric>{formatMoney(trial.totals.periodDebitUsd, 'USD')}</TD>
                      <TD numeric>{formatMoney(trial.totals.periodCreditUsd, 'USD')}</TD>
                    </>
                  ) : null}
                  <TD numeric>{formatMoney(trial.totals.debitUsd, 'USD')}</TD>
                  <TD numeric>{formatMoney(trial.totals.creditUsd, 'USD')}</TD>
                  <TD numeric>{formatMoney(trial.totals.debitLocal, local)}</TD>
                  <TD numeric>{formatMoney(trial.totals.creditLocal, local)}</TD>
                </tr>
              </TFoot>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
