import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { COLLECTED_BY_SQL, MEMO_SQL } from '@/lib/services/ledger-sql';
import { REFERENCE_SQL } from '@/lib/services/ledger';
import { businessNumber } from '@/lib/short-number';
import { LIVE_ENTRY_SQL, LIVE_ENTRY_TEXT, LIVE_ENTRY_WHERE } from '@/lib/services/journal-visibility';
import { Decimal, dec, sum, toMoney, toQuantity, toUnitCost } from '@/lib/money';
import { REPORT_GROUPS, ACCOUNT_KEYS } from '@/lib/constants';
import { getCompanyContext } from '@/lib/services/company';
import { getReceivables, getPayables } from '@/lib/services/receivables';
import { resolveLedgerViewCurrency, pickCashBankCurrency } from '@/lib/ledger-currency';
import type { Tx } from '@/lib/db';

/**
 * Reporting.
 *
 * Two principles run through everything here.
 *
 *   1. Every figure is derived from posted journal lines or posted documents.
 *      There is not a single stored summary number in this file.
 *   2. Currencies are never merged into a meaningless total. A cash position is
 *      reported per account in its own currency, and only then translated for a
 *      group view — with the original always kept alongside.
 */

type LedgerBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  reportGroup: string | null;
  debitUsd: string;
  creditUsd: string;
  debitLocal: string;
  creditLocal: string;
};

/** The narrowing a trial balance can be read under — a party, a job, a currency, a kind of account. */
export type LedgerFilters = {
  customerId?: string | null;
  vendorId?: string | null;
  agentId?: string | null;
  shipmentId?: string | null;
  warehouseId?: string | null;
  currency?: string | null;
  accountType?: string | null;
};

async function accountBalances(params: {
  companyId: string;
  from?: Date | null;
  to?: Date | null;
  filters?: LedgerFilters;
}): Promise<LedgerBalanceRow[]> {
  const f = params.filters ?? {};
  return prisma.$queryRaw<LedgerBalanceRow[]>`
    SELECT a."id" AS "accountId", a."code", a."name", a."type"::text AS type, a."reportGroup",
           COALESCE(SUM(jl."debitUsd"), 0)::text    AS "debitUsd",
           COALESCE(SUM(jl."creditUsd"), 0)::text   AS "creditUsd",
           COALESCE(SUM(jl."debitLocal"), 0)::text  AS "debitLocal",
           COALESCE(SUM(jl."creditLocal"), 0)::text AS "creditLocal"
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl."accountId" = a."id"
      AND (${f.customerId ?? null}::text IS NULL OR jl."customerId" = ${f.customerId ?? null})
      AND (${f.vendorId ?? null}::text IS NULL OR jl."vendorId" = ${f.vendorId ?? null})
      AND (${f.agentId ?? null}::text IS NULL OR jl."agentId" = ${f.agentId ?? null})
      AND (${f.shipmentId ?? null}::text IS NULL OR jl."shipmentId" = ${f.shipmentId ?? null})
      AND (${f.currency ?? null}::text IS NULL OR jl."currency" = ${f.currency ?? null})
      -- A warehouse is not on a journal line; it is on the stock movement the
      -- line was written for, so the filter walks through that.
      AND (${f.warehouseId ?? null}::text IS NULL OR EXISTS (
            SELECT 1 FROM inventory_transactions it
             WHERE it."warehouseId" = ${f.warehouseId ?? null}
               AND it."referenceId" = (SELECT je2."sourceId" FROM journal_entries je2 WHERE je2."id" = jl."journalEntryId")))
    LEFT JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
      AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
    WHERE a."companyId" = ${params.companyId}
      AND (${f.accountType ?? null}::text IS NULL OR a."type"::text = ${f.accountType ?? null})
      AND (jl."id" IS NULL OR je."id" IS NOT NULL)
    GROUP BY a."id", a."code", a."name", a."type", a."reportGroup"
    ORDER BY a."code"
  `;
}

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export type TrialBalanceRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  /** Closing balance, split into the column it belongs in. */
  debitUsd: Decimal;
  creditUsd: Decimal;
  debitLocal: Decimal;
  creditLocal: Decimal;
  /** Where the account stood the day the period opened. */
  openingDebitUsd: Decimal;
  openingCreditUsd: Decimal;
  /** What moved through it during the period, gross — not netted. */
  periodDebitUsd: Decimal;
  periodCreditUsd: Decimal;
};

/**
 * The trial balance, as an accountant expects to read it.
 *
 * Four figures per account: where it stood when the period opened, what moved
 * through it in debits and in credits, and where it stands now. A period
 * report that shows only the net movement cannot be tied to last month's
 * closing balance, which is the first thing anybody checks.
 *
 * With no `from`, the opening is zero and the movement is the whole history —
 * the "from day one" view, where closing and movement are the same thing.
 */
export async function getTrialBalanceReport(params: { companyId: string; from?: Date; to?: Date; filters?: LedgerFilters }) {
  const [closingRows, openingRows, movementRows] = await Promise.all([
    accountBalances({ companyId: params.companyId, to: params.to, filters: params.filters }),
    params.from
      ? accountBalances({ companyId: params.companyId, to: dayBefore(params.from), filters: params.filters })
      : Promise.resolve([] as LedgerBalanceRow[]),
    accountBalances({ companyId: params.companyId, from: params.from, to: params.to, filters: params.filters }),
  ]);

  const openingBy = new Map(openingRows.map((r) => [r.accountId, r]));
  const movementBy = new Map(movementRows.map((r) => [r.accountId, r]));
  const shaped: TrialBalanceRow[] = [];

  for (const row of closingRows) {
    const netUsd = dec(row.debitUsd).minus(dec(row.creditUsd));
    const netLocal = dec(row.debitLocal).minus(dec(row.creditLocal));

    const opening = openingBy.get(row.accountId);
    const openingNet = opening ? dec(opening.debitUsd).minus(dec(opening.creditUsd)) : new Decimal(0);
    const movement = movementBy.get(row.accountId);
    const periodDebit = movement ? dec(movement.debitUsd) : new Decimal(0);
    const periodCredit = movement ? dec(movement.creditUsd) : new Decimal(0);

    // An account that neither holds a balance nor moved is not on the report.
    if (netUsd.isZero() && netLocal.isZero() && openingNet.isZero() && periodDebit.isZero() && periodCredit.isZero()) {
      continue;
    }

    shaped.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      debitUsd: netUsd.greaterThan(0) ? toMoney(netUsd) : new Decimal(0),
      creditUsd: netUsd.lessThan(0) ? toMoney(netUsd.abs()) : new Decimal(0),
      debitLocal: netLocal.greaterThan(0) ? toMoney(netLocal) : new Decimal(0),
      creditLocal: netLocal.lessThan(0) ? toMoney(netLocal.abs()) : new Decimal(0),
      openingDebitUsd: openingNet.greaterThan(0) ? toMoney(openingNet) : new Decimal(0),
      openingCreditUsd: openingNet.lessThan(0) ? toMoney(openingNet.abs()) : new Decimal(0),
      periodDebitUsd: toMoney(periodDebit),
      periodCreditUsd: toMoney(periodCredit),
    });
  }

  const totals = shaped.reduce(
    (acc, r) => ({
      debitUsd: acc.debitUsd.plus(r.debitUsd),
      creditUsd: acc.creditUsd.plus(r.creditUsd),
      debitLocal: acc.debitLocal.plus(r.debitLocal),
      creditLocal: acc.creditLocal.plus(r.creditLocal),
      openingDebitUsd: acc.openingDebitUsd.plus(r.openingDebitUsd),
      openingCreditUsd: acc.openingCreditUsd.plus(r.openingCreditUsd),
      periodDebitUsd: acc.periodDebitUsd.plus(r.periodDebitUsd),
      periodCreditUsd: acc.periodCreditUsd.plus(r.periodCreditUsd),
    }),
    {
      debitUsd: new Decimal(0),
      creditUsd: new Decimal(0),
      debitLocal: new Decimal(0),
      creditLocal: new Decimal(0),
      openingDebitUsd: new Decimal(0),
      openingCreditUsd: new Decimal(0),
      periodDebitUsd: new Decimal(0),
      periodCreditUsd: new Decimal(0),
    },
  );

  return {
    rows: shaped,
    totals: {
      debitUsd: toMoney(totals.debitUsd),
      creditUsd: toMoney(totals.creditUsd),
      debitLocal: toMoney(totals.debitLocal),
      creditLocal: toMoney(totals.creditLocal),
      openingDebitUsd: toMoney(totals.openingDebitUsd),
      openingCreditUsd: toMoney(totals.openingCreditUsd),
      periodDebitUsd: toMoney(totals.periodDebitUsd),
      periodCreditUsd: toMoney(totals.periodCreditUsd),
    },
    differenceUsd: toMoney(totals.debitUsd.minus(totals.creditUsd)),
    isBalanced: toMoney(totals.debitUsd).equals(toMoney(totals.creditUsd)),
    hasOpening: Boolean(params.from),
  };
}

/** The day before a period starts, for reading its opening balances. */
function dayBefore(date: Date): Date {
  const previous = new Date(date);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous;
}

