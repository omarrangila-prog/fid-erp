import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { currencyName } from '@/lib/currencies';
import { formatDate, formatRate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { RateForm } from '@/app/(app)/settings/exchange-rates/rate-form';

export const metadata: Metadata = { title: 'Exchange Rates' };
export const dynamic = 'force-dynamic';

export default async function ExchangeRatesPage() {
  const user = await requirePageAccess(PERMISSIONS.SETTINGS_MANAGE);
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency.toUpperCase();

  const rows = await prisma.exchangeRate.findMany({
    where: { OR: [{ companyId }, { companyId: null }] },
    orderBy: [{ effectiveDate: 'desc' }, { quoteCurrency: 'asc' }],
    take: 400,
  });
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.quoteCurrency) || (row.companyId && !latest.get(row.quoteCurrency)!.companyId && row.effectiveDate >= latest.get(row.quoteCurrency)!.effectiveDate)) latest.set(row.quoteCurrency, row);

  const wanted = [...new Set([local, ...(user.activeCompany.transactionCurrencies ?? []), ...(user.activeCompany.salesCurrencies ?? [])].map((c) => c.toUpperCase()))].filter((c) => c !== 'USD');
  const missing = wanted.filter((c) => !latest.has(c));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Exchange Rates"
        description={`Units of each currency per 1 US dollar. They are the starting rate offered on new documents — every document keeps the rate it was entered at, so changing one here never restates anything already posted.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Settings', href: '/settings' }, { label: 'Exchange rates' }]}
      />
      {missing.length > 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900" role="status">
          No rate on file for <strong>{missing.join(', ')}</strong>. Add one below so new documents do not start at 1.
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Add or correct a rate</CardTitle>
          <CardDescription>Choose the currency, the day it starts and “1 USD =” how many units.</CardDescription>
        </CardHeader>
        <CardContent>
          <RateForm suggested={wanted} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Rates on file</CardTitle>
          <CardDescription>Latest first. Shared rates apply to every company until it enters its own.</CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <TableWrap>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Currency</TH>
                  <TH numeric>1 USD =</TH>
                  <TH>From</TH>
                  <TH>Set by</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <span className="font-semibold">{r.quoteCurrency}</span> <span className="text-xs text-ink-subtle">{currencyName(r.quoteCurrency)}</span>
                    </TD>
                    <TD numeric>{formatRate(r.rate)}</TD>
                    <TD>{formatDate(r.effectiveDate)}</TD>
                    <TD className="text-xs text-ink-muted">{r.companyId ? 'This company' : 'Shared default'}</TD>
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
