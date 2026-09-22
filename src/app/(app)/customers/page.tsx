import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getReceivables } from '@/lib/services/receivables';
import { formatMoney, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { getRateDefaults } from '@/lib/services/exchange-rate';
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

  const [customers, agents, receivables, traded, rates] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId },
      orderBy: { customerName: 'asc' },
      include: { _count: { select: { salesInvoices: true } } },
    }),
    // For the one case where a customer and an agent are the same person.
    prisma.agent.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { agentName: 'asc' },
      select: { id: true, agentName: true },
    }),
    getReceivables({ companyId, onlyOutstanding: true }),
    // What each customer has actually bought and paid, and when they last
    // did anything — the three figures the client wants without opening a
    // ledger, read from the posted invoices and the receipts against them.
    prisma.$queryRaw<
      Array<{ customerId: string; currency: string; sold: string; received: string; lastAt: Date | null }>
    >`
      SELECT si."customerId", si."currency",
             COALESCE(SUM(si."totalAmount"), 0)::text AS sold,
             COALESCE(SUM((
               SELECT COALESCE(SUM(ra."amount"), 0) FROM receipt_allocations ra
               JOIN receipts r ON r."id" = ra."receiptId"
               WHERE ra."salesInvoiceId" = si."id" AND r."status" = 'POSTED'
             )), 0)::text AS received,
             MAX(si."invoiceDate") AS "lastAt"
      FROM sales_invoices si
      WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'
      GROUP BY si."customerId", si."currency"`,
    getRateDefaults(companyId),
  ]);

  const tradedByCustomer = new Map(traded.map((row) => [row.customerId, row]));

  const outstandingByCustomer = new Map<string, { amount: number; currency: string; usd: number }>();
  for (const row of receivables) {
    const existing = outstandingByCustomer.get(row.customerId);
    if (!existing) {
      outstandingByCustomer.set(row.customerId, {
        amount: Number(row.outstandingAmount),
        currency: row.currency,
        usd: Number(row.outstandingAmountUsd),
      });
      continue;
    }
    existing.usd += Number(row.outstandingAmountUsd);
    if (existing.currency === row.currency) {
      existing.amount += Number(row.outstandingAmount);
    } else {
      existing.currency = 'MIXED';
    }
  }

  // Decimals are formatted here so nothing but plain data crosses to the client.
  const rows: CustomerRow[] = customers.map((c) => {
    const outstanding = outstandingByCustomer.get(c.id);
    const outstandingUsd = outstanding?.usd ?? 0;
    const outstandingLabel =
      !outstanding || outstandingUsd === 0
        ? '—'
        : outstanding.currency === 'MIXED'
          ? formatMoney(outstanding.usd, 'USD')
          : formatMoney(outstanding.amount, outstanding.currency);
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
      outstandingUsd,
      outstandingLabel,
      invoiceCount: c._count.salesInvoices,
      soldLabel: (() => {
        const row = tradedByCustomer.get(c.id);
        return row ? formatMoney(row.sold, row.currency) : '—';
      })(),
      soldSort: Number(tradedByCustomer.get(c.id)?.sold ?? 0),
      receivedLabel: (() => {
        const row = tradedByCustomer.get(c.id);
        return row ? formatMoney(row.received, row.currency) : '—';
      })(),
      lastTradedLabel: (() => {
        const at = tradedByCustomer.get(c.id)?.lastAt;
        return at ? formatDate(at) : '—';
      })(),
      lastTradedSort: tradedByCustomer.get(c.id)?.lastAt?.getTime() ?? 0,
      status: c.status,
      agentId: c.agentId,
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
        canPostOpening={can(user, PERMISSIONS.ACCOUNTING_POST)}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        defaultCurrency={user.activeCompany.code === 'FID-MA' ? 'MAD' : 'USD'}
        agents={agents}
      />
    </div>
  );
}
