import type { Tx } from '@/lib/db';
import { BASE_CURRENCY, Decimal, convertToUsd, convertFromUsd, dec, toMoney, sum } from '@/lib/money';
import { ACCOUNT_KEYS, DOC_TYPES, type AccountKey } from '@/lib/constants';
import { nextReference } from '@/lib/services/numbering';
import { BusinessRuleError, NotFoundError } from '@/lib/errors';
import type { AccountType, JournalSourceType, SubledgerType } from '@prisma/client';
import { assertPeriodOpen } from '@/lib/services/period';

/**
 * The accounting posting engine.
 *
 * Every balance in the system — receivables, payables, cash, inventory value,
 * revenue, cost — is derived from journal entries written through this one
 * service. No other module is permitted to mutate a financial balance directly.
 * That is what keeps the subsystems from drifting apart.
 *
 * Multi-currency model (see docs/MULTI_CURRENCY.md):
 *   Each line records three views of the same amount, all captured at posting
 *   time and never recomputed afterwards:
 *     1. the transaction currency amount  (what actually moved)
 *     2. the USD equivalent              (the group reporting anchor)
 *     3. the company local currency      (statutory/local reporting)
 *   `rateToUsd` and `rateLocalPerUsd` are stored on the line so that a later
 *   change to the default rate table cannot alter a historical voucher.
 */

export type JournalDirection = 'DEBIT' | 'CREDIT';

export type JournalLineInput = {
  /** Resolve the GL account by system key, explicit id, or cash/bank account. */
  accountKey?: AccountKey;
  accountId?: string;
  cashBankAccountId?: string;

  direction: JournalDirection;
  currency: string;
  amount: Decimal | string | number;
  /** Units of `currency` per 1 USD. Must be 1 for USD. */
  rateToUsd: Decimal | string | number;

  description?: string;
  /**
   * A local-currency-only line: zero in USD, non-zero in the company's own
   * currency. Used for foreign-currency revaluation, where the USD position has
   * not moved but the local carrying value has.
   */
  localOnly?: boolean;
  /**
   * Settling a document: the line's USD and local values are the ones the
   * document was booked at, not a fresh conversion at today's rate.
   *
   * A receivable raised at 9.85 is cleared at 9.85, whatever the money that
   * clears it was worth on the day. Otherwise a MAD customer paying a MAD
   * invoice in full would leave a phantom "advance" (or a phantom balance)
   * every time the rate moved, which is what happened. The difference between
   * the booked value and the money's value is a realised exchange gain or
   * loss, which the engine books itself.
   */
  bookedUsd?: Decimal | string | number;
  bookedLocal?: Decimal | string | number;

  customerId?: string | null;
  vendorId?: string | null;
  /** For the agent ledger: whose clearing or commission balance this moves. */
  agentId?: string | null;
  shipmentId?: string | null;
  purchaseContractId?: string | null;
  salesInvoiceId?: string | null;
  itemId?: string | null;
  batchId?: string | null;
};

export type PostJournalParams = {
  companyId: string;
  entryDate: Date;
  description: string;
  sourceType: JournalSourceType;
  sourceId: string;
  createdById: string;
  /** Units of the company's local currency per 1 USD, captured on the voucher. */
  rateLocalPerUsd: Decimal | string | number;
  localCurrency: string;
  lines: JournalLineInput[];
};

/**
 * Largest local-currency difference we treat as rounding noise and absorb into
 * the largest line. Anything bigger is a genuine exchange difference and is
 * posted to the FX gain/loss account instead.
 */
const LOCAL_DRIFT_TOLERANCE = new Decimal('0.05');

/**
 * Largest USD difference we treat as translation noise.
 *
 * One foreign-currency amount split across several lines is converted a line at
 * a time, and each conversion rounds on its own. A MAD 120,000 invoice at 9.85
 * becomes USD 12,182.7411 as one receivable, but 10,152.2843 of revenue plus
 * 2,030.4569 of tax — 12,182.7412. The books are not wrong by a hundredth of a
 * cent; the arithmetic simply cannot land on the same figure both ways.
 *
 * Half a cent is the ceiling, and only ever absorbed on a translated line. Any
 * difference a person could see is still a bug and is still refused.
 */
const USD_TRANSLATION_TOLERANCE = new Decimal('0.005');

