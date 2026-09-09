import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBalanceSheet } from '@/lib/services/reports';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { AsOfPicker } from '@/components/shared/date-range';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Callout } from '@/components/ui/feedback';
import { PrintButton } from '@/components/shared/print-button';
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
              <span className="text-ink-subtle">{line.code}</span> {line.name}
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
        actions={<PrintButton />}
      />
      <PrintHeader
        title="Balance Sheet"
        companyName={user.activeCompany.name}
        country={user.activeCompany.country}
      />

      <AsOfPicker defaultDate={asOfDate.toISOString().slice(0, 10)} />

      {!sheet.balancesUsd ? (
        <Callout tone="danger" title="The balance sheet does not balance">
          Assets differ from liabilities plus equity by {formatMoney(sheet.differenceUsd, 'USD')}. This should never
          happen — every posting is balanced by construction. Check the journal for an entry posted outside the
          application.
        </Callout>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {[
          { label: 'Assets', value: sheet.assets.totalUsd },
          { label: 'Liabilities', value: sheet.liabilities.totalUsd },
          { label: 'Equity', value: sheet.equity.totalUsd },
        ].map((card) => (
          <Card key={card.label} className="p-4">
            <p className="text-xs font-medium text-ink-muted">{card.label}</p>
            <p className="tnum mt-1 text-lg font-semibold text-ink">{formatMoney(card.value, 'USD')}</p>
          </Card>
        ))}
      </div>

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
