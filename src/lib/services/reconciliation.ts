import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { getTrialBalanceReport, getBalanceSheet, getFinancialPosition, getProfitAndLoss, getSalesRegister, getExpenseSplit } from '@/lib/services/reports';
import { getUnpaidExpenseLedger } from '@/lib/services/unpaid-expenses';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getAgentSummaries } from '@/lib/services/agent-account';
import { getAgentStatement } from '@/lib/services/agent-statement';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';
import { ACCOUNT_KEYS } from '@/lib/constants';
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
  group: 'Accounting' | 'Sub-ledgers' | 'Cash & bank' | 'Inventory' | 'Reports';
  label: string;
  /** What the two figures mean, for someone who has to fix a failure. */
  explanation: string;
  left: { label: string; value: string };
  right: { label: string; value: string };
  differenceUsd: string;
  passed: boolean;
  /** On a failure: the records behind the difference, so it can be traced. */
  detail?: string[];
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

  /*
   * A status that disagrees with the goods.
   *
   * Receiving a container used to leave the shipment's own status alone, so
   * an order could read "0 of 2 arrived" while the coffee was on the shelf
   * and being sold from. The engine now moves the status when the goods are
   * counted in; this is the check that says so, because the client found
   * that fault before the software did.
   */
  const stranded = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(DISTINCT s."id") AS count
    FROM shipments s
    JOIN batches b ON b."shipmentId" = s."id"
    WHERE s."companyId" = ${companyId}
      AND s."status" IN ('CONTRACT_CREATED', 'AWAITING_LOADING', 'LOADED', 'IN_TRANSIT')
      AND b."receivedQuantityKg" > 0`;
  const strandedCount = Number(stranded[0]?.count ?? 0);
  checks.push({
    id: 'shipment-status-matches-goods',
    group: 'Inventory',
    label: 'No shipment is still in transit after its goods were received',
    explanation:
      'Coffee counted into a warehouse means the shipment arrived. A shipment left in transit with received stock is why an order can read "0 of 2 arrived" while the goods are on the shelf.',
    left: { label: 'Shipments in transit holding received stock', value: String(strandedCount) },
    right: { label: 'Expected', value: '0' },
    differenceUsd: String(strandedCount),
    passed: strandedCount === 0,
  });

  checks.push(...(await reportChecks(companyId)));

  const failed = checks.filter((c) => !c.passed).length;
  return { companyId, checks, passed: checks.length - failed, failed, healthy: failed === 0 };
}

/**
 * The same figure on different pages.
 *
 * The client found the dashboard, the detailed reports and the statements
 * giving different answers to the same question. These compare, in the
 * company's own currency and over all dates, each report figure with the
 * ledger it should agree with — sales on the invoices, the register and the
 * Profit and Loss; the dashboard's net profit and the statement's; the
 * expense report and the operating expenses; the shipment costs on the
 * vouchers, the cost sheets and the ledger; unpaid expenses; each agent's
 * statement and his accounts. Figures with different meanings are not
 * compared.
 */
async function reportChecks(companyId: string): Promise<ReconciliationCheck[]> {
  const out: ReconciliationCheck[] = [];
  const allTime = { from: new Date(Date.UTC(1970, 0, 1)), to: new Date(Date.UTC(9999, 11, 31)) };
  const [company, pnl, register, profit, split, unpaid, sheets, agents] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { localCurrency: true } }),
    getProfitAndLoss({ companyId, ...allTime }),
    getSalesRegister({ companyId }),
    getCompanyProfitSummary({ companyId }),
    getExpenseSplit({ companyId }),
    getUnpaidExpenseLedger(companyId),
    getOrderCostSheets(companyId),
    getAgentSummaries(companyId),
  ]);
  const local = company.localCurrency;
  const add = (
    id: string,
    label: string,
    explanation: string,
    leftLabel: string,
    left: Decimal,
    rightLabel: string,
    right: Decimal,
  ) => out.push(build(id, 'Reports', label, explanation, `${leftLabel} (${local})`, left, `${rightLabel} (${local})`, right));

  // Sales: the invoices themselves, less customer credit notes.
  const docs = await prisma.$queryRaw<Array<{ sales: string }>>`
    SELECT (COALESCE((SELECT SUM(CASE WHEN si."currency" = ${local} THEN si."subtotal" ELSE si."subtotalUsd" * si."rateLocalPerUsd" END)
                        FROM sales_invoices si WHERE si."companyId" = ${companyId} AND si."status" = 'POSTED'), 0)
          - COALESCE((SELECT SUM(CASE WHEN cn."currency" = ${local} THEN cn."subtotalAmount" ELSE cn."subtotalAmountUsd" * cn."rateLocalPerUsd" END)
                        FROM credit_notes cn WHERE cn."companyId" = ${companyId} AND cn."status" = 'POSTED' AND cn."type" = 'CUSTOMER'), 0))::text AS sales`;
  const invoiceSales = dec(docs[0]?.sales ?? 0);
  add('sales-invoices-ledger', 'Sales on the invoices agree with the Profit and Loss',
    'Every posted invoice line, less customer credit notes, against the revenue the ledger carries. A payment is never revenue, and an invoice with several lines or receipts counts once.',
    'Posted invoices', invoiceSales, 'Profit and Loss revenue', dec(pnl.totals.revenueLocal));
  // The register lists each invoice in its own currency, so it is compared
  // only where every invoice is in the company's.
  if (register.every((r) => r.currency === local)) {
    add('sales-register-ledger', 'Sales Register agrees with the invoices',
      'The Sales Register lists each posted invoice once; its total must be the invoices’ own.',
      'Sales Register', register.reduce((t, r) => t.plus(r.subtotal), dec(0)), 'Posted invoices', invoiceSales);
  }
  add('dashboard-revenue', 'Dashboard sales agree with the Profit and Loss',
    'The dashboard’s sales figure against the statement’s revenue for the same dates.',
    'Dashboard', dec(profit.revenueLocal), 'Profit and Loss', dec(pnl.totals.revenueLocal));
  add('dashboard-net-profit', 'Dashboard net profit agrees with the Profit and Loss',
    'The dashboard’s Net Profit tile against the statement’s net profit for the same dates.',
    'Dashboard', dec(profit.netProfitLocal), 'Profit and Loss', dec(pnl.totals.netProfitLocal));
  // The Expense Report's costs charged to the period — general and
  // period vouchers and journal-entry costs — against what the ledger's
  // expense accounts were charged by the same documents: every expense line
  // except exchange differences and the costs that went into the coffee.
  const ledgerPeriod = await prisma.$queryRaw<Array<{ v: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS v
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND a."type" = 'EXPENSE'
      AND a."reportGroup" IS DISTINCT FROM 'OTHER_EXPENSE'
      AND (CASE WHEN je."sourceType"::text = 'EXPENSE'
                THEN a."systemKey" IS DISTINCT FROM ${ACCOUNT_KEYS.COST_OF_GOODS_SOLD}
                ELSE a."reportGroup" IS DISTINCT FROM 'COGS' END)`;
  add('expense-report-ledger', 'Expense Report agrees with the ledger',
    'The costs the Expense Report says are charged to the period — general and period vouchers and costs entered as journal entries — against what those entries charged to the expense accounts.',
    'Expense Report', dec(split.periodChargeLocal), 'Ledger expense accounts', dec(ledgerPeriod[0]?.v ?? 0));

  // Direct shipment costs: on the vouchers, on the cost sheets, in the ledger.
  const ledgerCap = await prisma.$queryRaw<Array<{ v: string }>>`
    SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS v
    FROM journal_lines jl
    JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
    JOIN accounts a ON a."id" = jl."accountId"
    WHERE je."companyId" = ${companyId} AND je."sourceType" = 'EXPENSE'
      AND a."systemKey" IN (${ACCOUNT_KEYS.INVENTORY}, ${ACCOUNT_KEYS.INVENTORY_IN_TRANSIT}, ${ACCOUNT_KEYS.COST_OF_GOODS_SOLD})`;
  const sheetCap = sheets.reduce((t, sh) => t.plus(sh.capitalisedExpenseLocal), dec(0));
  add('shipment-costs-sheets', 'Shipment cost sheets agree with the expense vouchers',
    'Direct shipment costs added to the coffee, on the Shipment Costing report, against the vouchers themselves. Each voucher counts once, however many containers share it.',
    'Shipment Costing', sheetCap, 'Expense vouchers', dec(split.capitalisedLocal));
  add('shipment-costs-ledger', 'Shipment costs on the vouchers agree with the ledger',
    'The same vouchers against what they wrote into stock, coffee on the way and cost of sales.',
    'Expense vouchers', dec(split.capitalisedLocal), 'Ledger', dec(ledgerCap[0]?.v ?? 0));

  // Unpaid expenses: the schedule against its control account.
  // Agent commission is left to the agent checks: a journal entry can
  // rightly credit it without a commission document behind it.
  for (const r of unpaid.reconciliation) {
    if (r.ledgerLocal === null || r.party !== 'GENERAL') continue;
    add(`unpaid-${r.party.toLowerCase()}`, `${r.control}: the open list agrees with the ledger`,
      'Each cost still owed, line by line, against the control account it sits in.',
      'Open list', dec(r.scheduleLocal), 'Ledger', dec(r.ledgerLocal));
  }

  // Each agent: his statement's closing position against his lines in the
  // ledger, read directly — the company's own cash side is not his balance,
  // and a sale to him as a customer is.
  for (const a of agents) {
    const statement = await getAgentStatement({ companyId, agentId: a.agentId });
    const closing = statement.events.length ? statement.events[statement.events.length - 1].runningNetLocal : dec(0);
    const lines = await prisma.$queryRaw<Array<{ v: string }>>`
      SELECT COALESCE(SUM(jl."debitLocal" - jl."creditLocal"), 0)::text AS v
      FROM journal_lines jl
      JOIN journal_entries je ON je."id" = jl."journalEntryId" AND ${LIVE_ENTRY_SQL}
      JOIN accounts acc ON acc."id" = jl."accountId"
      WHERE je."companyId" = ${companyId} AND jl."cashBankAccountId" IS NULL
        AND (jl."agentId" = ${a.agentId}
             OR (acc."systemKey" = 'ACCOUNTS_RECEIVABLE'
                 AND jl."customerId" IN (SELECT cu."id" FROM customers cu WHERE cu."agentId" = ${a.agentId})))`;
    add(`agent-${a.agentId}`, `${a.agentName}: the agent statement agrees with the ledger`,
      'The closing position on the agent’s statement against every journal line on his balances.',
      'Agent statement', closing, 'Ledger', dec(lines[0]?.v ?? 0));
  }
  return out;
}
