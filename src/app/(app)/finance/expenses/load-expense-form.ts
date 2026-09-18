import { prisma, transaction } from '@/lib/db';
import { ensureExpenseCategories } from '@/lib/services/chart-of-accounts';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { getTaxSettings, listTaxCodes } from '@/lib/services/tax';
import type { CategoryOption, ShipmentTrace } from '@/app/(app)/finance/expenses/expense-form';

export async function loadExpenseFormOptions(companyId: string) {
  await transaction((tx) => ensureExpenseCategories(tx, companyId));

  const [categories, shipments, agents, vendors, accounts, containers, batches, taxSettings, taxCodeRows, rates] =
    await Promise.all([
      prisma.expenseCategory.findMany({
        where: { companyId, status: 'ACTIVE' },
        orderBy: [{ kind: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, code: true, capitaliseByDefault: true, kind: true },
      }),
      prisma.shipment.findMany({
        where: { companyId, purchaseContract: { status: 'POSTED' } },
        orderBy: { shipmentNumber: 'desc' },
        select: {
          id: true,
          jobNumber: true,
          shipmentNumber: true,
          item: { select: { itemName: true } },
          vendor: { select: { vendorName: true } },
          purchaseContract: { select: { contractReference: true, contractNumber: true } },
        },
      }),
      prisma.agent.findMany({
        where: { companyId, status: 'ACTIVE' },
        orderBy: { agentName: 'asc' },
        select: { id: true, agentName: true },
      }),
      prisma.vendor.findMany({
        where: { companyId, status: 'ACTIVE' },
        orderBy: { vendorName: 'asc' },
        select: { id: true, vendorName: true, vendorCode: true, primaryCurrency: true },
      }),
      prisma.cashBankAccount.findMany({
        where: { companyId, status: 'ACTIVE' },
        orderBy: [{ accountType: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, code: true, currency: true, accountType: true },
      }),
      prisma.container.findMany({
        where: { companyId, shipmentId: { not: null }, status: 'ACTIVE' },
        orderBy: { containerNumber: 'asc' },
        select: { id: true, containerNumber: true, shipmentId: true },
      }),
      prisma.batch.findMany({
        where: { companyId, status: 'ACTIVE' },
        orderBy: { batchNumber: 'asc' },
        select: { id: true, batchNumber: true, shipmentId: true, containerId: true },
      }),
      getTaxSettings(companyId),
      listTaxCodes(companyId, 'PURCHASE'),
      getRateDefaults(companyId),
    ]);

  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.capitaliseByDefault ? 'Landed cost' : 'Period cost',
    keywords: c.code,
    capitaliseByDefault: c.capitaliseByDefault,
    kind: c.kind,
  }));

  const shipmentOptions = shipments.map((s) => ({
    value: s.id,
    label: s.purchaseContract.contractReference,
    hint: `${s.vendor.vendorName} · ${s.item.itemName}`,
    keywords: `${s.purchaseContract.contractReference} ${s.purchaseContract.contractNumber} ${s.jobNumber} ${s.shipmentNumber} ${s.vendor.vendorName} ${s.item.itemName}`,
  }));

  const traceByShipment: Record<string, ShipmentTrace> = {};
  for (const container of containers) {
    if (!container.shipmentId) continue;
    const entry = (traceByShipment[container.shipmentId] ??= { containers: [], batches: [] });
    entry.containers.push({ value: container.id, label: container.containerNumber });
  }
  for (const batch of batches) {
    const entry = (traceByShipment[batch.shipmentId] ??= { containers: [], batches: [] });
    entry.batches.push({
      value: batch.id,
      label: batch.batchNumber,
      containerId: batch.containerId,
    });
  }

  return {
    categories: categoryOptions,
    shipments: shipmentOptions,
    agents: agents.map((a) => ({ value: a.id, label: a.agentName })),
    vendors: vendors.map((v) => ({
      value: v.id,
      label: v.vendorName,
      hint: v.primaryCurrency,
      keywords: v.vendorCode,
      currency: v.primaryCurrency,
    })),
    accounts: accounts.map((a) => ({
      value: a.id,
      label: a.name,
      hint: `${a.currency} · ${a.accountType.replaceAll('_', ' ').toLowerCase()}`,
      keywords: `${a.code} ${a.currency}`,
      currency: a.currency,
      accountType: a.accountType,
    })),
    traceByShipment,
    taxEnabled: taxSettings.enabled,
    taxLabel: taxSettings.label,
    taxCodes: taxCodeRows.map((code) => ({
      value: code.id,
      label: `${code.name} (${code.ratePct.toString()}%)`,
      ratePct: code.ratePct.toString(),
    })),
    rates,
  };
}
