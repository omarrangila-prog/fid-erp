import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { PurchaseForm, type ItemOption } from '@/app/(app)/purchases/purchase-form';

export const metadata: Metadata = { title: 'New Purchase Contract' };
export const dynamic = 'force-dynamic';

export default async function NewPurchasePage() {
  const user = await requirePageAccess(PERMISSIONS.PURCHASES_CREATE);
  const companyId = user.activeCompany.id;

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

  const prerequisites: Prerequisite[] = [
    {
      met: vendors.length > 0,
      label: 'At least one supplier',
      description: 'The exporter or estate you are buying from. Their currency defaults onto the contract.',
      href: '/vendors?new=1',
      actionLabel: 'Add supplier',
    },
    {
      met: items.length > 0,
      label: 'At least one coffee item',
      description: 'Origin, grade, screen size and bag weight — entered once, then reused on every contract.',
      href: '/items?new=1',
      actionLabel: 'Add coffee',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New Purchase Contract"
          breadcrumbs={[{ label: 'Trading' }, { label: 'Purchase Contracts', href: '/purchases' }, { label: 'New' }]}
        />
        <PrerequisiteGate
          title="Before you can raise a purchase contract"
          description="A contract records who you are buying from and what you are buying, so both have to exist first."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  const itemOptions: ItemOption[] = items.map((i) => ({
    value: i.id,
    label: i.itemName,
    hint: [i.itemCode, i.originCountry, i.grade].filter(Boolean).join(' · '),
    keywords: `${i.itemCode} ${i.originCountry} ${i.grade ?? ''}`,
    bagWeightKg: i.bagWeightKg.toString(),
    defaultUnit: i.defaultUnit,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Purchase Contract"
        description="One contract can carry several containers, each with its own lot and batch."
        breadcrumbs={[{ label: 'Trading' }, { label: 'Purchase Contracts', href: '/purchases' }, { label: 'New' }]}
      />
      <PurchaseForm
        vendors={vendors.map((v) => ({
          value: v.id,
          label: v.vendorName,
          hint: [v.vendorCode, v.country, v.primaryCurrency].filter(Boolean).join(' · '),
          keywords: `${v.vendorCode} ${v.country ?? ''}`,
        }))}
        items={itemOptions}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={user.activeCompany.localCurrency === 'AED' ? '3.6725' : '9.85'}
      />
    </div>
  );
}
