import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PurchaseForm, type ItemOption } from '@/app/(app)/purchases/purchase-form';

export const metadata: Metadata = { title: 'Edit Purchase Contract' };
export const dynamic = 'force-dynamic';

export default async function EditPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.PURCHASES_EDIT);
  const companyId = user.activeCompany.id;

  const contract = await prisma.purchaseContract.findFirst({
    where: { id, companyId },
    include: { lines: { orderBy: { lineNumber: 'asc' } } },
  });

  if (!contract) notFound();
  // Posted contracts are corrected by reversal, never by silent edits.
  if (contract.status !== 'DRAFT') redirect(`/purchases/${id}`);

  const [vendors, items] = await Promise.all([
    prisma.vendor.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { vendorName: 'asc' },
      select: { id: true, vendorName: true, vendorCode: true, country: true, primaryCurrency: true },
    }),
    prisma.coffeeItem.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { itemName: 'asc' },
      select: {
        id: true,
        itemName: true,
        itemCode: true,
        originCountry: true,
        grade: true,
        bagWeightKg: true,
        defaultUnit: true,
      },
    }),
  ]);

  const itemOptions: ItemOption[] = items.map((i) => ({
    value: i.id,
    label: i.itemName,
    hint: [i.itemCode, i.originCountry, i.grade].filter(Boolean).join(' · '),
    keywords: `${i.itemCode} ${i.originCountry}`,
    bagWeightKg: i.bagWeightKg.toString(),
    defaultUnit: i.defaultUnit,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Edit ${contract.contractNumber}`}
        description="Only draft contracts can be edited. Once approved, corrections are made by reversal."
        breadcrumbs={[
          { label: 'Trading' },
          { label: 'Purchase Contracts', href: '/purchases' },
          { label: contract.contractNumber, href: `/purchases/${id}` },
          { label: 'Edit' },
        ]}
      />
      <PurchaseForm
        vendors={vendors.map((v) => ({
          value: v.id,
          label: v.vendorName,
          hint: [v.vendorCode, v.country].filter(Boolean).join(' · '),
        }))}
        items={itemOptions}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={contract.rateLocalPerUsd.toString()}
        defaults={{
          id: contract.id,
          contractReference: contract.contractReference,
          supplierContractNo: contract.supplierContractNo ?? '',
          contractDate: toDateInputValue(contract.contractDate),
          vendorId: contract.vendorId,
          origin: contract.origin ?? '',
          currency: contract.currency,
          rateToUsd: contract.rateToUsd.toString(),
          rateLocalPerUsd: contract.rateLocalPerUsd.toString(),
          freightAmount: contract.freightAmount.toString(),
          otherCharges: contract.otherCharges.toString(),
          incoterm: contract.incoterm,
          portOfLoading: contract.portOfLoading ?? '',
          destination: contract.destination ?? '',
          paymentTermDays: String(contract.paymentTermDays),
          notes: contract.notes ?? '',
          lines: contract.lines.map((l) => ({
            itemId: l.itemId,
            lotNumber: l.lotNumber,
            batchNumber: l.batchNumber,
            containerNumber: l.containerNumber ?? '',
            quantity: l.quantity.toString(),
            unit: l.unit as 'KG' | 'MT' | 'BAG',
            unitPrice: l.unitPrice.toString(),
            bags: String(l.bags),
            bagWeightKg: l.bagWeightKg.toString(),
          })),
        }}
      />
    </div>
  );
}
