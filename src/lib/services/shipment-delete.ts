import { prisma, transaction } from '@/lib/db';
import { dec, sum, toMoney, toQuantity } from '@/lib/money';
import { NotFoundError, BusinessRuleError } from '@/lib/errors';
import { writeAudit } from '@/lib/services/audit';
import { reverseGoodsReceipt, deleteDraftGoodsReceipt } from '@/lib/services/goods-receipt';
import { reverseExpense, deleteDraftExpense } from '@/lib/services/expense';
import { getExpenseSettlements } from '@/lib/services/expense-settlement';
import { cancelStockTransfer, deleteDraftStockTransfer, reverseReceivedStockTransferIn } from '@/lib/services/stock-transfer';
import { reversePurchaseContract, correctPurchaseContract } from '@/lib/services/purchase';

/**
 * Delete a shipment, in one action.
 *
 * The client's shipment is an order and its containers: the loading sheet
 * row. Creating one is one step; taking it back out used to be five —
 * reverse the goods receipt, cancel the transfer, delete the cost, come back,
 * try again. This works out what has to be undone, undoes it in the right
 * order, and removes the shipment, all inside one transaction: either all of
 * it happens or none of it does.
 *
 * Nothing here is a second way of reversing anything. Each step is the
 * service the rest of the ERP uses — the goods receipt's reversal, the
 * transfer's, the expense's, the order's — so stock, batches, the ledger and
 * the audit trail move exactly as they do when those are undone one by one.
 * Posted documents are reversed, not erased: the entry and its reversal both
 * stay in the journal; only drafts are removed outright.
 *
 * What it will not do is undo something real on the way:
 *
 *   - coffee already sold, returned on a credit note, counted, or held by a
 *     draft sale — the sale is the customer's document and has to be dealt
 *     with as one;
 *   - a cost that has been paid — money that left cash or bank does not
 *     come back because a shipment was deleted;
 *   - a supplier payment or debit note against the order;
 *   - a transfer that moved other coffee as well, or one still on the road.
 *
 * Those are listed, with links, and nothing changes until they are dealt with.
 *
 * The order itself stays, by default, as a draft with the same reference and
 * every line, to be corrected and approved again; or it goes too, when the
 * user asks for that.
 */

export type DeleteMode = 'keep-order' | 'delete-order';

export const DELETE_REASONS = ['Mistaken entry', 'Duplicate shipment', 'Wrong purchase order', 'Test entry', 'Other'] as const;

export type DeletePreview = {
  contractId: string;
  reference: string;
  supplier: string;
  containers: string[];
  containerCount: number;
  batches: number;
  /** Goods receipts that will be reversed (posted) or removed (draft). */
  receipts: Array<{ id: string; number: string; status: string; kg: string; warehouse: string }>;
  receivedKg: string;
  stockMovements: number;
  /** Costs: drafts removed, unpaid ones reversed, paid ones block. */
  costs: Array<{ id: string; number: string; status: string; amount: string; currency: string; settlement: 'DRAFT' | 'UNPAID' | 'PAID' | 'PARTIAL'; paidFrom: string | null }>;
  transfers: Array<{ id: string; number: string; state: string; action: 'delete' | 'cancel' | 'reverse' | 'block' }>;
  sales: Array<{ id: string; number: string; status: string; customer: string; kg: string }>;
  creditNotes: Array<{ id: string; number: string }>;
  stockCounts: Array<{ id: string; number: string }>;
  supplierPayments: Array<{ id: string; number: string; amount: string; currency: string }>;
  debitNotes: Array<{ id: string; number: string }>;
  /** Plain-language reasons nothing can be deleted yet; empty when it can. */
  blockers: string[];
  /** Plain-language list of what deleting will also undo. */
  willUndo: string[];
  canDelete: boolean;
};

async function loadOrder(companyId: string, contractId: string) {
  const contract = await prisma.purchaseContract.findFirst({
    where: { id: contractId, companyId },
    select: {
      id: true,
      status: true,
      contractReference: true,
      contractNumber: true,
      totalValue: true,
      currency: true,
      vendor: { select: { vendorName: true } },
      shipments: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, status: true, containerList: { select: { containerNumber: true } } },
      },
    },
  });
  if (!contract) throw new NotFoundError('Shipment');
  const batches = await prisma.batch.findMany({
    where: { companyId, purchaseContractId: contractId, status: 'ACTIVE' },
    select: {
      id: true,
      batchNumber: true,
      receivedQuantityKg: true,
      soldQuantityKg: true,
      allocatedQuantityKg: true,
      container: { select: { containerNumber: true } },
    },
  });
  return { contract, batches };
}

