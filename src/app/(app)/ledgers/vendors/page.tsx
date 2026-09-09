import type { Metadata } from 'next';
import Link from 'next/link';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma, transaction } from '@/lib/db';
import { getVendorBalance } from '@/lib/services/accounting';
import { formatMoney } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { Table, TableWrap, TBody, TD, TH, THead, TR } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/feedback';

export const metadata: Metadata = { title: 'Supplier Ledgers' };
export const dynamic = 'force-dynamic';

export default async function VendorLedgersPage() {
  const user = await requirePageAccess(PERMISSIONS.LEDGERS_VIEW);
  const companyId = user.activeCompany.id;

  const vendors = await prisma.vendor.findMany({
    where: { companyId },
    orderBy: { vendorName: 'asc' },
    select: { id: true, vendorName: true, vendorCode: true, primaryCurrency: true, country: true },
  });

  const balances = await transaction(async (tx) => {
    const out: Record<string, string> = {};
    for (const vendor of vendors) {
      out[vendor.id] = (await getVendorBalance(tx, companyId, vendor.id)).toString();
    }
    return out;
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Supplier Ledgers"
        description="Overseas coffee suppliers are carried in USD for both companies, viewable in local currency too."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Supplier Ledgers' }]}
      />

      {vendors.length === 0 ? (
        <EmptyState title="No suppliers yet" description="Add a supplier to open a ledger." />
      ) : (
        <TableWrap>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Supplier</TH>
                <TH>Origin</TH>
                <TH>Ledger currency</TH>
                <TH numeric>We owe</TH>
              </TR>
            </THead>
            <TBody>
              {vendors.map((vendor) => (
                <TR key={vendor.id}>
                  <TD>
                    <Link href={`/ledgers/vendors/${vendor.id}`} className="font-medium text-forest-800 hover:text-gold-700">
                      <span className="block">{vendor.vendorName}</span>
                      <span className="block text-xs font-normal text-ink-subtle">{vendor.vendorCode}</span>
                    </Link>
                  </TD>
                  <TD>{vendor.country ?? '—'}</TD>
                  <TD>
                    <Badge tone="neutral">{vendor.primaryCurrency}</Badge>
                  </TD>
                  <TD numeric className="font-semibold">
                    {formatMoney(balances[vendor.id] ?? 0, vendor.primaryCurrency)}
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
