import { transaction } from '@/lib/db';
import type { Decimal } from '@/lib/money';
import { convertToUsd, dec, toMoney } from '@/lib/money';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { postJournalEntry } from '@/lib/services/accounting';
import { getCompanyContext } from '@/lib/services/company';
import { getRate } from '@/lib/services/exchange-rate';
import { writeAudit } from '@/lib/services/audit';

/**
 * Move money between two cash or bank accounts of the same company.
 *
 * Same currency: debit destination, credit source, no profit or loss, the
 * original amount posted unchanged onto both cash books and the GL.
 *
 * Different currencies: the bank decides what arrives, not the bookkeeping
 * rate, so both sides are stated — what left and what landed. Each account
 * moves by the amount it really moved, in its own currency, and whatever the
 * conversion cost or gained against the book rate is a realised exchange
 * difference. Inventing the far side from a stored rate would put a figure in
 * the cash book that the bank statement does not show.
 */
export async function postCashBankTransfer(input: {
  companyId: string;
  userId: string;
  transferDate: Date;
  fromAccountId: string;
  toAccountId: string;
  amount: string | number;
  /** What actually landed, when the two accounts are in different currencies. */
  receivedAmount?: string | number | null;
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
    const crossCurrency = from.currency !== to.currency;
    // As above: a blank field reaches here as "0", which means nothing was
    // said rather than that nothing arrived.
    const received = crossCurrency ? toMoney(input.receivedAmount ?? 0) : amount;
    if (crossCurrency && received.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(
        `${from.name} is ${from.currency} and ${to.name} is ${to.currency}. Say how much ${to.currency} actually arrived.`,
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

    const toRateToUsd = !crossCurrency
      ? rateToUsd
      : to.currency === 'USD'
        ? dec(1)
        : ((await getRate({ companyId: input.companyId, quoteCurrency: to.currency, asOf: input.transferDate })) ??
          (await getRate({ companyId: input.companyId, quoteCurrency: to.currency })) ??
          dec(0));
    if (toRateToUsd.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError(`An exchange rate is required for ${to.currency}.`);
    }

    const sourceId = `XFER-${Date.now()}`;
    const description =
      input.description?.trim() ||
      (crossCurrency
        ? `Transfer ${from.currency} ${amount.toFixed(2)} from ${from.name} to ${to.name} as ${to.currency} ${received.toFixed(2)}${input.reference ? ` · ${input.reference}` : ''}`
        : `Transfer ${from.currency} ${amount.toFixed(2)} from ${from.name} to ${to.name}${input.reference ? ` · ${input.reference}` : ''}`);

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
          currency: to.currency,
          amount: received,
          rateToUsd: toRateToUsd,
          // Stating the USD value each side was booked at tells the posting
          // engine this is a settlement, so the difference between what left
          // and what arrived lands in realised exchange gain or loss rather
          // than being refused as an unbalanced entry.
          ...(crossCurrency ? { bookedUsd: convertToUsd(received, toRateToUsd, to.currency) } : {}),
          description: `From ${from.name}`,
        },
        {
          cashBankAccountId: from.id,
          direction: 'CREDIT',
          currency: from.currency,
          amount,
          rateToUsd,
          ...(crossCurrency ? { bookedUsd: convertToUsd(amount, rateToUsd, from.currency) } : {}),
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
        ...(crossCurrency ? { received, receivedCurrency: to.currency } : {}),
        reference: input.reference ?? null,
      },
    });

    return entry;
  });
}

/**
 * A loan from one FID company to the other.
 *
 * Dubai and Morocco are separate legal entities, so this is not a transfer
 * between accounts and must not be recorded as one. Money leaves a Dubai bank
 * in dollars and lands in a Moroccan bank in dirhams, and what remains is a
 * debt: Dubai is owed, Morocco owes. It stays on both balance sheets until it
 * is repaid.
 *
 * Two journal entries, one in each company's books, written inside a single
 * database transaction so a half-recorded loan cannot exist:
 *
 *   lender    credit bank (USD)    debit  Loan Receivable — Group Company
 *   borrower  debit  bank (MAD)    credit Loan Payable — Group Company
 *
 * The principal touches no income or expense account on either side, because
 * lending money is not a cost and receiving it is not revenue.
 *
 * The rate is the one the person enters — the historical rate the bank
 * actually used — and the amount that lands is worked out from it. Where the
 * bank credited something slightly different, `receivedAmount` states what
 * really arrived and the two sides still each balance in their own books.
 *
 * Company isolation holds: each company's ledgers, reports and reconciliation
 * see only their own entry. What they share is a balance that must agree.
 */
