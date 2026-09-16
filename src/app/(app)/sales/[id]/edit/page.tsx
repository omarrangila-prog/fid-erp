import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { getTaxSettings, listTaxCodes } from '@/lib/services/tax';
import { prisma } from '@/lib/db';
import { dec } from '@/lib/money';
import { getSellableStock } from '@/lib/services/stock';
import { formatQuantityKg, toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { SaleForm, type StockOption } from '@/app/(app)/sales/sale-form';

export const metadata: Metadata = { title: 'Edit Sales Invoice' };
export const dynamic = 'force-dynamic';

export default async function EditSalePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.SALES_EDIT);
  const companyId = user.activeCompany.id;

  const invoice = await prisma.salesInvoice.findFirst({
    where: { id, companyId },
    include: {
      lines: {
        orderBy: { lineNumber: 'asc' },
        include: {
          batch: { select: { id: true, batchNumber: true, bagWeightKg: true, shipmentId: true } },
          warehouse: { select: { id: true, name: true } },
          item: { select: { itemName: true } },
        },
      },
    },
  });

  if (!invoice) notFound();
  if (invoice.status === 'REVERSED') redirect(`/sales/${id}`);

  const [customers, stock, cashAccounts] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true, customerCode: true, primaryCurrency: true, paymentTermDays: true },
    }),
    getSellableStock(companyId),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true },
    }),
  ]);

  const stockOptions: StockOption[] = stock.map((s) => ({
    value: `${s.batchId}:${s.warehouseId}`,
    label: `${s.batchNumber} · ${s.itemName}`,
    hint: `${s.warehouseName} · ${formatQuantityKg(s.availableKg)} available · Lot ${s.lotNumber}`,
    keywords: `${s.itemCode} ${s.originCountry} ${s.lotNumber} ${s.warehouseCode}`,
    batchId: s.batchId,
    warehouseId: s.warehouseId,
    batchNumber: s.batchNumber,
    availableKg: s.availableKg.toString(),
    bagWeightKg: s.bagWeightKg.toString(),
    itemName: s.itemName,
    itemId: s.itemId,
    warehouseName: s.warehouseName,
    shipmentId: s.shipmentId,
  }));

  // Stock this invoice already holds is reserved (draft) or consumed (posted),
  // so it does not appear as free. Add each line's own quantity back so the
  // figure the user already entered still validates.
  for (const line of invoice.lines) {
    if (!line.warehouseId) continue;
    const key = `${line.batchId}:${line.warehouseId}`;
    const existing = stockOptions.find((o) => o.value === key);
    const including = invoice.status === 'POSTED' ? 'including this invoice' : 'including this draft';
    if (existing) {
      existing.availableKg = dec(existing.availableKg).plus(dec(line.quantityKg)).toString();
      existing.hint = `${existing.warehouseName} · ${formatQuantityKg(existing.availableKg)} available (${including})`;
    } else {
      stockOptions.push({
        value: key,
        label: `${line.batch.batchNumber} · ${line.item.itemName}`,
        hint: `${line.warehouse?.name ?? 'Warehouse'} · held by this invoice`,
        batchId: line.batchId,
        warehouseId: line.warehouseId,
        batchNumber: line.batch.batchNumber,
        availableKg: line.quantityKg.toString(),
        bagWeightKg: line.batch.bagWeightKg.toString(),
        itemName: line.item.itemName,
        itemId: line.itemId,
        warehouseName: line.warehouse?.name ?? 'Warehouse',
        shipmentId: line.batch.shipmentId,
      });
    }
  }

  const taxSettings = await getTaxSettings(user.activeCompany.id);
  const taxCodeRows = taxSettings.enabled ? await listTaxCodes(user.activeCompany.id, 'SALES') : [];
  const taxCodes = taxCodeRows.map((code) => ({
    id: code.id,
    code: code.code,
    name: code.name,
    ratePct: code.ratePct.toString(),
  }));

  const rates = await getRateDefaults(user.activeCompany.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Edit ${invoice.invoiceNumber}`}
        description="Correct quantity, rate, batch, due date and other details. Totals, stock and the customer ledger are recalculated when you save."
        breadcrumbs={[
          { label: 'Trading' },
          { label: 'Sales', href: '/sales' },
          { label: invoice.invoiceNumber, href: `/sales/${id}` },
          { label: 'Edit' },
        ]}
      />
      <SaleForm
        cashAccounts={cashAccounts}
        customers={customers.map((c) => ({
          value: c.id,
          label: c.customerName,
          hint: `${c.customerCode} · ${c.primaryCurrency}`,
          currency: c.primaryCurrency,
          paymentTermDays: c.paymentTermDays,
        }))}
        stock={stockOptions}
        localCurrency={user.activeCompany.localCurrency}
        defaultCurrency={invoice.currency}
        defaultLocalRate={invoice.rateLocalPerUsd.toString()}
        ratesByCurrency={rates.byCurrency}
        taxCodes={taxCodes}
        taxLabel={taxSettings.label}
        taxEnabled={taxSettings.enabled}
        canApprove={can(user, PERMISSIONS.SALES_APPROVE)}
        canCreateCustomer={can(user, PERMISSIONS.CUSTOMERS_CREATE)}
        canDelete={can(user, PERMISSIONS.SALES_DELETE)}
        canReverse={can(user, PERMISSIONS.SALES_REVERSE)}
        defaults={{
          id: invoice.id,
          status: invoice.status,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: toDateInputValue(invoice.invoiceDate),
          customerId: invoice.customerId,
          currency: invoice.currency,
          rateToUsd: invoice.rateToUsd.toString(),
          rateLocalPerUsd: invoice.rateLocalPerUsd.toString(),
          dueDate: invoice.dueDate ? toDateInputValue(invoice.dueDate) : '',
          paymentType: invoice.paymentType,
          cashBankAccountId: invoice.cashBankAccountId ?? '',
          reference: invoice.reference ?? '',
          notes: invoice.notes ?? '',
          warehouseId: invoice.lines[0]?.warehouseId ?? undefined,
          lines: invoice.lines.map((l) => ({
            stockKey: `${l.batchId}:${l.warehouseId}`,
            quantity: l.quantity.toString(),
            unit: l.unit as 'KG' | 'MT' | 'BAG',
            unitPrice: l.unitPrice.toString(),
            taxCodeId: l.taxCodeId ?? '',
          })),
        }}
      />
    </div>
  );
}
