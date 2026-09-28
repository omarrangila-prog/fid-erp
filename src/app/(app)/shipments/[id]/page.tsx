import type { Metadata } from 'next';
import { CostingTable } from '@/components/shared/costing-table';
import { getBatchCostings } from '@/lib/services/landed-cost';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import {
  PERMISSIONS,
  SHIPMENT_STATUS_META,
  DOCUMENT_STATUS_META,
  SETTLEMENT_STATUS_META,
  INCOTERM_LABELS,
  SHIPMENT_STATUSES_LANDED,
} from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { dec } from '@/lib/money';
import { getShipmentSettlement } from '@/lib/services/shipment';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { DualAmount } from '@/components/shared/dual-amount';
import { getReceivables } from '@/lib/services/receivables';
import { shortDocumentNumber } from '@/lib/short-number';
import { getJobCostSummary, getShipmentCostSheet } from '@/lib/services/landed-cost';
import { getBatchStock } from '@/lib/services/stock';
import { formatMoney, formatQuantityKg, formatQuantityMt, formatDate, formatDateTime, formatPercent, formatRate, toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Metric, MetricGrid, DetailRow } from '@/components/shared/stat-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { StatusBadge, Badge } from '@/components/ui/badge';
import { Table, TableWrap, TBody, TD, TFoot, TH, THead, TR } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { ShipmentWorkflow } from '@/app/(app)/shipments/[id]/shipment-workflow';
import { Plus } from 'lucide-react';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const shipment = await prisma.shipment.findUnique({ where: { id }, select: { shipmentNumber: true } });
  return { title: shipment?.shipmentNumber ?? 'Shipment' };
}