/**
 * Which ledger account a line lands on, and — when that account is the head
 * of a cash or bank drawer — which drawer.
 *
 * The cash book and the general ledger read the same lines; the cash book by
 * drawer, the ledger by account. A line that reaches a drawer's account
 * without naming the drawer is real to the ledger and invisible to the cash
 * book, and the two screens then disagree. So a line posted to such an
 * account by id — a manual journal, typically — is given its drawer here,
 * and a line in a currency the drawer cannot hold is refused.
 */
async function resolveAccount(
  tx: Tx,
  companyId: string,
  line: JournalLineInput,
  currency: string,
  translationOnly: boolean,
): Promise<{ accountId: string; cashBankAccountId: string | null }> {
  if (line.cashBankAccountId) {
    const drawer = await tx.cashBankAccount.findUnique({
      where: { id: line.cashBankAccountId },
      select: { id: true, name: true, glAccountId: true, companyId: true, currency: true },
    });
    if (!drawer || drawer.companyId !== companyId) throw new NotFoundError('Cash/bank account');
    if (line.accountId && line.accountId !== drawer.glAccountId) {
      throw new BusinessRuleError(`${drawer.name} is not held on the account this line names.`);
    }
    if (!translationOnly && drawer.currency !== currency) {
      throw new BusinessRuleError(
        `${drawer.name} is held in ${drawer.currency}; a ${currency} amount cannot be recorded through it.`,
      );
    }
    return { accountId: drawer.glAccountId, cashBankAccountId: drawer.id };
  }

  let accountId: string;
  if (line.accountId) {
    const account = await tx.account.findFirst({ where: { id: line.accountId, companyId }, select: { id: true } });
    if (!account) throw new NotFoundError('Account');
    accountId = account.id;
  } else if (line.accountKey) {
    accountId = (await getSystemAccount(tx, companyId, line.accountKey)).id;
  } else {
    throw new Error('Journal line must specify an account key, account id, or cash/bank account.');
  }

  const drawers = await tx.cashBankAccount.findMany({
    where: { glAccountId: accountId, companyId },
    select: { id: true, name: true, currency: true },
  });
  if (drawers.length === 0) return { accountId, cashBankAccountId: null };

  if (translationOnly) return { accountId, cashBankAccountId: drawers.length === 1 ? drawers[0].id : null };

  const matching = drawers.filter((d) => d.currency === currency);
  if (matching.length === 1) return { accountId, cashBankAccountId: matching[0].id };
  if (matching.length === 0) {
    throw new BusinessRuleError(
      `${drawers[0].name} is held in ${drawers[0].currency}; a ${currency} amount cannot be recorded through it.`,
    );
  }
  throw new BusinessRuleError(
    `Several ${currency} cash or bank accounts share this ledger account — say which one the money moved through.`,
  );
}

export async function getSystemAccount(
  tx: Tx,
  companyId: string,
  key: AccountKey,
): Promise<{ id: string; code: string; name: string; type: AccountType; subledgerType: SubledgerType }> {
  const account = await tx.account.findFirst({
    where: { companyId, systemKey: key },
    select: { id: true, code: true, name: true, type: true, subledgerType: true },
  });
  if (!account) {
    throw new NotFoundError(`System account "${key}" for this company`);
  }
  return account;
}

async function assertJournalDimensions(tx: Tx, companyId: string, line: JournalLineInput) {
  if (line.customerId) {
    const row = await tx.customer.findFirst({ where: { id: line.customerId, companyId }, select: { id: true } });
    if (!row) throw new NotFoundError('Customer');
  }
  if (line.vendorId) {
    const row = await tx.vendor.findFirst({ where: { id: line.vendorId, companyId }, select: { id: true } });
    if (!row) throw new NotFoundError('Vendor');
  }
  if (line.agentId) {
    const row = await tx.agent.findFirst({ where: { id: line.agentId, companyId }, select: { id: true } });
    if (!row) throw new NotFoundError('Agent');
  }
  if (line.shipmentId) {
    const row = await tx.shipment.findFirst({ where: { id: line.shipmentId, companyId }, select: { id: true } });
    if (!row) throw new NotFoundError('Shipment');
  }
}

/**
 * Posts a balanced journal entry.
 *
 * Balance is enforced in USD, to within the sub-cent noise that converting one
 * foreign amount line by line necessarily creates. The local-currency columns are
 * derived from the USD figures, which can leave a sub-cent rounding drift when
 * several currencies meet in one entry; that residue is absorbed by the largest
 * line rather than being written to a suspense account, and anything beyond
 * `LOCAL_DRIFT_TOLERANCE` is treated as a bug and rejected.
 */