// ---------------------------------------------------------------------------
// Profit & Loss
// ---------------------------------------------------------------------------

/** `accountId` is what makes a figure on the statement clickable. */
export type PnlLine = {
  accountId: string;
  code: string;
  name: string;
  amountUsd: Decimal;
  amountLocal: Decimal;
};

export type ProfitAndLoss = {
  revenue: PnlLine[];
  costOfSales: PnlLine[];
  operatingExpenses: PnlLine[];
  otherItems: PnlLine[];
  totals: {
    revenueUsd: Decimal;
    revenueLocal: Decimal;
    costOfSalesUsd: Decimal;
    costOfSalesLocal: Decimal;
    grossProfitUsd: Decimal;
    grossProfitLocal: Decimal;
    operatingExpensesUsd: Decimal;
    operatingExpensesLocal: Decimal;
    otherUsd: Decimal;
    otherLocal: Decimal;
    netProfitUsd: Decimal;
    netProfitLocal: Decimal;
  };
  grossMarginPct: Decimal;
  netMarginPct: Decimal;
};

export async function getProfitAndLoss(params: {
  companyId: string;
  from: Date;
  to: Date;
}): Promise<ProfitAndLoss> {
  const rows = await accountBalances(params);

  const revenue: PnlLine[] = [];
  const costOfSales: PnlLine[] = [];
  const operatingExpenses: PnlLine[] = [];
  const otherItems: PnlLine[] = [];

  for (const row of rows) {
    // Income is a credit balance, expenses are debit balances; both are shown
    // as positive figures on the statement.
    const isIncome = row.type === 'INCOME';
    const amountUsd = isIncome
      ? dec(row.creditUsd).minus(dec(row.debitUsd))
      : dec(row.debitUsd).minus(dec(row.creditUsd));
    const amountLocal = isIncome
      ? dec(row.creditLocal).minus(dec(row.debitLocal))
      : dec(row.debitLocal).minus(dec(row.creditLocal));

    if (amountUsd.isZero() && amountLocal.isZero()) continue;
    const line: PnlLine = {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amountUsd: toMoney(amountUsd),
      amountLocal: toMoney(amountLocal),
    };

    if (row.type === 'INCOME') {
      if (row.reportGroup === REPORT_GROUPS.OTHER_INCOME) otherItems.push(line);
      else revenue.push(line);
    } else if (row.type === 'EXPENSE') {
      if (row.reportGroup === REPORT_GROUPS.COGS) costOfSales.push(line);
      else if (row.reportGroup === REPORT_GROUPS.OTHER_EXPENSE) {
        otherItems.push({ ...line, amountUsd: line.amountUsd.negated(), amountLocal: line.amountLocal.negated() });
      } else operatingExpenses.push(line);
    }
  }

  const sumUsd = (list: PnlLine[]) => toMoney(list.reduce((a, l) => a.plus(l.amountUsd), new Decimal(0)));
  const sumLocal = (list: PnlLine[]) => toMoney(list.reduce((a, l) => a.plus(l.amountLocal), new Decimal(0)));

  const revenueUsd = sumUsd(revenue);
  const revenueLocal = sumLocal(revenue);
  const costOfSalesUsd = sumUsd(costOfSales);
  const costOfSalesLocal = sumLocal(costOfSales);
  const grossProfitUsd = toMoney(revenueUsd.minus(costOfSalesUsd));
  const grossProfitLocal = toMoney(revenueLocal.minus(costOfSalesLocal));
  const operatingExpensesUsd = sumUsd(operatingExpenses);
  const operatingExpensesLocal = sumLocal(operatingExpenses);
  const otherUsd = sumUsd(otherItems);
  const otherLocal = sumLocal(otherItems);
  const netProfitUsd = toMoney(grossProfitUsd.minus(operatingExpensesUsd).plus(otherUsd));
  const netProfitLocal = toMoney(grossProfitLocal.minus(operatingExpensesLocal).plus(otherLocal));

  return {
    revenue,
    costOfSales,
    operatingExpenses,
    otherItems,
    totals: {
      revenueUsd,
      revenueLocal,
      costOfSalesUsd,
      costOfSalesLocal,
      grossProfitUsd,
      grossProfitLocal,
      operatingExpensesUsd,
      operatingExpensesLocal,
      otherUsd,
      otherLocal,
      netProfitUsd,
      netProfitLocal,
    },
    grossMarginPct: revenueUsd.isZero()
      ? new Decimal(0)
      : grossProfitUsd.dividedBy(revenueUsd).times(100).toDecimalPlaces(2),
    netMarginPct: revenueUsd.isZero()
      ? new Decimal(0)
      : netProfitUsd.dividedBy(revenueUsd).times(100).toDecimalPlaces(2),
  };
}

// ---------------------------------------------------------------------------
// Balance Sheet
// ---------------------------------------------------------------------------

export type BalanceSheetSection = { title: string; lines: PnlLine[]; totalUsd: Decimal; totalLocal: Decimal };

/** A line on the statement, with the sub-heading it sits under — current or non-current. */
export type BalanceSheetLine = PnlLine & { group: string };

export async function getBalanceSheet(params: { companyId: string; asOf: Date }) {
  const rows = await accountBalances({ companyId: params.companyId, to: params.asOf });

  const assets: BalanceSheetLine[] = [];
  const liabilities: BalanceSheetLine[] = [];
  const equity: BalanceSheetLine[] = [];
  let retainedThisPeriodUsd = new Decimal(0);
  let retainedThisPeriodLocal = new Decimal(0);

  for (const row of rows) {
    const debitMinusCreditUsd = dec(row.debitUsd).minus(dec(row.creditUsd));
    const debitMinusCreditLocal = dec(row.debitLocal).minus(dec(row.creditLocal));

    if (row.type === 'INCOME' || row.type === 'EXPENSE') {
      // Income and expense roll into the current period result rather than
      // appearing on the balance sheet in their own right.
      retainedThisPeriodUsd = retainedThisPeriodUsd.minus(debitMinusCreditUsd);
      retainedThisPeriodLocal = retainedThisPeriodLocal.minus(debitMinusCreditLocal);
      continue;
    }

    if (debitMinusCreditUsd.isZero() && debitMinusCreditLocal.isZero()) continue;

    const line: BalanceSheetLine = {
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      amountUsd: toMoney(row.type === 'ASSET' ? debitMinusCreditUsd : debitMinusCreditUsd.negated()),
      amountLocal: toMoney(row.type === 'ASSET' ? debitMinusCreditLocal : debitMinusCreditLocal.negated()),
      group:
        row.reportGroup === 'NON_CURRENT_ASSET'
          ? 'Fixed assets'
          : row.reportGroup === 'NON_CURRENT_LIABILITY'
            ? 'Long-term liabilities'
            : row.type === 'ASSET'
              ? 'Current assets'
              : row.type === 'LIABILITY'
                ? 'Current liabilities'
                : 'Equity',
    };

    if (row.type === 'ASSET') assets.push(line);
    else if (row.type === 'LIABILITY') liabilities.push(line);
    else equity.push(line);
  }

  equity.push({
    // A derived line, not an account, so there is nothing to drill into.
    accountId: '',
    code: '3900',
    name: 'Current Period Result',
    amountUsd: toMoney(retainedThisPeriodUsd),
    amountLocal: toMoney(retainedThisPeriodLocal),
    group: 'Equity',
  });

  const section = (title: string, lines: BalanceSheetLine[]) => ({
    title,
    lines,
    totalUsd: toMoney(lines.reduce((a, l) => a.plus(l.amountUsd), new Decimal(0))),
    totalLocal: toMoney(lines.reduce((a, l) => a.plus(l.amountLocal), new Decimal(0))),
  });

  const assetSection = section('Assets', assets);
  const liabilitySection = section('Liabilities', liabilities);
  const equitySection = section('Equity', equity);

  return {
    assets: assetSection,
    liabilities: liabilitySection,
    equity: equitySection,
    balancesUsd: assetSection.totalUsd.equals(toMoney(liabilitySection.totalUsd.plus(equitySection.totalUsd))),
    differenceUsd: toMoney(assetSection.totalUsd.minus(liabilitySection.totalUsd).minus(equitySection.totalUsd)),
  };
}

// ---------------------------------------------------------------------------
// Financial position — "what do I actually have, right now?"
// ---------------------------------------------------------------------------

export type CashPosition = {
  accountId: string;
  /** The ledger account behind the drawer, so the GL is one click away. */
  glAccountId: string;
  code: string;
  name: string;
  accountType: string;
  currency: string;
  balance: Decimal;
  balanceUsd: Decimal;
};

