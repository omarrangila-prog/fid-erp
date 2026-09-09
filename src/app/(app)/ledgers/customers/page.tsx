import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { getCustomerBalance } from '@/lib/services/accounting';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';

export const metadata: Metadata = { title: 'Customer Ledgers' };
export const dynamic = 'force-dynamic';

export default async function CustomerLedgersPage() {
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const customers = await prisma.customer.findMany({
    where: { companyId },
    orderBy: { customerName: 'asc' },
    select: { id: true, customerName: true, customerCode: true, primaryCurrency: true, country: true },
  });

  const balances = await transaction(async (tx) => {
    const out: Record<string, string> = {};
    for (const customer of customers) {
      out[customer.id] = (await getCustomerBalance(tx, companyId, customer.id)).toString();
    }
    return out;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer Ledgers"
        description="Each customer's account, viewable in their own currency, in USD, or in the company's local books."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Customer Ledgers' }]}
      />

      {customers.length === 0 ? (
        <EmptyState title="No customers yet" description="Add a customer to open a ledger." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Customer</TH>
                <TH>Country</TH>
                <TH>Ledger currency</TH>
                <TH numeric>Balance</TH>
              </TR>
            </THead>
            <TBody>
              {customers.map((customer) => (
                <TR key={customer.id}>
                  <TD>
                    <Link
                      href={`/ledgers/customers/${customer.id}`}
                      className="font-medium text-forest-800 hover:text-gold-700"
                    >
                      <span className="block">{customer.customerName}</span>
                      <span className="block text-xs font-normal text-ink-subtle">{customer.customerCode}</span>
                    </Link>
                  </TD>
                  <TD>{customer.country ?? '—'}</TD>
                  <TD>
                    <Badge tone="neutral">{customer.primaryCurrency}</Badge>
                  </TD>
                  <TD numeric className="font-semibold">
                    {formatMoney(balances[customer.id] ?? 0, customer.primaryCurrency)}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableWrap>
      )}
    </div>
  );
}
