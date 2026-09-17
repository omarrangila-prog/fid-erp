import { transaction } from '@/lib/db';
import type { Tx } from '@/lib/db';
import { Decimal, convertToUsd, dec, toMoney } from '@/lib/money';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { getRate } from '@/lib/services/exchange-rate';
import { writeAudit } from '@/lib/services/audit';

/**
 * Money lent to the company, and money the company lends, by anybody at all.
 *
 * The inter-company loan screen answers one case — Dubai lending to Morocco —
 * but the client borrows from directors, shareholders and friends on the same
 * terms and with the same questions:
 *
 *     Who gave us the money?      How much do we owe them?
 *     What reached our bank?      At what rate?
 *
 * So the lender is a named ledger account rather than a second company, and one
 * is opened for anybody who does not have one yet. Ahmed lends dirhams this
 * month and dollars the next; both sit in "Ahmed", each shown in its own
 * currency, and the net is what the company owes him.
 *
 * The accounting is the same either way and touches no income or expense
 * account: borrowing money is not revenue and lending it is not a cost.
 *
 *     RECEIVED   Dr Bank                Cr Loan from <lender>
 *     GIVEN      Dr Loan to <borrower>  Cr Bank
 *     REPAID     Dr Loan from <lender>  Cr Bank
 *
 * Where the money arrives in a different currency from the loan — USD 50,000
 * landing as MAD 461,000 at 9.22 — both facts are kept. The bank moves by what
 * really reached it; the debt is stated in the currency it was struck in, at
 * the rate of the day, so the ledger answers "we owe USD 50,000" and "that was
 * MAD 461,000" without either being inferred later from a rate that has moved.
 */

export const LOAN_DIRECTIONS = ['RECEIVED', 'GIVEN', 'REPAID'] as const;
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number];

/** The series named loan and current accounts are opened in. */
const LOAN_SERIES = 2400;

async function nextLoanCode(tx: Tx, companyId: string): Promise<string> {
  const existing = await tx.account.findMany({
    where: { companyId, code: { startsWith: '24' } },
    select: { code: true },
  });
  const taken = new Set(existing.map((row) => row.code));
  for (let offset = 0; offset < 400; offset += 1) {
    const code = String(LOAN_SERIES + offset);
    if (!taken.has(code)) return code;
  }
  throw new BusinessRuleError('There is no free account code left in the loan series.');
}

/**
 * The lender's own ledger, opened the first time they lend.
 *
 * Matching on the name is what makes "Ahmed" one account rather than four:
 * the client types a name, not a code, and typing it again next month has to
 * find the same ledger. An account they already keep — the one they made
 * themselves for Dubai, say — is used as it stands rather than duplicated.
 */
export async function findOrCreateLoanAccount(
  tx: Tx,
  params: { companyId: string; userId: string; name: string; direction: LoanDirection },
) {
  const name = params.name.trim();
  if (!name) throw new BusinessRuleError('Say who the loan is with.');

  const existing = await tx.account.findFirst({
    where: {
      companyId: params.companyId,
      status: 'ACTIVE',
      type: { in: ['ASSET', 'LIABILITY'] },
      subledgerType: 'NONE',
      cashBankAccounts: { none: {} },
      OR: [
        { name: { equals: name, mode: 'insensitive' } },
        { name: { equals: `Loan from ${name}`, mode: 'insensitive' } },
        { name: { equals: `Loan to ${name}`, mode: 'insensitive' } },
      ],
    },
  });
  if (existing) return existing;

  // Money received is owed, so the account opens as a liability; money lent is
  // owed to us. Either way it is one running account that can go both ways,
  // and it holds no fixed currency because the same person may deal in both.
  const borrowing = params.direction !== 'GIVEN';
  const created = await tx.account.create({
    data: {
      companyId: params.companyId,
      code: await nextLoanCode(tx, params.companyId),
      name: borrowing ? `Loan from ${name}` : `Loan to ${name}`,
      type: borrowing ? 'LIABILITY' : 'ASSET',
      reportGroup: borrowing ? 'CURRENT_LIABILITY' : 'CURRENT_ASSET',
      currency: null,
      isSystem: false,
      subledgerType: 'NONE',
    },
  });

  await writeAudit(tx, {
    companyId: params.companyId,
    userId: params.userId,
    action: 'LEDGER_ACCOUNT_CREATED',
    entityType: 'Account',
    entityId: created.id,
    after: { code: created.code, name: created.name, openedFor: 'LOAN', lender: name },
  });

  return created;
}

