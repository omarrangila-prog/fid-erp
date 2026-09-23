import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { prisma } from '@/lib/db';
import { getPayables } from '@/lib/services/receivables';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { PaymentForm, type OpenContract } from '@/app/(app)/finance/payments/payment-form';

export const metadata: Metadata = { title: 'Edit Payment' };
export const dynamic = 'force-dynamic';

/**
 * Correcting a payment, posted or not.
 *
 * A posted payment is rewritten under its own number: the old posting comes
 * out of the books and the new figures go on. What it settled is owed again
 * while it is being rewritten, so the documents it is already against are
 * offered here alongside the ones still outstanding.
 */
export default async function EditPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.PAYMENTS_CREATE);
  const companyId = user.activeCompany.id;

  const payment = await prisma.payment.findFirst({
    where: { id, companyId },
    include: {
      allocations: { select: { purchaseContractId: true, expenseId: true, amount: true } },
      cheque: { select: { chequeNumber: true, chequeDate: true, bankName: true } },
    },
  });
  if (!payment) notFound();
  if (payment.status !== 'DRAFT' && payment.status !== 'POSTED') redirect(`/finance/payments/${payment.id}`);

  const allocatedContractIds = payment.allocations.map((a) => a.purchaseContractId).filter((v): v is string => !!v);
  const allocatedExpenseIds = payment.allocations.map((a) => a.expenseId).filter((v): v is string => !!v);

  const [vendors, accounts, payables, rates, settledContracts, settledExpenses] = await Promise.all([
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
    getRateDefaults(companyId),
    prisma.purchaseContract.findMany({
      where: { id: { in: allocatedContractIds } },
      select: { id: true, contractNumber: true, contractReference: true, contractDate: true, currency: true, vendorId: true, totalValue: true },
    }),
    prisma.expense.findMany({
      where: { id: { in: allocatedExpenseIds } },
      select: { id: true, expenseNumber: true, expenseDate: true, currency: true, description: true, vendorId: true, amount: true, expenseCategory: { select: { name: true } } },
    }),
  ]);

  const contracts: OpenContract[] = payables
    .filter((p): p is typeof p & { kind: 'CONTRACT' | 'EXPENSE' } => p.kind !== 'OPENING')
    .map((p) => ({
      kind: p.kind,
      id: p.contractId,
      label: p.contractReference || p.contractNumber,
      contractDate: toDateInputValue(p.contractDate),
      currency: p.currency,
      outstanding: p.outstandingAmount.toString(),
      vendorId: p.vendorId,
    }));

  // What this payment already settled, which the outstanding list no longer has.
  for (const contract of settledContracts) {
    if (contracts.some((c) => c.id === contract.id)) continue;
    contracts.push({
      kind: 'CONTRACT',
      id: contract.id,
      label: contract.contractReference || contract.contractNumber,
      contractDate: toDateInputValue(contract.contractDate),
      currency: contract.currency,
      outstanding: contract.totalValue.toString(),
      vendorId: contract.vendorId,
    });
  }
  for (const expense of settledExpenses) {
    if (contracts.some((c) => c.id === expense.id)) continue;
    contracts.push({
      kind: 'EXPENSE',
      id: expense.id,
      label: expense.expenseCategory?.name ?? expense.description ?? 'Cost',
      contractDate: toDateInputValue(expense.expenseDate),
      currency: expense.currency,
      outstanding: expense.amount.toString(),
      vendorId: expense.vendorId,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Edit payment"
        description={
          payment.status === 'POSTED'
            ? 'This payment is posted. Saving takes the old posting back out of the books and writes the new one under the same number — the journal keeps both, so the correction can be traced.'
            : 'Drafts have no ledger impact. Saving replaces the voucher; posting writes the journal once.'
        }
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Payments', href: '/finance/payments' },
          { label: payment.paymentNumber, href: `/finance/payments/${payment.id}` },
          { label: 'Edit' },
        ]}
      />
      <PaymentForm
        vendors={vendors.map((v) => ({
          value: v.id,
          label: v.vendorName,
          hint: v.primaryCurrency,
          keywords: v.vendorCode,
          currency: v.primaryCurrency,
        }))}
        accounts={accounts.map((a) => ({
          value: a.id,
          label: a.name,
          hint: `${a.currency} · ${a.accountType.replaceAll('_', ' ').toLowerCase()}`,
          keywords: `${a.code} ${a.currency}`,
          currency: a.currency,
          accountType: a.accountType,
        }))}
        contracts={contracts}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        canPost={can(user, PERMISSIONS.PAYMENTS_POST)}
        canCreateCashBank={can(user, PERMISSIONS.CASHBANK_MANAGE)}
        initial={{
          id: payment.id,
          status: payment.status,
          paymentNumber: payment.paymentNumber,
          paymentDate: toDateInputValue(payment.paymentDate),
          vendorId: payment.vendorId,
          currency: payment.currency,
          amount: payment.amount.toString(),
          rateToUsd: payment.rateToUsd.toString(),
          rateLocalPerUsd: payment.rateLocalPerUsd.toString(),
          paymentMethod: payment.paymentMethod,
          cashBankAccountId: payment.cashBankAccountId,
          reference: payment.reference ?? '',
          description: payment.description ?? '',
          allocations: payment.allocations.map((a) => ({
            id: (a.purchaseContractId ?? a.expenseId)!,
            amount: a.amount.toString(),
          })),
          cheque: payment.cheque
            ? {
                chequeNumber: payment.cheque.chequeNumber,
                chequeDate: toDateInputValue(payment.cheque.chequeDate),
                bankName: payment.cheque.bankName ?? '',
              }
            : null,
        }}
      />
    </div>
  );
}