export async function getFinancialPosition(params: { companyId: string; asOf?: Date }) {
  const company = await getCompanyContext(prisma as unknown as Tx, params.companyId);
  const asOf = params.asOf ?? null;

  // --- Cash, petty cash and bank, each in its own currency ------------------
  const cashRows = await prisma.$queryRaw<
    Array<{
      accountId: string;
      glAccountId: string;
      code: string;
      name: string;
      accountType: string;
      currency: string;
      opening: string;
      movement: string;
      movementUsd: string;
    }>
  >`
    SELECT cba."id" AS "accountId", cba."glAccountId", cba."code", cba."name",
           cba."accountType"::text AS "accountType", cba."currency",
           cba."openingBalance"::text AS opening,
           COALESCE((SELECT SUM(jl."debit" - jl."credit") FROM journal_lines jl
                       JOIN journal_entries je ON je."id" = jl."journalEntryId"
                      WHERE jl."cashBankAccountId" = cba."id" AND ${LIVE_ENTRY_SQL}
                        AND (${asOf}::date IS NULL OR je."entryDate" <= ${asOf}::date)), 0)::text AS movement,
           COALESCE((SELECT SUM(jl."debitUsd" - jl."creditUsd") FROM journal_lines jl
                       JOIN journal_entries je ON je."id" = jl."journalEntryId"
                      WHERE jl."cashBankAccountId" = cba."id" AND ${LIVE_ENTRY_SQL}
                        AND (${asOf}::date IS NULL OR je."entryDate" <= ${asOf}::date)), 0)::text AS "movementUsd"
    FROM cash_bank_accounts cba
    WHERE cba."companyId" = ${params.companyId} AND cba."status" = 'ACTIVE'
    ORDER BY cba."accountType", cba."currency", cba."code"
  `;

  const accounts: CashPosition[] = cashRows.map((row) => ({
    accountId: row.accountId,
    glAccountId: row.glAccountId,
    code: row.code,
    name: row.name,
    accountType: row.accountType,
    currency: row.currency,
    balance: toMoney(dec(row.opening).plus(dec(row.movement))),
    balanceUsd: toMoney(dec(row.movementUsd)),
  }));

  // Totals per currency — never merged into one meaningless number.
  const byCurrency = new Map<string, { currency: string; cash: Decimal; bank: Decimal; total: Decimal }>();
  for (const account of accounts) {
    const entry = byCurrency.get(account.currency) ?? {
      currency: account.currency,
      cash: new Decimal(0),
      bank: new Decimal(0),
      total: new Decimal(0),
    };
    if (account.accountType === 'BANK') entry.bank = entry.bank.plus(account.balance);
    else entry.cash = entry.cash.plus(account.balance);
    entry.total = entry.total.plus(account.balance);
    byCurrency.set(account.currency, entry);
  }

  // --- Receivables, payables and stock -------------------------------------
  const totals = await prisma.$queryRaw<
    Array<{
      receivableUsd: string;
      payableUsd: string;
      inventoryUsd: string;
      inTransitUsd: string;
      availableKg: string;
      inTransitKg: string;
      bags: string;
      chequesOnHandUsd: string;
    }>
  >`
    SELECT
      -- Outstanding is summed per document first. Correlating the allocation
      -- subquery to an aggregated row is not valid SQL, so the allocations are
      -- pre-aggregated and joined instead.
      COALESCE((SELECT SUM(si."totalAmountUsd" - COALESCE(alloc."paid", 0))
                FROM sales_invoices si
                LEFT JOIN (
                  SELECT ra."salesInvoiceId" AS "invoiceId", SUM(ra."amountUsd") AS "paid"
                  FROM receipt_allocations ra
                  JOIN receipts r ON r."id" = ra."receiptId"
                  WHERE r."status" = 'POSTED'
                  GROUP BY ra."salesInvoiceId"
                ) alloc ON alloc."invoiceId" = si."id"
               WHERE si."companyId" = ${params.companyId} AND si."status" = 'POSTED'), 0)::text AS "receivableUsd",
      COALESCE((SELECT SUM(pc."totalValueUsd" - COALESCE(settled."paid", 0))
                FROM purchase_contracts pc
                LEFT JOIN (
                  SELECT pa."purchaseContractId" AS "contractId", SUM(pa."amountUsd") AS "paid"
                  FROM payment_allocations pa
                  JOIN payments p ON p."id" = pa."paymentId"
                  WHERE p."status" = 'POSTED'
                  GROUP BY pa."purchaseContractId"
                ) settled ON settled."contractId" = pc."id"
               WHERE pc."companyId" = ${params.companyId} AND pc."status" = 'POSTED'), 0)::text AS "payableUsd",
      -- On hand, not available. Reserving stock against a draft invoice does
      -- not remove it from the balance sheet: the coffee is still owned, still
      -- in the warehouse, and still an asset until it is actually sold. Valuing
      -- availableQuantityKg understated inventory by the whole of whatever
      -- was reserved, and the reconciliation report reported it, correctly, as
      -- the asset account disagreeing with the valued stock.
      COALESCE((SELECT SUM((b."availableQuantityKg" + b."allocatedQuantityKg") * b."landedUnitCostUsd") FROM batches b
                 WHERE b."companyId" = ${params.companyId} AND b."status" = 'ACTIVE'), 0)::text AS "inventoryUsd",
      COALESCE((SELECT SUM(b."inTransitQuantityKg" * b."landedUnitCostUsd") FROM batches b
                 WHERE b."companyId" = ${params.companyId} AND b."status" = 'ACTIVE'), 0)::text AS "inTransitUsd",
      COALESCE((SELECT SUM(b."availableQuantityKg") FROM batches b
                 WHERE b."companyId" = ${params.companyId} AND b."status" = 'ACTIVE'), 0)::text AS "availableKg",
      COALESCE((SELECT SUM(b."inTransitQuantityKg") FROM batches b
                 WHERE b."companyId" = ${params.companyId} AND b."status" = 'ACTIVE'), 0)::text AS "inTransitKg",
      COALESCE((SELECT SUM(ib."onHandKg" / NULLIF(b."bagWeightKg", 0)) FROM inventory_balances ib
                 JOIN batches b ON b."id" = ib."batchId"
                 WHERE ib."companyId" = ${params.companyId}), 0)::text AS bags,
      COALESCE((SELECT SUM(c."amountUsd") FROM cheques c
                 WHERE c."companyId" = ${params.companyId} AND c."direction" = 'INBOUND'
                   AND c."status" IN ('RECEIVED','DEPOSITED')), 0)::text AS "chequesOnHandUsd"
  `;

  const t = totals[0];

  return {
    companyName: company.name,
    localCurrency: company.localCurrency,
    accounts,
    currencyTotals: [...byCurrency.values()].map((v) => ({
      currency: v.currency,
      cash: toMoney(v.cash),
      bank: toMoney(v.bank),
      total: toMoney(v.total),
    })),
    receivableUsd: toMoney(t?.receivableUsd ?? 0),
    payableUsd: toMoney(t?.payableUsd ?? 0),
    inventoryValueUsd: toMoney(t?.inventoryUsd ?? 0),
    inTransitValueUsd: toMoney(t?.inTransitUsd ?? 0),
    availableKg: toQuantity(t?.availableKg ?? 0),
    inTransitKg: toQuantity(t?.inTransitKg ?? 0),
    bags: Number(dec(t?.bags ?? 0).toDecimalPlaces(2)),
    chequesOnHandUsd: toMoney(t?.chequesOnHandUsd ?? 0),
  };
}

// ---------------------------------------------------------------------------
// General ledger, cash book and journal
// ---------------------------------------------------------------------------

export type GeneralLedgerRow = {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  description: string;
  sourceType: string;
  sourceId: string;
  reference: string | null;
  currency: string;
  debit: Decimal;
  credit: Decimal;
  debitUsd: Decimal;
  creditUsd: Decimal;
  balanceUsd: Decimal;
  balance: Decimal;
};

