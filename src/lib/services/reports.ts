import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney, toQuantity } from '@/lib/money';
import { REPORT_GROUPS } from '@/lib/constants';
import { getCompanyContext } from '@/lib/services/company';
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

async function accountBalances(params: {
  companyId: string;
  from?: Date | null;
  to?: Date | null;
}): Promise<LedgerBalanceRow[]> {
  return prisma.$queryRaw<LedgerBalanceRow[]>`
    SELECT a."id" AS "accountId", a."code", a."name", a."type"::text AS type, a."reportGroup",
           COALESCE(SUM(jl."debitUsd"), 0)::text    AS "debitUsd",
           COALESCE(SUM(jl."creditUsd"), 0)::text   AS "creditUsd",
           COALESCE(SUM(jl."debitLocal"), 0)::text  AS "debitLocal",
           COALESCE(SUM(jl."creditLocal"), 0)::text AS "creditLocal"
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl."accountId" = a."id"
    LEFT JOIN journal_entries je ON je."id" = jl."journalEntryId" AND je."status" = 'POSTED'
      AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
    WHERE a."companyId" = ${params.companyId}
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
  debitUsd: Decimal;
  creditUsd: Decimal;
  debitLocal: Decimal;
  creditLocal: Decimal;
};

export async function getTrialBalanceReport(params: { companyId: string; from?: Date; to?: Date }) {
  const rows = await accountBalances(params);
  const shaped: TrialBalanceRow[] = [];

  for (const row of rows) {
    const netUsd = dec(row.debitUsd).minus(dec(row.creditUsd));
    const netLocal = dec(row.debitLocal).minus(dec(row.creditLocal));
    if (netUsd.isZero() && netLocal.isZero()) continue;

    shaped.push({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      debitUsd: netUsd.greaterThan(0) ? toMoney(netUsd) : new Decimal(0),
      creditUsd: netUsd.lessThan(0) ? toMoney(netUsd.abs()) : new Decimal(0),
      debitLocal: netLocal.greaterThan(0) ? toMoney(netLocal) : new Decimal(0),
      creditLocal: netLocal.lessThan(0) ? toMoney(netLocal.abs()) : new Decimal(0),
    });
  }

  const totals = shaped.reduce(
    (acc, r) => ({
      debitUsd: acc.debitUsd.plus(r.debitUsd),
      creditUsd: acc.creditUsd.plus(r.creditUsd),
      debitLocal: acc.debitLocal.plus(r.debitLocal),
      creditLocal: acc.creditLocal.plus(r.creditLocal),
    }),
    { debitUsd: new Decimal(0), creditUsd: new Decimal(0), debitLocal: new Decimal(0), creditLocal: new Decimal(0) },
  );

  return {
    rows: shaped,
    totals: {
      debitUsd: toMoney(totals.debitUsd),
      creditUsd: toMoney(totals.creditUsd),
      debitLocal: toMoney(totals.debitLocal),
      creditLocal: toMoney(totals.creditLocal),
    },
    isBalanced: toMoney(totals.debitUsd).equals(toMoney(totals.creditUsd)),
  };
}

// ---------------------------------------------------------------------------
// Profit & Loss
// ---------------------------------------------------------------------------

export type PnlLine = { code: string; name: string; amountUsd: Decimal; amountLocal: Decimal };

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

export async function getBalanceSheet(params: { companyId: string; asOf: Date }) {
  const rows = await accountBalances({ companyId: params.companyId, to: params.asOf });

  const assets: PnlLine[] = [];
  const liabilities: PnlLine[] = [];
  const equity: PnlLine[] = [];
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

    const line: PnlLine = {
      code: row.code,
      name: row.name,
      amountUsd: toMoney(row.type === 'ASSET' ? debitMinusCreditUsd : debitMinusCreditUsd.negated()),
      amountLocal: toMoney(row.type === 'ASSET' ? debitMinusCreditLocal : debitMinusCreditLocal.negated()),
    };

    if (row.type === 'ASSET') assets.push(line);
    else if (row.type === 'LIABILITY') liabilities.push(line);
    else equity.push(line);
  }

  equity.push({
    code: '3900',
    name: 'Current Period Result',
    amountUsd: toMoney(retainedThisPeriodUsd),
    amountLocal: toMoney(retainedThisPeriodLocal),
  });

  const section = (title: string, lines: PnlLine[]): BalanceSheetSection => ({
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
      code: string;
      name: string;
      accountType: string;
      currency: string;
      opening: string;
      movement: string;
      movementUsd: string;
    }>
  >`
    SELECT cba."id" AS "accountId", cba."code", cba."name",
           cba."accountType"::text AS "accountType", cba."currency",
           cba."openingBalance"::text AS opening,
           COALESCE((SELECT SUM(jl."debit" - jl."credit") FROM journal_lines jl
                       JOIN journal_entries je ON je."id" = jl."journalEntryId"
                      WHERE jl."cashBankAccountId" = cba."id" AND je."status" = 'POSTED'
                        AND (${asOf}::date IS NULL OR je."entryDate" <= ${asOf}::date)), 0)::text AS movement,
           COALESCE((SELECT SUM(jl."debitUsd" - jl."creditUsd") FROM journal_lines jl
                       JOIN journal_entries je ON je."id" = jl."journalEntryId"
                      WHERE jl."cashBankAccountId" = cba."id" AND je."status" = 'POSTED'
                        AND (${asOf}::date IS NULL OR je."entryDate" <= ${asOf}::date)), 0)::text AS "movementUsd"
    FROM cash_bank_accounts cba
    WHERE cba."companyId" = ${params.companyId} AND cba."status" = 'ACTIVE'
    ORDER BY cba."accountType", cba."currency", cba."code"
  `;

  const accounts: CashPosition[] = cashRows.map((row) => ({
    accountId: row.accountId,
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
      COALESCE((SELECT SUM(ib."bags") FROM inventory_balances ib
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
    bags: Number(t?.bags ?? 0),
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
  reference: string | null;
  currency: string;
  debit: Decimal;
  credit: Decimal;
  debitUsd: Decimal;
  creditUsd: Decimal;
  balanceUsd: Decimal;
};

export async function getGeneralLedger(params: {
  companyId: string;
  accountId: string;
  from?: Date;
  to?: Date;
}) {
  const account = await prisma.account.findFirstOrThrow({
    where: { id: params.accountId, companyId: params.companyId },
    select: { id: true, code: true, name: true, type: true },
  });

  const openingRows = await prisma.$queryRaw<Array<{ net: string | null }>>`
    SELECT SUM(jl."debitUsd" - jl."creditUsd")::text AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${params.companyId} AND je."status" = 'POSTED'
      AND jl."accountId" = ${params.accountId}
      AND ${params.from ?? null}::date IS NOT NULL AND je."entryDate" < ${params.from ?? null}::date
  `;

  const rows = await prisma.$queryRaw<
    Array<{
      entryId: string;
      entryNumber: string;
      entryDate: Date;
      description: string;
      sourceType: string;
      currency: string;
      debit: string;
      credit: string;
      debitUsd: string;
      creditUsd: string;
      reference: string | null;
    }>
  >`
    SELECT je."id" AS "entryId", je."entryNumber", je."entryDate", je."description",
           je."sourceType"::text AS "sourceType", jl."currency",
           jl."debit"::text AS debit, jl."credit"::text AS credit,
           jl."debitUsd"::text AS "debitUsd", jl."creditUsd"::text AS "creditUsd",
           jl."description" AS reference
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    WHERE je."companyId" = ${params.companyId} AND je."status" = 'POSTED'
      AND jl."accountId" = ${params.accountId}
      AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
    ORDER BY je."entryDate", je."entryNumber", jl."lineNumber"
  `;

  let running = toMoney(dec(openingRows[0]?.net ?? 0));
  const opening = running;

  const shaped: GeneralLedgerRow[] = rows.map((row) => {
    running = toMoney(running.plus(dec(row.debitUsd)).minus(dec(row.creditUsd)));
    return {
      entryId: row.entryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      description: row.description,
      sourceType: row.sourceType,
      reference: row.reference,
      currency: row.currency,
      debit: dec(row.debit),
      credit: dec(row.credit),
      debitUsd: dec(row.debitUsd),
      creditUsd: dec(row.creditUsd),
      balanceUsd: running,
    };
  });

  return { account, openingBalanceUsd: opening, closingBalanceUsd: running, rows: shaped };
}

/** Cash book / bank book: every movement through one cash or bank account. */
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

  const rows = await prisma.$queryRaw<
    Array<{
      entryId: string;
      entryNumber: string;
      entryDate: Date;
      description: string;
      sourceType: string;
      debit: string;
      credit: string;
      counterparty: string | null;
    }>
  >`
    SELECT je."id" AS "entryId", je."entryNumber", je."entryDate", je."description",
           je."sourceType"::text AS "sourceType",
           jl."debit"::text AS debit, jl."credit"::text AS credit,
           COALESCE(c."customerName", v."vendorName") AS counterparty
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    LEFT JOIN customers c ON c."id" = jl."customerId"
    LEFT JOIN vendors v ON v."id" = jl."vendorId"
    WHERE je."companyId" = ${params.companyId} AND je."status" = 'POSTED'
      AND jl."cashBankAccountId" = ${params.cashBankAccountId}
      AND (${params.from ?? null}::date IS NULL OR je."entryDate" >= ${params.from ?? null}::date)
      AND (${params.to ?? null}::date IS NULL OR je."entryDate" <= ${params.to ?? null}::date)
    ORDER BY je."entryDate", je."entryNumber"
  `;

  let running = toMoney(account.openingBalance);
  const opening = running;

  const shaped = rows.map((row) => {
    running = toMoney(running.plus(dec(row.debit)).minus(dec(row.credit)));
    return {
      entryId: row.entryId,
      entryNumber: row.entryNumber,
      entryDate: row.entryDate,
      description: row.description,
      sourceType: row.sourceType,
      counterparty: row.counterparty,
      moneyIn: dec(row.debit),
      moneyOut: dec(row.credit),
      balance: running,
    };
  });

  return { account, openingBalance: opening, closingBalance: running, rows: shaped };
}

/** The journal: every posted entry, newest first. */
export async function getJournalReport(params: {
  companyId: string;
  from?: Date;
  to?: Date;
  sourceType?: string;
  limit?: number;
}) {
  return prisma.journalEntry.findMany({
    where: {
      companyId: params.companyId,
      status: 'POSTED',
      ...(params.sourceType ? { sourceType: params.sourceType as never } : {}),
      ...(params.from || params.to
        ? { entryDate: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
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
    WHERE je."companyId" = ${params.companyId} AND je."status" = 'POSTED'
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