export default async function ShipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.SHIPMENTS_VIEW);
  const companyId = user.activeCompany.id;
  const showProfit = can(user, PERMISSIONS.PROFITS_VIEW);
  const showCost = can(user, PERMISSIONS.PURCHASE_COST_VIEW);

  const shipment = await prisma.shipment.findFirst({
    where: { id, companyId },
    include: {
      purchaseContract: {
        select: {
          id: true,
          contractNumber: true,
          contractReference: true,
          currency: true,
          // Every shipment on the same order, so this one knows it is "2 of 3"
          // and the reader can step to its siblings without going back.
          shipments: { orderBy: { createdAt: 'asc' }, select: { id: true, status: true } },
        },
      },
      vendor: { select: { id: true, vendorName: true } },
      customer: { select: { id: true, customerName: true } },
      item: { select: { itemName: true, originCountry: true, grade: true } },
      shippingLine: { select: { id: true, name: true } },
    },
  });

  if (!shipment) notFound();

  /*
   * The whole shipment, not the record that happened to be opened.
   *
   * ICUL/FID/002 was entered as one record holding both its containers, so
   * its page always showed the whole shipment. Orders entered since hold one
   * record per container, and each container's page showed only itself —
   * three "shipments" for one ICUL/FID reference. The page now loads every
   * record on the order, so every shipment reads the way ICUL/FID/002 does.
   * Status and logistics actions still apply to the container opened.
   */
  const records = await prisma.shipment.findMany({
    where: { companyId, purchaseContractId: shipment.purchaseContract.id },
    orderBy: { createdAt: 'asc' },
    include: {
      item: { select: { itemName: true } },
      containerList: { orderBy: { containerNumber: 'asc' } },
      statusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: { name: true } } } },
      docStatusHistory: { orderBy: { changedAt: 'desc' }, include: { changedBy: { select: { name: true } } } },
    },
  });
  const ids = records.map((r) => r.id);
  const local = user.activeCompany.localCurrency;
  const containerLabel = (recordId: string) => {
    const index = records.findIndex((r) => r.id === recordId);
    const numbers = records[index]?.containerList.map((c) => c.containerNumber).join(', ');
    return `Container ${index + 1}${numbers ? ` · ${numbers}` : ''}`;
  };

  /*
   * The sales from this shipment's coffee: every invoice with a line sold from
   * one of its batches, and how much of the invoice that was. By the lines,
   * not the invoice header, which may name another container or none — the
   * reason a sold-out SCREEN 18 container once showed almost no sales.
   *
   * An edited invoice keeps its id and has its lines replaced, so what is read
   * here is always the invoice as it stands now. Drafts are listed too, marked,
   * and left out of every total until they are posted.
   */
  const soldFromHere = await prisma.$queryRaw<
    Array<{
      id: string;
      invoiceNumber: string;
      invoiceDate: Date;
      status: string;
      currency: string;
      rate: string;
      customerName: string;
      containers: string | null;
      kg: string;
      amount: string;
      usd: string;
      invoiceSubtotal: string;
    }>
  >`
    SELECT si."id", si."invoiceNumber", si."invoiceDate", si."status"::text AS status, si."currency",
           si."rateLocalPerUsd"::text AS rate, c."customerName", si."subtotal"::text AS "invoiceSubtotal",
           string_agg(DISTINCT ct."containerNumber", ', ') AS containers,
           SUM(sil."quantityKg")::text AS kg, SUM(sil."lineTotal")::text AS amount, SUM(sil."lineTotalUsd")::text AS usd
    FROM sales_invoice_lines sil
    JOIN sales_invoices si ON si."id" = sil."salesInvoiceId"
    JOIN batches b ON b."id" = sil."batchId"
    LEFT JOIN containers ct ON ct."id" = b."containerId"
    JOIN customers c ON c."id" = si."customerId"
    WHERE si."companyId" = ${companyId} AND b."shipmentId" = ANY(${ids}) AND si."status" IN ('POSTED', 'DRAFT')
    GROUP BY si."id", si."invoiceNumber", si."invoiceDate", si."status", si."currency", si."rateLocalPerUsd",
             c."customerName", si."subtotal"
    ORDER BY si."invoiceDate" DESC, si."invoiceNumber" DESC`;
  const invoiceIds = soldFromHere.map((inv) => inv.id);

  const [settlements, pnlRows, jobCost, costSheet, batches, orderExpenses, shippingLines, customers, ports, invoiceEdits, receivables] = await Promise.all([
    Promise.all(ids.map((recordId) => getShipmentSettlement(prisma as never, companyId, recordId))),
    showProfit ? getShipmentProfitability({ companyId }) : Promise.resolve([]),
    showCost ? transaction((tx) => getJobCostSummary(tx, companyId, ids)) : Promise.resolve(null),
    showCost ? getShipmentCostSheet(companyId, shipment.id, { wholeOrder: true }) : Promise.resolve(null),
    getBatchStock({ companyId, purchaseContractId: shipment.purchaseContract.id, includeEmpty: true }),
    prisma.expense.findMany({
      where: { companyId, shipmentId: { in: ids }, status: 'POSTED' },
      include: { expenseCategory: { select: { name: true } } },
      orderBy: { expenseDate: 'desc' },
    }),
    prisma.shippingLine.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.customer.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true },
    }),
    prisma.port.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ country: 'asc' }, { name: 'asc' }],
      select: { id: true, code: true, name: true, country: true },
    }),
    // How often each invoice was corrected, when last and by whom.
    invoiceIds.length
      ? prisma.$queryRaw<Array<{ entityId: string; edits: number; lastEdited: Date; lastBy: string | null }>>`
          SELECT a."entityId", COUNT(*)::int AS edits, MAX(a."createdAt") AS "lastEdited",
                 (array_agg(u."name" ORDER BY a."createdAt" DESC))[1] AS "lastBy"
          FROM audit_logs a
          LEFT JOIN users u ON u."id" = a."userId"
          WHERE a."companyId" = ${companyId} AND a."entityType" = 'SalesInvoice'
            AND a."action" = 'SALES_INVOICE_UPDATED' AND a."entityId" = ANY(${invoiceIds})
          GROUP BY a."entityId"`
      : Promise.resolve([]),
    // Paid, partly paid or unpaid: the same answer the invoice list gives.
    invoiceIds.length ? getReceivables({ companyId }) : Promise.resolve([]),
  ]);
  const editsByInvoice = new Map(invoiceEdits.map((e) => [e.entityId, e]));
  const receivableByInvoice = new Map(receivables.map((r) => [r.invoiceId, r]));
  // The posted sales, in the company's currency at each invoice's own rate.
  const postedSales = soldFromHere.filter((inv) => inv.status === 'POSTED');
  const salesKg = postedSales.reduce((t, inv) => t.plus(dec(inv.kg)), dec(0));
  const salesUsd = postedSales.reduce((t, inv) => t.plus(dec(inv.usd)), dec(0));
  const salesLocal = postedSales.reduce(
    (t, inv) => t.plus(inv.currency === local ? dec(inv.amount) : dec(inv.usd).times(dec(inv.rate))),
    dec(0),
  );

  const costing = await getBatchCostings({ companyId, purchaseContractId: shipment.purchaseContract.id });
  const localPerKg = new Map(costing.map((c) => [c.batchId, c.landedPerKgLocal]));

  // The order's money, added up once from its containers.
  const settlement = (() => {
    const invoicedUsd = settlements.reduce((t, x) => t.plus(x.invoicedUsd), dec(0));
    const receivedUsd = settlements.reduce((t, x) => t.plus(x.receivedUsd), dec(0));
    const outstandingUsd = invoicedUsd.minus(receivedUsd);
    const status = invoicedUsd.isZero() ? 'UNPAID' : outstandingUsd.lessThanOrEqualTo('0.005') ? 'PAID' : receivedUsd.greaterThan(0) ? 'PARTIAL' : 'UNPAID';
    return { invoicedUsd, receivedUsd, outstandingUsd, status };
  })();
  const mine = pnlRows.filter((row) => ids.includes(row.shipmentId));
  const total = (pick: (row: (typeof mine)[number]) => Parameters<typeof dec>[0]) => mine.reduce((t, row) => t.plus(dec(pick(row))), dec(0));
  const profit = showProfit && mine.length
    ? (() => {
        const soldKg = total((r) => r.soldQuantityKg);
        const revenueUsd = total((r) => r.salesRevenueUsd);
        const grossUsd = total((r) => r.grossProfitUsd);
        const netUsd = total((r) => r.netProfitUsd);
        const netLocal = total((r) => r.netProfitLocal);
        const pct = (part: ReturnType<typeof dec>) => (revenueUsd.greaterThan(0) ? part.dividedBy(revenueUsd).times(100) : dec(0));
        return {
          soldQuantityKg: soldKg,
          remainingQuantityKg: total((r) => r.remainingQuantityKg),
          salesRevenueUsd: revenueUsd,
          salesRevenueLocal: total((r) => r.salesRevenueLocal),
          allocatedLandedCostUsd: total((r) => r.allocatedLandedCostUsd),
          allocatedLandedCostLocal: total((r) => r.allocatedLandedCostLocal),
          grossProfitUsd: grossUsd,
          grossProfitLocal: total((r) => r.grossProfitLocal),
          grossMarginPct: pct(grossUsd),
          otherCostsUsd: total((r) => r.otherCostsUsd),
          otherCostsLocal: total((r) => r.otherCostsLocal),
          netProfitUsd: netUsd,
          netProfitLocal: netLocal,
          netMarginPct: pct(netUsd),
          profitPerKgUsd: soldKg.greaterThan(0) ? netUsd.dividedBy(soldKg) : dec(0),
          profitPerKgLocal: soldKg.greaterThan(0) ? netLocal.dividedBy(soldKg) : dec(0),
        };
      })()
    : null;
  // Sales in the company's currency are at each invoice's own rate; this is
  // their weighted rate, used only to restate what has been received.
  const salesRate = profit && profit.salesRevenueUsd.greaterThan(0) ? profit.salesRevenueLocal.dividedBy(profit.salesRevenueUsd) : null;

  const quantityKg = records.reduce((t, r) => t.plus(dec(r.quantityKg)), dec(0));
  const bags = records.reduce((t, r) => t + r.bags, 0);
  const containerCount = records.reduce((t, r) => t + r.containers, 0);
  const lastEta = records.map((r) => r.etaDate).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0] ?? null;
  const items = [...new Set(records.map((r) => r.item.itemName))];
  const statuses = [...new Set(records.map((r) => r.status))];
  const arrived = records.filter((r) => SHIPMENT_STATUSES_LANDED.includes(r.status)).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title={shipment.purchaseContract.contractReference}
        description={`${items.join(' / ')} · ${shipment.vendor.vendorName}`}
        breadcrumbs={[{ label: 'Trading' }, { label: 'Shipments', href: '/shipments' }, { label: shipment.purchaseContract.contractReference }]}
        meta={
          <>
            {statuses.length === 1 ? (
              <StatusBadge status={statuses[0]} meta={SHIPMENT_STATUS_META} />
            ) : (
              <Badge tone="progress">
                {arrived} of {records.length} containers arrived
              </Badge>
            )}
            <StatusBadge status={shipment.documentStatus} meta={DOCUMENT_STATUS_META} />
            <StatusBadge status={settlement.status} meta={SETTLEMENT_STATUS_META} />
            <Link href={`/purchases/${shipment.purchaseContract.id}`}>
              <Badge tone="info">Purchase order</Badge>
            </Link>
            {records.length > 1
              ? records.map((record, index) =>
                  record.id === shipment.id ? (
                    <Badge key={record.id} tone="progress" title="Status and logistics actions apply to this container">
                      Container {index + 1} · actions
                    </Badge>
                  ) : (
                    <Link key={record.id} href={`/shipments/${record.id}`} title="Use this container's status and logistics actions">
                      <Badge tone={SHIPMENT_STATUSES_LANDED.includes(record.status) ? 'success' : 'neutral'}>
                        Container {index + 1}
                      </Badge>
                    </Link>
                  ),
                )
              : null}
          </>
        }
        actions={
          <>
            {can(user, PERMISSIONS.EXPENSES_CREATE) ? (
              <Button asChild variant="outline">
                <Link href={`/finance/expenses/new?job=${shipment.id}`}>
                  <Plus />
                  Add shipment expense
                </Link>
              </Button>
            ) : null}
            <ShipmentWorkflow
            shipmentId={shipment.id}
            status={shipment.status}
            documentStatus={shipment.documentStatus}
            canUpdate={can(user, PERMISSIONS.SHIPMENTS_UPDATE)}
            shippingLines={shippingLines}
              ports={ports}
            customers={customers.map((c) => ({ id: c.id, name: c.customerName }))}
            values={{
              bookingNumber: shipment.bookingNumber ?? '',
              billOfLading: shipment.billOfLading ?? '',
              vesselName: shipment.vesselName ?? '',
              voyageNumber: shipment.voyageNumber ?? '',
              portOfLoading: shipment.portOfLoading ?? '',
              portOfDischarge: shipment.portOfDischarge ?? '',
              shippingLineId: shipment.shippingLineId ?? '',
              etdDate: toDateInputValue(shipment.etdDate),
              etaDate: toDateInputValue(shipment.etaDate),
              ataDate: toDateInputValue(shipment.ataDate),
              loadingDate: toDateInputValue(shipment.loadingDate),
              clearanceDate: toDateInputValue(shipment.clearanceDate),
              deliveryDate: toDateInputValue(shipment.deliveryDate),
              destination: shipment.destination ?? '',
              customerId: shipment.customerId ?? '',
              containers: String(shipment.containers),
            }}
          />
          </>
        }
      />

      <MetricGrid>
        <Metric label="Quantity" value={formatQuantityKg(quantityKg)} hint={`${bags.toLocaleString()} bags`} />
        <Metric label="Containers" value={String(containerCount)} hint={items.join(' / ')} />
        <Metric label="ETA" value={formatDate(lastEta)} hint={records.length > 1 ? 'Latest of the containers' : (shipment.vesselName ?? undefined)} />
        <Metric
          label="Invoiced"
          value={<DualAmount amount={settlement.invoicedUsd} currency="USD" localCurrency={local} amountLocal={profit?.salesRevenueLocal} rateSource="Each invoice at its own rate" hideMissing />}
        />
        <Metric
          label="Received"
          value={<DualAmount amount={settlement.receivedUsd} currency="USD" localCurrency={local} rateLocalPerUsd={salesRate} rateSource="Weighted rate of the invoices' own rates" hideMissing />}
          tone={settlement.receivedUsd.greaterThan(0) ? 'positive' : 'muted'}
        />
        <Metric
          label="Outstanding"
          value={<DualAmount amount={settlement.outstandingUsd} currency="USD" localCurrency={local} rateLocalPerUsd={salesRate} rateSource="Weighted rate of the invoices' own rates" hideMissing />}
          tone={settlement.outstandingUsd.greaterThan(0) ? 'negative' : 'positive'}
        />
      </MetricGrid>

      {showCost && costSheet ? (
        <Card id="costing">
          <CardHeader>
            <CardTitle>Shipment costing</CardTitle>
            <CardDescription>
              Purchase cost USD + local expenses USD equivalent = total landed cost USD. Every expense keeps its own
              amount, currency and rate; {costSheet.localCurrency} totals add up those amounts, not dollars at one rate.
              {costSheet.costFx.map((pair) => (
                <span key={pair.from} className="block" data-testid="shipment-fx">
                  {pair.from} → {pair.to} weighted average over the order&rsquo;s {pair.count}{' '}
                  {pair.count === 1 ? 'transaction' : 'transactions'}: 1 {pair.from} = {Number(pair.rate).toFixed(4)} {pair.to}
                  {pair.lowest.equals(pair.highest) ? '' : ` (rates ${Number(pair.lowest).toFixed(4)} to ${Number(pair.highest).toFixed(4)})`}.
                </span>
              ))}
              Cost per KG = total landed ÷ received KG (ordered KG if nothing has landed). Cost per MT = cost per KG × 1,000.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <MetricGrid className="lg:grid-cols-5">
              <Metric
                label="Purchase cost"
                value={<DualAmount amount={costSheet.goodsUsd} currency="USD" localCurrency={costSheet.localCurrency} amountLocal={costSheet.goodsLocal} rateLocalPerUsd={costSheet.rateLocalPerUsd} rateSource="The purchase order's own rate" />}
              />
              <Metric
                label="Local shipment expenses"
                value={<DualAmount amount={costSheet.expenseLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.expenseUsd} rateSource="Each expense at its own rate" />}
              />
              <Metric
                label="Total landed cost"
                value={<DualAmount amount={costSheet.totalShipmentCostLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.totalShipmentCostUsd} rateSource="Each transaction at its own rate" />}
                hint={
                  costSheet.periodExpenseUsd.isZero()
                    ? undefined
                    : `Leaves out ${formatMoney(costSheet.periodExpenseLocal, costSheet.localCurrency)} not added to the coffee`
                }
              />
              <Metric
                label="Received"
                value={formatQuantityKg(costSheet.receivedKg)}
                hint={
                  costSheet.receivedKg.greaterThan(0)
                    ? formatQuantityMt(costSheet.receivedKg)
                    : `Ordered ${formatQuantityKg(costSheet.orderedKg)} · ${formatQuantityMt(costSheet.orderedKg)}`
                }
              />
              <Metric
                label="Cost / MT"
                value={<DualAmount amount={costSheet.costPerMtLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.costPerMtUsd} rateSource="From the landed cost, each transaction at its own rate" />}
              />
              <Metric
                label="Cost / KG"
                value={<DualAmount amount={costSheet.costPerKgLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.costPerKgUsd} rateSource="From the landed cost, each transaction at its own rate" />}
              />
              <Metric
                label="Revenue"
                value={<DualAmount amount={costSheet.revenueLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.revenueUsd} rateSource="Each invoice at its own rate" />}
              />
              <Metric
                label="COGS"
                value={<DualAmount amount={costSheet.cogsLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.cogsUsd} rateSource="At the rates the cost was incurred at" />}
                tone="muted"
              />
              <Metric
                label="Gross profit"
                value={<DualAmount amount={costSheet.grossProfitLocal} currency={costSheet.localCurrency} localCurrency={costSheet.localCurrency} amountUsd={costSheet.grossProfitUsd} rateSource="Sales less cost of sales, each at its own rate" />}
                tone={costSheet.grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
                hint={formatPercent(costSheet.profitPct)}
              />
              <Metric label="Remaining" value={formatQuantityKg(costSheet.remainingKg)} tone="muted" />
            </MetricGrid>

            {/* §7: where the shipment's money went, line by line. The shared
                local charges are divided equally between the item/container
                lines, and the table says so on each row. */}
            <CostingTable
              rows={costing}
              caption="Each container keeps its own purchase price; the job's shared local charges are split equally between the lines."
            />

            {costSheet.purchaseLines.length > 0 ? (
              <TableWrap>
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Coffee purchase</TH>
                      <TH numeric>Quantity</TH>
                      <TH numeric>Purchase USD</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {costSheet.purchaseLines.map((line) => (
                      <TR key={line.batchId}>
                        <TD className="font-medium">{line.batchNumber}</TD>
                        <TD numeric>{formatQuantityKg(line.quantityKg)}</TD>
                        <TD numeric>
                          <DualAmount amount={line.purchaseCostUsd} currency="USD" localCurrency={costSheet.localCurrency} rateLocalPerUsd={costSheet.rateLocalPerUsd} rateSource="The purchase order's own rate" />
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                  <TFoot>
                    <tr>
                      <TD>Total purchase cost</TD>
                      <TD />
                      <TD numeric>
                        <DualAmount amount={costSheet.goodsUsd} currency="USD" localCurrency={costSheet.localCurrency} amountLocal={costSheet.goodsLocal} rateSource="The purchase order's own rate" />
                      </TD>
                    </tr>
                  </TFoot>
                </Table>
              </TableWrap>
            ) : null}

            {costSheet.lines.length > 0 ? (
              <TableWrap>
                <Table>
                  <THead>
                    <TR className="hover:bg-transparent">
                      <TH>Date</TH>
                      <TH>Expense Category</TH>
                      <TH>Memo</TH>
                      <TH>Original Currency</TH>
                      <TH numeric>Original Amount</TH>
                      <TH numeric>FX Rate</TH>
                      <TH numeric>{costSheet.localCurrency} Amount</TH>
                      <TH numeric>USD Equivalent</TH>
                      <TH>Paid / Unpaid</TH>
                      <TH>Paid From</TH>
                      <TH>Container</TH>
                      <TH>Batch</TH>
                      <TH>Reference</TH>
                      <TH className="text-right">Actions</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {costSheet.lines.map((line) => (
                      <TR key={line.expenseId} data-testid="shipment-expense-row">
                        <TD className="text-xs">{formatDate(line.expenseDate)}</TD>
                        <TD className="font-medium">{line.category}</TD>
                        <TD className="text-xs text-ink-muted">{line.description ?? '—'}</TD>
                        <TD className="text-xs">{line.currency}</TD>
                        <TD numeric>{formatMoney(line.amount, line.currency)}</TD>
                        <TD numeric className="text-xs">{formatRate(line.rateToUsd)}</TD>
                        <TD numeric>
                          {costSheet.localCurrency === 'MAD'
                            ? formatMoney(line.amountLocal, 'MAD')
                            : formatMoney(line.amountLocal, costSheet.localCurrency)}
                        </TD>
                        <TD numeric>{formatMoney(line.amountUsd, 'USD')}</TD>
                        <TD>
                          <Badge tone={line.payment === 'PAID' ? 'success' : line.payment === 'PARTIAL' ? 'warning' : 'danger'}>
                            {line.payment === 'PAID' ? 'Paid' : line.payment === 'PARTIAL' ? 'Partially settled' : 'Unpaid'}
                          </Badge>
                        </TD>
                        <TD className="text-xs">{line.paidFrom ?? '—'}</TD>
                        <TD className="text-xs text-ink-muted">{line.containerNumber ?? 'Whole shipment'}</TD>
                        <TD className="text-xs text-ink-muted">{line.batchNumber ?? 'Every batch'}</TD>
                        <TD className="text-xs">{line.reference ?? '—'}</TD>
                        <TD className="text-right">
                          <Link href={`/finance/expenses/${line.expenseId}`} className="text-xs font-medium text-forest-800 hover:text-gold-700">
                            Open
                          </Link>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                  <TFoot>
                    <tr>
                      <TD colSpan={6}>Totals</TD>
                      <TD numeric>{formatMoney(costSheet.expenseLocal, costSheet.localCurrency)}</TD>
                      <TD numeric>{formatMoney(costSheet.expenseUsd, 'USD')}</TD>
                      <TD colSpan={6} />
                    </tr>
                  </TFoot>
                </Table>
              </TableWrap>
            ) : (
              <p className="text-xs text-ink-subtle">No shipment expenses posted yet. Use Add shipment expense for freight, duty, clearing, transport and commission.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {showProfit && profit ? (
        <Card>
          <CardHeader>
            <CardTitle>Shipment profitability</CardTitle>
            <CardDescription>
              Only the coffee that has actually sold counts. Unsold stock stays on the balance sheet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MetricGrid className="lg:grid-cols-5">
              <Metric label="Sold" value={formatQuantityKg(profit.soldQuantityKg)} />
              <Metric label="Remaining" value={formatQuantityKg(profit.remainingQuantityKg)} tone="muted" />
              <Metric label="Sales revenue" value={<DualAmount amount={profit.salesRevenueLocal} currency={local} localCurrency={local} amountUsd={profit.salesRevenueUsd} rateSource="Each invoice at its own rate" />} />
              <Metric label="Landed cost of sales" value={<DualAmount amount={profit.allocatedLandedCostLocal} currency={local} localCurrency={local} amountUsd={profit.allocatedLandedCostUsd} rateSource="At the rates the cost was incurred at" />} tone="muted" />
              <Metric
                label="Gross profit"
                value={<DualAmount amount={profit.grossProfitLocal} currency={local} localCurrency={local} amountUsd={profit.grossProfitUsd} rateSource="Each transaction at its own rate" />}
                tone={profit.grossProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
                hint={`${formatPercent(profit.grossMarginPct)} margin`}
              />
              <Metric label="Period costs" value={<DualAmount amount={profit.otherCostsLocal} currency={local} localCurrency={local} amountUsd={profit.otherCostsUsd} rateSource="Each expense at its own rate" />} tone="muted" />
              <Metric
                label="Net profit"
                value={<DualAmount amount={profit.netProfitLocal} currency={local} localCurrency={local} amountUsd={profit.netProfitUsd} rateSource="Each transaction at its own rate" />}
                tone={profit.netProfitUsd.greaterThanOrEqualTo(0) ? 'positive' : 'negative'}
                hint={`${formatPercent(profit.netMarginPct)} margin`}
              />
              <Metric label="Profit per KG" value={<DualAmount amount={profit.profitPerKgLocal} currency={local} localCurrency={local} amountUsd={profit.profitPerKgUsd} rateSource="Each transaction at its own rate" />} />
              {jobCost && costSheet ? (
                <>
                  <Metric label="Landed cost / KG" value={<DualAmount amount={costSheet.costPerKgLocal} currency={local} localCurrency={local} amountUsd={jobCost.landedCostPerKgUsd} rateSource="Each transaction at its own rate" />} />
                  <Metric label="Landed cost / bag" value={formatMoney(jobCost.landedCostPerBagUsd, 'USD')} />
                </>
              ) : null}
            </MetricGrid>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Batches and containers</CardTitle>
            <CardDescription>Traceability from lot to container to warehouse.</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <TableWrap className="rounded-none border-0 border-t">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Batch</TH>
                    <TH>Lot</TH>
                    <TH>Container</TH>
                    <TH>Warehouse</TH>
                    <TH numeric>Received</TH>
                    <TH numeric>Sold</TH>
                    <TH numeric>Available</TH>
                    {showCost ? <TH numeric>Landed / KG</TH> : null}
                  </TR>
                </THead>
                <TBody>
                  {batches.map((b) => (
                    <TR key={b.batchId}>
                      <TD className="font-medium">
                        <Link href={`/inventory/batches/${b.batchId}`} className="text-forest-800 hover:text-gold-700">
                          {b.batchNumber}
                        </Link>
                      </TD>
                      <TD>{b.lotNumber}</TD>
                      <TD className="text-xs">{b.containerNumber ?? '—'}</TD>
                      <TD>{b.warehouseNames || '—'}</TD>
                      <TD numeric>{formatQuantityKg(b.receivedKg)}</TD>
                      <TD numeric>{formatQuantityKg(b.soldKg)}</TD>
                      <TD numeric className="font-medium">{formatQuantityKg(b.availableKg)}</TD>
                      {showCost ? (
                        <TD numeric>
                          <DualAmount amount={b.unitCostUsd} currency="USD" localCurrency={local} amountLocal={localPerKg.get(b.batchId) ?? null} rateSource="The purchase at its rate, each cost at its own" hideMissing />
                        </TD>
                      ) : null}
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableWrap>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Logistics</CardTitle>
          </CardHeader>
          <CardContent>
            <dl>
              <DetailRow label="Supplier">
                <Link href={`/vendors/${shipment.vendor.id}`} className="text-gold-700 hover:underline">
                  {shipment.vendor.vendorName}
                </Link>
              </DetailRow>
              <DetailRow label="Buyer">
                {shipment.customer ? (
                  <Link href={`/customers/${shipment.customer.id}`} className="text-gold-700 hover:underline">
                    {shipment.customer.customerName}
                  </Link>
                ) : (
                  <span className="text-ink-subtle">Not yet sold</span>
                )}
              </DetailRow>
              <DetailRow label="Incoterm">{INCOTERM_LABELS[shipment.incoterm] ?? shipment.incoterm}</DetailRow>
              <DetailRow label="Shipping line">{shipment.shippingLine?.name ?? '—'}</DetailRow>
              <DetailRow label="Booking">{shipment.bookingNumber ?? '—'}</DetailRow>
              <DetailRow label="Bill of lading">{shipment.billOfLading ?? '—'}</DetailRow>
              <DetailRow label="Vessel">
                {shipment.vesselName ?? '—'}
                {shipment.voyageNumber ? (
                  <span className="block text-xs text-ink-subtle">Voyage {shipment.voyageNumber}</span>
                ) : null}
              </DetailRow>
              <DetailRow label="Port of loading">{shipment.portOfLoading ?? '—'}</DetailRow>
              <DetailRow label="Port of discharge">{shipment.portOfDischarge ?? '—'}</DetailRow>
              <DetailRow label="ETD">{formatDate(shipment.etdDate)}</DetailRow>
              <DetailRow label="ETA">{formatDate(shipment.etaDate)}</DetailRow>
              <DetailRow label="Arrived">{formatDate(shipment.ataDate)}</DetailRow>
              <DetailRow label="Cleared">{formatDate(shipment.clearanceDate)}</DetailRow>
              <DetailRow label="Delivered">{formatDate(shipment.deliveryDate)}</DetailRow>
            </dl>

            {records.some((r) => r.containerList.length > 0) ? (
              <div className="mt-3 border-t border-line pt-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Containers</p>
                <ul className="space-y-2">
                  {records.flatMap((record, index) =>
                    record.containerList.map((c) => (
                      <li key={c.id} className="text-xs">
                        <span className="flex items-center justify-between">
                          <span className="font-medium text-ink">{c.containerNumber}</span>
                          <span className="text-ink-subtle">
                            {c.containerType} · {formatQuantityKg(c.netWeightKg)}
                          </span>
                        </span>
                        {records.length > 1 ? (
                          <span className="block text-ink-subtle">
                            Container {index + 1} · {record.item.itemName} ·{' '}
                            {SHIPMENT_STATUS_META[record.status]?.label ?? record.status}
                            {record.etaDate ? ` · ETA ${formatDate(record.etaDate)}` : ''}
                            {record.ataDate ? ` · arrived ${formatDate(record.ataDate)}` : ''}
                            {record.vesselName ? ` · ${record.vesselName}` : ''}
                            {record.billOfLading ? ` · B/L ${record.billOfLading}` : ''}
                          </span>
                        ) : null}
                      </li>
                    )),
                  )}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Sales invoices from this shipment</CardTitle>
          <CardDescription>
            Every invoice with coffee from this shipment, as it stands now — a corrected invoice shows its corrected
            lines. An invoice that also sold other coffee shows only this shipment&rsquo;s part. Drafts are listed but not
            counted until they are posted.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {soldFromHere.length === 0 ? (
            <p className="px-5 pb-5 text-center text-xs text-ink-subtle">Nothing sold from this shipment yet.</p>
          ) : (
            <TableWrap className="rounded-none border-0 border-t">
              <Table data-testid="shipment-sales-invoices">
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Invoice</TH>
                    <TH>Date</TH>
                    <TH>Customer</TH>
                    <TH>Container</TH>
                    <TH numeric>KG</TH>
                    <TH numeric>Amount</TH>
                    <TH>Payment</TH>
                    <TH>Updated</TH>
                  </TR>
                </THead>
                <TBody>
                  {soldFromHere.map((inv) => {
                    const edit = editsByInvoice.get(inv.id);
                    const due = receivableByInvoice.get(inv.id);
                    const partOfInvoice = !dec(inv.amount).equals(dec(inv.invoiceSubtotal));
                    return (
                      <TR key={inv.id} data-testid="shipment-sales-invoice">
                        <TD className="whitespace-nowrap">
                          <Link href={`/sales/${inv.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                            {shortDocumentNumber(inv.invoiceNumber)}
                          </Link>
                        </TD>
                        <TD className="whitespace-nowrap text-xs">{formatDate(inv.invoiceDate)}</TD>
                        <TD className="text-sm">{inv.customerName}</TD>
                        <TD className="font-mono text-xs">{inv.containers ?? '—'}</TD>
                        <TD numeric>{formatQuantityKg(dec(inv.kg))}</TD>
                        <TD numeric>
                          <DualAmount
                            amount={dec(inv.amount)}
                            currency={inv.currency}
                            localCurrency={local}
                            rateLocalPerUsd={dec(inv.rate)}
                            amountUsd={inv.currency === local ? dec(inv.usd) : null}
                            rateSource={`This invoice's own rate, ${formatDate(inv.invoiceDate)}`}
                            primaryClassName="font-normal"
                          />
                          {partOfInvoice ? (
                            <span className="block text-[11px] text-ink-subtle">
                              of {formatMoney(inv.invoiceSubtotal, inv.currency)} on the invoice
                            </span>
                          ) : null}
                        </TD>
                        <TD>
                          {inv.status === 'DRAFT' ? (
                            <Badge tone="neutral">Draft — not posted</Badge>
                          ) : due ? (
                            <>
                              <Badge tone={due.status === 'PAID' ? 'success' : due.status === 'PARTIAL' ? 'warning' : 'danger'}>
                                {due.status === 'PAID' ? 'Paid' : due.status === 'PARTIAL' ? 'Partly paid' : 'Unpaid'}
                              </Badge>
                              {due.status === 'PAID' ? null : (
                                <span className="block text-[11px] text-ink-subtle">
                                  {formatMoney(due.outstandingAmount, due.currency)} to collect
                                </span>
                              )}
                            </>
                          ) : (
                            '—'
                          )}
                        </TD>
                        <TD className="text-xs">
                          {edit ? (
                            <>
                              <Badge tone="info">
                                Edited{edit.edits > 1 ? ` ${edit.edits}×` : ''}
                              </Badge>
                              <span className="block text-[11px] text-ink-subtle">
                                {formatDateTime(edit.lastEdited)}
                                {edit.lastBy ? ` · ${edit.lastBy}` : ''}
                              </span>
                            </>
                          ) : (
                            <span className="text-ink-subtle">—</span>
                          )}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
                <TFoot>
                  <tr>
                    <TD colSpan={4}>
                      {postedSales.length} posted {postedSales.length === 1 ? 'invoice' : 'invoices'}
                    </TD>
                    <TD numeric>{formatQuantityKg(salesKg)}</TD>
                    <TD numeric>
                      <DualAmount
                        amount={salesLocal}
                        currency={local}
                        localCurrency={local}
                        amountUsd={salesUsd}
                        rateSource="Each invoice at its own rate"
                      />
                    </TD>
                    <TD colSpan={2} />
                  </tr>
                </TFoot>
              </Table>
            </TableWrap>
          )}
        </CardContent>
      </Card>

      <div>
        <Card>
          <CardHeader>
            <CardTitle>Shipment costs</CardTitle>
            <CardDescription>Capitalised costs raise the landed cost; period costs reduce net profit.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {orderExpenses.length === 0 ? (
              <p className="py-4 text-center text-xs text-ink-subtle">No costs booked to this shipment yet.</p>
            ) : (
              orderExpenses.map((e) => (
                <Link
                  key={e.id}
                  href={`/finance/expenses/${e.id}`}
                  className="flex items-center justify-between gap-3 border-b border-line pb-3 last:border-0 last:pb-0"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-forest-800">
                      {e.expenseCategory.name}
                    </span>
                    <span className="block truncate text-xs text-ink-subtle">
                      {formatDate(e.expenseDate)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <DualAmount
                      className="text-sm"
                      amount={e.amount}
                      currency={e.currency}
                      localCurrency={local}
                      amountUsd={e.amountUsd}
                      amountLocal={e.amountLocal}
                      rateLocalPerUsd={e.rateLocalPerUsd}
                      rateSource={`This expense's own rate, ${formatDate(e.expenseDate)}`}
                    />
                    <Badge tone={e.capitaliseToLandedCost ? 'info' : 'neutral'}>
                      {e.capitaliseToLandedCost ? 'Landed cost' : 'Period cost'}
                    </Badge>
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>Every status change, who made it and when.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {records.flatMap((record) => [
            ...record.statusHistory.map((h) => ({ ...h, kind: 'status' as const, recordId: record.id })),
            ...record.docStatusHistory.map((h) => ({ ...h, kind: 'document' as const, recordId: record.id })),
          ])
            .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
            .map((entry) => (
              <div key={`${entry.kind}-${entry.id}`} className="flex items-start gap-3 border-b border-line pb-2 last:border-0">
                <StatusBadge
                  status={entry.toStatus}
                  meta={entry.kind === 'status' ? SHIPMENT_STATUS_META : DOCUMENT_STATUS_META}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-ink-muted">
                    {records.length > 1 ? `${containerLabel(entry.recordId)} · ` : ''}
                    {entry.kind === 'document' ? 'Documents · ' : ''}
                    {entry.changedBy.name} · {formatDateTime(entry.changedAt)}
                  </p>
                  {entry.notes ? <p className="text-xs text-ink">{entry.notes}</p> : null}
                </div>
              </div>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
