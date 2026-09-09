import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { previewRevaluation } from '@/lib/services/revaluation';
import { formatMoney, toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { RevaluationClient, type PreviewLine } from '@/app/(app)/accounting/revaluation/revaluation-client';

export const metadata: Metadata = { title: 'Currency Revaluation' };
export const dynamic = 'force-dynamic';

export default async function RevaluationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const params = await searchParams;
  const companyId = user.activeCompany.id;
  const local = user.activeCompany.localCurrency;

  const asOf = params.asOf ?? toDateInputValue(new Date());
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);

  // Currencies actually used by this company's ledger, other than USD.
  const used = await prisma.journalLine.findMany({
    where: { journalEntry: { companyId } },
    select: { currency: true },
    distinct: ['currency'],
  });
  const currencies = [...new Set([local, ...used.map((row) => row.currency)])]
    .filter((currency) => currency !== 'USD')
    .sort();

  const latest = await prisma.exchangeRate.findMany({
    where: { quoteCurrency: { in: currencies }, effectiveDate: { lte: asOfDate } },
    orderBy: { effectiveDate: 'desc' },
    distinct: ['quoteCurrency'],
    select: { quoteCurrency: true, rate: true },
  });
  const fallback: Record<string, string> = { AED: '3.6725', MAD: '9.85' };

  const rates = currencies.map((currency) => ({
    currency,
    rate:
      params[`rate_${currency}`] ??
      latest.find((row) => row.quoteCurrency === currency)?.rate.toString() ??
      fallback[currency] ??
      '1',
  }));

  const rateMap = Object.fromEntries(rates.map((row) => [row.currency, row.rate]));
  const preview = await transaction((tx) => previewRevaluation(tx, { companyId, asOf: asOfDate, rates: rateMap }));

  const lines: PreviewLine[] = preview.lines.map((line) => ({
    accountId: line.accountId,
    accountCode: line.accountCode,
    accountName: line.accountName,
    currency: line.currency,
    balanceUsd: formatMoney(line.balanceUsd, 'USD'),
    carriedLocal: formatMoney(line.carriedLocal, local),
    revaluedLocal: formatMoney(line.revaluedLocal, local),
    differenceLocal: formatMoney(line.differenceLocal, local),
    differenceValue: Number(line.differenceLocal),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Currency Revaluation"
        description="Restate foreign-currency balances at a closing rate and book the difference to exchange gain or loss."
        breadcrumbs={[{ label: 'Accounting' }, { label: 'Currency Revaluation' }]}
      />
      <RevaluationClient
        asOf={asOf}
        rates={rates}
        preview={lines}
        netDifference={formatMoney(preview.netDifferenceLocal, local)}
        localCurrency={local}
        canPost={can(user, PERMISSIONS.ACCOUNTING_POST)}
      />
    </div>
  );
}