export async function getGeneralLedger(params: {
  companyId: string;
  accountId: string;
  from?: Date;
  to?: Date;
  currency?: string;
}) {
  const account = await prisma.account.findFirstOrThrow({
    where: { id: params.accountId, companyId: params.companyId },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      currency: true,
      cashBankAccounts: { select: { currency: true }, orderBy: { currency: 'asc' } },
    },
  });

  // A report reads; it never writes. The drawer's currency is preferred in
  // memory below, which is all the "Cash in Hand opened as USD" case needed.
  const viewCurrency = resolveLedgerViewCurrency({
    requested: params.currency,
    accountCurrency: account.currency,
    cashBankCurrency: pickCashBankCurrency(account.cashBankAccounts, account.currency ?? params.currency),
  });
  // Three ways to read an account:
  //
  //   REPORTING — every line, in its USD value, with a running USD balance.
  //          The default for a control account that carries several
  //          currencies (receivables, payables, sales): every line has a USD
  //          value, so every line is shown. The old default was a filter on
  //          lines whose own currency was USD, which for a Moroccan
  //          receivables account — all MAD — opened as no rows and a closing
  //          balance of zero.
  //   USD, MAD, AED — only lines in that currency, in that currency, with a
  //          native running balance. The natural view of a MAD cash drawer,
  //          and what keeps a personal account's dollars and dirhams apart.
  //   ALL  — every line in its own currency, listed without a running
  //          balance, because dirhams and dollars are never added together.
  const allCurrencies = viewCurrency === 'ALL';
  const currencyFilter = allCurrencies || viewCurrency === 'REPORTING' ? null : viewCurrency;
  const useOriginal = Boolean(currencyFilter) || allCurrencies;

  const openingRows = currencyFilter
    ? await prisma.$queryRaw<Array<{ net: string | null }>>`
        SELECT SUM(jl."debit" - jl."credit")::text AS net
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
          AND jl."accountId" = ${params.accountId}
          AND jl."currency" = ${currencyFilter}
          AND ${params.from ?? null}::date IS NOT NULL AND je."entryDate" < ${params.from ?? null}::date
      `
    : await prisma.$queryRaw<Array<{ net: string | null }>>`
        SELECT SUM(jl."debitUsd" - jl."creditUsd")::text AS net
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
          AND jl."accountId" = ${params.accountId}
          AND ${params.from ?? null}::date IS NOT NULL AND je."entryDate" < ${params.from ?? null}::date
      `;

  const rows = currencyFilter
    ? await prisma.$queryRaw<
        Array<{
          entryId: string;
          entryNumber: string;
          entryDate: Date;
          description: string;
          sourceType: string;
          sourceId: string;
          currency: string;
          debit: string;
          credit: string;
          debitUsd: string;
          creditUsd: string;
          reference: string | null;
        }>
      >`
        SELECT je."id" AS "entryId", je."entryNumber", je."entryDate", je."description",
               je."sourceType"::text AS "sourceType", je."sourceId" AS "sourceId", jl."currency",
               jl."debit"::text AS debit, jl."credit"::text AS credit,
               jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
               jl."description" AS reference
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
          AND jl."accountId" = ${params.accountId}
          AND jl."currency" = ${currencyFilter}
          AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
          AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
        ORDER BY je."entryDate", je."entryNumber", jl."lineNumber"
      `
    : await prisma.$queryRaw<
        Array<{
          entryId: string;
          entryNumber: string;
          entryDate: Date;
          description: string;
          sourceType: string;
          sourceId: string;
          currency: string;
          debit: string;
          credit: string;
          debitUsd: string;
          creditUsd: string;
          reference: string | null;
        }>
      >`
        SELECT je."id" AS "entryId", je."entryNumber", je."entryDate", je."description",
               je."sourceType"::text AS "sourceType", je."sourceId" AS "sourceId", jl."currency",
               jl."debit"::text AS debit, jl."credit"::text AS credit,
               jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
               jl."description" AS reference
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
          AND jl."accountId" = ${params.accountId}
          AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
          AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
        ORDER BY je."entryDate", je."entryNumber", jl."lineNumber"
      `;

  let running = allCurrencies ? toMoney(0) : toMoney(dec(openingRows[0]?.net ?? 0));
  const opening = running;

  const shaped: GeneralLedgerRow[] = rows.map((row) => {
    const debitMove = useOriginal ? dec(row.debit) : dec(row.debitUsd);
    const creditMove = useOriginal ? dec(row.credit) : dec(row.creditUsd);
    if (!allCurrencies) running = toMoney(running.plus(debitMove).minus(creditMove));
    return {
      entryId: row.entryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      description: row.description,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      reference: row.reference,
      currency: row.currency,
      debit: dec(row.debit),
      credit: dec(row.credit),
      debitUsd: dec(row.debitUsd),
      creditUsd: dec(row.creditUsd),
      balanceUsd: running,
      balance: running,
    };
  });

  return {
    account: {
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      currency: account.currency,
    },
    openingBalanceUsd: opening,
    closingBalanceUsd: running,
    openingBalance: opening,
    closingBalance: running,
    viewCurrency,
    mixedCurrencies: allCurrencies,
    rows: shaped,
  };
}

/** Cash book / bank book: every movement through one cash or bank account. */
function cashBookMemo(row: {
  typed: string | null;
  sourceType: string;
  counterparty: string | null;
  collectedBy: string | null;
  moneyIn: boolean;
  description: string;
}): string {
  const typed = row.typed?.trim();
  const who = row.counterparty?.trim();
  const collected = row.collectedBy ? ` (collected by ${row.collectedBy})` : '';
  let built: string;
  switch (row.sourceType) {
    case 'RECEIPT':
      built = who ? `Cash received from ${who}${collected}` : `Cash received${collected}`;
      break;
    case 'PAYMENT':
      built = who ? `Paid to ${who}` : 'Payment made';
      break;
    case 'EXPENSE':
      built = who ? `Expense paid to ${who}` : 'Expense paid';
      break;
    case 'AGENT_SETTLEMENT':
      built = who ? (row.moneyIn ? `Received from agent ${who}` : `Paid to agent ${who}`) : row.moneyIn ? 'Received from agent' : 'Paid to agent';
      break;
    case 'CHEQUE':
      built = who ? `Cheque from ${who}` : 'Cheque';
      break;
    case 'OPENING_BALANCE':
      built = 'Opening balance';
      break;
    default:
      built = row.description.replace(/\bFID-[A-Z]{2,3}-[A-Z]{2,4}-\d{4,}\b/g, (m) => businessNumber(m));
  }
  return typed ? (typed === built ? typed : `${typed}`) : built;
}

export async function getCashBook(params: {
  companyId: string;
  cashBankAccountId: string;
  from?: Date;
  to?: Date;
}) {
  const account = await prisma.cashBankAccount.findFirstOrThrow({
    where: { id: params.cashBankAccountId, companyId: params.companyId },
    select: { id: true, code: true, name: true, currency: true, accountType: true, openingBalance: true },
  });

  // The balance the period opened with: the account's own opening figure plus
  // everything that moved through it before the first day asked for. Without
  // this a book run "for September" opened at the figure the account was
  // created with, and every running balance in it was wrong.
  const before = params.from
    ? await prisma.$queryRaw<Array<{ net: string | null }>>`
        SELECT SUM(jl."debit" - jl."credit")::text AS net
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
          AND jl."cashBankAccountId" = ${params.cashBankAccountId}
          AND je."entryDate" < ${params.from}::date
      `
    : [];

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      entryId: string;
      entryNumber: string;
      entryDate: Date;
      description: string;
      sourceType: string;
      sourceId: string;
      debit: string;
      credit: string;
      counterparty: string | null;
      reference: string | null;
      memo: string | null;
      collectedBy: string | null;
    }>
  >(
    `
    SELECT je."id" AS "entryId", je."entryNumber", je."entryDate", je."description",
           je."sourceType"::text AS "sourceType", je."sourceId" AS "sourceId",
           jl."debit"::text AS debit, jl."credit"::text AS credit,
           COALESCE(
             c."customerName", v."vendorName", ag."agentName",
             CASE je."sourceType"
               WHEN 'RECEIPT' THEN (SELECT cu."customerName" FROM receipts r JOIN customers cu ON cu."id" = r."customerId" WHERE r."id" = je."sourceId")
               WHEN 'PAYMENT' THEN (SELECT ve."vendorName" FROM payments p JOIN vendors ve ON ve."id" = p."vendorId" WHERE p."id" = je."sourceId")
               WHEN 'EXPENSE' THEN (SELECT COALESCE(ve."vendorName", ag2."agentName") FROM expenses e LEFT JOIN vendors ve ON ve."id" = e."vendorId" LEFT JOIN agents ag2 ON ag2."id" = e."agentId" WHERE e."id" = je."sourceId")
               WHEN 'AGENT_SETTLEMENT' THEN (SELECT ag3."agentName" FROM agent_settlements s JOIN agents ag3 ON ag3."id" = s."agentId" WHERE s."id" = je."sourceId")
             END
           ) AS counterparty,
           ${REFERENCE_SQL} AS reference,
           ${MEMO_SQL} AS memo,
           ${COLLECTED_BY_SQL} AS "collectedBy"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    LEFT JOIN customers c ON c."id" = jl."customerId"
    LEFT JOIN vendors v ON v."id" = jl."vendorId"
    LEFT JOIN agents ag ON ag."id" = jl."agentId"
    WHERE je."companyId" = $1 AND ${LIVE_ENTRY_TEXT}
      AND jl."cashBankAccountId" = $2
      AND ($3::date IS NULL OR je."entryDate" >= $3::date)
      AND ($4::date IS NULL OR je."entryDate" <= $4::date)
    ORDER BY je."entryDate", je."entryNumber"
    `,
    params.companyId,
    params.cashBankAccountId,
    params.from ?? null,
    params.to ?? null,
  );

  let running = toMoney(dec(account.openingBalance).plus(dec(before[0]?.net ?? 0)));
  const opening = running;

  const shaped = rows.map((row) => {
    const moneyIn = dec(row.debit);
    const moneyOut = dec(row.credit);
    running = toMoney(running.plus(moneyIn).minus(moneyOut));
    return {
      entryId: row.entryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      description: row.description,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      counterparty: row.counterparty,
      /** The document's own number in the client's words: PAY 22, EXP 8, JV 86. */
      reference: businessNumber(row.reference ?? row.entryNumber),
      /**
       * What the person typed on the document; failing that, a sentence built
       * from what the entry knows — who the money came from or went to —
       * because "Cash received from BANI against INV 15" is what the client
       * wants to read, not a source-type code.
       */
      memo: cashBookMemo({
        typed: row.memo,
        sourceType: row.sourceType,
        counterparty: row.counterparty,
        collectedBy: row.collectedBy,
        moneyIn: moneyIn.greaterThan(0),
        description: row.description,
      }),
      moneyIn,
      moneyOut,
      balance: running,
    };
  });

  return { account, openingBalance: opening, closingBalance: running, rows: shaped };
}

