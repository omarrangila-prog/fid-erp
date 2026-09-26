import 'dotenv/config';
import { prisma } from '@/lib/db';
import { dec, toMoney, toQuantity } from '@/lib/money';
import { getOrderCostSheets } from '@/lib/services/order-cost';
import { getShipmentProfitability } from '@/lib/services/profitability';
import { getBatchStock } from '@/lib/services/stock';
import { ACCOUNT_KEYS } from '@/lib/constants';
import { LIVE_ENTRY_SQL } from '@/lib/services/journal-visibility';

/**
 * The eleven questions the client must be able to answer about one shipment,
 * answered from the records rather than from a screen:
 *
 *   what the coffee cost · what was spent on it · how much of that is paid
 *   and how much is still owed · the landed cost · the cost per kilo · what
 *   was sold · what the sold coffee cost · the profit · what is left · what
 *   the remainder is worth.
 *
 * Each figure is read back from the rows and compared with what the screens
 * report, because a check that borrows its subject's arithmetic proves
 * nothing. Nothing here writes.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/audit-shipment-economics.ts
 */

type Finding = { severity: '🐛' | '🟠' | '🟡'; where: string; what: string };
const findings: Finding[] = [];
const report = (severity: Finding['severity'], where: string, what: string) => {
  findings.push({ severity, where, what });
  console.log(`      ${severity} ${what}`);
};

const money = (d: unknown) => dec(d as never).toFixed(2);
const kg = (d: unknown) => dec(d as never).toFixed(3);