export type LoanInput = {
  companyId: string;
  userId: string;
  loanDate: Date;
  direction: LoanDirection;
  /** The other side: a name to find or open an account for… */
  counterpartyName?: string | null;
  /** …or a ledger account already chosen. */
  loanAccountId?: string | null;
  /** The company's own account the money moved through. */
  cashBankAccountId: string;
  /** The currency the loan is struck in — often not the bank's. */
  currency: string;
  /** How much, in that currency. */
  amount: string | number;
  /**
   * Units of the bank's currency per one unit of the loan currency. USD 50,000
   * at 9.22 lands as MAD 461,000. One when the two are the same.
   */
  exchangeRate?: string | number | null;
  /** What the bank really credited, where it differs from amount × rate. */
  bankAmount?: string | number | null;
  reference?: string | null;
  description?: string | null;
};

export async function postLoan(input: LoanInput) {
  const amount = toMoney(input.amount);
  if (amount.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('The loan amount must be greater than zero.');
  }
  if (!input.counterpartyName?.trim() && !input.loanAccountId) {
    throw new BusinessRuleError('Say who the loan is with.');
  }

  return transaction(async (tx) => {
    const company = await getCompanyContext(tx, input.companyId);

    const bank = await tx.cashBankAccount.findFirst({
      where: { id: input.cashBankAccountId, companyId: input.companyId },
      select: { id: true, name: true, currency: true, status: true },
    });
    if (!bank) throw new NotFoundError('Cash or bank account');
    if (bank.status !== 'ACTIVE') throw new BusinessRuleError(`${bank.name} is inactive.`);

    const loanCurrency = input.currency.trim().toUpperCase();
    const sameCurrency = loanCurrency === bank.currency.toUpperCase();
    const rate = sameCurrency ? dec(1) : dec(input.exchangeRate ?? 0);
    if (rate.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(
        `${bank.name} is a ${bank.currency} account and the loan is in ${loanCurrency}. Enter the rate used on the day.`,
      );
    }

    // A blank "what really landed" arrives as "0", which means nothing was
    // said rather than that nothing arrived.
    const stated = input.bankAmount === undefined || input.bankAmount === null ? null : toMoney(input.bankAmount);
    const moved = stated && stated.greaterThan(0) ? stated : toMoney(amount.times(rate));
    if (moved.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError('The converted amount works out at zero. Check the amount and the rate.');
    }

    /** Units of a currency per 1 USD, on the day, in this company's books. */
    async function usdRate(currency: string): Promise<Decimal> {
      if (currency === 'USD') return dec(1);
      const found =
        (await getRate({ companyId: input.companyId, quoteCurrency: currency, asOf: input.loanDate })) ??
        (await getRate({ companyId: input.companyId, quoteCurrency: currency }));
      if (!found || found.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError(`An exchange rate is required for ${currency}.`);
      }
      return found;
    }

    /*
     * Both lines are worth the same in USD, at the rate of this transaction.
     *
     * The stored rate is what dirhams are worth today; the rate entered is
     * what they were worth when the money moved. Valuing the bank at one and
     * the debt at the other made a loan struck at 9.22 arrive as USD 46,802
     * against USD 50,000 owed, and the entry would not balance. So whichever
     * side is in dollars fixes the other, and the stored rate is used only
     * where the transaction says nothing.
     */
    const bankCode = bank.currency.toUpperCase();
    const bankRateToUsd =
      bankCode === 'USD' ? dec(1) : loanCurrency === 'USD' ? rate : await usdRate(bankCode);
    const movedUsd = convertToUsd(moved, bankRateToUsd, bankCode);
    if (movedUsd.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError('The loan works out at nothing in USD. Check the amount and the rate.');
    }

    const account = input.loanAccountId
      ? await tx.account.findFirst({
          where: { id: input.loanAccountId, companyId: input.companyId, status: 'ACTIVE' },
        })
      : await findOrCreateLoanAccount(tx, {
          companyId: input.companyId,
          userId: input.userId,
          name: input.counterpartyName!,
          direction: input.direction,
        });
    if (!account) throw new NotFoundError('Loan account');
    if (account.type !== 'ASSET' && account.type !== 'LIABILITY') {
      throw new BusinessRuleError(
        `${account.name} is not an asset or liability account, so a loan balance cannot sit in it.`,
      );
    }

    /*
     * The debt is stated in the currency it was struck in — "we owe USD
     * 50,000" — unless the account is pinned to one currency, in which case it
     * is stated in that, because the ledger refuses any other. Its rate is
     * derived from this transaction so the two lines agree to the cent.
     */
    const debtCurrency = (account.currency ?? loanCurrency).toUpperCase();
    const debtAmount =
      debtCurrency === loanCurrency
        ? amount
        : debtCurrency === bankCode
          ? moved
          : debtCurrency === 'USD'
            ? movedUsd
            : toMoney(movedUsd.times(await usdRate(debtCurrency)));
    if (debtAmount.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError('The loan works out at zero in the account it is carried in.');
    }
    const debtRateToUsd = debtCurrency === 'USD' ? dec(1) : dec(debtAmount).dividedBy(movedUsd);

    /*
     * The local column follows the transaction too, where the company's own
     * currency is one of the two. Reading a stored rate there would state the
     * bank in dirhams at 9.85 and the debt at 9.22, and the entry would not
     * balance locally even though it balanced in dollars.
     */
    const localCode = company.localCurrency.toUpperCase();
    const rateLocalPerUsd =
      localCode === bankCode
        ? bankRateToUsd
        : localCode === debtCurrency
          ? debtRateToUsd
          : await usdRate(localCode);

    const counterparty = input.counterpartyName?.trim() || account.name;
    const note = input.reference?.trim() ? ` · ${input.reference.trim()}` : '';
    const memo = input.description?.trim();
    const headline =
      input.direction === 'RECEIVED'
        ? `Loan received from ${counterparty}`
        : input.direction === 'GIVEN'
          ? `Loan given to ${counterparty}`
          : `Loan repaid to ${counterparty}`;

    // Money in on a loan received; money out when giving or repaying one.
    const moneyIn = input.direction === 'RECEIVED';

    const entry = await postJournalEntry(tx, {
      companyId: input.companyId,
      entryDate: input.loanDate,
      description: `${memo || headline}${note}`,
      sourceType: 'MANUAL',
      sourceId: `LOANX-${Date.now()}`,
      createdById: input.userId,
      localCurrency: company.localCurrency,
      rateLocalPerUsd,
      lines: [
        {
          cashBankAccountId: bank.id,
          direction: moneyIn ? 'DEBIT' : 'CREDIT',
          currency: bank.currency,
          amount: moved,
          rateToUsd: bankRateToUsd,
          description: moneyIn ? `Received from ${counterparty}` : `Paid to ${counterparty}`,
        },
        {
          accountId: account.id,
          direction: moneyIn ? 'CREDIT' : 'DEBIT',
          currency: debtCurrency,
          amount: debtAmount,
          rateToUsd: debtRateToUsd,
          description:
            input.direction === 'RECEIVED'
              ? `Owed to ${counterparty}`
              : input.direction === 'GIVEN'
                ? `Owed to us by ${counterparty}`
                : `Repayment to ${counterparty}`,
        },
      ],
    });

    await writeAudit(tx, {
      companyId: input.companyId,
      userId: input.userId,
      action: `LOAN_${input.direction}`,
      entityType: 'JournalEntry',
      entityId: entry.id,
      after: {
        counterparty,
        account: `${account.code} ${account.name}`,
        loan: `${loanCurrency} ${amount.toFixed(2)}`,
        bank: `${bank.currency} ${moved.toFixed(2)} · ${bank.name}`,
        rate: rate.toString(),
        reference: input.reference ?? null,
      },
    });

    return { entry, account, amount, moved, rate };
  }, 60_000);
}