/** What deleting this shipment would involve — the dialog shows it before anything is done. */
export async function getShipmentDeletePreview(
  companyId: string,
  contractId: string,
  access: { canReverseCosts: boolean } = { canReverseCosts: true },
): Promise<DeletePreview> {
  const { contract, batches } = await loadOrder(companyId, contractId);
  const batchIds = batches.map((b) => b.id);
  const shipmentIds = contract.shipments.map((s) => s.id);

  const [receipts, movements, expenses, transferLines, invoiceLines, creditLines, countLines, adjustments, payments, debitNotes] = await Promise.all([
    prisma.goodsReceipt.findMany({
      where: { companyId, purchaseContractId: contractId, status: { in: ['DRAFT', 'POSTED'] } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, grnNumber: true, status: true, warehouse: { select: { name: true } }, lines: { select: { quantityKg: true } } },
    }),
    batchIds.length ? prisma.inventoryTransaction.count({ where: { companyId, batchId: { in: batchIds } } }) : Promise.resolve(0),
    prisma.expense.findMany({
      where: {
        companyId,
        status: { in: ['DRAFT', 'POSTED'] },
        OR: [{ purchaseContractId: contractId }, ...(shipmentIds.length ? [{ shipmentId: { in: shipmentIds } }] : []), ...(batchIds.length ? [{ batchId: { in: batchIds } }] : [])],
      },
      include: {
        cashBankAccount: { select: { name: true } },
        ledgerAccount: { select: { name: true } },
        ledgerAgent: { select: { agentName: true } },
        vendor: { select: { country: true } },
      },
    }),
    batchIds.length
      ? prisma.stockTransferLine.findMany({
          where: { batchId: { in: batchIds } },
          select: { stockTransfer: { select: { id: true, transferNumber: true, workflowState: true, lines: { select: { batchId: true } } } } },
        })
      : Promise.resolve([]),
    batchIds.length
      ? prisma.salesInvoiceLine.findMany({
          where: { batchId: { in: batchIds }, salesInvoice: { status: { in: ['DRAFT', 'POSTED'] } } },
          select: { quantityKg: true, salesInvoice: { select: { id: true, invoiceNumber: true, status: true, customer: { select: { customerName: true } } } } },
        })
      : Promise.resolve([]),
    batchIds.length
      ? prisma.creditNoteLine.findMany({
          where: { batchId: { in: batchIds }, creditNote: { status: { in: ['DRAFT', 'POSTED'] } } },
          select: { creditNote: { select: { id: true, creditNoteNumber: true } } },
        })
      : Promise.resolve([]),
    batchIds.length
      ? prisma.stockCountLine.findMany({
          where: { batchId: { in: batchIds }, stockCount: { status: { notIn: ['CANCELLED'] } } },
          select: { stockCount: { select: { id: true, countNumber: true } } },
        })
      : Promise.resolve([]),
    batchIds.length
      ? prisma.inventoryTransaction.count({ where: { companyId, batchId: { in: batchIds }, transactionType: { in: ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] } } })
      : Promise.resolve(0),
    prisma.paymentAllocation.findMany({
      where: { purchaseContractId: contractId, payment: { status: 'POSTED' } },
      select: { amount: true, payment: { select: { id: true, paymentNumber: true, currency: true } } },
    }),
    prisma.creditNote.findMany({
      where: { companyId, purchaseContractId: contractId, status: 'POSTED' },
      select: { id: true, creditNoteNumber: true },
    }),
  ]);

  const blockers: string[] = [];
  const willUndo: string[] = [];

  // --- Sales, returns, counts: the coffee has been used ----------------------
  const salesById = new Map<string, DeletePreview['sales'][number]>();
  for (const line of invoiceLines) {
    const inv = line.salesInvoice;
    const existing = salesById.get(inv.id);
    const kg = toQuantity(dec(existing?.kg ?? 0).plus(dec(line.quantityKg)));
    salesById.set(inv.id, { id: inv.id, number: inv.invoiceNumber, status: inv.status, customer: inv.customer.customerName, kg: kg.toString() });
  }
  const sales = [...salesById.values()];
  const postedSales = sales.filter((s) => s.status === 'POSTED');
  const draftSales = sales.filter((s) => s.status === 'DRAFT');
  if (postedSales.length > 0) {
    blockers.push(
      `Coffee from this shipment has been sold on ${postedSales.length} sales invoice${postedSales.length === 1 ? '' : 's'}. A sale is the customer's document: delete those invoices first if they were mistakes, and the shipment can then be deleted.`,
    );
  }
  if (draftSales.length > 0) {
    blockers.push(`${draftSales.length} draft sales invoice${draftSales.length === 1 ? ' holds' : 's hold'} coffee from this shipment. Delete or change ${draftSales.length === 1 ? 'it' : 'them'} first.`);
  }
  const creditNotes = [...new Map(creditLines.map((l) => [l.creditNote.id, { id: l.creditNote.id, number: l.creditNote.creditNoteNumber }])).values()];
  if (creditNotes.length > 0) blockers.push(`Coffee from this shipment came back on ${creditNotes.length} credit note${creditNotes.length === 1 ? '' : 's'}.`);
  const stockCounts = [...new Map(countLines.map((l) => [l.stockCount.id, { id: l.stockCount.id, number: l.stockCount.countNumber }])).values()];
  if (stockCounts.length > 0 || adjustments > 0) {
    blockers.push('This shipment’s coffee has been counted or adjusted in a stock count. Cancel that count first.');
  }
  const reservedWithoutSale = batches.some((b) => dec(b.allocatedQuantityKg).greaterThan(0)) && draftSales.length === 0;

  // --- Transfers ---------------------------------------------------------------
  const ours = new Set(batchIds);
  const transfers: DeletePreview['transfers'] = [];
  for (const t of new Map(transferLines.map((l) => [l.stockTransfer.id, l.stockTransfer])).values()) {
    if (t.workflowState === 'CANCELLED') continue;
    const onlyOurs = t.lines.every((l) => ours.has(l.batchId));
    const action: DeletePreview['transfers'][number]['action'] = !onlyOurs
      ? 'block'
      : t.workflowState === 'DRAFT'
        ? 'delete'
        : t.workflowState === 'APPROVED'
          ? 'cancel'
          : t.workflowState === 'RECEIVED'
            ? 'reverse'
            : 'block';
    transfers.push({ id: t.id, number: t.transferNumber, state: t.workflowState, action });
  }
  const blockedTransfers = transfers.filter((t) => t.action === 'block');
  if (blockedTransfers.length > 0) {
    blockers.push(
      `${blockedTransfers.map((t) => t.number).join(', ')} moved other coffee too, or ${blockedTransfers.length === 1 ? 'is' : 'are'} still on the road. Receive or cancel ${blockedTransfers.length === 1 ? 'that transfer' : 'those transfers'} first.`,
    );
  }
  if (reservedWithoutSale && transfers.every((t) => t.action !== 'cancel')) {
    blockers.push('Some of this shipment’s coffee is held for another document. Release it first.');
  }

  // --- Money: supplier payments and debit notes --------------------------------
  const supplierPayments = payments.map((p) => ({ id: p.payment.id, number: p.payment.paymentNumber, amount: toMoney(p.amount).toFixed(2), currency: p.payment.currency }));
  if (supplierPayments.length > 0) {
    blockers.push(
      `The supplier has been paid against this shipment (${supplierPayments.map((p) => `${p.number} ${p.currency} ${p.amount}`).join(', ')}). Money paid out does not disappear with a shipment: delete that payment first if it was a mistake, or keep the shipment.`,
    );
  }
  if (debitNotes.length > 0) blockers.push(`${debitNotes.length} supplier debit note${debitNotes.length === 1 ? '' : 's'} ${debitNotes.length === 1 ? 'is' : 'are'} raised against this shipment. Delete ${debitNotes.length === 1 ? 'it' : 'them'} first.`);

  // --- Costs --------------------------------------------------------------------
  const settlements = await getExpenseSettlements(companyId, expenses as never);
  const costs: DeletePreview['costs'] = expenses.map((e) => {
    const s = settlements.get(e.id);
    return {
      id: e.id,
      number: e.expenseNumber,
      status: e.status,
      amount: toMoney(e.amount).toFixed(2),
      currency: e.currency,
      settlement: e.status === 'DRAFT' ? 'DRAFT' : (s?.status ?? 'UNPAID'),
      paidFrom: s?.paidFrom ?? null,
    };
  });
  const paidCosts = costs.filter((c) => c.settlement === 'PAID' || c.settlement === 'PARTIAL');
  if (paidCosts.length > 0) {
    blockers.push(
      `${paidCosts.length} cost${paidCosts.length === 1 ? ' on this shipment has' : 's on this shipment have'} been paid (${paidCosts.map((c) => `${c.number} ${c.currency} ${c.amount}${c.paidFrom ? ` from ${c.paidFrom}` : ''}`).join(', ')}). Paid money does not come back because a shipment is deleted: delete ${paidCosts.length === 1 ? 'that cost' : 'those costs'} from Expenses first if ${paidCosts.length === 1 ? 'it was' : 'they were'} entered by mistake.`,
    );
  }
  const unpaidPosted = costs.filter((c) => c.settlement === 'UNPAID');
  if (unpaidPosted.length > 0 && !access.canReverseCosts) {
    blockers.push('This shipment has unpaid costs, and deleting it would reverse them — that needs permission to post expenses.');
  }

  // --- What will be undone -----------------------------------------------------
  const receiptRows = receipts.map((r) => ({
    id: r.id,
    number: r.grnNumber,
    status: r.status,
    kg: toQuantity(sum(r.lines.map((l) => dec(l.quantityKg)))).toString(),
    warehouse: r.warehouse.name,
  }));
  const posted = receiptRows.filter((r) => r.status === 'POSTED');
  const receivedKg = toQuantity(sum(batches.map((b) => dec(b.receivedQuantityKg))));
  if (posted.length > 0) {
    willUndo.push(
      `Goods receipt${posted.length === 1 ? '' : 's'} ${posted.map((r) => `${r.number} (${Number(r.kg).toLocaleString('en-US')} KG, ${r.warehouse})`).join(', ')} — reversed, and the coffee taken back out of stock`,
    );
  }
  for (const t of transfers.filter((x) => x.action !== 'block')) {
    willUndo.push(`Warehouse transfer ${t.number} — ${t.action === 'reverse' ? 'reversed, the coffee moved back' : t.action === 'cancel' ? 'cancelled' : 'draft removed'}`);
  }
  if (unpaidPosted.length > 0) willUndo.push(`${unpaidPosted.length} unpaid cost${unpaidPosted.length === 1 ? '' : 's'} (${unpaidPosted.map((c) => c.number).join(', ')}) — reversed; nothing was paid on ${unpaidPosted.length === 1 ? 'it' : 'them'}`);
  const draftCosts = costs.filter((c) => c.settlement === 'DRAFT');
  if (draftCosts.length > 0) willUndo.push(`${draftCosts.length} draft cost${draftCosts.length === 1 ? '' : 's'} — removed`);
  const draftReceipts = receiptRows.filter((r) => r.status === 'DRAFT');
  if (draftReceipts.length > 0) willUndo.push(`${draftReceipts.length} draft goods receipt${draftReceipts.length === 1 ? '' : 's'} — removed`);

  const containers = [
    ...new Set([...contract.shipments.flatMap((s) => s.containerList.map((c) => c.containerNumber)), ...batches.map((b) => b.container?.containerNumber).filter((n): n is string => Boolean(n))]),
  ];
  if (contract.status !== 'POSTED') blockers.push('This purchase order is not approved, so it has no shipment to delete. Delete the draft order itself.');

  return {
    contractId: contract.id,
    reference: contract.contractReference,
    supplier: contract.vendor.vendorName,
    containers,
    containerCount: Math.max(contract.shipments.length, containers.length),
    batches: batches.length,
    receipts: receiptRows,
    receivedKg: receivedKg.toString(),
    stockMovements: movements,
    costs,
    transfers,
    sales,
    creditNotes,
    stockCounts,
    supplierPayments,
    debitNotes: debitNotes.map((d) => ({ id: d.id, number: d.creditNoteNumber })),
    blockers,
    willUndo,
    canDelete: blockers.length === 0,
  };
}

