import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getPayables } from '@/lib/services/receivables';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PrerequisiteGate, anyMissing, type Prerequisite } from '@/components/shared/prerequisite-gate';
import { PaymentForm, type OpenContract } from '@/app/(app)/finance/payments/payment-form';

export const metadata: Metadata = { title: 'New Payment' };
export const dynamic = 'force-dynamic';

export default async function NewPaymentPage() {
  const user = await requirePageAccess(PERMISSIONS.PAYMENTS_CREATE);
  const companyId = user.activeCompany.id;

  const [vendors, accounts, payables] = await Promise.all([
    prisma.vendor.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { vendorName: 'asc' },
      select: { id: true, vendorName: true, vendorCode: true, primaryCurrency: true },
    }),
    prisma.cashBankAccount.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, code: true, currency: true, accountType: true },
    }),
    getPayables({ companyId, onlyOutstanding: true }),
  ]);

  const prerequisites: Prerequisite[] = [
    {
      met: vendors.length > 0,
      label: 'At least one supplier',
      description: 'Money paid is always paid to somebody.',
      href: '/vendors?new=1',
      actionLabel: 'Add supplier',
    },
    {
      met: accounts.length > 0,
      label: 'A cash or bank account',
      description: 'The payment has to come out of an account you hold.',
      href: '/finance/cash-bank',
      actionLabel: 'Open cash & bank',
    },
  ];

  if (anyMissing(prerequisites)) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="New Payment"
          breadcrumbs={[{ label: 'Finance' }, { label: 'Payments', href: '/finance/payments' }, { label: 'New' }]}
        />
        <PrerequisiteGate
          title="Before you can record a payment"
          description="A payment moves money from one of your accounts to a supplier, so both have to exist first."
          prerequisites={prerequisites}
        />
      </div>
    );
  }

  const contracts: OpenContract[] = payables.map((p) => ({
    id: p.contractId,
    contractNumber: p.contractNumber,
    contractDate: toDateInputValue(p.contractDate),
    currency: p.currency,
    outstanding: p.outstandingAmount.toString(),
    vendorId: p.vendorId,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New Payment"
        description="Record money paid to a supplier and apply it to their contracts."
        breadcrumbs={[{ label: 'Finance' }, { label: 'Payments', href: '/finance/payments' }, { label: 'New' }]}
      />
      <PaymentForm
        vendors={vendors.map((v) => ({
          value: v.id,
          label: v.vendorName,
          hint: `${v.vendorCode} · ${v.primaryCurrency}`,
          keywords: v.vendorCode,
          currency: v.primaryCurrency,
        }))}
        accounts={accounts.map((a) => ({
          value: a.id,
          label: a.name,
          hint: `${a.code} · ${a.currency}`,
          keywords: `${a.code} ${a.currency}`,
          currency: a.currency,
        }))}
        contracts={contracts}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={user.activeCompany.localCurrency === 'AED' ? '3.6725' : '9.85'}
      />
    </div>
  );
}
