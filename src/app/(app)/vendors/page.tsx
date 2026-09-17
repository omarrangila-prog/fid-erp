import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getPayables } from '@/lib/services/receivables';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { getRateDefaults } from '@/lib/services/exchange-rate';
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

  const [vendors, payables, traded, rates] = await Promise.all([
    prisma.vendor.findMany({
      where: { companyId },
      orderBy: { vendorName: 'asc' },
      include: { _count: { select: { purchaseContracts: true } } },
    }),
    getPayables({ companyId, onlyOutstanding: true }),
    // What each supplier has been bought from and paid, and when they last
    // supplied — so the list answers those without opening a ledger.
    prisma.$queryRaw<
      Array<{ vendorId: string; currency: string; purchased: string; paid: string; lastAt: Date | null }>
    >`
      SELECT pc."vendorId", pc."currency",
             COALESCE(SUM(pc."totalValue"), 0)::text AS purchased,
             COALESCE(SUM((
               SELECT COALESCE(SUM(pa."amount"), 0) FROM payment_allocations pa
               JOIN payments p ON p."id" = pa."paymentId"
               WHERE pa."purchaseContractId" = pc."id" AND p."status" = 'POSTED'
             )), 0)::text AS paid,
             MAX(pc."contractDate") AS "lastAt"
      FROM purchase_contracts pc
      WHERE pc."companyId" = ${companyId} AND pc."status" = 'POSTED'
      GROUP BY pc."vendorId", pc."currency"`,
    getRateDefaults(companyId),
  ]);

  const tradedByVendor = new Map(traded.map((row) => [row.vendorId, row]));

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
      outstandingUsd,
      outstandingLabel: outstandingUsd > 0 ? formatMoney(outstandingUsd, 'USD') : '—',
      contractCount: v._count.purchaseContracts,
      purchasedLabel: (() => {
        const row = tradedByVendor.get(v.id);
        return row ? formatMoney(row.purchased, row.currency) : '—';
      })(),
      purchasedSort: Number(tradedByVendor.get(v.id)?.purchased ?? 0),
      paidLabel: (() => {
        const row = tradedByVendor.get(v.id);
        return row ? formatMoney(row.paid, row.currency) : '—';
      })(),
      lastTradedLabel: (() => {
        const at = tradedByVendor.get(v.id)?.lastAt;
        return at ? formatDate(at) : '—';
      })(),
      lastTradedSort: tradedByVendor.get(v.id)?.lastAt?.getTime() ?? 0,
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
        canPostOpening={can(user, PERMISSIONS.ACCOUNTING_POST)}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
      />
    </div>
  );
}
