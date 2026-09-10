import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity } from '@/lib/money';
import { SHIPMENT_STATUSES_IN_TRANSIT } from '@/lib/constants';
import { getFinancialPosition } from '@/lib/services/reports';
import { getCompanyProfitSummary } from '@/lib/services/profitability';
import { getReceivables, getPayables } from '@/lib/services/receivables';

/**
 * The whole business on one screen.
 *
 * Deliberately assembled from the same services the individual reports use, so
 * a figure here can never disagree with the report it links to — the commonest
 * way an overview screen loses a management team's trust.
 */

export type OverviewFigure = {
  label: string;
  value: string;
  /** Currency code when the figure is money, so it is never shown bare. */
  currency?: string;
  hint?: string;
  href?: string;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
};

export type OverviewSection = { title: string; figures: OverviewFigure[] };

export async function getBusinessOverview(params: {
  companyId: string;
  localCurrency: string;
  from?: Date;
  to?: Date;
  showCost: boolean;
  showProfit: boolean;
}) {
  const { companyId, localCurrency } = params;

  const [position, profit, receivables, payables, warehouses, containers, openPurchases, shipments] =
    await Promise.all([
      getFinancialPosition({ companyId }),
      getCompanyProfitSummary({ companyId, from: params.from, to: params.to }),
      getReceivables({ companyId, onlyOutstanding: true }),
      getPayables({ companyId, onlyOutstanding: true }),
      prisma.$queryRaw<Array<{ id: string; code: string; name: string; kg: string; value: string }>>`
        SELECT w."id", w."code", w."name",
               COALESCE(SUM(ib."onHandKg"), 0)::text AS kg,
               COALESCE(SUM(ib."onHandKg" * b."landedUnitCostUsd"), 0)::text AS value
        FROM warehouses w
        LEFT JOIN inventory_balances ib ON ib."warehouseId" = w."id"
        LEFT JOIN batches b ON b."id" = ib."batchId"
        WHERE w."companyId" = ${companyId} AND w."status" = 'ACTIVE'
        GROUP BY w."id", w."code", w."name"
        ORDER BY w."name"`,
      prisma.$queryRaw<Array<{ landed: bigint; transit: bigint }>>`
        SELECT
          COUNT(*) FILTER (WHERE s."status" = ANY(${['ARRIVED', 'CUSTOMS_CLEARING', 'CLEARED', 'DELIVERED']}))::bigint AS landed,
          COUNT(*) FILTER (WHERE s."status" = ANY(${SHIPMENT_STATUSES_IN_TRANSIT}))::bigint AS transit
        FROM containers c
        JOIN shipments s ON s."id" = c."shipmentId"
        WHERE c."companyId" = ${companyId}`,
      prisma.$queryRaw<Array<{ c: bigint }>>`
        SELECT COUNT(DISTINCT pc."id")::bigint AS c
        FROM purchase_contracts pc
        JOIN batches b ON b."purchaseContractId" = pc."id"
        WHERE pc."companyId" = ${companyId} AND pc."status" = 'POSTED'
          AND b."receivedQuantityKg" < b."orderedQuantityKg"`,
      prisma.shipment.findMany({
        where: { companyId, status: { in: SHIPMENT_STATUSES_IN_TRANSIT as never[] } },
        select: { id: true, shipmentNumber: true, etaDate: true },
        orderBy: { etaDate: 'asc' },
      }),
    ]);

  const overdue = receivables.filter((r) => r.bucket !== 'CURRENT');
  const overdueTotal = overdue.reduce((sum, r) => sum.plus(r.outstandingAmountUsd), new Decimal(0));
  const openInvoices = receivables.length;

  const soon = shipments.filter(
    (s) => s.etaDate && s.etaDate.getTime() - Date.now() < 30 * 86_400_000,
  ).length;

  const money = (v: Decimal | string | number, currency: string) => ({
    value: toMoney(v).toFixed(2),
    currency,
  });

  const byCurrency = position.currencyTotals;
  const cash = (currency: string, kind: 'cash' | 'bank') =>
    dec(byCurrency.find((c) => c.currency === currency)?.[kind] ?? 0);

  const sections: OverviewSection[] = [];

  // Cash and bank, one figure per currency and never added together.
  const currencies = [...new Set([localCurrency, 'USD', ...byCurrency.map((c) => c.currency)])];
  sections.push({
    title: 'Cash and bank',
    figures: currencies.flatMap((currency) => [
      { label: `Cash ${currency}`, ...money(cash(currency, 'cash'), currency), href: '/finance/cash-bank' },
      { label: `Bank ${currency}`, ...money(cash(currency, 'bank'), currency), href: '/finance/cash-bank' },
    ]),
  });

  sections.push({
    title: 'Who owes what',
    figures: [
      {
        label: 'Customer receivable',
        ...money(position.receivableUsd, 'USD'),
        hint: `${openInvoices} open invoice${openInvoices === 1 ? '' : 's'}`,
        href: '/finance/receivables',
      },
      {
        label: 'Overdue receivable',
        ...money(overdueTotal, 'USD'),
        hint: `${overdue.length} invoice${overdue.length === 1 ? '' : 's'} past due`,
        tone: overdue.length > 0 ? 'warning' : 'default',
        href: '/finance/receivables',
      },
      {
        label: 'Vendor payable',
        ...money(position.payableUsd, 'USD'),
        hint: `${payables.length} open contract${payables.length === 1 ? '' : 's'}`,
        href: '/finance/payables',
      },
    ],
  });

  const stockFigures: OverviewFigure[] = [
    { label: 'Inventory on hand', value: toQuantity(position.availableKg).toFixed(3), currency: 'KG', href: '/inventory' },
    { label: 'Coffee in transit', value: toQuantity(position.inTransitKg).toFixed(3), currency: 'KG', href: '/shipments' },
  ];
  if (params.showCost) {
    stockFigures.push(
      // /inventory is the valuation view: valued stock on hand, per warehouse.
      // It pointed at /reports/inventory-valuation, which does not exist — so
      // the figure was a dead link, and Next prefetched the 404 on every visit.
      { label: 'Inventory value', ...money(position.inventoryValueUsd, 'USD'), href: '/inventory' },
      { label: 'In-transit value', ...money(position.inTransitValueUsd, 'USD'), href: '/shipments' },
    );
  }
  for (const warehouse of warehouses) {
    stockFigures.push({
      label: warehouse.name,
      value: toQuantity(warehouse.kg).toFixed(3),
      currency: 'KG',
      hint: warehouse.code,
      href: '/inventory',
    });
  }
  sections.push({ title: 'Stock', figures: stockFigures });

  sections.push({
    title: 'Logistics',
    figures: [
      { label: 'Containers landed', value: String(Number(containers[0]?.landed ?? 0)), href: '/shipments' },
      { label: 'Containers in transit', value: String(Number(containers[0]?.transit ?? 0)), href: '/shipments' },
      { label: 'Active shipments', value: String(shipments.length), href: '/shipments' },
      { label: 'Arriving within 30 days', value: String(soon), href: '/shipments' },
      { label: 'Open purchase orders', value: String(Number(openPurchases[0]?.c ?? 0)), href: '/purchases' },
    ],
  });

  if (params.showProfit) {
    sections.push({
      title: 'Trading result',
      figures: [
        { label: 'Sales revenue', ...money(profit.revenueUsd, 'USD'), href: '/reports/profit-loss' },
        { label: 'Cost of goods sold', ...money(profit.cogsUsd, 'USD'), href: '/reports/profit-loss' },
        {
          label: 'Gross profit',
          ...money(profit.grossProfitUsd, 'USD'),
          hint: `${profit.grossMarginPct.toString()}% margin`,
          tone: dec(profit.grossProfitUsd).greaterThanOrEqualTo(0) ? 'positive' : 'negative',
          href: '/reports/profit-loss',
        },
        { label: 'Operating expenses', ...money(profit.expensesUsd, 'USD'), href: '/reports/expenses' },
        {
          label: 'Net profit',
          ...money(profit.netProfitUsd, 'USD'),
          hint: `${profit.netMarginPct.toString()}% margin`,
          tone: dec(profit.netProfitUsd).greaterThanOrEqualTo(0) ? 'positive' : 'negative',
          href: '/reports/profit-loss',
        },
      ],
    });
  }

  return { sections, localCurrency };
}
