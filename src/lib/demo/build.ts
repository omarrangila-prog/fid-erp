import { prisma } from '@/lib/db';
import { createPurchaseContract, postPurchaseContract } from '@/lib/services/purchase';
import { createGoodsReceipt, postGoodsReceipt } from '@/lib/services/goods-receipt';
import { createSalesInvoice, postSalesInvoice } from '@/lib/services/sales';
import { createReceipt, postReceipt } from '@/lib/services/receipt';
import { createPayment, postPayment } from '@/lib/services/payment';
import { createExpense, postExpense } from '@/lib/services/expense';
import { createCashBankAccount } from '@/lib/services/chart-of-accounts';
import { enableTax, setStandardRate } from '@/lib/services/tax';
import { createTenant, addCompany } from '@/lib/services/tenant';
import { reconcile } from '@/lib/services/reconciliation';
import { DEMO_ORGANIZATION, DEMO_PRESETS, type DemoSpec } from '@/lib/demo/presets';
import { countryByName } from '@/lib/countries';

/**
 * Builds the demonstration customer: one organization, four fictional
 * companies (general trading, coffee, apparel, distribution).
 *
 * Every figure comes from the real services — orders post, stock is received,
 * landed cost is capitalised, invoices are issued and paid — so the books
 * balance and every report is genuine. Nothing is inserted behind the engine's
 * back, and nothing comes from a real customer.
 */

const DAY = 86_400_000;
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * DAY);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

export type DemoResult = { organizationId: string; ownerEmail: string; password: string; companies: Array<{ key: string; id: string; code: string; reconciled: boolean }> };

