import { prisma, transaction, type Tx } from '@/lib/db';
import { BusinessRuleError } from '@/lib/errors';
import { dec } from '@/lib/money';
import { makeTerms } from '@/lib/terminology';
import { BASE_UOMS } from '@/lib/uom';
import { getRate } from '@/lib/services/exchange-rate';
import { writeAudit } from '@/lib/services/audit';
import { createLedgerAccount, postAccountOpeningBalance, postOpeningBalance } from '@/lib/services/chart-of-accounts';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import type { ImportKind, ParsedRow } from '@/lib/import/templates';

/**
 * Bringing a customer's existing data in from a spreadsheet.
 *
 * Every row goes through the same services a person would use by hand — so an
 * opening balance posts a real journal, opening stock becomes a real receipt
 * with a real cost, and a duplicate is refused for the same reason it would be
 * on a form.
 *
 * `dryRun` runs the whole import and then rolls it back. Because the services
 * join the transaction already open, the preview a person sees is not a guess
 * at what would happen — it is what happened, undone.
 */

export type ImportOutcome = {
  kind: ImportKind;
  dryRun: boolean;
  created: number;
  skipped: Array<{ line: number; reason: string }>;
  failed: Array<{ line: number; reason: string }>;
};

class Rollback extends Error {
  constructor(readonly outcome: ImportOutcome) {
    super('dry run');
  }
}

type Ctx = { companyId: string; userId: string; localCurrency: string; unit: string };

const lower = (v: unknown) => String(v ?? '').trim().toLowerCase();
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));

async function nextCode(tx: Tx, prefix: string, existing: Set<string>, counter: { n: number }): Promise<string> {
  for (;;) {
    counter.n += 1;
    const code = `${prefix}-${String(counter.n).padStart(4, '0')}`;
    if (!existing.has(code)) {
      existing.add(code);
      return code;
    }
  }
}

async function ratesFor(ctx: Ctx, currency: string, asOf: Date): Promise<{ toUsd: string; localPerUsd: string }> {
  const code = currency.toUpperCase();
  const local = ctx.localCurrency.toUpperCase();
  const toUsd = code === 'USD' ? dec(1) : await getRate({ companyId: ctx.companyId, quoteCurrency: code, asOf });
  const localPerUsd = local === 'USD' ? dec(1) : await getRate({ companyId: ctx.companyId, quoteCurrency: local, asOf });
  if (!toUsd) throw new BusinessRuleError(`No exchange rate for ${code} on file. Add it under Settings → Exchange rates first.`);
  if (!localPerUsd) throw new BusinessRuleError(`No exchange rate for ${local} (the company currency) on file. Add it under Settings → Exchange rates first.`);
  return { toUsd: toUsd.toString(), localPerUsd: localPerUsd.toString() };
}

const day = (iso: unknown): Date => new Date(`${String(iso)}T00:00:00.000Z`);

// ---------------------------------------------------------------------------

async function importItems(tx: Tx, ctx: Ctx, rows: ParsedRow[], out: ImportOutcome) {
  const existing = await tx.coffeeItem.findMany({ where: { companyId: ctx.companyId }, select: { itemName: true, itemCode: true } });
  const names = new Set(existing.map((i) => lower(i.itemName)));
  const codes = new Set(existing.map((i) => i.itemCode));
  const counter = { n: existing.length };
  for (const row of rows) {
    const v = row.values;
    const name = String(v.itemName);
    if (names.has(lower(name))) {
      out.skipped.push({ line: row.line, reason: `"${name}" already exists` });
      continue;
    }
    const sku = str(v.sku);
    if (sku && codes.has(sku)) {
      out.skipped.push({ line: row.line, reason: `SKU ${sku} is already used` });
      continue;
    }
    const baseUom = str(v.baseUom) ?? ((BASE_UOMS as readonly string[]).includes(ctx.unit) ? ctx.unit : 'PCS');
    const itemCode = sku ?? (await nextCode(tx, 'ITM', codes, counter));
    codes.add(itemCode);
    names.add(lower(name));
    await tx.coffeeItem.create({
      data: {
        companyId: ctx.companyId,
        itemCode,
        itemName: name,
        baseUom,
        defaultUnit: baseUom as never,
        packUom: str(v.packUom) ?? (baseUom === 'KG' ? 'BAG' : 'CTN'),
        bagWeightKg: v.packSize ? String(v.packSize) : '1',
        category: str(v.category),
        brand: str(v.brand),
        hsCode: str(v.hsCode),
        taxCategory: str(v.taxCategory),
        originCountry: str(v.originCountry),
        description: str(v.description),
      },
    });
    out.created += 1;
  }
}