/**
 * Delete the shipment: everything the preview listed, in dependency order,
 * inside one transaction.
 *
 *   1. drafts that name it go: goods receipts, costs, transfers;
 *   2. transfers of its coffee are cancelled or moved back;
 *   3. its goods receipts are reversed, newest first — the coffee leaves
 *      stock at what it is carried at, batches and the PO's receipt count go
 *      back to nothing received;
 *   4. its unpaid costs are reversed, with the landed cost they added;
 *   5. the order is reversed — its payable taken back, batches retired, its
 *      shipments off the loading sheet — and, unless the order is to go too,
 *      opened again as a draft under the same reference.
 */
export async function deleteShipment(params: {
  companyId: string;
  userId: string;
  contractId: string;
  mode: DeleteMode;
  reason: string;
  memo?: string | null;
  canReverseCosts?: boolean;
}): Promise<{ contractId: string; draftId: string | null; undone: string[] }> {
  const reasonText = [params.reason?.trim(), params.memo?.trim()].filter(Boolean).join(' — ');
  if (reasonText.length < 3) throw new BusinessRuleError('Choose why this shipment is being deleted.');
  const reason = `Shipment deleted: ${reasonText}`;

  return transaction(async (tx) => {
    // One delete of an order at a time; a second press waits, then finds it gone.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM purchase_contracts WHERE "id" = ${params.contractId} AND "companyId" = ${params.companyId} FOR UPDATE
    `;
    if (locked.length === 0) throw new NotFoundError('Shipment');

    const preview = await getShipmentDeletePreview(params.companyId, params.contractId, { canReverseCosts: params.canReverseCosts ?? true });
    if (!preview.canDelete) throw new BusinessRuleError(preview.blockers.join(' '));

    const common = { companyId: params.companyId, userId: params.userId };

    // 1. Drafts.
    for (const r of preview.receipts.filter((x) => x.status === 'DRAFT')) await deleteDraftGoodsReceipt({ id: r.id, ...common });
    for (const c of preview.costs.filter((x) => x.settlement === 'DRAFT')) await deleteDraftExpense({ id: c.id, ...common });
    for (const t of preview.transfers.filter((x) => x.action === 'delete')) await deleteDraftStockTransfer({ id: t.id, ...common });

    // 2. Transfers.
    for (const t of preview.transfers.filter((x) => x.action === 'cancel')) await cancelStockTransfer({ id: t.id, ...common, reason });
    for (const t of preview.transfers.filter((x) => x.action === 'reverse')) await reverseReceivedStockTransferIn(tx, { id: t.id, ...common, reason });

    // 3. Goods receipts, newest first.
    for (const r of [...preview.receipts].filter((x) => x.status === 'POSTED').reverse()) await reverseGoodsReceipt({ id: r.id, ...common, reason });

    // 4. Unpaid costs.
    for (const c of preview.costs.filter((x) => x.settlement === 'UNPAID')) await reverseExpense({ id: c.id, ...common, reason });

    // 5. The order.
    let draftId: string | null = null;
    if (params.mode === 'keep-order') {
      draftId = (await correctPurchaseContract({ id: params.contractId, ...common, reason })).id;
    } else {
      await reversePurchaseContract({ id: params.contractId, ...common, reason });
    }

    const undone = [...preview.willUndo, params.mode === 'keep-order' ? 'The purchase order — kept as a draft to correct and approve again' : 'The purchase order — deleted'];
    await writeAudit(tx, {
      companyId: params.companyId,
      userId: params.userId,
      action: 'SHIPMENT_DELETED',
      entityType: 'PurchaseContract',
      entityId: params.contractId,
      before: {
        reference: preview.reference,
        supplier: preview.supplier,
        containers: preview.containers,
        receivedKg: preview.receivedKg,
        receipts: preview.receipts,
        costs: preview.costs,
        transfers: preview.transfers,
      },
      after: { mode: params.mode, reason: params.reason, memo: params.memo ?? null, draftId, undone },
    });

    return { contractId: params.contractId, draftId, undone };
  }, 180_000);
}