async function auditCompany(code: string) {
  const company = await prisma.company.findUnique({
    where: { code },
    select: { id: true, name: true, localCurrency: true },
  });
  if (!company) return;
  const companyId = company.id;
  console.log(`\n${company.name} (books in ${company.localCurrency})`);

  const [sheets, profits, stock] = await Promise.all([
    getOrderCostSheets(companyId),
    getShipmentProfitability({ companyId }),
    getBatchStock({ companyId, includeEmpty: true }),
  ]);
  const profitByShipment = new Map(profits.map((p) => [p.shipmentId, p]));
  console.log(`  ${sheets.length} order(s) on the costing report, ${profits.length} shipment record(s) with a P&L`);

  for (const sheet of sheets) {
    const batches = await prisma.batch.findMany({
      where: { companyId, purchaseContractId: sheet.contractId, status: 'ACTIVE' },
      select: {
        id: true, batchNumber: true, orderedQuantityKg: true, receivedQuantityKg: true,
        soldQuantityKg: true, availableQuantityKg: true, allocatedQuantityKg: true,
        purchaseCostUsd: true, capitalisedCostUsd: true, landedUnitCostUsd: true, unitCostUsd: true,
      },
    });

    const goodsUsd = toMoney(batches.reduce((t, b) => t.plus(dec(b.purchaseCostUsd)), dec(0)));
    const carriedExpenseUsd = toMoney(batches.reduce((t, b) => t.plus(dec(b.capitalisedCostUsd)), dec(0)));
    const receivedKg = toQuantity(batches.reduce((t, b) => t.plus(dec(b.receivedQuantityKg)), dec(0)));
    const soldKg = toQuantity(batches.reduce((t, b) => t.plus(dec(b.soldQuantityKg)), dec(0)));
    const onHandKg = toQuantity(
      batches.reduce((t, b) => t.plus(dec(b.availableQuantityKg)).plus(dec(b.allocatedQuantityKg)), dec(0)),
    );

    // Paid and unpaid, from the expense rows: a cost incurred counts whether
    // or not the money has left yet.
    const expenses = await prisma.expense.findMany({
      where: { companyId, status: 'POSTED', shipmentId: { in: sheet.shipmentIds } },
      select: {
        expenseNumber: true, currency: true, amount: true, amountUsd: true, amountLocal: true,
        capitaliseToLandedCost: true, cashBankAccountId: true, kind: true,
        allocations: { select: { amountUsd: true, payment: { select: { status: true } } } },
      },
    });
    let paidUsd = dec(0);
    let unpaidUsd = dec(0);
    for (const e of expenses) {
      const gross = dec(e.amountUsd);
      if (e.cashBankAccountId) { paidUsd = paidUsd.plus(gross); continue; }
      const settled = e.allocations
        .filter((a) => a.payment.status === 'POSTED')
        .reduce((t, a) => t.plus(dec(a.amountUsd)), dec(0));
      paidUsd = paidUsd.plus(settled);
      unpaidUsd = unpaidUsd.plus(gross.minus(settled));
    }
    const capitalisedRaisedUsd = toMoney(
      expenses.filter((e) => e.capitaliseToLandedCost).reduce((t, e) => t.plus(dec(e.amountUsd)), dec(0)),
    );
    const notCapitalisedUsd = toMoney(
      expenses.filter((e) => !e.capitaliseToLandedCost).reduce((t, e) => t.plus(dec(e.amountUsd)), dec(0)),
    );

    console.log(`\n  ${sheet.contractReference} — ${sheet.vendorName}`);
    console.log(`    coffee ${money(goodsUsd)} · spent ${money(sheet.expenseUsd)} (paid ${money(paidUsd)}, still owed ${money(unpaidUsd)})`);
    console.log(`    of that spend, ${money(capitalisedRaisedUsd)} added to the coffee's cost and ${money(notCapitalisedUsd)} not`);
    console.log(`    report landed ${money(sheet.landedUsd)} · batches carry ${money(goodsUsd.plus(carriedExpenseUsd))}`);
    console.log(`    ${kg(receivedKg)} KG in · ${kg(soldKg)} sold · report says ${kg(sheet.remainingKg)} left, stock says ${kg(onHandKg)}`);
    console.log(`    sold for ${money(sheet.revenueUsd)} · cost of it ${money(sheet.cogsUsd)} · profit ${money(sheet.grossProfitUsd)}`);

    // 1. Whatever was capitalised must equal what was raised — not a multiple
    //    of it (allocated to every batch in full) and not a fraction.
    if (capitalisedRaisedUsd.minus(carriedExpenseUsd).abs().greaterThan('1')) {
      report('🐛', sheet.contractReference,
        `the coffee carries ${money(carriedExpenseUsd)} of expenses but ${money(capitalisedRaisedUsd)} was raised against it` +
        (carriedExpenseUsd.greaterThan(capitalisedRaisedUsd.times('1.5')) ? ' — counted more than once' : ''));
    }

    // 2. The landed cost the report prints vs the one the coffee is valued at.
    const carriedLanded = toMoney(goodsUsd.plus(carriedExpenseUsd));
    if (dec(sheet.landedUsd).minus(carriedLanded).abs().greaterThan('1')) {
      report('🐛', sheet.contractReference,
        `"Total landed cost" reads ${money(sheet.landedUsd)} on the cost report but the coffee is valued at ${money(carriedLanded)}; ` +
        `the report adds ${money(notCapitalisedUsd)} of costs the client said not to add to stock, so "Cost per KG" is overstated`);
    }

    // 3. Cost per KG: the report divides by received; COGS uses the batch's
    //    own landed unit cost. They must agree or two screens price the same
    //    coffee differently.
    for (const b of batches) {
      if (dec(b.receivedQuantityKg).lessThanOrEqualTo(0)) continue;
      const fromRows = toMoney(dec(b.purchaseCostUsd).plus(dec(b.capitalisedCostUsd))).dividedBy(dec(b.receivedQuantityKg));
      if (dec(b.landedUnitCostUsd).minus(fromRows).abs().greaterThan('0.005')) {
        report('🐛', sheet.contractReference,
          `${b.batchNumber}: the stored cost per KG is ${dec(b.landedUnitCostUsd).toFixed(4)} but its own cost and quantity give ${fromRows.toFixed(4)} — COGS is drawn from the stored one`);
      }
    }

    // 4. Unpaid costs must still reach the coffee, or a shipment looks cheap
    //    until the bill is settled.
    if (unpaidUsd.greaterThan('1') && carriedExpenseUsd.lessThan(capitalisedRaisedUsd.minus('1'))) {
      report('🐛', sheet.contractReference, `${money(unpaidUsd)} is owed and has not reached the landed cost`);
    }

    // 5. Nothing sold that was not received, and what is left agrees with stock.
    if (soldKg.greaterThan(receivedKg.plus('0.001'))) {
      report('🐛', sheet.contractReference, `${kg(soldKg)} KG sold against ${kg(receivedKg)} KG received`);
    }
    if (dec(sheet.remainingKg).minus(onHandKg).abs().greaterThan('0.001')) {
      report('🟠', sheet.contractReference,
        `the cost report says ${kg(sheet.remainingKg)} KG left (received less sold) while the stock records hold ${kg(onHandKg)} KG`);
    }

    // 6. Profit is earned on what was sold, not on the whole shipment.
    if (soldKg.greaterThan(0) && receivedKg.greaterThan(0)) {
      const share = soldKg.dividedBy(receivedKg);
      const expected = toMoney(carriedLanded.times(share));
      const tolerance = expected.times('0.02').plus('1');
      if (dec(sheet.cogsUsd).minus(expected).abs().greaterThan(tolerance)) {
        report('🟡', sheet.contractReference,
          `the cost of what sold reads ${money(sheet.cogsUsd)}; ${kg(soldKg)} of ${kg(receivedKg)} KG at landed cost is ${money(expected)}`);
      }
    }
    if (dec(sheet.cogsUsd).greaterThan(carriedLanded.plus('1'))) {
      report('🐛', sheet.contractReference, `the cost of what sold (${money(sheet.cogsUsd)}) exceeds the whole shipment's cost (${money(carriedLanded)})`);
    }

    // 7. The costing report and the shipment P&L must tell one story (§21).
    const mine = sheet.shipmentIds.map((id) => profitByShipment.get(id)).filter(Boolean);
    if (mine.length > 0) {
      const pnlRevenue = toMoney(mine.reduce((t, p) => t.plus(dec(p!.salesRevenueUsd)), dec(0)));
      const pnlCogs = toMoney(mine.reduce((t, p) => t.plus(dec(p!.allocatedLandedCostUsd)), dec(0)));
      const pnlLanded = toMoney(mine.reduce((t, p) => t.plus(dec(p!.totalLandedCostUsd)), dec(0)));
      if (pnlRevenue.minus(dec(sheet.revenueUsd)).abs().greaterThan('1')) {
        report('🐛', sheet.contractReference, `sales read ${money(sheet.revenueUsd)} on the cost report and ${money(pnlRevenue)} on the shipment P&L`);
      }
      if (pnlCogs.minus(dec(sheet.cogsUsd)).abs().greaterThan('1')) {
        report('🟠', sheet.contractReference, `the cost of what sold reads ${money(sheet.cogsUsd)} on the cost report and ${money(pnlCogs)} on the shipment P&L`);
      }
      if (pnlLanded.minus(dec(sheet.landedUsd)).abs().greaterThan('1')) {
        report('🟠', sheet.contractReference, `landed cost reads ${money(sheet.landedUsd)} on the cost report and ${money(pnlLanded)} on the shipment P&L`);
      }
    }

    // 8. A local-currency bill must never be shown as dollars (§10).
    for (const e of expenses) {
      if (e.currency === 'USD') continue;
      if (dec(e.amountUsd).minus(dec(e.amount)).abs().lessThan('0.01') && dec(e.amount).greaterThan('1')) {
        report('🐛', sheet.contractReference,
          `${e.expenseNumber}: ${e.currency} ${money(e.amount)} was converted to USD ${money(e.amountUsd)} — the same number in both currencies`);
      }
    }

    // 9. What the Stock screen says this coffee is worth, against the books.
    const rows = stock.filter((r) => r.contractId === sheet.contractId);
    const stockScreenUsd = toMoney(rows.reduce((t, r) => t.plus(dec(r.stockValueUsd)), dec(0)));
    const atLandedUsd = toMoney(
      batches.reduce((t, b) => t.plus(dec(b.availableQuantityKg).times(dec(b.landedUnitCostUsd))), dec(0)),
    );
    if (stockScreenUsd.minus(atLandedUsd).abs().greaterThan('1')) {
      report('🐛', sheet.contractReference,
        `the Stock screen values what is left at ${money(stockScreenUsd)}; at landed cost it is ${money(atLandedUsd)} — the screen leaves the shipment's expenses out`);
    }
  }

  // Shipment costs that no costing screen can reach.
  const orphans = await prisma.expense.findMany({
    where: { companyId, status: 'POSTED', kind: 'SHIPMENT', shipmentId: null },
    select: { expenseNumber: true, amountUsd: true, purchaseContractId: true, description: true },
  });
  if (orphans.length > 0) {
    console.log('');
    for (const o of orphans) {
      report('🐛', 'shipment costs', `${o.expenseNumber} (${money(o.amountUsd)} USD) is a shipment cost with no shipment, so no costing sheet counts it`);
    }
  }

  // The inventory account against what the coffee on hand is worth.
  const account = await prisma.account.findFirst({
    where: { companyId, systemKey: ACCOUNT_KEYS.INVENTORY },
    select: { id: true, name: true },
  });
  if (account) {
    const [ledger] = await prisma.$queryRaw<Array<{ balance: string }>>`
      SELECT COALESCE(SUM(jl."debitUsd" - jl."creditUsd"), 0)::text AS balance
        FROM journal_lines jl JOIN journal_entries je ON je."id" = jl."journalEntryId"
       WHERE je."companyId" = ${companyId} AND jl."accountId" = ${account.id}
         AND ${LIVE_ENTRY_SQL}`;
    const [held] = await prisma.$queryRaw<Array<{ value: string }>>`
      SELECT COALESCE(SUM((b."availableQuantityKg" + b."allocatedQuantityKg") * b."landedUnitCostUsd"), 0)::text AS value
        FROM batches b WHERE b."companyId" = ${companyId} AND b."status" = 'ACTIVE'`;
    const gap = toMoney(dec(ledger.balance).minus(dec(held.value)));
    console.log(`\n  ${account.name}: books ${money(ledger.balance)} USD · coffee on hand at landed cost ${money(held.value)} USD`);
    if (gap.abs().greaterThan('1')) {
      report('🟠', 'inventory', `the inventory account and the coffee on hand differ by ${money(gap)} USD, and no reconciliation check looks at this`);
    }
  }
}

async function main() {
  console.log('Shipment costs, costing and profit, read against the records. Nothing is written.');
  for (const code of ['FID-MA', 'FID-DXB']) await auditCompany(code);

  console.log(`\n${findings.length === 0 ? 'Every shipment reconciles to its records.' : `${findings.length} finding(s):`}`);
  for (const f of findings) console.log(`  ${f.severity} ${f.where}: ${f.what}`);
}

main().finally(() => prisma.$disconnect());
