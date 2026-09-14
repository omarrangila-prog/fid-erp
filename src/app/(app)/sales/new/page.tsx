import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { getTaxSettings, listTaxCodes } from '@/lib/services/tax';
import { prisma, transaction } from '@/lib/db';
import { getSellableStock } from '@/lib/services/stock';
import { formatQuantityKg } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { SaleForm, type StockOption } from '@/app/(app)/sales/sale-form';
import { suggestSalesInvoiceNumber } from '@/lib/services/numbering';

export const metadata: Metadata = { title: 'New Sales Invoice' };
export const dynamic = 'force-dynamic';

export default async function NewSalePage() {
  const user = await requirePageAccess(PERMISSIONS.SALES_CREATE);
  const companyId = user.activeCompany.id;

  const [customers, stock, cashAccounts] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true, customerCode: true, primaryCurrency: true },
    }),
    getSellableStock(companyId),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true },
    }),
  ]);

  const prerequisites: Prerequisite[] = [
    {
      met: customers.length > 0,
      label: 'At least one customer',
      description: 'An invoice has to be addressed to somebody, and their currency comes from their record.',
      href: '/customers?new=1',
      actionLabel: 'Add customer',
    },
    {
      met: stock.length > 0,
      label: 'Coffee available in a warehouse',
      description: 'You can only sell stock that has actually been received. Order it, then receive it into a warehouse.',
      href: '/purchases',
      actionLabel: 'Open purchases',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New Sales Invoice"
          breadcrumbs={[{ label: 'Trading' }, { label: 'Sales', href: '/sales' }, { label: 'New' }]}
        />
        <PrerequisiteGate
          title="Before you can raise a sales invoice"
          description="A sale takes stock out of a warehouse and bills a customer for it, so both have to exist first."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  const taxSettings = await getTaxSettings(user.activeCompany.id);
  const taxCodeRows = taxSettings.enabled ? await listTaxCodes(user.activeCompany.id, 'SALES') : [];
  const taxCodes = taxCodeRows.map((code) => ({
    id: code.id,
    code: code.code,
    name: code.name,
    ratePct: code.ratePct.toString(),
  }));

  const stockOptions: StockOption[] = stock.map((s) => ({
    value: `${s.batchId}:${s.warehouseId}`,
    label: `${s.batchNumber} · ${s.itemName}`,
    hint: `${s.warehouseName} · ${formatQuantityKg(s.availableKg)} available · Lot ${s.lotNumber}${s.containerNumber ? ` · ${s.containerNumber}` : ''}`,
    keywords: `${s.itemCode} ${s.originCountry} ${s.lotNumber} ${s.containerNumber ?? ''} ${s.warehouseCode} ${s.shipmentNumber}`,
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

  const defaultCurrency = user.activeCompany.localCurrency === 'MAD' ? 'MAD' : 'USD';

  const rates = await getRateDefaults(user.activeCompany.id);
  const invoiceNumber = await transaction((tx) => suggestSalesInvoiceNumber(tx, companyId));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Sales Invoice"
        description="Sell from a specific batch in a specific warehouse. Partial sales of a batch are normal."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Sales', href: '/sales' }, { label: 'New' }]}
      />
      <SaleForm
        cashAccounts={cashAccounts}
        customers={customers.map((c) => ({
          value: c.id,
          label: c.customerName,
          hint: `${c.customerCode} · ${c.primaryCurrency}`,
          keywords: c.customerCode,
          currency: c.primaryCurrency,
        }))}
        stock={stockOptions}
        localCurrency={user.activeCompany.localCurrency}
        defaultCurrency={defaultCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        taxCodes={taxCodes}
        taxLabel={taxSettings.label}
        taxEnabled={taxSettings.enabled}
        canApprove={can(user, PERMISSIONS.SALES_APPROVE)}
        canCreateCustomer={can(user, PERMISSIONS.CUSTOMERS_CREATE)}
        defaults={{ invoiceNumber }}
      />
    </div>
  );
}
