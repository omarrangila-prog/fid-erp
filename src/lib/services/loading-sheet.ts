import { prisma, type Tx } from '@/lib/db';
import { Decimal, dec, toQuantity, toMoney } from '@/lib/money';
import { repairSharedContainerAssignments } from '@/lib/services/shipment';

function uniqueNames(names: Iterable<string>): string {
  return [...new Set(names)].filter(Boolean).sort((a, b) => a.localeCompare(b)).join(', ');
}


/**
 * The loading / contract follow-up sheet.
 *
 * This is the screen the client actually lives in, and it is a *derived* view:
 * every column is read from the document that already holds it — the purchase
 * contract, the shipment, the sales invoices raised against the batch — so
 * nothing on it is typed twice. Updating a shipment's ETA updates the sheet;
 * posting a sale fills in the consignee and moves the sold figures; receiving
 * a payment moves the payment status. There is no separate loading-sheet
 * record to fall out of step with the rest of the system.
 *
 * One row per shipment — which is to say per purchase order, since approving
 * an order creates its shipment. A contract for two coffees in two containers
 * is one consignment: one supplier, one reference, one booking, one ETA, two
 * containers in total. It used to be one row per batch, so a two-item order
 * appeared twice and carried "2 containers" on each line, which read as four.
 * The item lines now sit under the shipment they belong to, and everything
 * that belongs to the consignment — containers, status, shipping details,
 * customers it was sold to — is stated once.
 */

export type Allocation = {
  customerName: string;
  customerId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date;
  quantityKg: Decimal;
  amount: Decimal;
  currency: string;
  outstanding: Decimal;
  settlement: 'PAID' | 'PARTIAL' | 'UNPAID' | 'OVERDUE';
  warehouseNames: string;
};

/** One coffee on the consignment: a purchase-order line, received as a batch. */
export type LoadingSheetLine = {
  batchId: string;
  itemName: string;
  origin: string | null;
  lotNumber: string;
  batchNumber: string;
  /**
   * True while the supplier has not yet said which coffee fills the contract,
   * so the lot and batch above are a placeholder the system issued. The sheet
   * says so rather than showing a number that looks like the supplier's.
   */
  traceabilityPending: boolean;
  containerNumber: string | null;
  quantityKg: Decimal;
  receivedKg: Decimal;
  soldKg: Decimal;
  availableKg: Decimal;
  bags: number;
  bagWeightKg: Decimal;
  warehouseNames: string;
};

export type LoadingSheetRow = {
  shipmentId: string;
  contractId: string;

  contractDate: Date;
  /** The supplier's own contract number, which is what they quote back. */
  contractReference: string;
  /** FID's internal document number. Both are kept and both are searchable. */
  contractNumber: string;

  exporter: string;
  /** The FID company doing the importing; never typed, always the company. */
  importer: string;
  /** Blank until sold. One name when one customer took it, a count when many. */
  consignee: string | null;
  allocations: Allocation[];

  /** The coffees on the order, one line each. Never fewer than one. */
  lines: LoadingSheetLine[];
  /** Origin of the consignment: the order's, or the coffees' when it names none. */
  origin: string;
  destination: string | null;
  /** Container numbers recorded so far, across every line. */
  containerNumbers: string[];
  /**
   * Containers on the consignment, stated once. The number on the order when
   * it was given, otherwise however many distinct containers the lines carry.
   */
  containers: number;

  /** Totals across the lines. */
  quantityKg: Decimal;
  receivedKg: Decimal;
  soldKg: Decimal;
  reservedKg: Decimal;
  availableKg: Decimal;
  bags: number;

  status: string;
  documentStatus: string;
  shippingLine: string | null;
  shippingLineId: string | null;
  bookingNumber: string | null;
  /** Shown on the sheet so a container can be tracked without opening it. */
  portOfLoading: string | null;
  portOfDischarge: string | null;
  billOfLading: string | null;
  etaDate: Date | null;
  remarks: string | null;

  /** Derived from the lines' own allocations, never stored. */
  saleStatus: 'UNSOLD' | 'PARTIALLY_SOLD' | 'FULLY_SOLD';
  /** Derived from what has actually been received against those invoices. */
  paymentStatus: 'NONE' | 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERDUE';
  warehouseNames: string;
};

/**
 * Settlement of one invoice, from the receipts posted against it and its own
 * due date — never a stored flag that somebody has to remember to update.
 */