async function buildCompany(spec: DemoSpec, companyId: string, localCurrency: string, userId: string) {
  const localRate = localCurrency === 'USD' ? '1' : spec.rates[localCurrency];
  const rateOf = (c: string) => (c === 'USD' ? '1' : spec.rates[c]);
  if (!localRate) throw new Error(`Demo ${spec.key}: no rate for ${localCurrency}`);

  // --- configuration -------------------------------------------------------
  await prisma.company.update({
    where: { id: companyId },
    data: {
      tagline: spec.company.tagline,
      phone: spec.company.phone,
      email: spec.company.email,
      website: spec.company.website,
      companyRegistration: spec.company.registration,
      transactionCurrencies: spec.transactionCurrencies,
      salesCurrencies: spec.salesCurrencies,
      defaultSalesCurrency: spec.defaultSalesCurrency ?? null,
      ...(spec.key === 'coffee' ? { terminology: { product: 'Coffee', unit: 'KG' } } : {}),
    },
  });
  const rateDates = [daysAgo(200), daysAgo(1)];
  for (const [currency, rate] of Object.entries(spec.rates)) {
    for (const effectiveDate of rateDates) {
      await prisma.exchangeRate.upsert({
        where: { companyId_quoteCurrency_effectiveDate: { companyId, quoteCurrency: currency, effectiveDate } },
        update: { rate },
        create: { companyId, quoteCurrency: currency, rate, effectiveDate },
      });
    }
  }
  if (spec.tax) {
    await enableTax({ companyId, userId, registrationNumber: spec.tax.registration, label: spec.tax.label });
    await setStandardRate({ companyId, name: `${spec.tax.label} ${spec.tax.ratePct}%`, ratePct: spec.tax.ratePct, userId });
  }

  // --- places and money -------------------------------------------------------
  const warehouses: Array<{ id: string }> = [];
  for (const [i, w] of spec.warehouses.entries()) {
    warehouses.push(
      await prisma.warehouse.create({
        data: { companyId, code: `WH-${i + 1}`, name: w.name, location: w.location, port: w.port ?? null, country: spec.company.country, isDefault: i === 0 },
      }),
    );
  }
  const accountCurrencies = [...new Set([localCurrency, 'USD', ...spec.salesCurrencies, ...spec.vendors.map((v) => v.currency)])];
  const banks: Record<string, { id: string }> = {};
  for (const [i, currency] of accountCurrencies.entries()) {
    banks[currency] = await createCashBankAccount(
      { companyId, code: `BANK-${i + 1}-${currency}`, name: `${currency} Bank Account`, accountType: 'BANK', currency, bankName: 'Demo Bank' },
      userId,
    );
  }

  // --- masters ----------------------------------------------------------------
  const vendors: Array<{ id: string }> = [];
  for (const [i, v] of spec.vendors.entries()) {
    vendors.push(await prisma.vendor.create({ data: { companyId, vendorCode: `SUP-${String(i + 1).padStart(4, '0')}`, vendorName: v.name, country: v.country, contactPerson: v.contact, email: v.email, primaryCurrency: v.currency, paymentTermDays: v.terms ?? 30 } }));
  }
  const customers: Array<{ id: string }> = [];
  for (const [i, c] of spec.customers.entries()) {
    customers.push(await prisma.customer.create({ data: { companyId, customerCode: `CUS-${String(i + 1).padStart(4, '0')}`, customerName: c.name, country: c.country, contactPerson: c.contact, email: c.email, primaryCurrency: c.currency, paymentTermDays: c.terms ?? 30 } }));
  }
  const items: Array<{ id: string }> = [];
  for (const [i, it] of spec.items.entries()) {
    items.push(
      await prisma.coffeeItem.create({
        data: {
          companyId,
          itemCode: `ITM-${String(i + 1).padStart(4, '0')}`,
          itemName: it.name,
          baseUom: it.baseUom,
          defaultUnit: it.baseUom,
          packUom: it.packUom,
          bagWeightKg: String(it.packSize),
          category: it.category,
          brand: it.brand ?? null,
          hsCode: it.hsCode,
          originCountry: it.origin,
          attributes: it.attributes ?? {},
          ...(it.coffee ? { coffeeType: it.coffee.coffeeType, grade: it.coffee.grade, screenSize: it.coffee.screenSize ?? null, region: it.coffee.region ?? null, cropYear: it.coffee.cropYear, process: it.coffee.process, packagingType: 'JUTE_BAG' as const } : {}),
        },
      }),
    );
  }

  // --- buying and receiving ---------------------------------------------------
  const shippingCategory = await prisma.expenseCategory.findFirst({ where: { companyId, capitaliseByDefault: true }, orderBy: { code: 'asc' } });
  const periodCategory = await prisma.expenseCategory.findFirst({ where: { companyId, capitaliseByDefault: false }, orderBy: { code: 'asc' } });
  const contracts: Array<{ id: string; vendorId: string; number: string }> = [];
  let n = 0;
  for (const p of spec.purchases) {
    n += 1;
    const vendor = vendors[p.vendor];
    const vc = spec.vendors[p.vendor].currency;
    const vRate = rateOf(vc);
    const price = (usd: number) => (usd * Number(vRate)).toFixed(usd < 0.1 ? 6 : 4);
    const contract = await createPurchaseContract(
      {
        companyId,
        contractReference: `DEMO-PO-${spec.key.toUpperCase().slice(0, 3)}-${String(n).padStart(3, '0')}`,
        contractDate: daysAgo(p.daysAgo),
        vendorId: vendor.id,
        currency: vc,
        rateToUsd: vRate,
        rateLocalPerUsd: localRate,
        freightAmount: price(p.freightUsd),
        origin: spec.items[p.lines[0].item].origin,
        lines: p.lines.map((l, li) => {
          const it = spec.items[l.item];
          return {
            itemId: items[l.item].id,
            quantity: String(l.qty),
            unit: it.baseUom,
            unitPrice: price(it.costUsd),
            bagWeightKg: String(it.packSize),
            lotNumber: `${it.sku}-L${n}${li + 1}`,
            ...(spec.logistics ? { containerNumber: `DEMU${String(7000000 + n * 31 + li * 7).padStart(7, '0')}` } : {}),
          };
        }),
      },
      userId,
    );
    await postPurchaseContract({ id: contract.id, companyId, userId });
    contracts.push({ id: contract.id, vendorId: vendor.id, number: contract.contractNumber });
    const shipment = await prisma.shipment.findFirst({ where: { purchaseContractId: contract.id } });

    if (p.receivedDaysAgo === null) {
      if (shipment && spec.logistics) {
        await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'IN_TRANSIT', etdDate: daysAgo(p.daysAgo - 8), etaDate: daysAgo(-9), vesselName: 'MV Demo Voyager', voyageNumber: `DV${n}01` } });
      }
      continue;
    }
    const batches = await prisma.batch.findMany({ where: { purchaseContractId: contract.id }, orderBy: { batchNumber: 'asc' } });
    const grn = await createGoodsReceipt(
      {
        companyId,
        purchaseContractId: contract.id,
        warehouseId: warehouses[p.warehouse].id,
        receiptDate: daysAgo(p.receivedDaysAgo),
        receivedById: userId,
        lines: batches.map((b) => ({ batchId: b.id, quantityKg: b.orderedQuantityKg.toString(), bags: b.orderedBags, ...(b.traceabilityPending ? { lotNumber: `LOT-${b.batchNumber}` } : {}) })),
      },
      userId,
    );
    await postGoodsReceipt({ id: grn.id, companyId, userId });
    if (shipment && spec.logistics) {
      await prisma.shipment.update({ where: { id: shipment.id }, data: { status: 'DELIVERED', etdDate: daysAgo(p.daysAgo - 8), etaDate: daysAgo(p.receivedDaysAgo + 2), ataDate: daysAgo(p.receivedDaysAgo + 2), deliveryDate: daysAgo(p.receivedDaysAgo), vesselName: 'MV Demo Voyager', voyageNumber: `DV${n}01` } });
    }
    if (p.clearingLocal && shipment && shippingCategory) {
      const exp = await createExpense(
        {
          companyId,
          expenseDate: daysAgo(p.receivedDaysAgo - 1),
          expenseCategoryId: shippingCategory.id,
          shipmentId: shipment.id,
          purchaseContractId: contract.id,
          currency: localCurrency,
          amount: String(p.clearingLocal),
          rateToUsd: localRate,
          rateLocalPerUsd: localRate,
          cashBankAccountId: banks[localCurrency].id,
          capitaliseToLandedCost: true,
          description: `Clearing and handling — ${contract.contractNumber}`,
        },
        userId,
      );
      await postExpense({ id: exp.id, companyId, userId });
    }
    if (p.paidShare) {
      const posted = await prisma.purchaseContract.findUniqueOrThrow({ where: { id: contract.id } });
      const amount = p.paidShare === 1 ? posted.totalValue.toString() : (Math.floor(Number(posted.totalValue) * p.paidShare * 100) / 100).toFixed(2);
      const pay = await createPayment(
        { companyId, paymentDate: daysAgo(Math.max(1, p.receivedDaysAgo - 5)), vendorId: vendor.id, currency: vc, amount, rateToUsd: vRate, rateLocalPerUsd: localRate, cashBankAccountId: banks[vc].id, paymentMethod: 'BANK_TRANSFER', description: `Payment against ${contract.contractNumber}`, allocations: [{ purchaseContractId: contract.id, amount }] },
        userId,
      );
      await postPayment({ id: pay.id, companyId, userId });
    }
  }

  // --- selling ----------------------------------------------------------------
  const taxCode = spec.tax ? await prisma.taxCode.findFirst({ where: { companyId, treatment: 'STANDARD' } }) : null;
  let sold = 0;
  for (const s of spec.sales) {
    const customer = customers[s.customer];
    const rate = rateOf(s.currency);
    const lines: Array<{ batchId: string; warehouseId: string; quantity: string; unit: 'KG' | 'PCS' | 'M' | 'L'; unitPrice: string; taxCodeId?: string }> = [];
    for (const l of s.lines) {
      const it = spec.items[l.item];
      const batch = await prisma.batch.findFirst({ where: { companyId, itemId: items[l.item].id, receivedQuantityKg: { gt: 0 } }, orderBy: { createdAt: 'asc' } });
      if (!batch) continue;
      const balance = await prisma.inventoryBalance.findFirst({ where: { batchId: batch.id, availableKg: { gte: String(l.qty) } } });
      if (!balance) continue;
      lines.push({
        batchId: batch.id,
        warehouseId: balance.warehouseId,
        quantity: String(l.qty),
        unit: it.baseUom,
        unitPrice: (it.costUsd * Number(rate) * l.markup).toFixed(it.costUsd < 0.1 ? 6 : 4),
        ...(taxCode ? { taxCodeId: taxCode.id } : {}),
      });
    }
    if (lines.length === 0) continue;
    const invoice = await createSalesInvoice(
      { companyId, invoiceDate: daysAgo(s.daysAgo), customerId: customer.id, currency: s.currency, rateToUsd: rate, rateLocalPerUsd: localRate, lines },
      userId,
    );
    await postSalesInvoice({ id: invoice.id, companyId, userId });
    sold += 1;
    if (s.settle !== 'none') {
      const posted = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      const amount = s.settle === 'full' ? posted.totalAmount.toString() : (Math.floor(Number(posted.totalAmount) * 0.6 * 100) / 100).toFixed(2);
      const receipt = await createReceipt(
        { companyId, receiptDate: daysAgo(Math.max(1, s.daysAgo - 12)), customerId: customer.id, currency: s.currency, amount, rateToUsd: rate, rateLocalPerUsd: localRate, paymentMethod: 'BANK_TRANSFER', cashBankAccountId: banks[s.currency].id, description: `Settlement of ${posted.invoiceNumber}`, allocations: [{ salesInvoiceId: invoice.id, amount }] },
        userId,
      );
      await postReceipt({ id: receipt.id, companyId, userId });
    }
  }

  // --- running costs --------------------------------------------------------------
  if (periodCategory) {
    for (const e of spec.expensesLocal) {
      const exp = await createExpense(
        { companyId, expenseDate: daysAgo(e.daysAgo), expenseCategoryId: periodCategory.id, currency: localCurrency, amount: String(e.amount), rateToUsd: localRate, rateLocalPerUsd: localRate, cashBankAccountId: banks[localCurrency].id, capitaliseToLandedCost: false, description: e.description },
        userId,
      );
      await postExpense({ id: exp.id, companyId, userId });
    }
  }
  const check = await reconcile(companyId);
  return { reconciled: check.checks.every((c) => c.passed), invoices: sold, contracts: contracts.length };
}

