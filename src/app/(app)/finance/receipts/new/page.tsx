import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getReceivables } from '@/lib/services/receivables';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { ReceiptForm, type OpenInvoice, type BankOption } from '@/app/(app)/finance/receipts/receipt-form';

export const metadata: Metadata = { title: 'New Receipt' };
export const dynamic = 'force-dynamic';

export default async function NewReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ invoice?: string }>;
}) {
  const { invoice } = await searchParams;
  const user = await requirePageAccess(PERMISSIONS.RECEIPTS_CREATE);
  const companyId = user.activeCompany.id;

  const [customers, accounts, receivables] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { customerName: 'asc' },
      select: { id: true, customerName: true, customerCode: true, primaryCurrency: true },
    }),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true, accountType: true },
    }),
    getReceivables({ companyId, onlyOutstanding: true }),
  ]);

  const prerequisites: Prerequisite[] = [
    {
      met: customers.length > 0,
      label: 'At least one customer',
      description: 'Money received is always received from somebody.',
      href: '/customers?new=1',
      actionLabel: 'Add customer',
    },
    {
      met: accounts.length > 0,
      label: 'A cash or bank account',
      description: 'The receipt has to land somewhere. One account per currency is the usual arrangement.',
      href: '/finance/cash-bank',
      actionLabel: 'Open cash & bank',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New Receipt"
          breadcrumbs={[{ label: 'Finance' }, { label: 'Receipts', href: '/finance/receipts' }, { label: 'New' }]}
        />
        <PrerequisiteGate
          title="Before you can record a receipt"
          description="A receipt moves money from a customer into one of your accounts, so both have to exist first."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  const invoices: OpenInvoice[] = receivables.map((r) => ({
    id: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: toDateInputValue(r.invoiceDate),
    currency: r.currency,
    outstanding: r.outstandingAmount.toString(),
    customerId: r.customerId,
  }));

  const bankOptions: BankOption[] = accounts.map((a) => ({
    value: a.id,
    label: a.name,
    hint: `${a.code} · ${a.currency} · ${a.accountType.replaceAll('_', ' ').toLowerCase()}`,
    keywords: `${a.code} ${a.currency}`,
    currency: a.currency,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Receipt"
        description="Record money received from a customer and apply it to their invoices."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Receipts', href: '/finance/receipts' }, { label: 'New' }]}
      />
      <ReceiptForm
        customers={customers.map((c) => ({
          value: c.id,
          label: c.customerName,
          hint: `${c.customerCode} · ${c.primaryCurrency}`,
          keywords: c.customerCode,
          currency: c.primaryCurrency,
        }))}
        accounts={bankOptions}
        invoices={invoices}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={user.activeCompany.localCurrency === 'AED' ? '3.6725' : '9.85'}
        preselectedInvoiceId={invoice}
      />
    </div>
  );
}
