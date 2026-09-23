import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { getReceivables } from '@/lib/services/receivables';
import { toDateInputValue } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { ReceiptForm, type OpenInvoice, type BankOption } from '@/app/(app)/finance/receipts/receipt-form';

export const metadata: Metadata = { title: 'Edit Receipt' };
export const dynamic = 'force-dynamic';

/**
 * Correcting a receipt, posted or not.
 *
 * A posted receipt is rewritten under its own number: the old posting comes
 * out of the books, the new figures go on, and the paper in somebody's hand
 * still points at a document that exists. The invoices it settled are
 * outstanding again while it is being rewritten, so they are all offered
 * here, not only the ones with a balance left.
 */
export default async function EditReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requirePageAccess(PERMISSIONS.RECEIPTS_CREATE);
  const companyId = user.activeCompany.id;

  const receipt = await prisma.receipt.findFirst({
    where: { id, companyId },
    include: {
      allocations: { select: { salesInvoiceId: true, amount: true } },
      cheque: { select: { chequeNumber: true, chequeDate: true, bankName: true, beneficiary: true } },
    },
  });
  if (!receipt) notFound();
  if (receipt.status !== 'DRAFT' && receipt.status !== 'POSTED') redirect(`/finance/receipts/${receipt.id}`);

  const [customers, accounts, receivables, agents, rates, settled] = await Promise.all([
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
    prisma.agent.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: { agentName: 'asc' },
      select: { id: true, agentName: true },
    }),
    getRateDefaults(companyId),
    // The invoices this receipt is already against: without these the form
    // would open with its own allocations missing from the list.
    prisma.salesInvoice.findMany({
      where: { id: { in: receipt.allocations.map((a) => a.salesInvoiceId) } },
      select: { id: true, invoiceNumber: true, invoiceDate: true, currency: true, customerId: true, totalAmount: true },
    }),
  ]);

  const invoices: OpenInvoice[] = [
    ...receivables.map((r) => ({
      id: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      invoiceDate: toDateInputValue(r.invoiceDate),
      currency: r.currency,
      outstanding: r.outstandingAmount.toString(),
      customerId: r.customerId,
    })),
    ...settled
      .filter((invoice) => !receivables.some((r) => r.invoiceId === invoice.id))
      .map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: toDateInputValue(invoice.invoiceDate),
        currency: invoice.currency,
        outstanding: invoice.totalAmount.toString(),
        customerId: invoice.customerId,
      })),
  ];

  const bankOptions: BankOption[] = accounts.map((a) => ({
    value: a.id,
    label: a.name,
    hint: `${a.currency} · ${a.accountType.replaceAll('_', ' ').toLowerCase()}`,
    keywords: `${a.code} ${a.currency}`,
    currency: a.currency,
    accountType: a.accountType,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Edit receipt"
        description={
          receipt.status === 'POSTED'
            ? 'This receipt is posted. Saving takes the old posting back out of the books and writes the new one under the same number — the journal keeps both, so the correction can be traced.'
            : 'Drafts have no ledger impact. Saving replaces the voucher; posting writes the journal once.'
        }
        breadcrumbs={[
          { label: 'Finance' },
          { label: 'Receipts', href: '/finance/receipts' },
          { label: receipt.receiptNumber, href: `/finance/receipts/${receipt.id}` },
          { label: 'Edit' },
        ]}
      />
      <ReceiptForm
        customers={customers.map((c) => ({
          value: c.id,
          label: c.customerName,
          hint: c.primaryCurrency,
          keywords: c.customerCode,
          currency: c.primaryCurrency,
        }))}
        accounts={bankOptions}
        invoices={invoices}
        localCurrency={user.activeCompany.localCurrency}
        defaultLocalRate={rates.local}
        ratesByCurrency={rates.byCurrency}
        agents={agents.map((a) => ({ id: a.id, name: a.agentName }))}
        canPost={can(user, PERMISSIONS.RECEIPTS_POST)}
        canCreateCashBank={can(user, PERMISSIONS.CASHBANK_MANAGE)}
        initial={{
          id: receipt.id,
          status: receipt.status,
          receiptNumber: receipt.receiptNumber,
          receiptDate: toDateInputValue(receipt.receiptDate),
          customerId: receipt.customerId,
          currency: receipt.currency,
          amount: receipt.amount.toString(),
          rateToUsd: receipt.rateToUsd.toString(),
          rateLocalPerUsd: receipt.rateLocalPerUsd.toString(),
          paymentMethod: receipt.paymentMethod,
          cashBankAccountId: receipt.cashBankAccountId,
          agentId: receipt.agentId,
          reference: receipt.reference ?? '',
          description: receipt.description ?? '',
          allocations: receipt.allocations.map((a) => ({
            salesInvoiceId: a.salesInvoiceId,
            amount: a.amount.toString(),
          })),
          cheque: receipt.cheque
            ? {
                chequeNumber: receipt.cheque.chequeNumber,
                chequeDate: toDateInputValue(receipt.cheque.chequeDate),
                bankName: receipt.cheque.bankName ?? '',
                beneficiary: receipt.cheque.beneficiary ?? '',
              }
            : null,
        }}
      />
    </div>
  );
}
