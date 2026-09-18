import type { Metadata } from 'next';
import Link from 'next/link';
import { ReportSummary } from '@/components/shared/report-summary';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBalanceSheet } from '@/lib/services/reports';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { AsOfPicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import type { BalanceSheetSection } from '@/lib/services/reports';

export const metadata: Metadata = { title: 'Balance Sheet' };
export const dynamic = 'force-dynamic';

export default async function BalanceSheetPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const { asOf } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const asOfDate = asOf ? new Date(`${asOf}T00:00:00.000Z`) : new Date();
  const sheet = await getBalanceSheet({ companyId: user.activeCompany.id, asOf: asOfDate });

  const renderSection = (section: BalanceSheetSection) => (
    <>
      <TR className="bg-forest-50/40 hover:bg-forest-50/40">
        <TD colSpan={3} className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
          {section.title}
        </TD>
      </TR>
      {section.lines.length === 0 ? (
        <TR>
          <TD colSpan={3} className="text-xs text-ink-subtle">
            Nothing to show.
          </TD>
        </TR>
      ) : (
        section.lines.map((line) => (
          <TR key={`${section.title}-${line.code}`}>
            <TD>
              {/* Each balance opens the movements behind it. A derived line
                  such as the current period result has no account to open. */}
              {line.accountId ? (
                <Link
                  href={`/reports/general-ledger?account=${line.accountId}`}
                  className="text-forest-800 hover:text-gold-700 hover:underline"
                >
                  {line.name}
                </Link>
              ) : (
                line.name
              )}
            </TD>
            <TD numeric>{formatMoney(line.amountUsd, 'USD')}</TD>
            <TD numeric className="text-ink-muted">{formatMoney(line.amountLocal, local)}</TD>
          </TR>
        ))
      )}
      <TR className="border-t-2 border-line-strong font-semibold">
        <TD>Total {section.title.toLowerCase()}</TD>
        <TD numeric>{formatMoney(section.totalUsd, 'USD')}</TD>
        <TD numeric className="text-ink-muted">{formatMoney(section.totalLocal, local)}</TD>
      </TR>
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Balance Sheet"
        description={`${user.activeCompany.name} · as at ${formatDate(asOfDate)}`}
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Balance Sheet' }]}
        actions={
          <>
            <ExportLinks href={exportHref('balance-sheet', { asOf })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader
        title="Balance Sheet"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <AsOfPicker defaultDate={asOfDate.toISOString().slice(0, 10)} />

      {/* What the company owns, what it owes, and what is left — with the one
          check that matters stated rather than left to be worked out. */}
      <ReportSummary
        figures={[
          { label: 'Total assets', value: formatMoney(sheet.assets.totalUsd, 'USD'), hint: formatMoney(sheet.assets.totalLocal, local) },
          { label: 'Total liabilities', value: formatMoney(sheet.liabilities.totalUsd, 'USD'), hint: formatMoney(sheet.liabilities.totalLocal, local) },
          { label: 'Total equity', value: formatMoney(sheet.equity.totalUsd, 'USD'), hint: formatMoney(sheet.equity.totalLocal, local) },
          {
            label: 'Liabilities + equity',
            value: formatMoney(sheet.liabilities.totalUsd.plus(sheet.equity.totalUsd), 'USD'),
            lead: true,
            hint: 'Should equal total assets',
          },
        ]}
        status={
          sheet.balancesUsd
            ? { label: 'Balanced', ok: true, detail: 'Assets equal liabilities plus equity.' }
            : {
                label: 'Attention required',
                ok: false,
                detail: `Assets differ from liabilities plus equity by ${formatMoney(sheet.differenceUsd, 'USD')}. Every posting balances by construction, so this points at an entry written outside the application.`,
              }
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Statement</CardTitle>
          <CardDescription>
            Built from the double-entry records. Inventory appears as an asset at landed cost; coffee still on the
            water sits in Inventory in Transit.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap className="rounded-none border-0 border-t">
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Account</TH>
                  <TH numeric>USD</TH>
                  <TH numeric>{local}</TH>
                </TR>
              </THead>
              <TBody>
                {renderSection(sheet.assets)}
                {renderSection(sheet.liabilities)}
                {renderSection(sheet.equity)}
                <TR className="border-t-2 border-line-strong bg-forest-50 font-semibold hover:bg-forest-50">
                  <TD>Liabilities and equity</TD>
                  <TD numeric>
                    {formatMoney(sheet.liabilities.totalUsd.plus(sheet.equity.totalUsd), 'USD')}
                  </TD>
                  <TD numeric className="text-ink-muted">
                    {formatMoney(sheet.liabilities.totalLocal.plus(sheet.equity.totalLocal), local)}
                  </TD>
                </TR>
              </TBody>
            </Table>
          </TableWrap>
        </CardContent>
      </Card>
    </div>
  );
}
