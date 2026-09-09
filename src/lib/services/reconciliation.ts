import { prisma } from '@/lib/db';
import { Decimal, dec, toMoney } from '@/lib/money';
import { getTrialBalanceReport, getBalanceSheet, getFinancialPosition } from '@/lib/services/reports';
import { getCompanyProfitSummary } from '@/lib/services/profitability';
import { getReceivables, getPayables } from '@/lib/services/receivables';

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
  group: 'Accounting' | 'Sub-ledgers' | 'Inventory';
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
  const arControl = await controlAccountBalance(companyId, 'ACCOUNTS_RECEIVABLE', 'debit');
  const arSub = (await getReceivables({ companyId, onlyOutstanding: true })).reduce(
    (total, row) => total.plus(row.outstandingAmountUsd),
    new Decimal(0),
  );
  checks.push(
    build(
      'receivables',
      'Sub-ledgers',
      'Receivables agree with the ledger',
      'The sum of what customers owe must equal the Accounts Receivable control account.',
      'AR control account',
      arControl,
      'Customer outstanding',
      arSub,
    ),
  );

  const apControl = await controlAccountBalance(companyId, 'ACCOUNTS_PAYABLE', 'credit');
  const apSub = (await getPayables({ companyId, onlyOutstanding: true })).reduce(
    (total, row) => total.plus(row.outstandingAmountUsd),
    new Decimal(0),
  );
  checks.push(
    build(
      'payables',
      'Sub-ledgers',
      'Payables agree with the ledger',
      'The sum of what we owe suppliers must equal the Accounts Payable control account.',
      'AP control account',
      apControl,
      'Supplier outstanding',
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

  // --- Inventory ----------------------------------------------------------
  const movementRows = await prisma.$queryRaw<Array<{ batchId: string; warehouseId: string; kg: string }>>`
    SELECT "batchId", "warehouseId", SUM("quantityKg")::text AS kg
    FROM inventory_transactions
    WHERE "companyId" = ${companyId} AND "warehouseId" IS NOT NULL
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

  const batches = await prisma.batch.findMany({ where: { companyId }, select: { id: true, availableQuantityKg: true } });
  let cacheDrift = 0;
  for (const batch of batches) {
    const total = balances
      .filter((b) => b.batchId === batch.id)
      .reduce((sum, b) => sum.plus(b.onHandKg), new Decimal(0));
    if (total.minus(batch.availableQuantityKg).abs().greaterThan('0.001')) cacheDrift += 1;
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