/** The journal: every posted entry, newest first. */
/**
 * Every journal entry one document produced.
 *
 * A posted document is not finished business until you can see what it did to
 * the ledger, and a document can produce more than one entry: an invoice books
 * the sale and the cost of goods, a correction adds a reversal, a late
 * shipment cost trues up what was already sold. All of them belong here, in
 * the order they were written, so the document tells its whole story.
 */
export async function getJournalForSource(params: {
  companyId: string;
  sourceType: string;
  sourceId: string;
}) {
  return prisma.journalEntry.findMany({
    where: {
      companyId: params.companyId,
      sourceId: params.sourceId,
      sourceType: params.sourceType as never,
    },
    include: {
      lines: {
        include: { account: { select: { code: true, name: true } } },
        orderBy: { lineNumber: 'asc' },
      },
    },
    orderBy: [{ entryDate: 'asc' }, { sourceSeq: 'asc' }, { entryNumber: 'asc' }],
  });
}

export async function getJournalReport(params: {
  companyId: string;
  from?: Date;
  to?: Date;
  sourceType?: string;
  q?: string;
  limit?: number;
}) {
  const needle = params.q?.trim();
  return prisma.journalEntry.findMany({
    where: {
      companyId: params.companyId,
      ...LIVE_ENTRY_WHERE,
      ...(params.sourceType ? { sourceType: params.sourceType as never } : {}),
      ...(params.from || params.to
        ? { entryDate: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
      ...(needle
        ? {
            OR: [
              { entryNumber: { contains: needle, mode: 'insensitive' } },
              { description: { contains: needle, mode: 'insensitive' } },
              { reference: { contains: needle, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: {
      lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNumber: 'asc' } },
      createdBy: { select: { name: true } },
    },
    orderBy: [{ entryDate: 'desc' }, { entryNumber: 'desc' }],
    take: params.limit ?? 200,
  });
}

/**
 * Cash flow, derived from actual cash and bank movements grouped by what caused
 * them. This is a direct-method statement: it reports the money that moved, not
 * an indirect reconciliation from profit.
 */
export async function getCashFlow(params: { companyId: string; from: Date; to: Date }) {
  const rows = await prisma.$queryRaw<Array<{ sourceType: string; inUsd: string; outUsd: string }>>`
    SELECT je."sourceType"::text AS "sourceType",
           COALESCE(SUM(jl."debitUsd"), 0)::text  AS "inUsd",
           COALESCE(SUM(jl."creditUsd"), 0)::text AS "outUsd"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
      AND jl."cashBankAccountId" IS NOT NULL
      AND je."entryDate" >= ${params.from}::date
      AND je."entryDate" <= ${params.to}::date
    GROUP BY je."sourceType"
    ORDER BY je."sourceType"
  `;

  const LABELS: Record<string, string> = {
    RECEIPT: 'Received from customers',
    PAYMENT: 'Paid to suppliers',
    EXPENSE: 'Operating and shipment costs',
    CHEQUE: 'Cheque settlements',
    MANUAL: 'Journal adjustments',
    OPENING_BALANCE: 'Opening balances',
  };

  const lines = rows.map((row) => {
    const inUsd = toMoney(row.inUsd);
    const outUsd = toMoney(row.outUsd);
    return {
      sourceType: row.sourceType,
      label: LABELS[row.sourceType] ?? row.sourceType.replaceAll('_', ' '),
      inUsd,
      outUsd,
      netUsd: toMoney(inUsd.minus(outUsd)),
    };
  });

  return {
    lines,
    totalInUsd: toMoney(lines.reduce((a, l) => a.plus(l.inUsd), new Decimal(0))),
    totalOutUsd: toMoney(lines.reduce((a, l) => a.plus(l.outUsd), new Decimal(0))),
    netMovementUsd: toMoney(lines.reduce((a, l) => a.plus(l.netUsd), new Decimal(0))),
  };
}

/** Expenses grouped by category, shipment or month. */
export type ExpenseGrouping = 'category' | 'shipment' | 'month' | 'payee' | 'type';

export async function getExpenseReport(params: {
  companyId: string;
  from?: Date;
  to?: Date;
  groupBy: ExpenseGrouping;
  /** Narrow to one side of the business, or leave off for everything. */
  kind?: 'SHIPMENT' | 'GENERAL';
}) {
  const rows = await prisma.$queryRaw<Array<{ key: string; label: string; amountUsd: string; count: bigint }>>`
    SELECT
      CASE ${params.groupBy}
        WHEN 'category' THEN ec."id"
        WHEN 'shipment' THEN COALESCE(s."id", 'unassigned')
        WHEN 'payee' THEN COALESCE(v."id", a."id", 'none')
        WHEN 'type' THEN e."kind"::text
        ELSE to_char(e."expenseDate", 'YYYY-MM')
      END AS key,
      CASE ${params.groupBy}
        WHEN 'category' THEN ec."name"
        WHEN 'shipment' THEN COALESCE(s."jobNumber", 'Not linked to a job')
        WHEN 'payee' THEN COALESCE(v."vendorName", a."agentName", 'No payee recorded')
        WHEN 'type' THEN CASE WHEN e."kind" = 'SHIPMENT' THEN 'Shipment expenses' ELSE 'General company expenses' END
        ELSE to_char(e."expenseDate", 'YYYY-MM')
      END AS label,
      COALESCE(SUM(e."amountUsd"), 0)::text AS "amountUsd",
      COUNT(*) AS count
    FROM expenses e
    JOIN expense_categories ec ON ec."id" = e."expenseCategoryId"
    LEFT JOIN shipments s ON s."id" = e."shipmentId"
    LEFT JOIN vendors v ON v."id" = e."vendorId"
    LEFT JOIN agents a ON a."id" = e."agentId"
    WHERE e."companyId" = ${params.companyId} AND e."status" = 'POSTED'
      AND (${params.kind ?? null}::text IS NULL OR e."kind"::text = ${params.kind ?? null})
      AND (${params.from ?? null}::date IS NULL OR e."expenseDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR e."expenseDate" <= ${params.to ?? null}::date)
    GROUP BY 1, 2
    ORDER BY SUM(e."amountUsd") DESC
  `;

  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    amountUsd: toMoney(r.amountUsd),
    count: Number(r.count),
  }));
}

/**
 * The two sides of the business, side by side.
 *
 * Shipment costs become the cost of the coffee and reach the profit and loss
 * as cost of sales when it is sold; overheads hit the period directly. Both
 * are money out of the same account, which is why the client wants them on one
 * screen — and why they must never be added together into a single "expenses"
 * figure that means nothing.
 */
export async function getExpenseSplit(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await prisma.$queryRaw<
    Array<{ kind: string; capitalised: boolean; amountUsd: string; count: bigint }>
  >`
    SELECT e."kind"::text AS kind,
           e."capitaliseToLandedCost" AS capitalised,
           COALESCE(SUM(e."amountUsd"), 0)::text AS "amountUsd",
           COUNT(*) AS count
    FROM expenses e
    WHERE e."companyId" = ${params.companyId} AND e."status" = 'POSTED'
      AND (${params.from ?? null}::date IS NULL OR e."expenseDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR e."expenseDate" <= ${params.to ?? null}::date)
    GROUP BY 1, 2`;

  const pick = (kind: string, capitalised?: boolean) =>
    rows
      .filter((r) => r.kind === kind && (capitalised === undefined || r.capitalised === capitalised))
      .reduce((sum, r) => sum.plus(r.amountUsd), new Decimal(0));

  const capitalised = toMoney(pick('SHIPMENT', true));
  const shipmentPeriod = toMoney(pick('SHIPMENT', false));
  const general = toMoney(pick('GENERAL'));

  return {
    /** Into the landed cost of the coffee; reaches the P&L as cost of sales. */
    capitalisedUsd: capitalised,
    /** Booked to a job but charged to the period, not to the coffee. */
    shipmentPeriodUsd: shipmentPeriod,
    /** Overheads. Nothing to do with any consignment. */
    generalUsd: general,
    /** What actually left the bank, which is all three together. */
    totalSpendUsd: toMoney(capitalised.plus(shipmentPeriod).plus(general)),
    /** What the period's profit and loss is charged, which is not the same. */
    periodChargeUsd: toMoney(shipmentPeriod.plus(general)),
    counts: {
      shipment: rows.filter((r) => r.kind === 'SHIPMENT').reduce((n, r) => n + Number(r.count), 0),
      general: rows.filter((r) => r.kind === 'GENERAL').reduce((n, r) => n + Number(r.count), 0),
    },
  };
}

export type ForexMovement = {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  description: string;
  sourceType: string;
  currency: string;
  debitUsd: Decimal;
  creditUsd: Decimal;
  debitLocal: Decimal;
  creditLocal: Decimal;
};

/**
 * Movements through Foreign Exchange Gain/Loss.
 *
 * The account is an expense head: a debit is a loss, a credit is a gain. The
 * original purchase or sale is never rewritten — only this account moves when
 * a later payment uses a different rate.
 */
export async function getForexGainLoss(params: { companyId: string; from?: Date; to?: Date }) {
  const account = await prisma.account.findFirst({
    where: { companyId: params.companyId, systemKey: ACCOUNT_KEYS.FX_GAIN_LOSS },
    select: { id: true, code: true, name: true },
  });
  if (!account) {
    return {
      account: null,
      rows: [] as ForexMovement[],
      lossUsd: toMoney(0),
      gainUsd: toMoney(0),
      netUsd: toMoney(0),
      lossLocal: toMoney(0),
      gainLocal: toMoney(0),
      netLocal: toMoney(0),
    };
  }

  const rows = await prisma.$queryRaw<
    Array<{
      entryId: string;
      entryNumber: string;
      entryDate: Date;
      description: string;
      sourceType: string;
      currency: string;
      debitUsd: string;
      creditUsd: string;
      debitLocal: string;
      creditLocal: string;
    }>
  >`
    SELECT je."id" AS "entryId", je."entryNumber", je."entryDate", je."description",
           je."sourceType"::text AS "sourceType", jl."currency",
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
           jl."debitLocal"::text AS "debitLocal", jl."creditLocal"::text AS "creditLocal"
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
     WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
       AND jl."accountId" = ${account.id}
       AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
       AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
     ORDER BY je."entryDate", je."entryNumber"
  `;

  const shaped: ForexMovement[] = rows.map((row) => ({
    entryId: row.entryId,
    entryNumber: row.entryNumber,
    entryDate: row.entryDate,
    description: row.description,
    sourceType: row.sourceType,
    currency: row.currency,
    debitUsd: toMoney(row.debitUsd),
    creditUsd: toMoney(row.creditUsd),
    debitLocal: toMoney(row.debitLocal),
    creditLocal: toMoney(row.creditLocal),
  }));

  const lossUsd = toMoney(shaped.reduce((sum, row) => sum.plus(row.debitUsd), new Decimal(0)));
  const gainUsd = toMoney(shaped.reduce((sum, row) => sum.plus(row.creditUsd), new Decimal(0)));
  const lossLocal = toMoney(shaped.reduce((sum, row) => sum.plus(row.debitLocal), new Decimal(0)));
  const gainLocal = toMoney(shaped.reduce((sum, row) => sum.plus(row.creditLocal), new Decimal(0)));

  return {
    account,
    rows: shaped,
    lossUsd,
    gainUsd,
    netUsd: toMoney(lossUsd.minus(gainUsd)),
    lossLocal,
    gainLocal,
    netLocal: toMoney(lossLocal.minus(gainLocal)),
  };
}


// ---------------------------------------------------------------------------
// Sales and purchase registers
// ---------------------------------------------------------------------------

export type SalesRegisterRow = {
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  customerId: string;
  customerName: string;
  shipmentId: string | null;
  jobNumber: string | null;
  /** The ICUL/FID orders the invoice's stock came from, taken from its lines. */
  references: string[];
  currency: string;
  quantityKg: Decimal;
  subtotal: Decimal;
  taxAmount: Decimal;
  total: Decimal;
  totalUsd: Decimal;
  costOfGoodsUsd: Decimal;
  grossProfitUsd: Decimal;
  settled: Decimal;
  outstanding: Decimal;
  status: string;
};

/**
 * Every sale in a period, with what it cost and what is still owed on it.
 *
 * Read from the posted invoices rather than from the journal, because the
 * question a sales register answers is about documents — which invoice, to
 * whom, for how much coffee — and the money on it is what the receipts and
 * credit notes say has been settled. Reversed invoices are left out: they did
 * not happen.
 */
export async function getSalesRegister(params: {
  companyId: string;
  from?: Date;
  to?: Date;
  customerId?: string;
  /** Only invoices with a line sold from an order whose ICUL/FID reference contains this. */
  reference?: string;
}): Promise<SalesRegisterRow[]> {
  const invoices = await prisma.salesInvoice.findMany({
    where: {
      companyId: params.companyId,
      status: 'POSTED',
      ...(params.customerId ? { customerId: params.customerId } : {}),
      ...(params.reference?.trim()
        ? { lines: { some: { batch: { purchaseContract: { contractReference: { contains: params.reference.trim(), mode: 'insensitive' as const } } } } } }
        : {}),
      ...(params.from || params.to
        ? {
            invoiceDate: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    },
    include: {
      customer: { select: { id: true, customerName: true } },
      shipment: { select: { id: true, jobNumber: true } },
      lines: { select: { quantityKg: true, batch: { select: { purchaseContract: { select: { contractReference: true } } } } } },
    },
    orderBy: [{ invoiceDate: 'desc' }, { invoiceNumber: 'desc' }],
  });

  if (invoices.length === 0) return [];

  // What has actually been settled against each, from the same query the
  // invoice screen uses — receipts that have not bounced, plus credit notes.
  const settlements = await prisma.$queryRaw<Array<{ id: string; settled: string }>>`
    SELECT si."id",
           (COALESCE(r.paid, 0) + COALESCE(c.credited, 0))::text AS settled
    FROM sales_invoices si
    LEFT JOIN LATERAL (
      SELECT SUM(ra."amount") AS paid
      FROM receipt_allocations ra
      JOIN receipts rc ON rc."id" = ra."receiptId"
      WHERE ra."salesInvoiceId" = si."id" AND rc."status" = 'POSTED'
        AND NOT EXISTS (
          SELECT 1 FROM cheques ch
          WHERE ch."receiptId" = rc."id" AND ch.status IN ('BOUNCED', 'CANCELLED')
        )
    ) r ON TRUE
    LEFT JOIN LATERAL (
      SELECT SUM(cn."totalAmount") AS credited
      FROM credit_notes cn
      WHERE cn."salesInvoiceId" = si."id" AND cn."status" = 'POSTED'
    ) c ON TRUE
    WHERE si."id" IN (${Prisma.join(invoices.map((i) => i.id))})
  `;
  const settledById = new Map(settlements.map((row) => [row.id, dec(row.settled)]));

  return invoices.map((invoice) => {
    const settled = toMoney(settledById.get(invoice.id) ?? 0);
    const total = toMoney(invoice.totalAmount);
    const totalUsd = toMoney(invoice.totalAmountUsd);
    const cogs = toMoney(invoice.costOfGoodsUsd);
    const outstanding = toMoney(total.minus(settled));

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      customerId: invoice.customer.id,
      customerName: invoice.customer.customerName,
      shipmentId: invoice.shipment?.id ?? null,
      jobNumber: invoice.shipment?.jobNumber ?? null,
      references: [...new Set(invoice.lines.map((l) => l.batch?.purchaseContract?.contractReference).filter((r): r is string => Boolean(r)))],
      currency: invoice.currency,
      quantityKg: toMoney(sum(invoice.lines.map((l) => dec(l.quantityKg)))),
      subtotal: toMoney(invoice.subtotal),
      taxAmount: toMoney(invoice.taxAmount),
      total,
      totalUsd,
      costOfGoodsUsd: cogs,
      grossProfitUsd: toMoney(totalUsd.minus(cogs)),
      settled,
      outstanding,
      status: outstanding.lessThanOrEqualTo(0) ? 'Paid' : settled.greaterThan(0) ? 'Part paid' : 'Unpaid',
    };
  });
}

export type PurchaseRegisterRow = {
  contractId: string;
  contractNumber: string;
  contractReference: string;
  contractDate: Date;
  vendorId: string;
  vendorName: string;
  origin: string | null;
  currency: string;
  quantityKg: Decimal;
  containers: number;
  bags: number;
  goodsValue: Decimal;
  freight: Decimal;
  total: Decimal;
  totalUsd: Decimal;
  receivedKg: Decimal;
  settled: Decimal;
  outstanding: Decimal;
  status: string;
};

/**
 * Every purchase in a period, with how much has landed and how much is paid.
 *
 * "Received" is what the goods receipts say arrived, not what was ordered:
 * coffee is bought months before it turns up, and a register that showed the
 * contracted tonnage as though it were in the warehouse would be answering a
 * different question from the one being asked.
 */
export async function getPurchaseRegister(params: {
  companyId: string;
  from?: Date;
  to?: Date;
  vendorId?: string;
}): Promise<PurchaseRegisterRow[]> {
  const contracts = await prisma.purchaseContract.findMany({
    where: {
      companyId: params.companyId,
      status: { not: 'DRAFT' },
      ...(params.vendorId ? { vendorId: params.vendorId } : {}),
      ...(params.from || params.to
        ? {
            contractDate: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    },
    include: {
      vendor: { select: { id: true, vendorName: true } },
      lines: { select: { quantityKg: true } },
    },
    orderBy: [{ contractDate: 'desc' }, { contractNumber: 'desc' }],
  });

  if (contracts.length === 0) return [];

  const received = await prisma.$queryRaw<Array<{ id: string; kg: string }>>`
    SELECT pc."id", COALESCE(SUM(grl."quantityKg"), 0)::text AS kg
    FROM purchase_contracts pc
    LEFT JOIN goods_receipts gr ON gr."purchaseContractId" = pc."id" AND gr."status" = 'POSTED'
    LEFT JOIN goods_receipt_lines grl ON grl."goodsReceiptId" = gr."id"
    WHERE pc."id" IN (${Prisma.join(contracts.map((c) => c.id))})
    GROUP BY pc."id"
  `;
  const receivedById = new Map(received.map((row) => [row.id, dec(row.kg)]));

  const paid = await prisma.$queryRaw<Array<{ id: string; paid: string }>>`
    SELECT pc."id", COALESCE(SUM(pa."amount"), 0)::text AS paid
    FROM purchase_contracts pc
    LEFT JOIN payment_allocations pa ON pa."purchaseContractId" = pc."id"
    LEFT JOIN payments p ON p."id" = pa."paymentId" AND p."status" = 'POSTED'
    WHERE pc."id" IN (${Prisma.join(contracts.map((c) => c.id))})
      AND (pa."id" IS NULL OR p."id" IS NOT NULL)
    GROUP BY pc."id"
  `;
  const paidById = new Map(paid.map((row) => [row.id, dec(row.paid)]));

  return contracts.map((contract) => {
    const total = toMoney(contract.totalValue);
    const settled = toMoney(paidById.get(contract.id) ?? 0);
    const outstanding = toMoney(total.minus(settled));

    return {
      contractId: contract.id,
      contractNumber: contract.contractNumber,
      contractReference: contract.contractReference,
      contractDate: contract.contractDate,
      vendorId: contract.vendor.id,
      vendorName: contract.vendor.vendorName,
      origin: contract.origin,
      currency: contract.currency,
      quantityKg: toMoney(sum(contract.lines.map((l) => dec(l.quantityKg)))),
      containers: contract.containers,
      bags: contract.totalBags,
      goodsValue: toMoney(contract.subtotal),
      freight: toMoney(contract.freightAmount),
      total,
      totalUsd: toMoney(contract.totalValueUsd),
      receivedKg: toMoney(receivedById.get(contract.id) ?? 0),
      settled,
      outstanding,
      status: outstanding.lessThanOrEqualTo(0) ? 'Paid' : settled.greaterThan(0) ? 'Part paid' : 'Unpaid',
    };
  });
}

// ---------------------------------------------------------------------------
// Statements by column: months, quarters, years, and period comparison
// ---------------------------------------------------------------------------

export type StatementColumnsBy = 'total' | 'month' | 'quarter' | 'year';
export type StatementCompare = 'none' | 'previous' | 'year';

export type StatementColumn = { label: string; from: Date; to: Date };

/** Split a period into the columns a reader asked for — never more than 60. */
export function statementColumns(from: Date, to: Date, by: StatementColumnsBy): StatementColumn[] {
  if (by === 'total') return [{ label: 'Total', from, to }];
  const columns: StatementColumn[] = [];
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), by === 'year' ? 0 : by === 'quarter' ? Math.floor(from.getUTCMonth() / 3) * 3 : from.getUTCMonth(), 1));
  const months = by === 'year' ? 12 : by === 'quarter' ? 3 : 1;
  while (cursor <= to && columns.length < 60) {
    const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + months, 0));
    const label =
      by === 'year'
        ? String(cursor.getUTCFullYear())
        : by === 'quarter'
          ? `Q${Math.floor(cursor.getUTCMonth() / 3) + 1} ${cursor.getUTCFullYear()}`
          : cursor.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    columns.push({ label, from: cursor < from ? from : cursor, to: end > to ? to : end });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + months, 1));
  }
  return columns;
}

