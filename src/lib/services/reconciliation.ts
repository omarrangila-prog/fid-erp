import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { getTrialBalanceReport, getBalanceSheet, getFinancialPosition } from '@/lib/services/reports';
import { getCompanyProfitSummary } from '@/lib/services/profitability';
import {
  getReceivables,
  getPayables,
  getUnappliedCredits,
  getUnappliedCreditsByParty,
} from '@/lib/services/receivables';

/**
 * Does the ledger agree with the operational records?
 *
 * Sub-ledgers and control accounts are written by different code paths, so they
 * can drift: a receipt that updates the customer's balance but not Accounts
 * Receivable leaves both figures individually plausible and the pair wrong.
 * These checks compare them and say so.
 *
 * They are deliberately computed independently of the reports they check —
 * summing journal lines directly rather than reusing a report's own total —
 * because a check that shares its subject's arithmetic proves nothing.
 */

export type ReconciliationCheck = {
  id: string;
  group: 'Accounting' | 'Sub-ledgers' | 'Cash & bank' | 'Inventory';
  label: string;
  /** What the two figures mean, for someone who has to fix a failure. */
  explanation: string;
  left: { label: string; value: string };
  right: { label: string; value: string };
  differenceUsd: string;
  passed: boolean;
};

export type ReconciliationResult = {
  companyId: string;
  checks: ReconciliationCheck[];
  passed: number;
  failed: number;
  healthy: boolean;
};

const TOLERANCE = new Decimal('0.05');

async function controlAccountBalance(companyId: string, systemKey: string, signed: 'debit' | 'credit') {
  const rows = await prisma.$queryRaw<Array<{ bal: string }>>`
    SELECT COALESCE(SUM(
      CASE WHEN ${signed} = 'debit'
           THEN jl."debitUsd" - jl."creditUsd"
           ELSE jl."creditUsd" - jl."debitUsd" END
    ), 0)::text AS bal
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED' AND a."systemKey" = ${systemKey}`;
  return dec(rows[0]?.bal ?? 0);
}

function build(
  id: string,
  group: ReconciliationCheck['group'],
  label: string,
  explanation: string,
  leftLabel: string,
  left: Decimal,
  rightLabel: string,
  right: Decimal,
): ReconciliationCheck {
  const difference = toMoney(left.minus(right));
  return {
    id,
    group,
    label,
    explanation,
    left: { label: leftLabel, value: toMoney(left).toFixed(2) },
    right: { label: rightLabel, value: toMoney(right).toFixed(2) },
    differenceUsd: difference.toFixed(2),
    passed: difference.abs().lessThanOrEqualTo(TOLERANCE),
  };
}