export async function buildDemoTenant(options: { ownerEmail: string; ownerPassword: string; actorUserId?: string | null; only?: DemoSpec['key'][] }): Promise<DemoResult> {
  const presets = DEMO_PRESETS.filter((p) => !options.only || options.only.includes(p.key));
  const first = presets[0];
  const country0 = countryByName(first.company.country)!;
  const created = await createTenant({
    organizationName: DEMO_ORGANIZATION,
    plan: 'ENTERPRISE',
    company: { name: first.company.name, legalName: first.company.legalName, country: first.company.country, localCurrency: country0.currency, industryTemplate: first.company.template, address: first.company.address, code: 'DEMO-GENERAL' },
    owner: { name: 'Demo Owner', email: options.ownerEmail, password: options.ownerPassword },
    actorUserId: options.actorUserId ?? null,
  });
  await prisma.user.update({ where: { id: created.ownerUserId }, data: { mustChangePassword: false } });
  await prisma.applicationSetting.updateMany({ where: { companyId: created.companyId, key: 'onboarding.status' }, data: { value: 'done' } });

  const out: DemoResult['companies'] = [];
  for (const [i, spec] of presets.entries()) {
    const country = countryByName(spec.company.country)!;
    let companyId = created.companyId;
    let code = created.companyCode;
    if (i > 0) {
      const added = await addCompany({
        organizationId: created.organizationId,
        name: spec.company.name,
        legalName: spec.company.legalName,
        country: spec.company.country,
        industryTemplate: spec.company.template,
        address: spec.company.address,
        code: `DEMO-${spec.key.toUpperCase()}`,
        userIds: [created.ownerUserId],
        actorUserId: created.ownerUserId,
      });
      companyId = added.companyId;
      code = added.companyCode;
      await prisma.applicationSetting.updateMany({ where: { companyId, key: 'onboarding.status' }, data: { value: 'done' } });
    }
    const result = await buildCompany(spec, companyId, country.currency, created.ownerUserId);
    out.push({ key: spec.key, id: companyId, code, reconciled: result.reconciled });
  }
  return { organizationId: created.organizationId, ownerEmail: options.ownerEmail, password: options.ownerPassword, companies: out };
}
