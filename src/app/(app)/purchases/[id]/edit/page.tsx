import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
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
  /*
   * A draft is edited freely. An approved order is corrected where it stands
   * — the books follow — by someone who may approve orders. A reversed one is
   * history and is not edited.
   */
  const approved = contract.status === 'POSTED';
  if (contract.status !== 'DRAFT' && !approved) redirect(`/purchases/${id}`);
  if (approved && !can(user, PERMISSIONS.PURCHASES_APPROVE)) redirect(`/purchases/${id}`);

  // Containers whose coffee has been received, sold or set aside: their
  // coffee, kilograms and numbers are what the warehouse counted.
  const moved = approved
    ? await prisma.batch.findMany({
        where: {
          purchaseContractId: id,
          status: 'ACTIVE',
          OR: [{ receivedQuantityKg: { gt: 0 } }, { soldQuantityKg: { gt: 0 } }, { allocatedQuantityKg: { gt: 0 } }],
        },
        select: { purchaseContractLineId: true, shipment: { select: { purchaseContractLineId: true } } },
      })
    : [];
  const lockedLines = new Set(
    moved.map((b) => b.purchaseContractLineId ?? b.shipment.purchaseContractLineId).filter(Boolean) as string[],
  );

  const [vendors, items, ports] = await Promise.all([
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
    prisma.port.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { name: true },
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
        title={`Edit ${contract.contractReference}`}
        description={
          approved
            ? 'Every field can be corrected. The supplier balance, stock value, cost of sales and profit follow the change. A container already received keeps the coffee and kilograms the warehouse counted.'
            : 'A draft order. Nothing is posted until it is saved as a purchase order.'
        }
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
        canApprove={can(user, PERMISSIONS.PURCHASES_APPROVE)}
        approved={approved}
        canCreateItem={can(user, PERMISSIONS.ITEMS_CREATE)}
        ports={ports.map((p) => p.name)}
        defaults={{
          id: contract.id,
          contractReference: contract.contractReference,
          supplierContractNo: contract.supplierContractNo ?? '',
          contractDate: toDateInputValue(contract.contractDate),
          vendorId: contract.vendorId,
          origin: contract.origin ?? '',
          dueDate: contract.dueDate ? toDateInputValue(contract.dueDate) : '',
          containers: contract.containers != null ? String(contract.containers) : '',
          currency: contract.currency,
          rateToUsd: contract.rateToUsd.toString(),
          rateLocalPerUsd: contract.rateLocalPerUsd.toString(),
          freightAmount: contract.freightAmount.toString(),
          otherCharges: contract.otherCharges.toString(),
          incoterm: contract.incoterm,
          portOfLoading: contract.portOfLoading ?? '',
          destination: contract.destination ?? '',
          notes: contract.notes ?? '',
          lines: contract.lines.map((l) => ({
            id: l.id,
            locked: lockedLines.has(l.id),
            itemId: l.itemId,
            lotNumber: l.lotNumber ?? '',
            batchNumber: l.batchNumber ?? '',
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