/** The period to compare with: the one just before of the same length, or the same dates a year earlier. */
export function comparisonPeriod(from: Date, to: Date, compare: StatementCompare): { from: Date; to: Date } | null {
  if (compare === 'none') return null;
  if (compare === 'year') {
    return {
      from: new Date(Date.UTC(from.getUTCFullYear() - 1, from.getUTCMonth(), from.getUTCDate())),
      to: new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), to.getUTCDate())),
    };
  }
  const span = to.getTime() - from.getTime() + 86_400_000;
  const previousTo = new Date(from.getTime() - 86_400_000);
  return { from: new Date(previousTo.getTime() - span + 86_400_000), to: previousTo };
}

/**
 * The profit and loss laid out in columns: one per month, quarter or year,
 * with a total, and optionally the comparison period beside it. Each column
 * is the ordinary statement for its own dates, so the total column is the
 * plain report and every other one is a slice of it.
 */
export async function getProfitAndLossByColumns(params: {
  companyId: string;
  from: Date;
  to: Date;
  columnsBy: StatementColumnsBy;
  compare: StatementCompare;
}) {
  const columns = statementColumns(params.from, params.to, params.columnsBy);
  const previous = comparisonPeriod(params.from, params.to, params.compare);
  const [byColumn, total, before] = await Promise.all([
    params.columnsBy === 'total'
      ? Promise.resolve([] as ProfitAndLoss[])
      : Promise.all(columns.map((c) => getProfitAndLoss({ companyId: params.companyId, from: c.from, to: c.to }))),
    getProfitAndLoss({ companyId: params.companyId, from: params.from, to: params.to }),
    previous ? getProfitAndLoss({ companyId: params.companyId, from: previous.from, to: previous.to }) : Promise.resolve(null),
  ]);
  return { columns, byColumn, total, previous, before };
}