async function importParties(tx: Tx, ctx: Ctx, rows: ParsedRow[], out: ImportOutcome, kind: 'CUSTOMER' | 'VENDOR') {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const isCustomer = kind === 'CUSTOMER';
  const model = (isCustomer ? tx.customer : tx.vendor) as unknown as {
    findMany: (a: unknown) => Promise<Array<Record<string, string>>>;
    create: (a: unknown) => Promise<{ id: string }>;
  };
  const nameKey = isCustomer ? 'customerName' : 'vendorName';
  const codeKey = isCustomer ? 'customerCode' : 'vendorCode';
  const existing = await model.findMany({ where: { companyId: ctx.companyId }, select: { [nameKey]: true, [codeKey]: true } });
  const names = new Set(existing.map((p) => lower(p[nameKey])));
  const codes = new Set(existing.map((p) => p[codeKey]));
  const counter = { n: existing.length };
  for (const row of rows) {
    const v = row.values;
    const name = String(v.name);
    if (names.has(lower(name))) {
      out.skipped.push({ line: row.line, reason: `"${name}" already exists` });
      continue;
    }
    const code = str(v.code);
    if (code && codes.has(code)) {
      out.skipped.push({ line: row.line, reason: `Code ${code} is already used` });
      continue;
    }
    const finalCode = code ?? (await nextCode(tx, isCustomer ? 'CUS' : 'SUP', codes, counter));
    codes.add(finalCode);
    names.add(lower(name));
    const currency = String(v.currency);
    const created = await model.create({
      data: {
        companyId: ctx.companyId,
        [codeKey]: finalCode,
        [nameKey]: name,
        country: str(v.country),
        contactPerson: str(v.contactPerson),
        phone: str(v.phone),
        email: str(v.email),
        address: str(v.address),
        primaryCurrency: currency,
        ...(isCustomer ? { paymentTermDays: Number(v.paymentTermDays ?? 0), ...(v.creditLimit ? { creditLimit: String(v.creditLimit) } : {}) } : {}),
      },
    });
    const opening = v.openingBalance ? dec(String(v.openingBalance)) : dec(0);
    if (opening.greaterThan(0)) {
      const asOf = v.openingDate ? day(v.openingDate) : today;
      const rates = await ratesFor(ctx, currency, asOf);
      await postOpeningBalance(tx, {
        companyId: ctx.companyId,
        party: { type: kind, id: created.id, name },
        currency,
        amount: opening.toString(),
        rateToUsd: rates.toUsd,
        rateLocalPerUsd: rates.localPerUsd,
        asOf,
        userId: ctx.userId,
      });
    }
    out.created += 1;
  }
}

async function importChart(tx: Tx, ctx: Ctx, rows: ParsedRow[], out: ImportOutcome) {
  const existing = await tx.account.findMany({ where: { companyId: ctx.companyId }, select: { name: true, code: true } });
  const names = new Set(existing.map((a) => lower(a.name)));
  const codes = new Set(existing.map((a) => a.code));
  for (const row of rows) {
    const v = row.values;
    const name = String(v.name);
    if (names.has(lower(name))) {
      out.skipped.push({ line: row.line, reason: `"${name}" already exists` });
      continue;
    }
    const code = str(v.code);
    if (code && codes.has(code)) {
      out.skipped.push({ line: row.line, reason: `Account code ${code} is already used` });
      continue;
    }
    const account = await createLedgerAccount({
      companyId: ctx.companyId,
      code,
      name,
      type: String(v.type) as 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE',
      currency: str(v.currency),
    });
    names.add(lower(name));
    codes.add(account.code);
    out.created += 1;
  }
}

async function importOpeningBalances(tx: Tx, ctx: Ctx, rows: ParsedRow[], out: ImportOutcome) {
  const accounts = await tx.account.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true, type: true } });
  const byName = new Map(accounts.map((a) => [lower(a.name), a]));
  for (const row of rows) {
    const v = row.values;
    const account = byName.get(lower(v.account));
    if (!account) {
      out.failed.push({ line: row.line, reason: `No ledger account called "${v.account}"` });
      continue;
    }
    const debitNormal = account.type === 'ASSET' || account.type === 'EXPENSE';
    const side = str(v.side);
    if (side) {
      const isDebit = side === 'DEBIT' || side === 'DR';
      if (isDebit !== debitNormal) {
        out.failed.push({
          line: row.line,
          reason: `${account.name} is ${debitNormal ? 'an asset or expense, so its opening is a debit' : 'a liability, equity or income account, so its opening is a credit'}`,
        });
        continue;
      }
    }
    const asOf = day(v.asOf);
    const currency = str(v.currency) ?? ctx.localCurrency;
    const rates = await ratesFor(ctx, currency, asOf);
    try {
      await postAccountOpeningBalance({
        accountId: account.id,
        companyId: ctx.companyId,
        userId: ctx.userId,
        amount: String(v.amount),
        asOf,
        currency,
        rateToUsd: rates.toUsd,
        rateLocalPerUsd: rates.localPerUsd,
      });
      out.created += 1;
    } catch (error) {
      out.failed.push({ line: row.line, reason: error instanceof Error ? error.message : 'Could not be posted' });
    }
  }
}

