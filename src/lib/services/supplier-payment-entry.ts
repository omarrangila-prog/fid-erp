import { transaction } from '@/lib/db';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { dec, toMoney, type Decimal } from '@/lib/money';
import { createPayment, postPaymentIn } from '@/lib/services/payment';
import { getPayables } from '@/lib/services/receivables';

/**
 * Money paid to a supplier, written from the journal entry screen.
 *
 * A manual journal line on Accounts Payable moves the control account but
 * settles nothing: the order it was meant to pay still reads as owed, and the
 * supplier's ageing disagrees with the ledger. So when an entry is "bank to
 * supplier" it is posted as the supplier payment it is — the same service the
 * Payments screen uses — either against the order or bill it settles, at that
 * document's booked value with the exchange difference recognised, or as an
 * advance when there is no invoice yet. Nothing is posted twice: the payment
 * writes the one journal entry.
 */
export type SupplierEntryInput = {
  companyId: string;
  entryDate: Date;
  description: string;
  reference?: string | null;
  vendorId: string;
  /** The ledger account of the cash or bank drawer the money left. */
  bankAccountId: string;
  bankCurrency: string;
  /** What left the bank, in the bank's currency. */
  bankAmount: string;
  supplierCurrency: string;
  /** What the supplier is credited with, in the supplier's currency. */
  supplierAmount: string;
  /** Units of the bank's currency per 1 USD. */
  rateToUsd: string;
  /** Units of the company's currency per 1 USD. */
  rateLocalPerUsd: string;
  settles: { kind: 'DOCUMENT'; purchaseContractId?: string | null; expenseId?: string | null } | { kind: 'ADVANCE' };
};

export type PostedLine = {
  account: string;
  direction: 'DEBIT' | 'CREDIT';
  currency: string;
  amount: string;
  amountLocal: string;
  amountUsd: string;
};

/** The supplier's open orders and bills, as the payment screen offers them. */
export async function getSupplierOpenItems(companyId: string, vendorId: string) {
  const rows = await getPayables({ companyId, vendorId, onlyOutstanding: true });
  return rows
    .filter((r) => r.kind !== 'OPENING' && r.outstandingAmount.greaterThan(0))
    .map((r) => ({
      kind: r.kind,
      id: r.contractId,
      label: r.orderReference ?? r.contractReference,
      number: r.contractNumber,
      currency: r.currency,
      outstanding: r.outstandingAmount.toFixed(2),
    }));
}

class Preview extends Error {
  constructor(readonly lines: PostedLine[]) {
    super('preview');
  }
}

async function write(input: SupplierEntryInput, userId: string): Promise<{ paymentNumber: string; lines: PostedLine[] }> {
  return transaction(async (tx) => {
    const vendor = await tx.vendor.findFirst({ where: { id: input.vendorId, companyId: input.companyId }, select: { id: true } });
    if (!vendor) throw new NotFoundError('Supplier');
    const drawer = await tx.cashBankAccount.findFirst({
      where: { companyId: input.companyId, glAccountId: input.bankAccountId, currency: input.bankCurrency, status: 'ACTIVE' },
      select: { id: true, accountType: true },
    });
    if (!drawer) throw new BusinessRuleError(`Choose a ${input.bankCurrency} cash or bank account for the money that left.`);

    let allocations: Array<{ purchaseContractId?: string | null; expenseId?: string | null; amount: string }> = [];
    if (input.settles.kind === 'DOCUMENT') {
      const { purchaseContractId, expenseId } = input.settles;
      if (!purchaseContractId === !expenseId) throw new BusinessRuleError('Choose the order or bill this payment settles.');
      const open = await getSupplierOpenItems(input.companyId, input.vendorId);
      const doc = open.find((o) => o.id === (purchaseContractId ?? expenseId));
      if (!doc) throw new BusinessRuleError('That order or bill is not open for this supplier.');
      if (doc.currency !== input.supplierCurrency) {
        throw new BusinessRuleError(`${doc.label} is owed in ${doc.currency}; state the supplier amount in ${doc.currency}.`);
      }
      allocations = [{ purchaseContractId: purchaseContractId ?? null, expenseId: expenseId ?? null, amount: toMoney(input.supplierAmount).toFixed(2) }];
    }

    const payment = await createPayment(
      {
        companyId: input.companyId,
        paymentDate: input.entryDate,
        vendorId: input.vendorId,
        currency: input.bankCurrency,
        amount: toMoney(input.bankAmount).toFixed(2),
        rateToUsd: input.bankCurrency === 'USD' ? '1' : input.rateToUsd,
        rateLocalPerUsd: input.rateLocalPerUsd,
        cashBankAccountId: drawer.id,
        paymentMethod: drawer.accountType === 'CASH' ? 'CASH' : 'BANK_TRANSFER',
        reference: input.reference ?? null,
        description: input.description,
        allocations,
        // No invoice yet: the money is the supplier's advance, never a
        // settlement of a bill that does not exist.
        keepRemainderAsAdvance: input.settles.kind === 'ADVANCE',
      },
      userId,
    );
    await postPaymentIn(tx, { id: payment.id, companyId: input.companyId, userId });

    const entry = await tx.journalEntry.findFirstOrThrow({
      where: { companyId: input.companyId, sourceType: 'PAYMENT', sourceId: payment.id, isReversal: false },
      orderBy: { sourceSeq: 'desc' },
      include: { lines: { orderBy: { lineNumber: 'asc' }, include: { account: { select: { name: true } } } } },
    });
    const lines = entry.lines.map((l): PostedLine => {
      const debit = dec(l.debit).greaterThan(0) || dec(l.debitLocal).greaterThan(0);
      return {
        account: l.account.name,
        direction: debit ? 'DEBIT' : 'CREDIT',
        currency: l.currency,
        amount: (debit ? dec(l.debit) : dec(l.credit)).toFixed(2),
        amountLocal: (debit ? dec(l.debitLocal) : dec(l.creditLocal)).toFixed(2),
        amountUsd: (debit ? dec(l.debitUsd) : dec(l.creditUsd)).toFixed(2),
      };
    });
    return { paymentNumber: payment.paymentNumber, lines };
  });
}

/** Exactly what posting would write, rolled back. */
export async function previewSupplierEntry(input: SupplierEntryInput, userId: string): Promise<PostedLine[]> {
  try {
    await transaction(async () => {
      const { lines } = await write(input, userId);
      throw new Preview(lines);
    });
  } catch (error) {
    if (error instanceof Preview) return error.lines;
    throw error;
  }
  return [];
}

export async function postSupplierEntry(input: SupplierEntryInput, userId: string) {
  return write(input, userId);
}

/** Debits less credits in the company's currency: zero on a balanced entry. */
export function localDifference(lines: PostedLine[]): Decimal {
  return lines.reduce((t, l) => (l.direction === 'DEBIT' ? t.plus(l.amountLocal) : t.minus(l.amountLocal)), dec(0));
}