// ---------------------------------------------------------------------------
// General ledger, every account at once
// ---------------------------------------------------------------------------

export type LedgerGroupLine = {
  entryId: string;
  entryDate: Date;
  sourceType: string;
  sourceId: string;
  reference: string | null;
  party: string | null;
  description: string;
  debitUsd: Decimal;
  creditUsd: Decimal;
  balanceUsd: Decimal;
};

export type LedgerGroup = {
  accountId: string;
  name: string;
  type: string;
  openingUsd: Decimal;
  lines: LedgerGroupLine[];
  debitUsd: Decimal;
  creditUsd: Decimal;
  closingUsd: Decimal;
};

/**
 * The general ledger the way it is printed: account by account, each with
 * its opening balance, its lines in date order with a running balance, and
 * its closing balance — in accounting order (assets, liabilities, equity,
 * income, expenses), not alphabetical. Two queries for the whole book,
 * however many accounts: one for the openings, one for the period's lines.
 */
export async function getGeneralLedgerByAccount(params: {
  companyId: string;
  from?: Date;
  to?: Date;
  filters?: LedgerFilters;
}): Promise<LedgerGroup[]> {
  const f = params.filters ?? {};
  const accounts = await prisma.account.findMany({
    where: { companyId: params.companyId, ...(f.accountType ? { type: f.accountType as never } : {}) },
    orderBy: { code: 'asc' },
    select: { id: true, name: true, type: true },
  });

  const openings = params.from
    ? await prisma.$queryRaw<Array<{ accountId: string; net: string }>>`
        SELECT jl."accountId", COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS net
        FROM journal_lines jl
        JOIN journal_entries je ON je."id" = jl."journalEntryId"
        WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
          AND je."entryDate" < ${params.from}::date
          AND (${f.customerId ?? null}::text IS NULL OR jl."customerId" = ${f.customerId ?? null})
          AND (${f.vendorId ?? null}::text IS NULL OR jl."vendorId" = ${f.vendorId ?? null})
          AND (${f.shipmentId ?? null}::text IS NULL OR jl."shipmentId" = ${f.shipmentId ?? null})
          AND (${f.currency ?? null}::text IS NULL OR jl."currency" = ${f.currency ?? null})
        GROUP BY jl."accountId"
      `
    : [];

  const lines = await prisma.$queryRaw<
    Array<{
      accountId: string;
      entryId: string;
      entryDate: Date;
      sourceType: string;
      sourceId: string;
      reference: string | null;
      party: string | null;
      description: string;
      debitUsd: string;
      creditUsd: string;
    }>
  >`
    SELECT jl."accountId", je."id" AS "entryId", je."entryDate", je."sourceType"::text AS "sourceType", je."sourceId",
           NULL::text AS "reference", COALESCE(c."customerName", v."vendorName", ag."agentName") AS party,
           COALESCE(NULLIF(jl."description", ''), je."description") AS description,
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd"
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    LEFT JOIN customers c ON c."id" = jl."customerId"
    LEFT JOIN vendors v ON v."id" = jl."vendorId"
    LEFT JOIN agents ag ON ag."id" = jl."agentId"
    WHERE je."companyId" = ${params.companyId} AND ${LIVE_ENTRY_SQL}
      AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
      AND (${f.customerId ?? null}::text IS NULL OR jl."customerId" = ${f.customerId ?? null})
      AND (${f.vendorId ?? null}::text IS NULL OR jl."vendorId" = ${f.vendorId ?? null})
      AND (${f.shipmentId ?? null}::text IS NULL OR jl."shipmentId" = ${f.shipmentId ?? null})
      AND (${f.currency ?? null}::text IS NULL OR jl."currency" = ${f.currency ?? null})
    ORDER BY je."entryDate", je."createdAt", jl."id"
  `;

  const openingBy = new Map(openings.map((o) => [o.accountId, dec(o.net)]));
  const linesBy = new Map<string, typeof lines>();
  for (const line of lines) linesBy.set(line.accountId, [...(linesBy.get(line.accountId) ?? []), line]);

  const groups: LedgerGroup[] = [];
  for (const account of accounts) {
    const opening = openingBy.get(account.id) ?? new Decimal(0);
    const own = linesBy.get(account.id) ?? [];
    if (opening.isZero() && own.length === 0) continue;

    let running = opening;
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    const shaped: LedgerGroupLine[] = own.map((line) => {
      const d = dec(line.debitUsd);
      const c = dec(line.creditUsd);
      running = running.plus(d).minus(c);
      debit = debit.plus(d);
      credit = credit.plus(c);
      return {
        entryId: line.entryId,
        entryDate: line.entryDate,
        sourceType: line.sourceType,
        sourceId: line.sourceId,
        reference: line.reference,
        party: line.party,
        description: line.description,
        debitUsd: toMoney(d),
        creditUsd: toMoney(c),
        balanceUsd: toMoney(running),
      };
    });

    groups.push({
      accountId: account.id,
      name: account.name,
      type: account.type,
      openingUsd: toMoney(opening),
      lines: shaped,
      debitUsd: toMoney(debit),
      creditUsd: toMoney(credit),
      closingUsd: toMoney(running),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Sales by customer / item / shipment / warehouse / batch
// ---------------------------------------------------------------------------

export type SalesDimension = 'customer' | 'item' | 'shipment' | 'warehouse' | 'batch';

export type SalesByRow = {
  key: string;
  label: string;
  /** Where the label links: the customer's ledger, the item, the shipment… */
  href: string | null;
  invoices: number;
  quantityKg: Decimal;
  revenueUsd: Decimal;
  costUsd: Decimal;
  grossProfitUsd: Decimal;
  marginPct: Decimal;
  /** The invoice lines behind the row, for the detail view. */
  detail: Array<{
    invoiceId: string;
    invoiceLabel: string;
    invoiceDate: Date;
    customerName: string;
    itemName: string;
    warehouseName: string | null;
    batchNumber: string | null;
    shipmentReference: string | null;
    quantityKg: Decimal;
    unitPriceUsd: Decimal;
    revenueUsd: Decimal;
    costUsd: Decimal;
  }>;
};

/**
 * Sales summarised by whichever dimension the reader picks, from posted
 * invoice lines — the same lines the profit and loss and the shipment
 * results are read from, so the totals agree with both. Each row carries
 * its lines, so the summary and the detail are one report at two depths.
 */
export async function getSalesBy(params: { companyId: string; from: Date; to: Date; by: SalesDimension }): Promise<SalesByRow[]> {
  const lines = await prisma.salesInvoiceLine.findMany({
    where: { salesInvoice: { companyId: params.companyId, status: 'POSTED', invoiceDate: { gte: params.from, lte: params.to } } },
    select: {
      id: true,
      quantityKg: true,
      lineTotalUsd: true,
      costTotalUsd: true,
      salesInvoice: { select: { id: true, invoiceNumber: true, invoiceDate: true, customer: { select: { id: true, customerName: true } } } },
      item: { select: { id: true, itemName: true } },
      warehouse: { select: { id: true, name: true } },
      batch: {
        select: {
          id: true,
          batchNumber: true,
          shipment: { select: { id: true, purchaseContract: { select: { contractReference: true } } } },
        },
      },
    },
    orderBy: [{ salesInvoice: { invoiceDate: 'asc' } }, { id: 'asc' }],
  });

  const keyOf = (line: (typeof lines)[number]): { key: string; label: string; href: string | null } => {
    switch (params.by) {
      case 'customer':
        return { key: line.salesInvoice.customer.id, label: line.salesInvoice.customer.customerName, href: `/ledgers/customers/${line.salesInvoice.customer.id}` };
      case 'item':
        return { key: line.item.id, label: line.item.itemName, href: `/items/${line.item.id}` };
      case 'shipment':
        return line.batch?.shipment
          ? { key: line.batch.shipment.id, label: line.batch.shipment.purchaseContract.contractReference, href: `/shipments/${line.batch.shipment.id}` }
          : { key: 'none', label: 'No shipment', href: null };
      case 'warehouse':
        return line.warehouse ? { key: line.warehouse.id, label: line.warehouse.name, href: null } : { key: 'none', label: 'No warehouse', href: null };
      case 'batch':
        return line.batch ? { key: line.batch.id, label: line.batch.batchNumber, href: `/inventory/batches/${line.batch.id}` } : { key: 'none', label: 'No batch', href: null };
    }
  };

  const rows = new Map<string, SalesByRow & { invoiceIds: Set<string> }>();
  for (const line of lines) {
    const { key, label, href } = keyOf(line);
    const row =
      rows.get(key) ??
      { key, label, href, invoices: 0, quantityKg: new Decimal(0), revenueUsd: new Decimal(0), costUsd: new Decimal(0), grossProfitUsd: new Decimal(0), marginPct: new Decimal(0), detail: [], invoiceIds: new Set<string>() };
    row.invoiceIds.add(line.salesInvoice.id);
    row.quantityKg = row.quantityKg.plus(line.quantityKg);
    row.revenueUsd = row.revenueUsd.plus(line.lineTotalUsd);
    row.costUsd = row.costUsd.plus(line.costTotalUsd);
    row.detail.push({
      invoiceId: line.salesInvoice.id,
      invoiceLabel: `INV ${Number(line.salesInvoice.invoiceNumber.match(/(\d+)\s*$/)?.[1] ?? line.salesInvoice.invoiceNumber)}`,
      invoiceDate: line.salesInvoice.invoiceDate,
      customerName: line.salesInvoice.customer.customerName,
      itemName: line.item.itemName,
      warehouseName: line.warehouse?.name ?? null,
      batchNumber: line.batch?.batchNumber ?? null,
      shipmentReference: line.batch?.shipment?.purchaseContract.contractReference ?? null,
      quantityKg: toQuantity(line.quantityKg),
      unitPriceUsd: dec(line.quantityKg).greaterThan(0) ? toUnitCost(dec(line.lineTotalUsd).dividedBy(line.quantityKg)) : new Decimal(0),
      revenueUsd: toMoney(line.lineTotalUsd),
      costUsd: toMoney(line.costTotalUsd),
    });
    rows.set(key, row);
  }

  return [...rows.values()]
    .map(({ invoiceIds, ...row }) => {
      const gross = toMoney(row.revenueUsd.minus(row.costUsd));
      return {
        ...row,
        invoices: invoiceIds.size,
        quantityKg: toQuantity(row.quantityKg),
        revenueUsd: toMoney(row.revenueUsd),
        costUsd: toMoney(row.costUsd),
        grossProfitUsd: gross,
        marginPct: row.revenueUsd.isZero() ? new Decimal(0) : gross.dividedBy(row.revenueUsd).times(100).toDecimalPlaces(2),
      };
    })
    .sort((a, b) => b.revenueUsd.comparedTo(a.revenueUsd));
}

// ---------------------------------------------------------------------------
// Customer and supplier balance summary
// ---------------------------------------------------------------------------

export type PartyBalanceRow = { partyId: string; partyName: string; currency: string; balance: Decimal; balanceUsd: Decimal; href: string };

/** What each customer owes, one line each, per currency — the totals the ledgers show. */
export async function getCustomerBalances(companyId: string): Promise<PartyBalanceRow[]> {
  const rows = await getReceivables({ companyId, onlyOutstanding: true });
  return partyBalances(rows.map((r) => ({ id: r.customerId, name: r.customerName, currency: r.currency, amount: r.outstandingAmount, usd: r.outstandingAmountUsd })), (id) => `/ledgers/customers/${id}`);
}

/** What the company owes each supplier, one line each, per currency. */
export async function getVendorBalances(companyId: string): Promise<PartyBalanceRow[]> {
  const rows = await getPayables({ companyId, onlyOutstanding: true });
  return partyBalances(rows.map((r) => ({ id: r.vendorId, name: r.vendorName, currency: r.currency, amount: r.outstandingAmount, usd: r.outstandingAmountUsd })), (id) => `/ledgers/vendors/${id}`);
}

function partyBalances(items: Array<{ id: string; name: string; currency: string; amount: Decimal; usd: Decimal }>, href: (id: string) => string): PartyBalanceRow[] {
  const by = new Map<string, PartyBalanceRow>();
  for (const item of items) {
    const key = `${item.id}:${item.currency}`;
    const row = by.get(key) ?? { partyId: item.id, partyName: item.name, currency: item.currency, balance: new Decimal(0), balanceUsd: new Decimal(0), href: href(item.id) };
    row.balance = row.balance.plus(item.amount);
    row.balanceUsd = row.balanceUsd.plus(item.usd);
    by.set(key, row);
  }
  return [...by.values()]
    .map((r) => ({ ...r, balance: toMoney(r.balance), balanceUsd: toMoney(r.balanceUsd) }))
    .filter((r) => !r.balance.isZero())
    .sort((a, b) => a.partyName.localeCompare(b.partyName) || a.currency.localeCompare(b.currency));
}
