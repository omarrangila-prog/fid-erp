import { transaction } from '@/lib/db';
import { dec, toMoney } from '@/lib/money';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { getRate } from '@/lib/services/exchange-rate';
import { writeAudit } from '@/lib/services/audit';

/**
 * Move money between two cash/bank accounts of the same currency.
 *
 * Debit destination, credit source. No P&L. The original amount is posted
 * unchanged onto both cash books and the GL.
 */
export async function postCashBankTransfer(input: {
  companyId: string;
  userId: string;
  transferDate: Date;
  fromAccountId: string;
  toAccountId: string;
  amount: string | number;
  reference?: string | null;
  description?: string | null;
}) {
  const amount = toMoney(input.amount);
  if (amount.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('The transfer amount must be greater than zero.');
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new BusinessRuleError('Choose two different accounts.');
  }

  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, input.companyId);
    const [from, to] = await Promise.all([
      tx.cashBankAccount.findFirst({
        where: { id: input.fromAccountId, companyId: input.companyId },
        select: { id: true, name: true, currency: true, status: true },
      }),
      tx.cashBankAccount.findFirst({
        where: { id: input.toAccountId, companyId: input.companyId },
        select: { id: true, name: true, currency: true, status: true },
      }),
    ]);
    if (!from) throw new NotFoundError('Source account');
    if (!to) throw new NotFoundError('Destination account');
    if (from.status !== 'ACTIVE') throw new BusinessRuleError(`${from.name} is inactive.`);
    if (to.status !== 'ACTIVE') throw new BusinessRuleError(`${to.name} is inactive.`);
    if (from.currency !== to.currency) {
      throw new BusinessRuleError(
        `Both accounts must be in the same currency. ${from.name} is ${from.currency} and ${to.name} is ${to.currency}.`,
      );
    }

    const rateToUsd =
      from.currency === 'USD'
        ? dec(1)
        : ((await getRate({ companyId: input.companyId, quoteCurrency: from.currency, asOf: input.transferDate })) ??
          (await getRate({ companyId: input.companyId, quoteCurrency: from.currency })) ??
          dec(0));
    if (rateToUsd.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`An exchange rate is required for ${from.currency}.`);
    }
    const rateLocalPerUsd =
      company.localCurrency === 'USD'
        ? dec(1)
        : from.currency === company.localCurrency
          ? rateToUsd
          : ((await getRate({
              companyId: input.companyId,
              quoteCurrency: company.localCurrency,
              asOf: input.transferDate,
            })) ??
            (await getRate({ companyId: input.companyId, quoteCurrency: company.localCurrency })) ??
            rateToUsd);

    const sourceId = `XFER-${Date.now()}`;
    const description =
      input.description?.trim() ||
      `Transfer ${from.currency} ${amount.toFixed(2)} from ${from.name} to ${to.name}${input.reference ? ` · ${input.reference}` : ''}`;

    const entry = await postJournalEntry(tx, {
      companyId: input.companyId,
      entryDate: input.transferDate,
      description,
      sourceType: 'MANUAL',
      sourceId,
      createdById: input.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd,
      lines: [
        {
          cashBankAccountId: to.id,
          direction: 'DEBIT',
          currency: from.currency,
          amount,
          rateToUsd,
          description: `From ${from.name}`,
        },
        {
          cashBankAccountId: from.id,
          direction: 'CREDIT',
          currency: from.currency,
          amount,
          rateToUsd,
          description: `To ${to.name}`,
        },
      ],
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: 'CASH_BANK_TRANSFER',
      entityType: 'JournalEntry',
      entityId: entry.id,
      after: {
        from: from.name,
        to: to.name,
        amount,
        currency: from.currency,
        reference: input.reference ?? null,
      },
    });

    return entry;
  });
}
