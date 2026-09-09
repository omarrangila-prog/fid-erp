import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getPayables } from '@/lib/services/receivables';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { VendorsClient, type VendorRow } from '@/app/(app)/vendors/vendors-client';

export const metadata: Metadata = { title: 'Suppliers' };
export const dynamic = 'force-dynamic';

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  // "+ New" from anywhere in the app lands here with ?new=1 and opens the form.
  const openCreate = (await searchParams).new === '1';
  const user = await requirePageAccess(PERMISSIONS.VENDORS_VIEW);
  const companyId = user.activeCompany.id;

  const [vendors, payables] = await Promise.all([
    prisma.vendor.findMany({
      where: { companyId },
      orderBy: { vendorName: 'asc' },
      include: { _count: { select: { purchaseContracts: true } } },
    }),
    getPayables({ companyId, onlyOutstanding: true }),
  ]);

  const outstandingByVendor = new Map<string, number>();
  for (const row of payables) {
    outstandingByVendor.set(
      row.vendorId,
      (outstandingByVendor.get(row.vendorId) ?? 0) + Number(row.outstandingAmountUsd),
    );
  }

  const rows: VendorRow[] = vendors.map((v) => {
    const outstandingUsd = outstandingByVendor.get(v.id) ?? 0;
    return {
      id: v.id,
      vendorCode: v.vendorCode,
      vendorName: v.vendorName,
      country: v.country,
      contactPerson: v.contactPerson,
      phone: v.phone,
      whatsapp: v.whatsapp,
      email: v.email,
      address: v.address,
      bankDetails: v.bankDetails,
      notes: v.notes,
      primaryCurrency: v.primaryCurrency,
      paymentTermDays: v.paymentTermDays,
      outstandingUsd,
      outstandingLabel: outstandingUsd > 0 ? formatMoney(outstandingUsd, 'USD') : '—',
      contractCount: v._count.purchaseContracts,
      status: v.status,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Suppliers"
        description="Exporters, cooperatives and estates you buy green coffee from. Overseas suppliers are carried in USD."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Suppliers' }]}
      />
      <VendorsClient
        rows={rows}
        canCreate={can(user, PERMISSIONS.VENDORS_CREATE)}
        openCreate={openCreate}
        canEdit={can(user, PERMISSIONS.VENDORS_EDIT)}
      />
    </div>
  );
}