export async function reconcile(companyId: string): Promise<ReconciliationResult> {
  const checks: ReconciliationCheck[] = [];

  // --- Accounting ---------------------------------------------------------
  const tb = await getTrialBalanceReport({ companyId });
  checks.push(
    build(
      'trial-balance',
      'Accounting',
      'Trial balance is balanced',
      'Total debits must equal total credits. A difference means an entry was written with unbalanced lines.',
      'Total debits',
      dec(tb.totals.debitUsd),
      'Total credits',
      dec(tb.totals.creditUsd),
    ),
  );

  const bs = await getBalanceSheet({ companyId, asOf: new Date() });
  checks.push(
    build(
      'balance-sheet',
      'Accounting',
      'Balance sheet balances',
      'Assets must equal liabilities plus equity. A difference points at an entry that missed one side.',
      'Assets',
      dec(bs.assets.totalUsd),
      'Liabilities + equity',
      dec(bs.liabilities.totalUsd).plus(bs.equity.totalUsd),
    ),
  );

  const unbalanced = await prisma.$queryRaw<Array<{ c: bigint }>>`
    SELECT COUNT(*)::bigint AS c FROM (
      SELECT je."id"
      FROM journal_entries je JOIN journal_lines jl ON jl."journalEntryId" = je."id"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      GROUP BY je."id"
      HAVING ABS(SUM(jl."debitUsd") - SUM(jl."creditUsd")) > 0.005
    ) x`;
  const unbalancedCount = Number(unbalanced[0]?.c ?? 0);
  checks.push({
    id: 'entry-level-balance',
    group: 'Accounting',
    label: 'Every posted entry balances on its own',
    explanation:
      'The trial balance can net to zero while individual entries are wrong. This counts entries whose own lines do not balance.',
    left: { label: 'Unbalanced entries', value: String(unbalancedCount) },
    right: { label: 'Expected', value: '0' },
    differenceUsd: String(unbalancedCount),
    passed: unbalancedCount === 0,
  });

  // --- Sub-ledgers --------------------------------------------------------
  // A credit raised without naming an invoice cannot be netted against one, so
  // it is subtracted from the sub-ledger total instead.
  const unapplied = await getUnappliedCredits(companyId);
  const arControl = await controlAccountBalance(companyId, 'ACCOUNTS_RECEIVABLE', 'debit');
  const arSub = (await getReceivables({ companyId, onlyOutstanding: true }))
    .reduce((total, row) => total.plus(row.outstandingAmountUsd), new Decimal(0))
    .minus(unapplied.customerUsd);
  checks.push(
    build(
      'receivables',
      'Sub-ledgers',
      'Receivables agree with the ledger',
      'The sum of what customers owe must equal the Accounts Receivable control account.',
      'AR control account',
      arControl,
      'Customer outstanding, less unapplied credits',
      arSub,
    ),
  );

  const apControl = await controlAccountBalance(companyId, 'ACCOUNTS_PAYABLE', 'credit');
  const apSub = (await getPayables({ companyId, onlyOutstanding: true }))
    .reduce((total, row) => total.plus(row.outstandingAmountUsd), new Decimal(0))
    .minus(unapplied.vendorUsd);
  checks.push(
    build(
      'payables',
      'Sub-ledgers',
      'Payables agree with the ledger',
      'The sum of what we owe suppliers must equal the Accounts Payable control account.',
      'AP control account',
      apControl,
      'Supplier outstanding, less unapplied credits',
      apSub,
    ),
  );

  const inventoryControl = await controlAccountBalance(companyId, 'INVENTORY', 'debit');
  const position = await getFinancialPosition({ companyId });
  checks.push(
    build(
      'inventory-value',
      'Sub-ledgers',
      'Inventory asset agrees with valued stock',
      'Stock on hand valued at landed cost must equal the Inventory control account.',
      'Inventory control account',
      inventoryControl,
      'Valued stock on hand',
      dec(position.inventoryValueUsd),
    ),
  );

  const cogsControl = await controlAccountBalance(companyId, 'COST_OF_GOODS_SOLD', 'debit');
  const profit = await getCompanyProfitSummary({ companyId });
  checks.push(
    build(
      'cost-of-sales',
      'Sub-ledgers',
      'Cost of sales agrees with profitability',
      'What the ledger charged to cost of sales must equal what the profitability report says was consumed.',
      'COGS control account',
      cogsControl,
      'Profitability report',
      dec(profit.cogsUsd),
    ),
  );

  // --- Sub-ledgers, in the party's own currency -----------------------------
  // The USD checks above can pass while a customer's MAD statement is wrong:
  // MAD 8,680 still showing as owed on an invoice paid to the dirham, and
  // MAD 8,680 sitting as a credit, net to zero in USD. So the receivable and
  // payable ledgers are also compared with the open documents customer by
  // customer and currency by currency, with nothing converted.
  const arNative = await prisma.$queryRaw<Array<{ partyId: string; currency: string; net: string }>>`
    SELECT jl."customerId" AS "partyId", jl."currency", SUM(jl."debit" - jl."credit")::text AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      AND a."systemKey" = 'ACCOUNTS_RECEIVABLE' AND jl."customerId" IS NOT NULL
    GROUP BY jl."customerId", jl."currency"`;
  // A document is restated in the party's ledger currency the way the
  // ledger line was: at the document's own rates.
  const localCode = (await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } }))
    .localCurrency.toUpperCase();
  const inPartyCurrency = (row: {
    currency: string;
    partyCurrency: string;
    rateLocalPerUsd: Decimal;
    outstandingAmount: Decimal;
    outstandingAmountUsd: Decimal;
  }) => {
    const party = row.partyCurrency.toUpperCase();
    if (party === row.currency.toUpperCase()) return row.outstandingAmount;
    if (party === 'USD') return row.outstandingAmountUsd;
    if (party === localCode) return toMoney(row.outstandingAmountUsd.times(row.rateLocalPerUsd));
    return row.outstandingAmount;
  };

  // A credit raised without naming an invoice reduces what the party owes but
  // belongs to no document, exactly as in the USD checks above.
  const unappliedByParty = await getUnappliedCreditsByParty(companyId);

  const arDocs = new Map<string, Decimal>();
  for (const row of await getReceivables({ companyId, onlyOutstanding: true })) {
    const key = `${row.customerId}|${row.partyCurrency.toUpperCase()}`;
    arDocs.set(key, (arDocs.get(key) ?? new Decimal(0)).plus(inPartyCurrency(row)));
  }
  for (const [key, amount] of unappliedByParty) {
    const [type, partyId, currency] = key.split('|');
    if (type !== 'CUSTOMER') continue;
    const at = `${partyId}|${currency}`;
    arDocs.set(at, (arDocs.get(at) ?? new Decimal(0)).minus(amount));
  }
  const arKeys = new Set([...arNative.map((r) => `${r.partyId}|${r.currency}`), ...arDocs.keys()]);
  let arNativeFaults = 0;
  for (const key of arKeys) {
    const [partyId, currency] = key.split('|');
    const ledger = dec(arNative.find((r) => r.partyId === partyId && r.currency === currency)?.net ?? 0);
    const docs = arDocs.get(key) ?? new Decimal(0);
    if (ledger.minus(docs).abs().greaterThan(TOLERANCE)) arNativeFaults += 1;
  }
  checks.push({
    id: 'receivables-native',
    group: 'Sub-ledgers',
    label: 'Each customer agrees with the ledger in their own currency',
    explanation:
      'For every customer and currency, the open invoices must equal the receivable ledger with nothing converted. A difference here is invisible to the USD check when it nets to zero across accounts.',
    left: { label: 'Customer/currency pairs out of step', value: String(arNativeFaults) },
    right: { label: 'Expected', value: '0' },
    differenceUsd: String(arNativeFaults),
    passed: arNativeFaults === 0,
  });

  const apNative = await prisma.$queryRaw<Array<{ partyId: string; currency: string; net: string }>>`
    SELECT jl."vendorId" AS "partyId", jl."currency", SUM(jl."credit" - jl."debit")::text AS net
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId"
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
      AND a."systemKey" = 'ACCOUNTS_PAYABLE' AND jl."vendorId" IS NOT NULL
    GROUP BY jl."vendorId", jl."currency"`;
  const apDocs = new Map<string, Decimal>();
  for (const row of await getPayables({ companyId, onlyOutstanding: true })) {
    const key = `${row.vendorId}|${row.partyCurrency.toUpperCase()}`;
    apDocs.set(key, (apDocs.get(key) ?? new Decimal(0)).plus(inPartyCurrency(row)));
  }
  for (const [key, amount] of unappliedByParty) {
    const [type, partyId, currency] = key.split('|');
    if (type !== 'VENDOR') continue;
    const at = `${partyId}|${currency}`;
    apDocs.set(at, (apDocs.get(at) ?? new Decimal(0)).minus(amount));
  }
  const apKeys = new Set([...apNative.map((r) => `${r.partyId}|${r.currency}`), ...apDocs.keys()]);
  let apNativeFaults = 0;
  for (const key of apKeys) {
    const [partyId, currency] = key.split('|');
    const ledger = dec(apNative.find((r) => r.partyId === partyId && r.currency === currency)?.net ?? 0);
    const docs = apDocs.get(key) ?? new Decimal(0);
    if (ledger.minus(docs).abs().greaterThan(TOLERANCE)) apNativeFaults += 1;
  }
  checks.push({
    id: 'payables-native',
    group: 'Sub-ledgers',
    label: 'Each supplier agrees with the ledger in their own currency',
    explanation:
      'For every supplier and currency, the open contracts and bills must equal the payable ledger with nothing converted.',
    left: { label: 'Supplier/currency pairs out of step', value: String(apNativeFaults) },
    right: { label: 'Expected', value: '0' },
    differenceUsd: String(apNativeFaults),
    passed: apNativeFaults === 0,
  });

  // --- Cash and bank -----------------------------------------------------
  // Invariants D and E: the cash book and the bank book must equal their
  // general-ledger heads, drawer by drawer, in the drawer's own currency.
  //
  // Both are read from the same journal lines, so they can only disagree
  // when a line reaches the GL head without naming the drawer (a manual
  // journal posted straight to 1001, say) or names the drawer on some other
  // account, or carries a currency the drawer cannot hold. Each of those is
  // a mapping fault that makes one screen show a number another screen
  // cannot, so each is checked on its own, and the balances are compared in
  // the drawer's currency — USD and MAD are never added together.
  const drawers = await prisma.cashBankAccount.findMany({
    where: { companyId, status: 'ACTIVE' },
    select: { id: true, code: true, name: true, currency: true, openingBalance: true, glAccountId: true },
    orderBy: { code: 'asc' },
  });

  for (const drawer of drawers) {
    const [book] = await prisma.$queryRaw<Array<{ net: string }>>`
      SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS net
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
        AND jl."cashBankAccountId" = ${drawer.id} AND jl."currency" = ${drawer.currency}`;
    const [head] = await prisma.$queryRaw<Array<{ net: string }>>`
      SELECT COALESCE(SUM(jl."debit" - jl."credit"), 0)::text AS net
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId"
      WHERE je."companyId" = ${companyId} AND je."status" = 'POSTED'
        AND jl."accountId" = ${drawer.glAccountId} AND jl."currency" = ${drawer.currency}`;
    const bookBalance = toMoney(dec(drawer.openingBalance).plus(book?.net ?? 0));
    const headBalance = toMoney(dec(drawer.openingBalance).plus(head?.net ?? 0));
    checks.push(
      build(
        `cash-book-${drawer.code}`,
        'Cash & bank',
        `${drawer.name} (${drawer.currency}) book agrees with its ledger account`,
        `Opening balance plus every movement recorded through ${drawer.name} must equal the balance of its general-ledger account, in ${drawer.currency}.`,
        `${drawer.currency} cash/bank book`,
        bookBalance,
        `${drawer.currency} ledger account`,
        headBalance,
      ),
    );
  }

  const [mapping] = await prisma.$queryRaw<Array<{ undimensioned: string; misfiled: string; foreign: string }>>`
    SELECT
      (SELECT count(*) FROM journal_lines jl
         JOIN journal_entries je ON je."id" = jl."journalEntryId"
         JOIN cash_bank_accounts cba ON cba."glAccountId" = jl."accountId"
        WHERE je."companyId" = ${companyId} AND jl."cashBankAccountId" IS NULL
          AND (jl."debitUsd" <> 0 OR jl."creditUsd" <> 0))::text AS undimensioned,
      (SELECT count(*) FROM journal_lines jl
         JOIN journal_entries je ON je."id" = jl."journalEntryId"
         JOIN cash_bank_accounts cba ON cba."id" = jl."cashBankAccountId"
        WHERE je."companyId" = ${companyId} AND jl."accountId" <> cba."glAccountId")::text AS misfiled,
      (SELECT count(*) FROM journal_lines jl
         JOIN journal_entries je ON je."id" = jl."journalEntryId"
         JOIN cash_bank_accounts cba ON cba."id" = jl."cashBankAccountId"
        WHERE je."companyId" = ${companyId} AND jl."currency" <> cba."currency"
          AND (jl."debitUsd" <> 0 OR jl."creditUsd" <> 0))::text AS foreign`;
  const mappingFaults = Number(mapping?.undimensioned ?? 0) + Number(mapping?.misfiled ?? 0) + Number(mapping?.foreign ?? 0);
  checks.push({
    id: 'cash-mapping',
    group: 'Cash & bank',
    label: 'Every cash and bank line names its drawer, on its own account, in its own currency',
    explanation:
      `A line on a cash or bank ledger account that does not name the drawer is invisible to the cash book; one that names a drawer but sits on another account is invisible to the ledger; one in a currency the drawer cannot hold is a posting fault. ${mapping?.undimensioned ?? 0} without a drawer, ${mapping?.misfiled ?? 0} on the wrong account, ${mapping?.foreign ?? 0} in a foreign currency.`,
    left: { label: 'Faulty lines', value: String(mappingFaults) },
    right: { label: 'Expected', value: '0' },
    differenceUsd: String(mappingFaults),
    passed: mappingFaults === 0,
  });

  // --- Inventory ----------------------------------------------------------
  // Reservations are excluded, exactly as computeWarehouseBalance excludes
  // them. A reservation ring-fences stock for a draft invoice; it does not move
  // a kilogram, and counting it here made the check fail the moment anyone left
  // a sales invoice unposted — which is to say, constantly.
  const movementRows = await prisma.$queryRaw<Array<{ batchId: string; warehouseId: string; kg: string }>>`
    SELECT "batchId", "warehouseId", SUM("quantityKg")::text AS kg
    FROM inventory_transactions
    WHERE "companyId" = ${companyId}
      AND "warehouseId" IS NOT NULL
      AND "transactionType" NOT IN ('RESERVATION', 'RESERVATION_RELEASE')
    GROUP BY "batchId", "warehouseId"`;
  const balances = await prisma.inventoryBalance.findMany({ where: { companyId } });

  let ledgerDrift = 0;
  for (const row of movementRows) {
    const balance = balances.find((b) => b.batchId === row.batchId && b.warehouseId === row.warehouseId);
    if (dec(row.kg).minus(dec(balance?.onHandKg ?? 0)).abs().greaterThan('0.001')) ledgerDrift += 1;
  }
  checks.push({
    id: 'stock-ledger',
    group: 'Inventory',
    label: 'Stock movements equal warehouse balances',
    explanation:
      'Every kilogram in a warehouse must be explained by the movement ledger. Drift means a balance was written without a matching movement.',
    left: { label: 'Batch/warehouse pairs', value: String(movementRows.length) },
    right: { label: 'Mismatched', value: String(ledgerDrift) },
    differenceUsd: String(ledgerDrift),
    passed: ledgerDrift === 0,
  });

  const batches = await prisma.batch.findMany({
    where: { companyId },
    select: { id: true, availableQuantityKg: true, allocatedQuantityKg: true },
  });
  let cacheDrift = 0;
  for (const batch of batches) {
    const total = balances
      .filter((b) => b.batchId === batch.id)
      .reduce((sum, b) => sum.plus(b.onHandKg), new Decimal(0));
    // The warehouse rows hold what is physically on hand; the batch record
    // holds what is *available*, which is on hand less what a draft invoice has
    // reserved. Comparing the two directly reported every reservation as drift.
    const batchOnHand = dec(batch.availableQuantityKg).plus(batch.allocatedQuantityKg);
    if (total.minus(batchOnHand).abs().greaterThan('0.001')) cacheDrift += 1;
  }
  checks.push({
    id: 'batch-cache',
    group: 'Inventory',
    label: 'Warehouse balances roll up to the batch total',
    explanation:
      'A batch spread across warehouses must total what the batch record claims is available, or a transfer has duplicated or lost stock.',
    left: { label: 'Batches', value: String(batches.length) },
    right: { label: 'Mismatched', value: String(cacheDrift) },
    differenceUsd: String(cacheDrift),
    passed: cacheDrift === 0,
  });

  const negative = await prisma.inventoryBalance.count({ where: { companyId, onHandKg: { lt: 0 } } });
  checks.push({
    id: 'negative-stock',
    group: 'Inventory',
    label: 'No warehouse holds negative stock',
    explanation: 'Negative stock means something was sold that had not been received.',
    left: { label: 'Negative balances', value: String(negative) },
    right: { label: 'Expected', value: '0' },
    differenceUsd: String(negative),
    passed: negative === 0,
  });

  const failed = checks.filter((c) => !c.passed).length;
  return { companyId, checks, passed: checks.length - failed, failed, healthy: failed === 0 };
}
