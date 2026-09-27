import { prisma, transaction } from '@/lib/db';
import { ensureExpenseCategories } from '@/lib/services/chart-of-accounts';
import { getRateDefaults } from '@/lib/services/exchange-rate';
import { getTaxSettings, listTaxCodes } from '@/lib/services/tax';
import { getLedgerSettlementAccounts } from '@/lib/services/ledger-settlement';
import type { CategoryOption, ShipmentTrace } from '@/app/(app)/finance/expenses/expense-form';

export async function loadExpenseFormOptions(companyId: string) {
  await transaction((tx) => ensureExpenseCategories(tx, companyId));

  const [categories, shipments, agents, vendors, accounts, containers, batches, taxSettings, taxCodeRows, rates, ledgerAccounts] =
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
          purchaseContractId: true,
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
        where: { companyId, status: 'ACTIVE', OR: [{ shipmentId: { not: null } }, { purchaseContractId: { not: null } }] },
        orderBy: { containerNumber: 'asc' },
        select: { id: true, containerNumber: true, shipmentId: true, purchaseContractId: true },
      }),
      prisma.batch.findMany({
        where: { companyId, status: 'ACTIVE' },
        orderBy: { batchNumber: 'asc' },
        select: {
          id: true,
          batchNumber: true,
          shipmentId: true,
          containerId: true,
          purchaseContractId: true,
          orderedQuantityKg: true,
          receivedQuantityKg: true,
          item: { select: { itemName: true } },
        },
      }),
      getTaxSettings(companyId),
      listTaxCodes(companyId, 'PURCHASE'),
      getRateDefaults(companyId),
      getLedgerSettlementAccounts(companyId),
    ]);

  const categoryOptions: CategoryOption[] = categories.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.capitaliseByDefault ? 'Landed cost' : 'Period cost',
    keywords: c.code,
    capitaliseByDefault: c.capitaliseByDefault,
    kind: c.kind,
  }));

  /*
   * One entry per order, and every container on it.
   *
   * An order holds one shipment record per container, so listing records
   * offered the same reference once per container and, once one was chosen,
   * only that record's own container. The order is what the client means by
   * "the shipment": it is offered once, and its containers are all of the
   * order's containers, however many records carry them. A cost named to a
   * container is filed under the record that carries it; a cost for the whole
   * shipment is spread across every container on the order.
   */
  const recordsByOrder = new Map<string, typeof shipments>();
  for (const shipment of shipments) {
    recordsByOrder.set(shipment.purchaseContractId, [...(recordsByOrder.get(shipment.purchaseContractId) ?? []), shipment]);
  }
  const orderOfShipment = new Map(shipments.map((s) => [s.id, s.purchaseContractId]));
  const orderShipmentId: Record<string, string> = {};
  const representative = new Map<string, string>();
  for (const [orderId, records] of recordsByOrder) {
    const first = [...records].sort((a, b) => a.shipmentNumber.localeCompare(b.shipmentNumber))[0];
    representative.set(orderId, first.id);
    for (const record of records) orderShipmentId[record.id] = first.id;
  }

  const containersByOrder = new Map<string, typeof containers>();
  for (const container of containers) {
    const orderId = container.purchaseContractId ?? (container.shipmentId ? orderOfShipment.get(container.shipmentId) : undefined);
    if (!orderId) continue;
    containersByOrder.set(orderId, [...(containersByOrder.get(orderId) ?? []), container]);
  }
  const batchesByOrder = new Map<string, typeof batches>();
  for (const batch of batches) {
    batchesByOrder.set(batch.purchaseContractId, [...(batchesByOrder.get(batch.purchaseContractId) ?? []), batch]);
  }

  const shipmentOptions = [...recordsByOrder.entries()]
    .sort(([, a], [, b]) =>
      Math.max(...b.map((r) => Number(r.shipmentNumber.replace(/\D/g, '')) || 0)) -
      Math.max(...a.map((r) => Number(r.shipmentNumber.replace(/\D/g, '')) || 0)),
    )
    .map(([orderId, records]) => {
      const s = records[0];
      const count = containersByOrder.get(orderId)?.length ?? 0;
      const items = [...new Set((batchesByOrder.get(orderId) ?? []).map((b) => b.item.itemName))];
      return {
        value: representative.get(orderId)!,
        label: s.purchaseContract.contractReference,
        hint: [count ? `${count} container${count === 1 ? '' : 's'}` : null, s.vendor.vendorName, items.join(', ') || s.item.itemName]
          .filter(Boolean)
          .join(' · '),
        keywords: [
          s.purchaseContract.contractReference,
          s.purchaseContract.contractNumber,
          ...records.flatMap((r) => [r.jobNumber, r.shipmentNumber]),
          s.vendor.vendorName,
          ...items,
          ...(containersByOrder.get(orderId) ?? []).map((c) => c.containerNumber),
        ].join(' '),
      };
    });

  const traceByOrder = new Map<string, ShipmentTrace>();
  for (const orderId of recordsByOrder.keys()) {
    const orderBatches = batchesByOrder.get(orderId) ?? [];
    const kg = (b: (typeof orderBatches)[number]) =>
      Number(b.receivedQuantityKg) > 0 ? Number(b.receivedQuantityKg) : Number(b.orderedQuantityKg);
    traceByOrder.set(orderId, {
      containers: (containersByOrder.get(orderId) ?? []).map((container) => {
        const inside = orderBatches.filter((b) => b.containerId === container.id);
        const items = [...new Set(inside.map((b) => b.item.itemName))].join(', ');
        const totalKg = inside.reduce((t, b) => t + kg(b), 0);
        return {
          value: container.id,
          label: [container.containerNumber, items || null, totalKg ? `${totalKg.toLocaleString('en-US')} KG` : null]
            .filter(Boolean)
            .join(' — '),
          keywords: `${container.containerNumber} ${items}`,
        };
      }),
      batches: orderBatches.map((batch) => ({
        value: batch.id,
        label: batch.batchNumber,
        hint: `${batch.item.itemName} · ${kg(batch).toLocaleString('en-US')} KG`,
        containerId: batch.containerId,
      })),
    });
  }
  // Any record of the order opens the order's containers: an expense filed
  // under the second container's record still shows all of them when edited.
  const traceByShipment: Record<string, ShipmentTrace> = {};
  for (const shipment of shipments) {
    const trace = traceByOrder.get(shipment.purchaseContractId);
    if (trace) traceByShipment[shipment.id] = trace;
  }

  return {
    categories: categoryOptions,
    shipments: shipmentOptions,
    /** Every shipment record → the one entry its order is offered as. */
    orderShipmentId,
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
    ledgerAccounts,
  };
}