/**
 * Opening stock as a real purchase, receipt and settlement.
 *
 * One order per (currency, date), against a supplier called "Opening stock",
 * received into the named warehouses at the stated cost — then the payable it
 * created is cleared against Opening Balance Equity, because nobody is owed
 * for stock that was already yours. Stock, its cost, its lots and the trial
 * balance all come out as if the goods had always been there.
 */
async function importOpeningStock(tx: Tx, ctx: Ctx, rows: ParsedRow[], out: ImportOutcome, userId: string) {
  const items = await tx.coffeeItem.findMany({ where: { companyId: ctx.companyId }, select: { id: true, itemName: true, bagWeightKg: true, baseUom: true } });
  const warehouses = await tx.warehouse.findMany({ where: { companyId: ctx.companyId }, select: { id: true, name: true } });
  const itemBy = new Map(items.map((i) => [lower(i.itemName), i]));
  const whBy = new Map(warehouses.map((w) => [lower(w.name), w]));

  const groups = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const item = itemBy.get(lower(row.values.itemName));
    const wh = whBy.get(lower(row.values.warehouse));
    if (!item) {
      out.failed.push({ line: row.line, reason: `No item called "${row.values.itemName}" — import items first` });
      continue;
    }
    if (!wh) {
      out.failed.push({ line: row.line, reason: `No warehouse called "${row.values.warehouse}"` });
      continue;
    }
    const key = `${row.values.currency}|${row.values.asOf}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  let sequence = 0;
  for (const [key, group] of groups) {
    const [currency, asOfIso] = key.split('|');
    const asOf = day(asOfIso);
    const rates = await ratesFor(ctx, currency, asOf);
    const vendorName = `Opening stock (${currency})`;
    let vendor = await tx.vendor.findFirst({ where: { companyId: ctx.companyId, vendorName } });
    if (!vendor) {
      vendor = await tx.vendor.create({
        data: { companyId: ctx.companyId, vendorCode: `OPEN-${currency}`, vendorName, primaryCurrency: currency, paymentTermDays: 0, notes: `Carries opening stock in ${currency}. Nothing is owed to it.` },
      });
    }

    const contract = await createPurchaseContract(
      {
        companyId: ctx.companyId,
        contractReference: `OPENING-${asOfIso}-${currency}`,
        contractDate: asOf,
        vendorId: vendor.id,
        currency,
        rateToUsd: rates.toUsd,
        rateLocalPerUsd: rates.localPerUsd,
        freightAmount: '0',
        notes: 'Opening stock carried forward from the previous system.',
        lines: group.map((row) => {
          const item = itemBy.get(lower(row.values.itemName))!;
          return {
            itemId: item.id,
            quantity: String(row.values.quantity),
            unit: item.baseUom as never,
            unitPrice: String(row.values.unitCost),
            bagWeightKg: item.bagWeightKg.toString(),
            lotNumber: str(row.values.lot) ?? `OPEN-${asOfIso.replaceAll('-', '')}-${(sequence += 1)}`,
          };
        }),
      },
      userId,
    );
    await postPurchaseContract({ id: contract.id, companyId: ctx.companyId, userId });

    // One receipt per warehouse, each batch landing where the row says.
    const batches = await tx.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { createdAt: 'asc' } });
    const byWarehouse = new Map<string, Array<{ batchId: string; quantity: string }>>();
    group.forEach((row, i) => {
      const wh = whBy.get(lower(row.values.warehouse))!;
      byWarehouse.set(wh.id, [...(byWarehouse.get(wh.id) ?? []), { batchId: batches[i].id, quantity: String(row.values.quantity) }]);
    });
    for (const [warehouseId, lines] of byWarehouse) {
      const receipt = await createGoodsReceipt(
        {
          companyId: ctx.companyId,
          purchaseContractId: contract.id,
          warehouseId,
          receiptDate: asOf,
          receivedById: userId,
          lines: lines.map((l) => {
            const batch = batches.find((b) => b.id === l.batchId)!;
            return { batchId: l.batchId, quantityKg: l.quantity, ...(batch.traceabilityPending ? { lotNumber: `OPEN-${batch.batchNumber}` } : {}) };
          }),
        },
        userId,
      );
      await postGoodsReceipt({ id: receipt.id, companyId: ctx.companyId, userId });
    }

    // Nobody is owed for opening stock: settle the payable ledger-to-ledger
    // against an equity account, as a real payment, so the supplier's own
    // ledger agrees with the books.
    const refreshed = await tx.purchaseContract.findUniqueOrThrow({ where: { id: contract.id } });
    const payable = dec(refreshed.totalValue).plus(refreshed.taxAmount ?? 0);
    if (payable.greaterThan(0)) {
      let equity = await tx.account.findFirst({ where: { companyId: ctx.companyId, name: 'Opening stock equity' } });
      if (!equity) {
        equity = await createLedgerAccount({ companyId: ctx.companyId, name: 'Opening stock equity', type: 'EQUITY' });
      }
      const payment = await createPayment(
        {
          companyId: ctx.companyId,
          paymentDate: asOf,
          vendorId: vendor.id,
          currency,
          amount: payable.toString(),
          rateToUsd: rates.toUsd,
          rateLocalPerUsd: rates.localPerUsd,
          paymentMethod: 'LEDGER_TRANSFER',
          ledgerAccountId: equity.id,
          description: `Opening stock — ${vendorName}`,
          allocations: [{ purchaseContractId: contract.id, amount: payable.toString() }],
        },
        userId,
      );
      await postPayment({ id: payment.id, companyId: ctx.companyId, userId });
    }
    out.created += group.length;
  }
}

// ---------------------------------------------------------------------------

export async function runImport(params: {
  kind: ImportKind;
  rows: ParsedRow[];
  companyId: string;
  userId: string;
  terminology: Record<string, string> | null | undefined;
  dryRun: boolean;
}): Promise<ImportOutcome> {
  const bad = params.rows.filter((r) => r.errors.length > 0);
  const outcome: ImportOutcome = { kind: params.kind, dryRun: params.dryRun, created: 0, skipped: [], failed: [] };
  for (const row of bad) outcome.failed.push({ line: row.line, reason: row.errors.join('; ') });
  const good = params.rows.filter((r) => r.errors.length === 0);
  if (outcome.failed.length > 0 && !params.dryRun) {
    // A real import is all or nothing: fix the file, then import it once.
    throw new BusinessRuleError(`${outcome.failed.length} row(s) have problems. Fix them in the file and upload again — nothing was imported.`);
  }

  const company = await prisma.company.findUniqueOrThrow({ where: { id: params.companyId }, select: { localCurrency: true } });
  const ctx: Ctx = {
    companyId: params.companyId,
    userId: params.userId,
    localCurrency: company.localCurrency,
    unit: makeTerms(params.terminology)('unit'),
  };

  const work = async (tx: Tx) => {
    switch (params.kind) {
      case 'ITEMS':
        await importItems(tx, ctx, good, outcome);
        break;
      case 'CUSTOMERS':
        await importParties(tx, ctx, good, outcome, 'CUSTOMER');
        break;
      case 'SUPPLIERS':
        await importParties(tx, ctx, good, outcome, 'VENDOR');
        break;
      case 'OPENING_STOCK':
        await importOpeningStock(tx, ctx, good, outcome, params.userId);
        break;
      case 'CHART_OF_ACCOUNTS':
        await importChart(tx, ctx, good, outcome);
        break;
      case 'OPENING_BALANCES':
        await importOpeningBalances(tx, ctx, good, outcome);
        break;
    }
    if (outcome.failed.length > 0 && !params.dryRun) {
      throw new BusinessRuleError(`${outcome.failed.length} row(s) could not be imported: ${outcome.failed.slice(0, 3).map((f) => `row ${f.line}: ${f.reason}`).join(' · ')}`);
    }
    if (!params.dryRun) {
      await writeAudit(tx, {
        companyId: params.companyId,
        userId: params.userId,
        action: 'DATA_IMPORTED',
        entityType: 'Import',
        entityId: params.kind,
        after: { kind: params.kind, created: outcome.created, skipped: outcome.skipped.length },
      });
    }
  };

  if (!params.dryRun) {
    await transaction(work, 300_000);
    return outcome;
  }
  try {
    await transaction(async (tx) => {
      await work(tx);
      throw new Rollback(outcome);
    }, 300_000);
  } catch (error) {
    if (error instanceof Rollback) return error.outcome;
    throw error;
  }
  return outcome;
}