export async function postJournalEntry(tx: Tx, params: PostJournalParams) {
  const { companyId, entryDate, description, sourceType, sourceId, createdById, localCurrency } = params;

  // Every posting in the application arrives here, so a closed period is
  // enforced once rather than in each document service.
  await assertPeriodOpen(tx, companyId, entryDate);

  if (params.lines.length < 2) {
    throw new BusinessRuleError('A journal entry needs at least two lines.');
  }

  const rateLocalPerUsd = dec(params.rateLocalPerUsd);
  if (rateLocalPerUsd.lessThanOrEqualTo(0)) {
    throw new BusinessRuleError('The local currency exchange rate must be greater than zero.');
  }

  type Prepared = {
    accountId: string;
    cashBankAccountId: string | null;
    lineNumber: number;
    input: JournalLineInput;
    currency: string;
    amount: Decimal;
    rateToUsd: Decimal;
    amountUsd: Decimal;
    amountLocal: Decimal;
  };

  const prepared: Prepared[] = [];

  for (let i = 0; i < params.lines.length; i += 1) {
    const line = params.lines[i];
    const currency = line.currency.toUpperCase();
    const amount = toMoney(line.amount);
    const rateToUsd = dec(line.rateToUsd);

    if (amount.isNegative()) {
      throw new BusinessRuleError('Journal line amounts must be positive; use the direction to express sign.');
    }
    if (!line.localOnly) {
      if (currency === 'USD' && !rateToUsd.equals(1)) {
        throw new BusinessRuleError('The USD exchange rate must be exactly 1.');
      }
      if (rateToUsd.lessThanOrEqualTo(0)) {
        throw new BusinessRuleError(`An exchange rate is required for ${currency}.`);
      }
    }

    // A local-only line carries its amount straight into the local columns and
    // contributes nothing to the USD position. A booked line carries the
    // values its document was posted at.
    const amountUsd = line.localOnly
      ? new Decimal(0)
      : line.bookedUsd !== undefined
        ? toMoney(line.bookedUsd)
        : convertToUsd(amount, rateToUsd, currency);
    const amountLocal = line.localOnly
      ? amount
      : line.bookedLocal !== undefined
        ? toMoney(line.bookedLocal)
        : currency === localCurrency.toUpperCase()
          ? amount
          : convertFromUsd(amountUsd, rateLocalPerUsd, localCurrency);

    await assertJournalDimensions(tx, companyId, line);

    const resolved = await resolveAccount(tx, companyId, line, currency, Boolean(line.localOnly));

    prepared.push({
      accountId: resolved.accountId,
      cashBankAccountId: resolved.cashBankAccountId,
      lineNumber: i + 1,
      input: line,
      currency,
      amount,
      rateToUsd,
      amountUsd,
      amountLocal,
    });
  }

  // --- USD balance: must be exact -----------------------------------------
  const debitUsd = sum(prepared.filter((l) => l.input.direction === 'DEBIT').map((l) => l.amountUsd));
  const creditUsd = sum(prepared.filter((l) => l.input.direction === 'CREDIT').map((l) => l.amountUsd));

  const usdDrift = debitUsd.minus(creditUsd);

  // A settlement entry — one that clears a document at its booked value —
  // may legitimately not balance in USD: the money was worth something else
  // on the day. That difference is a realised exchange gain or loss and is
  // posted as such, in USD only, because in the company's own currency the
  // MAD that arrived is the MAD that was owed. Any other entry that fails to
  // balance is a bug and is refused.
  const settles = prepared.some((l) => l.input.bookedUsd !== undefined);
  let usdFxLine: { accountId: string; lineNumber: number; direction: JournalDirection; amountUsd: Decimal } | null =
    null;

  if (!usdDrift.isZero() && settles && usdDrift.abs().greaterThan(USD_TRANSLATION_TOLERANCE)) {
    const fxAccount = await getSystemAccount(tx, companyId, ACCOUNT_KEYS.FX_GAIN_LOSS);
    usdFxLine = {
      accountId: fxAccount.id,
      lineNumber: prepared.length + 1,
      // Debits exceed credits, so the balancing entry is a credit: a gain.
      direction: usdDrift.greaterThan(0) ? 'CREDIT' : 'DEBIT',
      amountUsd: toMoney(usdDrift.abs()),
    };
  } else if (!usdDrift.isZero()) {
    // Only lines stated in another currency may be nudged: a line already in
    // USD is exact by definition, and moving it would misstate a real amount.
    const translated = prepared.filter((l) => l.currency !== BASE_CURRENCY && !l.input.localOnly);

    if (usdDrift.abs().greaterThan(USD_TRANSLATION_TOLERANCE) || translated.length === 0) {
      throw new BusinessRuleError(
        `Journal entry does not balance: debits USD ${debitUsd.toFixed(4)} vs credits USD ${creditUsd.toFixed(4)}.`,
      );
    }

    // Put the residue on the largest translated line, where it is smallest
    // relative to the amount it is folded into.
    let target = translated[0];
    for (const line of translated) {
      if (line.amountUsd.greaterThan(target.amountUsd)) target = line;
    }

    const debitsHeavy = usdDrift.greaterThan(0);
    const shrink = target.input.direction === (debitsHeavy ? 'DEBIT' : 'CREDIT');
    target.amountUsd = toMoney(
      shrink ? target.amountUsd.minus(usdDrift.abs()) : target.amountUsd.plus(usdDrift.abs()),
    );
  }

  // --- Local balance: absorb sub-cent conversion drift ----------------------
  const debitLocal = sum(prepared.filter((l) => l.input.direction === 'DEBIT').map((l) => l.amountLocal));
  const creditLocal = sum(prepared.filter((l) => l.input.direction === 'CREDIT').map((l) => l.amountLocal));
  const localDrift = debitLocal.minus(creditLocal);

  let fxLine: {
    accountId: string;
    lineNumber: number;
    direction: JournalDirection;
    amountLocal: Decimal;
  } | null = null;

  if (!localDrift.isZero()) {
    if (localDrift.abs().lessThanOrEqualTo(LOCAL_DRIFT_TOLERANCE)) {
      // Sub-cent conversion noise. Absorb it on a *translated* line — one whose
      // currency is not the local currency — because a line already in the
      // local currency is exact by definition and must keep its stated amount.
      // Adjusting the AED cash line to make an AED receipt balance would be
      // exactly the wrong move.
      const localCode = localCurrency.toUpperCase();
      const translated = prepared.filter((l) => l.currency !== localCode && !l.input.localOnly);
      const pool = translated.length > 0 ? translated : prepared;

      let target = pool[0];
      for (const line of pool) {
        if (line.amountLocal.greaterThan(target.amountLocal)) target = line;
      }

      // Debits heavy: either shrink a debit or grow a credit. And vice versa.
      const debitsHeavy = localDrift.greaterThan(0);
      const shrink = target.input.direction === (debitsHeavy ? 'DEBIT' : 'CREDIT');
      target.amountLocal = toMoney(
        shrink ? target.amountLocal.minus(localDrift.abs()) : target.amountLocal.plus(localDrift.abs()),
      );
    } else {
      // A real exchange difference.
      //
      // Settling a USD payable out of a MAD bank at a rate different from the
      // one the payable was booked at leaves the USD books balanced but the
      // local books short. That difference is a genuine gain or loss in the
      // company's own currency, so it is posted to FX Gain/Loss as a
      // local-currency-only line: zero in USD, non-zero in local. Both currency
      // dimensions then balance and each shows the economically correct result.
      const fxAccount = await getSystemAccount(tx, companyId, ACCOUNT_KEYS.FX_GAIN_LOSS);
      fxLine = {
        accountId: fxAccount.id,
        lineNumber: prepared.length + (usdFxLine ? 2 : 1),
        // Debits exceed credits locally, so the balancing entry is a credit
        // (an exchange gain); the reverse is a loss.
        direction: localDrift.greaterThan(0) ? 'CREDIT' : 'DEBIT',
        amountLocal: toMoney(localDrift.abs()),
      };
    }
  }

  // --- Allocate the source sequence, which is what makes posting idempotent -
  const existingCount = await tx.journalEntry.count({ where: { companyId, sourceType, sourceId } });
  const entryNumber = await nextReference(tx, { companyId, docType: DOC_TYPES.JOURNAL });

  return tx.journalEntry.create({
    data: {
      companyId,
      entryNumber,
      entryDate,
      description,
      sourceType,
      sourceId,
      sourceSeq: existingCount + 1,
      isReversal: false,
      status: 'POSTED',
      createdById,
      lines: {
        create: [
          ...prepared.map((l) => ({
            lineNumber: l.lineNumber,
            accountId: l.accountId,
            description: l.input.description ?? null,
            currency: l.currency,
            debit: l.input.direction === 'DEBIT' ? l.amount : new Decimal(0),
            credit: l.input.direction === 'CREDIT' ? l.amount : new Decimal(0),
            rateToUsd: l.rateToUsd,
            debitUsd: l.input.direction === 'DEBIT' ? l.amountUsd : new Decimal(0),
            creditUsd: l.input.direction === 'CREDIT' ? l.amountUsd : new Decimal(0),
            rateLocalPerUsd,
            debitLocal: l.input.direction === 'DEBIT' ? l.amountLocal : new Decimal(0),
            creditLocal: l.input.direction === 'CREDIT' ? l.amountLocal : new Decimal(0),
            customerId: l.input.customerId ?? null,
            vendorId: l.input.vendorId ?? null,
            agentId: l.input.agentId ?? null,
            cashBankAccountId: l.cashBankAccountId,
            shipmentId: l.input.shipmentId ?? null,
            purchaseContractId: l.input.purchaseContractId ?? null,
            salesInvoiceId: l.input.salesInvoiceId ?? null,
            itemId: l.input.itemId ?? null,
            batchId: l.input.batchId ?? null,
          })),
          ...(usdFxLine
            ? [
                {
                  lineNumber: usdFxLine.lineNumber,
                  accountId: usdFxLine.accountId,
                  description: 'Exchange difference on settlement',
                  currency: BASE_CURRENCY,
                  debit: usdFxLine.direction === 'DEBIT' ? usdFxLine.amountUsd : new Decimal(0),
                  credit: usdFxLine.direction === 'CREDIT' ? usdFxLine.amountUsd : new Decimal(0),
                  rateToUsd: new Decimal(1),
                  debitUsd: usdFxLine.direction === 'DEBIT' ? usdFxLine.amountUsd : new Decimal(0),
                  creditUsd: usdFxLine.direction === 'CREDIT' ? usdFxLine.amountUsd : new Decimal(0),
                  rateLocalPerUsd,
                  // Nothing in the company's own currency: the MAD that moved
                  // is the MAD that was owed. This is a reporting-currency
                  // difference only.
                  debitLocal: new Decimal(0),
                  creditLocal: new Decimal(0),
                },
              ]
            : []),
          ...(fxLine
            ? [
                {
                  lineNumber: fxLine.lineNumber,
                  accountId: fxLine.accountId,
                  description: 'Exchange difference on settlement',
                  currency: localCurrency.toUpperCase(),
                  debit: new Decimal(0),
                  credit: new Decimal(0),
                  rateToUsd: rateLocalPerUsd,
                  debitUsd: new Decimal(0),
                  creditUsd: new Decimal(0),
                  rateLocalPerUsd,
                  debitLocal: fxLine.direction === 'DEBIT' ? fxLine.amountLocal : new Decimal(0),
                  creditLocal: fxLine.direction === 'CREDIT' ? fxLine.amountLocal : new Decimal(0),
                },
              ]
            : []),
        ],
      },
    },
    include: { lines: true },
  });
}

