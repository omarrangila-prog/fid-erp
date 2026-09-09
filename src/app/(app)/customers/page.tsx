import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getReceivables } from '@/lib/services/receivables';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { CustomersClient, type CustomerRow } from '@/app/(app)/customers/customers-client';

export const metadata: Metadata = { title: 'Customers' };
export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  // "+ New" from anywhere in the app lands here with ?new=1 and opens the form.
  const openCreate = (await searchParams).new === '1';
  const user = await requirePageAccess(PERMISSIONS.CUSTOMERS_VIEW);
  const companyId = user.activeCompany.id;

  const [customers, receivables] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId },
      orderBy: { customerName: 'asc' },
      include: { _count: { select: { salesInvoices: true } } },
    }),
    getReceivables({ companyId, onlyOutstanding: true }),
  ]);

  const outstandingByCustomer = new Map<string, number>();
  for (const row of receivables) {
    outstandingByCustomer.set(
      row.customerId,
      (outstandingByCustomer.get(row.customerId) ?? 0) + Number(row.outstandingAmountUsd),
    );
  }

  // Decimals are formatted here so nothing but plain data crosses to the client.
  const rows: CustomerRow[] = customers.map((c) => {
    const outstandingUsd = outstandingByCustomer.get(c.id) ?? 0;
    return {
      id: c.id,
      customerCode: c.customerCode,
      customerName: c.customerName,
      country: c.country,
      contactPerson: c.contactPerson,
      phone: c.phone,
      whatsapp: c.whatsapp,
      email: c.email,
      address: c.address,
      notes: c.notes,
      primaryCurrency: c.primaryCurrency,
      creditLimit: c.creditLimit.toString(),
      creditLimitLabel: formatMoney(c.creditLimit, c.primaryCurrency),
      paymentTermDays: c.paymentTermDays,
      outstandingUsd,
      outstandingLabel: outstandingUsd > 0 ? formatMoney(outstandingUsd, 'USD') : '—',
      invoiceCount: c._count.salesInvoices,
      status: c.status,
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Roasters and traders you sell coffee to. Each customer's ledger is kept in their own currency."
        breadcrumbs={[{ label: 'Masters' }, { label: 'Customers' }]}
      />
      <CustomersClient
        rows={rows}
        canCreate={can(user, PERMISSIONS.CUSTOMERS_CREATE)}
        openCreate={openCreate}
        canEdit={can(user, PERMISSIONS.CUSTOMERS_EDIT)}
        defaultCurrency={user.activeCompany.code === 'FID-MA' ? 'MAD' : 'USD'}
      />
    </div>
  );
}