export async function postIntercompanyLoan(input: {
  fromCompanyId: string;
  toCompanyId: string;
  userId: string;
  transferDate: Date;
  fromAccountId: string;
  toAccountId: string;
  /** What leaves the lender's account, in that account's currency. */
  amount: string | number;
  /** Units of the receiving currency per one unit of the sending currency. */
  exchangeRate: string | number;
  /** What actually landed. Defaults to amount × rate. */
  receivedAmount?: string | number | null;
  /**
   * Which account each side carries the debt in.
   *
   * The built-in "Loan Receivable / Payable — Group Company" pair is the
   * default, but a company that keeps a named account for the other company —
   * the usual way of running a current account with a sister business — should
   * be able to say so, rather than have the loan land somewhere they never
   * look.
   */
  fromLoanAccountId?: string | null;
  toLoanAccountId?: string | null;
  reference?: string | null;
  description?: string | null;
}) {
  const sent = toMoney(input.amount);
  const rate = dec(input.exchangeRate);
  if (sent.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('The loan amount must be greater than zero.');
  }
  if (rate.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('Enter the exchange rate used for this loan.');
  }
  if (input.fromCompanyId === input.toCompanyId) {
    throw new BusinessRuleError('A company cannot lend to itself. Use a transfer between its own accounts.');
  }

  return transaction(async (tx) => {
    const [lender, borrower] = await Promise.all([
      getCompanyContext(tx, input.fromCompanyId),
      getCompanyContext(tx, input.toCompanyId),
    ]);

    // Each account must belong to the company it is claimed for. This is what
    // stops money appearing to leave a Dubai account and land in a Moroccan
    // one that Dubai does not own.
    const [from, to] = await Promise.all([
      tx.cashBankAccount.findFirst({
        where: { id: input.fromAccountId, companyId: input.fromCompanyId },
        select: { id: true, name: true, currency: true, status: true },
      }),
      tx.cashBankAccount.findFirst({
        where: { id: input.toAccountId, companyId: input.toCompanyId },
        select: { id: true, name: true, currency: true, status: true },
      }),
    ]);
    if (!from) throw new NotFoundError(`Lending account in ${lender.name}`);
    if (!to) throw new NotFoundError(`Receiving account in ${borrower.name}`);
    if (from.status !== 'ACTIVE') throw new BusinessRuleError(`${from.name} is inactive.`);
    if (to.status !== 'ACTIVE') throw new BusinessRuleError(`${to.name} is inactive.`);

    /*
     * What actually landed, when somebody has said so.
     *
     * An empty field arrives here as "0" rather than as nothing — the
     * validator fills blanks that way — and zero is not an override, it is
     * silence. Reading it as an override rejected every loan where the
     * converted amount was left to be calculated, which is the ordinary case.
     */
    const stated = input.receivedAmount === undefined || input.receivedAmount === null
      ? null
      : toMoney(input.receivedAmount);
    const received = stated && stated.greaterThan(0) ? stated : toMoney(sent.times(rate));
    if (received.lessThanOrEqualTo(0)) {
      throw new BusinessRuleError('The converted amount works out at zero. Check the amount and the rate.');
    }

    /** Units of a currency per 1 USD, on the day, in one company's books. */
    async function usdRate(companyId: string, currency: string) {
      if (currency === 'USD') return dec(1);
      const found =
        (await getRate({ companyId, quoteCurrency: currency, asOf: input.transferDate })) ??
        (await getRate({ companyId, quoteCurrency: currency }));
      if (!found || found.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError(`An exchange rate is required for ${currency}.`);
      }
      return found;
    }

    // The lender's side is measured at the rate the loan was struck at, so
    // both companies record the same debt: dirhams received, divided by the
    // rate entered, is the dollars lent.
    const sentRate = await usdRate(input.fromCompanyId, from.currency);
    const receivedRateToUsd =
      to.currency === 'USD'
        ? dec(1)
        : from.currency === 'USD'
          ? rate
          : await usdRate(input.toCompanyId, to.currency);

    /*
     * A company's own books carry this loan at the rate the loan was struck
     * at, not at today's.
     *
     * Where a company's local currency is the currency its side of the loan
     * moved in, the loan's own rate is the local rate by definition — Morocco
     * received dirhams at 9.22, so 9.22 is what its dirham books used. Reading
     * a stored rate instead put 9.85 on an entry whose lines were all at 9.22,
     * which stayed invisible only while every line was in dirhams and threw
     * the local column out the moment one was not.
     */
    const [lenderLocalRate, borrowerLocalRate] = await Promise.all([
      lender.localCurrency === from.currency
        ? Promise.resolve(sentRate)
        : usdRate(input.fromCompanyId, lender.localCurrency),
      borrower.localCurrency === to.currency
        ? Promise.resolve(receivedRateToUsd)
        : usdRate(input.toCompanyId, borrower.localCurrency),
    ]);

    const sourceId = `LOAN-${Date.now()}`;

    /*
     * The bank's reference belongs on the entry whatever else was written.
     *
     * A journal entry has no reference column of its own, so the description
     * carries it. Appending it only to the default description meant that
     * anyone who typed a memo lost their reference silently — the one detail
     * they need to tie the entry back to the bank statement.
     */
    const note = input.reference?.trim() ? ` · ${input.reference.trim()}` : '';
    const memo = input.description?.trim();

    /*
     * A chosen account must belong to the company that will carry it, and
     * must be one a balance can sit in. Without the first check a Moroccan
     * account could be named on Dubai's entry, which is the cross-company
     * leak the whole application is built to prevent.
     */
    async function loanAccount(companyId: string, accountId: string | null | undefined, side: string) {
      if (!accountId) return null;
      const account = await tx.account.findFirst({
        where: { id: accountId, companyId, status: 'ACTIVE' },
        select: { id: true, name: true, type: true, currency: true },
      });
      if (!account) throw new NotFoundError(`${side} loan account`);
      if (account.type !== 'ASSET' && account.type !== 'LIABILITY') {
        throw new BusinessRuleError(
          `${account.name} is not an asset or liability account, so a loan balance cannot sit in it.`,
        );
      }
      return account;
    }

    const [lenderLoanAccount, borrowerLoanAccount] = await Promise.all([
      loanAccount(input.fromCompanyId, input.fromLoanAccountId, `${lender.name}'s`),
      loanAccount(input.toCompanyId, input.toLoanAccountId, `${borrower.name}'s`),
    ]);

    /*
     * The debt is stated in whatever currency the account is held in.
     *
     * A company that keeps its account with the other one in dollars is
     * recording a dollar debt, even though the money arrived as dirhams — and
     * the ledger refuses a MAD line in a USD account outright, so a loan
     * pointed at such an account could not be posted at all. The bank line
     * still moves by what really moved; only the debt is restated, at the same
     * rate, so both lines are worth the same in USD and the entry balances.
     */
    async function loanSide(
      companyId: string,
      account: { id: string; currency: string | null } | null,
      bank: { currency: string; amount: Decimal; rateToUsd: Decimal },
    ) {
      const target = account?.currency ?? bank.currency;
      const where = account ? { accountId: account.id } : null;
      if (target === bank.currency) {
        return { where, currency: bank.currency, amount: bank.amount, rateToUsd: bank.rateToUsd };
      }
      const usd = convertToUsd(bank.amount, bank.rateToUsd, bank.currency);
      const rateToUsd = await usdRate(companyId, target);
      return { where, currency: target, amount: toMoney(usd.times(rateToUsd)), rateToUsd };
    }

    const [lenderSide, borrowerSide] = await Promise.all([
      loanSide(input.fromCompanyId, lenderLoanAccount, {
        currency: from.currency,
        amount: sent,
        rateToUsd: sentRate,
      }),
      loanSide(input.toCompanyId, borrowerLoanAccount, {
        currency: to.currency,
        amount: received,
        rateToUsd: receivedRateToUsd,
      }),
    ]);

    const lenderEntry = await postJournalEntry(tx, {
      companyId: input.fromCompanyId,
      entryDate: input.transferDate,
      description: `${memo || `Loan to ${borrower.name}`}${note}`,
      sourceType: 'MANUAL',
      sourceId,
      createdById: input.userId,
      localCurrency: lender.localCurrency,
      rateLocalPerUsd: lenderLocalRate,
      lines: [
        {
          ...(lenderSide.where ?? { accountKey: ACCOUNT_KEYS.INTERCOMPANY_LOAN_RECEIVABLE }),
          direction: 'DEBIT',
          currency: lenderSide.currency,
          amount: lenderSide.amount,
          rateToUsd: lenderSide.rateToUsd,
          description: `Lent to ${borrower.name}`,
        },
        {
          cashBankAccountId: from.id,
          direction: 'CREDIT',
          currency: from.currency,
          amount: sent,
          rateToUsd: sentRate,
          description: `Loan to ${borrower.name}`,
        },
      ],
    });

    const borrowerEntry = await postJournalEntry(tx, {
      companyId: input.toCompanyId,
      entryDate: input.transferDate,
      description: `${memo || `Loan from ${lender.name}`}${note}`,
      sourceType: 'MANUAL',
      sourceId,
      createdById: input.userId,
      localCurrency: borrower.localCurrency,
      rateLocalPerUsd: borrowerLocalRate,
      lines: [
        {
          cashBankAccountId: to.id,
          direction: 'DEBIT',
          currency: to.currency,
          amount: received,
          rateToUsd: receivedRateToUsd,
          description: `Loan from ${lender.name}`,
        },
        {
          ...(borrowerSide.where ?? { accountKey: ACCOUNT_KEYS.INTERCOMPANY_LOAN_PAYABLE }),
          direction: 'CREDIT',
          currency: borrowerSide.currency,
          amount: borrowerSide.amount,
          rateToUsd: borrowerSide.rateToUsd,
          description: `Owed to ${lender.name}`,
        },
      ],
    });

    for (const [companyId, entryId] of [
      [input.fromCompanyId, lenderEntry.id],
      [input.toCompanyId, borrowerEntry.id],
    ] as const) {
      await writeAudit(tx, {
        companyId,
        userId: input.userId,
        action: 'INTERCOMPANY_LOAN',
        entityType: 'JournalEntry',
        entityId: entryId,
        after: {
          lender: `${lender.name} · ${from.name}`,
          borrower: `${borrower.name} · ${to.name}`,
          lent: `${from.currency} ${sent.toFixed(2)}`,
          received: `${to.currency} ${received.toFixed(2)}`,
          rate: rate.toString(),
          reference: input.reference ?? null,
        },
      });
    }

    return { lenderEntry, borrowerEntry, sent, received, rate };
  }, 60_000);
}