function settlementOf(
  total: Decimal,
  received: Decimal,
  credited: Decimal,
  dueDate: Date | null,
  today: Date,
): Allocation['settlement'] {
  const outstanding = toMoney(total.minus(received).minus(credited));
  if (outstanding.lessThanOrEqualTo('0.005')) return 'PAID';
  if (dueDate && dueDate < today) return 'OVERDUE';
  return received.greaterThan('0.005') ? 'PARTIAL' : 'UNPAID';
}

/** The worst position among a batch's invoices is the one worth showing. */
function rollUpPayment(allocations: Allocation[]): LoadingSheetRow['paymentStatus'] {
  if (allocations.length === 0) return 'NONE';
  if (allocations.some((a) => a.settlement === 'OVERDUE')) return 'OVERDUE';
  if (allocations.every((a) => a.settlement === 'PAID')) return 'PAID';
  if (allocations.some((a) => a.settlement === 'PAID' || a.settlement === 'PARTIAL')) return 'PARTIAL';
  return 'UNPAID';
}

export async function getLoadingSheet(companyId: string): Promise<LoadingSheetRow[]> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    select: { name: true },
  });

  // Repair the known duplicate-container assignment without deleting anything.
  await repairSharedContainerAssignments(prisma as Tx, companyId);

  const shipments = await prisma.shipment.findMany({
    where: { companyId, purchaseContract: { status: 'POSTED' } },
    orderBy: [{ createdAt: 'desc' }],
    include: {
      shippingLine: { select: { id: true, name: true } },
      customer: { select: { customerName: true } },
      containerList: { orderBy: { createdAt: 'asc' }, select: { id: true, containerNumber: true } },
      purchaseContract: {
        select: {
          id: true,
          contractNumber: true,
          contractReference: true,
          contractDate: true,
          origin: true,
          destination: true,
          portOfLoading: true,
          vendor: { select: { vendorName: true } },
        },
      },
      batches: {
        where: { status: 'ACTIVE' },
        orderBy: [{ createdAt: 'asc' }, { batchNumber: 'asc' }],
        include: {
          item: { select: { itemName: true, originCountry: true } },
          lot: { select: { lotNumber: true } },
          container: { select: { containerNumber: true } },
          warehouse: { select: { name: true } },
          balances: {
            where: {
              OR: [{ onHandKg: { gt: 0 } }, { availableKg: { gt: 0 } }, { reservedKg: { gt: 0 } }],
            },
            select: { warehouse: { select: { name: true } } },
          },
          invoiceLines: {
            where: { salesInvoice: { status: 'POSTED' } },
            select: {
              quantityKg: true,
              warehouse: { select: { name: true } },
              salesInvoice: {
                select: {
                  id: true,
                  invoiceNumber: true,
                  invoiceDate: true,
                  dueDate: true,
                  currency: true,
                  totalAmount: true,
                  customerId: true,
                  customer: { select: { customerName: true } },
                  allocations: {
                    where: { receipt: { status: 'POSTED' } },
                    select: { amount: true },
                  },
                  creditNotes: { where: { status: 'POSTED' }, select: { totalAmount: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const today = new Date();

  return shipments
    .filter((shipment) => shipment.batches.length > 0)
    .map((shipment) => {
      // One allocation per invoice across the whole consignment, so a
      // customer who bought two coffees from it on one invoice shows once
      // with both quantities, and one who bought twice shows twice — which
      // is what actually happened.
      const byInvoice = new Map<string, Allocation>();

      for (const batch of shipment.batches) {
        for (const line of batch.invoiceLines) {
          const invoice = line.salesInvoice;
          const existing = byInvoice.get(invoice.id);

          if (existing) {
            existing.quantityKg = toQuantity(existing.quantityKg.plus(line.quantityKg));
            if (line.warehouse?.name && !existing.warehouseNames.includes(line.warehouse.name)) {
              existing.warehouseNames = uniqueNames(
                [...existing.warehouseNames.split(', '), line.warehouse.name],
              );
            }
            continue;
          }

          const total = dec(invoice.totalAmount);
          const received = invoice.allocations.reduce((sum, a) => sum.plus(a.amount), new Decimal(0));
          const credited = invoice.creditNotes.reduce((sum, n) => sum.plus(n.totalAmount), new Decimal(0));

          byInvoice.set(invoice.id, {
            customerName: invoice.customer.customerName,
            customerId: invoice.customerId,
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceDate: invoice.invoiceDate,
            quantityKg: toQuantity(line.quantityKg),
            amount: toMoney(total),
            currency: invoice.currency,
            outstanding: toMoney(total.minus(received).minus(credited)),
            settlement: settlementOf(total, received, credited, invoice.dueDate, today),
            warehouseNames: line.warehouse?.name ?? '',
          });
        }
      }

      const allocations = [...byInvoice.values()].sort(
        (a, b) => a.invoiceDate.getTime() - b.invoiceDate.getTime(),
      );

      const lines: LoadingSheetLine[] = shipment.batches.map((batch) => ({
        batchId: batch.id,
        itemName: batch.item.itemName,
        origin: batch.item.originCountry,
        lotNumber: batch.lot.lotNumber,
        batchNumber: batch.batchNumber,
        traceabilityPending: batch.traceabilityPending,
        containerNumber: batch.container?.containerNumber ?? null,
        quantityKg: toQuantity(batch.orderedQuantityKg),
        receivedKg: toQuantity(batch.receivedQuantityKg),
        soldKg: toQuantity(batch.soldQuantityKg),
        availableKg: toQuantity(batch.availableQuantityKg),
        bags: batch.orderedBags,
        bagWeightKg: toQuantity(batch.bagWeightKg),
        warehouseNames: uniqueNames([
          ...batch.balances.map((row) => row.warehouse.name),
          batch.warehouse?.name ?? '',
        ]),
      }));

      const sumOf = (pick: (line: LoadingSheetLine) => Decimal) =>
        toQuantity(lines.reduce((total, line) => total.plus(pick(line)), new Decimal(0)));
      const quantityKg = sumOf((l) => l.quantityKg);
      const receivedKg = sumOf((l) => l.receivedKg);
      const soldKg = sumOf((l) => l.soldKg);
      const availableKg = sumOf((l) => l.availableKg);
      const reservedKg = toQuantity(
        shipment.batches.reduce((total, b) => total.plus(b.allocatedQuantityKg), new Decimal(0)),
      );
      const bags = lines.reduce((total, line) => total + line.bags, 0);

      // Containers are a fact about the consignment, not about each coffee on
      // it. Numbers recorded on the shipment itself are included even when a
      // batch has not been pointed at them yet, otherwise two boxes collapse
      // into one on the sheet.
      const seen = new Set<string>();
      const containerNumbers: string[] = [];
      for (const number of [
        ...shipment.containerList.map((container) => container.containerNumber),
        ...lines.map((line) => line.containerNumber),
      ]) {
        if (!number || seen.has(number)) continue;
        seen.add(number);
        containerNumbers.push(number);
      }
      const containers = shipment.containers > 0 ? shipment.containers : containerNumbers.length;

      const origins = [...new Set(lines.map((l) => l.origin).filter((o): o is string => Boolean(o)))];
      const origin = shipment.purchaseContract.origin?.trim() || origins.join(', ');

      // Sold or unsold is arithmetic on the allocations, not a label somebody
      // typed. A consignment is only "sold" when every kilogram of it has gone.
      const saleStatus: LoadingSheetRow['saleStatus'] =
        soldKg.lessThanOrEqualTo('0.001')
          ? 'UNSOLD'
          : soldKg.greaterThanOrEqualTo(quantityKg.minus('0.001'))
            ? 'FULLY_SOLD'
            : 'PARTIALLY_SOLD';

      const names = [...new Set(allocations.map((a) => a.customerName))];
      const consignee =
        names.length === 0
          ? (shipment.customer?.customerName ?? null)
          : names.length === 1
            ? names[0]
            : `${names.length} customers`;

      return {
        shipmentId: shipment.id,
        contractId: shipment.purchaseContract.id,

        contractDate: shipment.purchaseContract.contractDate,
        contractReference: shipment.purchaseContract.contractReference,
        contractNumber: shipment.purchaseContract.contractNumber,

        exporter: shipment.purchaseContract.vendor.vendorName,
        importer: company.name,
        consignee,
        allocations,

        lines,
        origin,
        destination:
          shipment.destination ?? shipment.portOfDischarge ?? shipment.purchaseContract.destination,
        containerNumbers,
        containers,

        quantityKg,
        receivedKg,
        soldKg,
        reservedKg,
        availableKg,
        bags,

        status: shipment.status,
        documentStatus: shipment.documentStatus,
        shippingLine: shipment.shippingLine?.name ?? null,
        shippingLineId: shipment.shippingLineId,
        bookingNumber: shipment.bookingNumber,
        portOfLoading: shipment.portOfLoading ?? shipment.purchaseContract.portOfLoading,
        portOfDischarge: shipment.portOfDischarge,
        billOfLading: shipment.billOfLading,
        etaDate: shipment.etaDate,
        remarks: shipment.notes,

        saleStatus,
        paymentStatus: rollUpPayment(allocations),
        warehouseNames: uniqueNames(lines.flatMap((line) => line.warehouseNames.split(', '))),
      };
    });
}