/**
 * Reverses the live journal entry for a source document by writing a mirrored
 * contra entry.
 *
 * Both entries stay POSTED and both stay in the balances. That is deliberate:
 * the contra entry is what cancels the original, so excluding the original as
 * well would apply the reversal twice. Nothing is ever deleted, and the pair is
 * linked through `reversalOfId` so the UI can show the original as reversed.
 */
export async function reverseJournalEntry(
  tx: Tx,
  params: {
    companyId: string;
    sourceType: JournalSourceType;
    sourceId: string;
    createdById: string;
    entryDate: Date;
    reason: string;
  },
) {
  const original = await tx.journalEntry.findFirst({
    where: {
      companyId: params.companyId,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      status: 'POSTED',
      isReversal: false,
      // Only an entry that has not already been reversed is a candidate, which
      // is what stops a double-clicked "Reverse" doubling the contra postings.
      reversedBy: { is: null },
    },
    include: { lines: true },
    orderBy: { sourceSeq: 'desc' },
  });

  if (!original) {
    throw new BusinessRuleError('There is no posted journal entry left to reverse for this document.');
  }

  const existingCount = await tx.journalEntry.count({
    where: { companyId: params.companyId, sourceType: params.sourceType, sourceId: params.sourceId },
  });
  const entryNumber = await nextReference(tx, {
    companyId: params.companyId,
    docType: DOC_TYPES.JOURNAL,
  });

  const reversal = await tx.journalEntry.create({
    data: {
      companyId: params.companyId,
      entryNumber,
      entryDate: params.entryDate,
      description: `Deletion of ${original.entryNumber} — ${params.reason}`,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      sourceSeq: existingCount + 1,
      isReversal: true,
      status: 'POSTED',
      reversalOfId: original.id,
      createdById: params.createdById,
      lines: {
        // Debits become credits and vice versa, at the ORIGINAL rates.
        create: original.lines.map((l) => ({
          lineNumber: l.lineNumber,
          accountId: l.accountId,
          description: l.description,
          currency: l.currency,
          debit: l.credit,
          credit: l.debit,
          rateToUsd: l.rateToUsd,
          debitUsd: l.creditUsd,
          creditUsd: l.debitUsd,
          rateLocalPerUsd: l.rateLocalPerUsd,
          debitLocal: l.creditLocal,
          creditLocal: l.debitLocal,
          customerId: l.customerId,
          vendorId: l.vendorId,
          agentId: l.agentId,
          cashBankAccountId: l.cashBankAccountId,
          shipmentId: l.shipmentId,
          purchaseContractId: l.purchaseContractId,
          salesInvoiceId: l.salesInvoiceId,
          itemId: l.itemId,
          batchId: l.batchId,
        })),
      },
    },
    include: { lines: true },
  });

  return reversal;
}

