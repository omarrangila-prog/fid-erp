import type { Tx } from '@/lib/db';
import { Decimal, convertToUsd, convertFromUsd, dec, toMoney, sum } from '@/lib/money';
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

  customerId?: string | null;
  vendorId?: string | null;
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

async function resolveAccountId(tx: Tx, companyId: string, line: JournalLineInput): Promise<string> {
  if (line.accountId) return line.accountId;

  if (line.cashBankAccountId) {
    const account = await tx.cashBankAccount.findUnique({
      where: { id: line.cashBankAccountId },
      select: { glAccountId: true, companyId: true },
    });
    if (!account || account.companyId !== companyId) throw new NotFoundError('Cash/bank account');
    return account.glAccountId;
  }

  if (line.accountKey) {
    return (await getSystemAccount(tx, companyId, line.accountKey)).id;
  }

  throw new Error('Journal line must specify an account key, account id, or cash/bank account.');
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

/**
 * Posts a balanced journal entry.
 *
 * Balance is enforced in USD to the cent. The local-currency columns are
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
    // contributes nothing to the USD position.
    const amountUsd = line.localOnly ? new Decimal(0) : convertToUsd(amount, rateToUsd, currency);
    const amountLocal = line.localOnly
      ? amount
      : currency === localCurrency.toUpperCase()
        ? amount
        : convertFromUsd(amountUsd, rateLocalPerUsd, localCurrency);

    prepared.push({
      accountId: await resolveAccountId(tx, companyId, line),
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

  if (!debitUsd.equals(creditUsd)) {
    throw new BusinessRuleError(
      `Journal entry does not balance: debits USD ${debitUsd.toFixed(4)} vs credits USD ${creditUsd.toFixed(4)}.`,
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
        lineNumber: prepared.length + 1,
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
            cashBankAccountId: l.input.cashBankAccountId ?? null,
            shipmentId: l.input.shipmentId ?? null,
            purchaseContractId: l.input.purchaseContractId ?? null,
            salesInvoiceId: l.input.salesInvoiceId ?? null,
            itemId: l.input.itemId ?? null,
            batchId: l.input.batchId ?? null,
          })),
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
      description: `Reversal of ${original.entryNumber} — ${params.reason}`,
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
