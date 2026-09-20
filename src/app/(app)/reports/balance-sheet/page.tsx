import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getBalanceSheet, type BalanceSheetLine } from '@/lib/services/reports';
import { formatMoney, formatDate } from '@/lib/format';
import { Decimal, dec } from '@/lib/money';
import { PageHeader } from '@/components/shared/page-header';
import { AsOfPicker } from '@/components/shared/date-range';
import { Card, CardContent } from '@/components/ui/card';
import { PrintButton } from '@/components/shared/print-button';
import { exportHref } from '@/components/shared/excel-link';
import { ExportLinks } from '@/components/shared/export-links';
import { PrintHeader } from '@/components/shared/print-header';
import { Badge } from '@/components/ui/badge';
import {
  Statement,
  StatementControls,
  StatementHeader,
  FavouriteStar,
  type StatementCell,
  type StatementSectionData,
} from '@/components/reports/report-statement';

export const metadata: Metadata = { title: 'Balance Sheet' };
export const dynamic = 'force-dynamic';

type Sheet = Awaited<ReturnType<typeof getBalanceSheet>>;

/**
 * The balance sheet as an accountant lays it out: assets split into current
 * and fixed with a subtotal for each, then liabilities, then equity, and the
 * equation checked at the bottom. Optionally the same statement as at the
 * previous period's end or a year earlier, with the change beside each line.
 */