// ---------------------------------------------------------------------------
// Balance queries — every figure below is derived, never stored
// ---------------------------------------------------------------------------

type BalanceRow = { debit: string | null; credit: string | null };

function netFromRows(rows: BalanceRow[]): Decimal {
  const row = rows[0];
  if (!row) return new Decimal(0);
  return toMoney(dec(row.debit ?? 0).minus(dec(row.credit ?? 0)));
}

/** Customer balance in the customer's own ledger currency (positive = owes us). */
export async function getCustomerBalance(tx: Tx, companyId: string, customerId: string): Promise<Decimal> {
  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT SUM(jl."debit")::text AS debit, SUM(jl."credit")::text AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'POSTED'
      AND jl."customerId" = ${customerId}
      AND a."subledgerType" = 'CUSTOMER'
  `;
  return netFromRows(rows);
}

/** Vendor balance in the vendor's ledger currency (positive = we owe them). */
export async function getVendorBalance(tx: Tx, companyId: string, vendorId: string): Promise<Decimal> {
  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT SUM(jl."credit")::text AS debit, SUM(jl."debit")::text AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'POSTED'
      AND jl."vendorId" = ${vendorId}
      AND a."subledgerType" = 'VENDOR'
  `;
  return netFromRows(rows);
}

/** Cash/bank balance in the account's own currency. */
export async function getCashBankBalance(tx: Tx, companyId: string, cashBankAccountId: string): Promise<Decimal> {
  const account = await tx.cashBankAccount.findFirst({
    where: { id: cashBankAccountId, companyId },
    select: { openingBalance: true },
  });
  if (!account) throw new NotFoundError('Cash/bank account');

  const rows = await tx.$queryRaw<BalanceRow[]>`
    SELECT SUM(jl."debit")::text AS debit, SUM(jl."credit")::text AS credit
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${companyId}
      AND je."status" = 'POSTED'
      AND jl."cashBankAccountId" = ${cashBankAccountId}
  `;
  return toMoney(dec(account.openingBalance).plus(netFromRows(rows)));
}

/** Trial balance by account, in USD. Used by reports and integrity checks. */
export async function getTrialBalance(tx: Tx, companyId: string, upTo?: Date) {
  return tx.$queryRaw<
    Array<{ accountId: string; code: string; name: string; type: AccountType; debitUsd: string; creditUsd: string }>
  >`
    SELECT a."id" AS "accountId", a."code", a."name", a."type",
           COALESCE(SUM(jl."debitUsd"), 0)::text  AS "debitUsd",
           COALESCE(SUM(jl."creditUsd"), 0)::text AS "creditUsd"
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl."accountId" = a."id"
    LEFT JOIN journal_entries je ON je."id" = jl."journalEntryId" AND je."status" = 'POSTED'
      AND (${upTo ?? null}::date IS NULL OR je."entryDate" <= ${upTo ?? null}::date)
    WHERE a."companyId" = ${companyId}
    GROUP BY a."id", a."code", a."name", a."type"
    HAVING COALESCE(SUM(jl."debitUsd"), 0) <> 0 OR COALESCE(SUM(jl."creditUsd"), 0) <> 0
    ORDER BY a."code"
  `;
}

export { ACCOUNT_KEYS };