export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; compare?: string; zero?: string }>;
}) {
  const query = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.ACCOUNTING_VIEW);
  const local = user.activeCompany.localCurrency;

  const asOfDate = query.asOf ? new Date(`${query.asOf}T00:00:00.000Z`) : new Date();
  const compare = (['previous', 'year'].includes(query.compare ?? '') ? query.compare : 'none') as 'none' | 'previous' | 'year';
  const showZero = query.zero === '1';

  // "Previous period" on a point-in-time statement is the end of the month
  // before; "previous year" is the same date a year back.
  const compareDate =
    compare === 'year'
      ? new Date(Date.UTC(asOfDate.getUTCFullYear() - 1, asOfDate.getUTCMonth(), asOfDate.getUTCDate()))
      : compare === 'previous'
        ? new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth(), 0))
        : null;

  const [sheet, before] = await Promise.all([
    getBalanceSheet({ companyId: user.activeCompany.id, asOf: asOfDate }),
    compareDate ? getBalanceSheet({ companyId: user.activeCompany.id, asOf: compareDate }) : Promise.resolve(null as Sheet | null),
  ]);
  const asOf = asOfDate.toISOString().slice(0, 10);

  const money = (value: Decimal, muted = false): StatementCell => ({ value: formatMoney(value, 'USD'), muted });
  const changeCells = (now: Decimal, then: Decimal): StatementCell[] => {
    const delta = now.minus(then);
    const pct = then.isZero() ? null : delta.dividedBy(then.abs()).times(100);
    return [
      money(then, true),
      { value: formatMoney(delta, 'USD'), tone: delta.isNegative() ? 'negative' : delta.isZero() ? undefined : 'positive' },
      { value: pct === null ? (delta.isZero() ? '—' : 'new') : `${pct.greaterThanOrEqualTo(0) ? '+' : ''}${pct.toFixed(1)}%`, muted: true },
    ];
  };
  const columns = ['Total', ...(before ? [compare === 'year' ? 'Previous year' : 'Previous period', 'Change', '% change'] : [])];

  /** One section per sub-heading — Current assets, Fixed assets — from both dates. */
  const sectionsFor = (
    now: BalanceSheetLine[],
    then: BalanceSheetLine[] | undefined,
    groups: string[],
    keyPrefix: string,
  ): StatementSectionData[] =>
    groups
      .map((group) => {
        const ordered = new Map<string, BalanceSheetLine>();
        for (const line of now.filter((l) => l.group === group)) ordered.set(line.accountId || line.name, line);
        for (const line of then?.filter((l) => l.group === group) ?? []) if (!ordered.has(line.accountId || line.name)) ordered.set(line.accountId || line.name, line);
        const amount = (list: BalanceSheetLine[] | undefined, key: string) =>
          dec(list?.find((l) => (l.accountId || l.name) === key)?.amountUsd ?? 0);
        const lines = [...ordered.entries()]
          .filter(([key]) => showZero || !amount(now, key).isZero() || (then ? !amount(then, key).isZero() : false))
          .map(([key, line]) => ({
            key: `${keyPrefix}-${key}`,
            label: line.name,
            href: line.accountId ? `/reports/general-ledger?account=${line.accountId}&to=${asOf}` : undefined,
            cells: [money(amount(now, key)), ...(then ? changeCells(amount(now, key), amount(then, key)) : [])],
          }));
        const totalNow = lines.reduce((a, l) => a.plus(amount(now, l.key.slice(keyPrefix.length + 1))), new Decimal(0));
        const totalThen = then ? lines.reduce((a, l) => a.plus(amount(then, l.key.slice(keyPrefix.length + 1))), new Decimal(0)) : null;
        return {
          key: `${keyPrefix}-${group}`,
          title: group,
          lines,
          total: {
            label: `Total ${group.toLowerCase()}`,
            cells: [money(totalNow), ...(totalThen !== null ? changeCells(totalNow, totalThen) : [])],
          },
        };
      })
      .filter((section) => section.lines.length > 0 || showZero);

  const assetSections = sectionsFor(sheet.assets.lines, before?.assets.lines, ['Current assets', 'Fixed assets'], 'asset');
  const liabilitySections = sectionsFor(sheet.liabilities.lines, before?.liabilities.lines, ['Current liabilities', 'Long-term liabilities'], 'liability');
  const equitySections = sectionsFor(sheet.equity.lines, before?.equity.lines, ['Equity'], 'equity');
  const sections = [...assetSections, ...liabilitySections, ...equitySections];

  const totalRow = (label: string, now: Decimal, then: Decimal | undefined, after: string, emphasis: 'strong' | 'final') => ({
    after,
    label,
    emphasis,
    cells: [money(now), ...(then !== undefined ? changeCells(now, then) : [])],
  });
  const lastAsset = assetSections.at(-1)?.key ?? '';
  const lastLiability = liabilitySections.at(-1)?.key ?? '';
  const lastEquity = equitySections.at(-1)?.key ?? '';
  const liabilitiesAndEquity = sheet.liabilities.totalUsd.plus(sheet.equity.totalUsd);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Balance Sheet"
        description="What the company owns, owes and is worth, as at any date."
        breadcrumbs={[{ label: 'Reports', href: '/reports' }, { label: 'Balance Sheet' }]}
        meta={
          <Badge tone={sheet.balancesUsd ? 'success' : 'danger'}>
            {sheet.balancesUsd ? 'Assets = Liabilities + Equity' : 'Attention required'}
          </Badge>
        }
        actions={
          <>
            <FavouriteStar href="/reports/balance-sheet" label="Balance Sheet" />
            <ExportLinks href={exportHref('balance-sheet', { asOf })} />
            <PrintButton />
          </>
        }
      />
      <PrintHeader title="Balance Sheet" companyName={user.activeCompany.name} country={user.activeCompany.country} />

      <div className="flex flex-wrap items-end gap-3 print:hidden">
        <AsOfPicker defaultDate={asOf} />
        <StatementControls compare={compare} showColumnsBy={false} showZero={showZero} />
      </div>

      <Card>
        <CardContent className="px-2 pb-4 pt-2 sm:px-4">
          <StatementHeader
            company={user.activeCompany.name}
            title="Balance Sheet"
            period={`As at ${formatDate(asOfDate)}`}
            meta={compareDate ? <p className="text-xs text-ink-subtle">Compared with {formatDate(compareDate)}</p> : null}
          />
          <Statement
            report="balance-sheet"
            columns={columns}
            sections={sections}
            grandTotals={[
              totalRow('Total assets', sheet.assets.totalUsd, before?.assets.totalUsd, lastAsset, 'strong'),
              totalRow('Total liabilities', sheet.liabilities.totalUsd, before?.liabilities.totalUsd, lastLiability, 'strong'),
              totalRow('Total equity', sheet.equity.totalUsd, before?.equity.totalUsd, lastEquity, 'strong'),
              totalRow(
                'Total liabilities and equity',
                liabilitiesAndEquity,
                before ? before.liabilities.totalUsd.plus(before.equity.totalUsd) : undefined,
                lastEquity,
                'final',
              ),
            ]}
          />
          <p className={`mt-3 px-3 text-xs ${sheet.balancesUsd ? 'text-ink-subtle' : 'font-medium text-red-700'}`}>
            {sheet.balancesUsd
              ? `Assets ${formatMoney(sheet.assets.totalUsd, 'USD')} = liabilities ${formatMoney(sheet.liabilities.totalUsd, 'USD')} + equity ${formatMoney(sheet.equity.totalUsd, 'USD')}. In ${local}: assets ${formatMoney(sheet.assets.totalLocal, local)}.`
              : `Assets and liabilities plus equity differ by ${formatMoney(sheet.differenceUsd, 'USD')}. The posting engine refuses unbalanced entries, so this points at data written outside the application.`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
