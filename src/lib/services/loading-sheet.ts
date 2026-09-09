import { prisma } from '@/lib/db';
import { Decimal, dec, toQuantity, toMoney } from '@/lib/money';

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
 * One row per batch, because a batch is the smallest thing that has its own
 * container, its own lot and its own buyer. Dubai works container to
 * container, so a row is usually a whole container; Morocco splits a container
 * across many customers, so a row carries its allocations underneath it.
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
};

export type LoadingSheetRow = {
  batchId: string;
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

  itemName: string;
  origin: string;
  destination: string | null;
  lotNumber: string;
  batchNumber: string;
  containerNumber: string | null;
  containers: number;

  quantityKg: Decimal;
  soldKg: Decimal;
  reservedKg: Decimal;
  availableKg: Decimal;
  bags: number;

  status: string;
  documentStatus: string;
  shippingLine: string | null;
  bookingNumber: string | null;
  billOfLading: string | null;
  etaDate: Date | null;
  remarks: string | null;

  /** Derived from the batch's own allocations, never stored. */
  saleStatus: 'UNSOLD' | 'PARTIALLY_SOLD' | 'FULLY_SOLD';
  /** Derived from what has actually been received against those invoices. */
  paymentStatus: 'NONE' | 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERDUE';
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

  const batches = await prisma.batch.findMany({
    where: { companyId, purchaseContract: { status: 'POSTED' } },
    orderBy: [{ createdAt: 'desc' }, { batchNumber: 'asc' }],
    include: {
      item: { select: { itemName: true, originCountry: true } },
      lot: { select: { lotNumber: true } },
      container: { select: { containerNumber: true } },
      purchaseContract: {
        select: {
          id: true,
          contractNumber: true,
          contractReference: true,
          contractDate: true,
          destination: true,
          vendor: { select: { vendorName: true } },
        },
      },
      shipment: {
        select: {
          id: true,
          status: true,
          documentStatus: true,
          bookingNumber: true,
          billOfLading: true,
          etaDate: true,
          destination: true,
          portOfDischarge: true,
          containers: true,
          notes: true,
          shippingLine: { select: { name: true } },
          customer: { select: { customerName: true } },
        },
      },
      invoiceLines: {
        where: { salesInvoice: { status: 'POSTED' } },
        select: {
          quantityKg: true,
          lineTotal: true,
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
  });

  const today = new Date();

  return batches.map((batch) => {
    // One allocation per invoice, so a customer who bought twice from the same
    // batch shows twice — which is what actually happened.
    const byInvoice = new Map<string, Allocation>();

    for (const line of batch.invoiceLines) {
      const invoice = line.salesInvoice;
      const existing = byInvoice.get(invoice.id);

      if (existing) {
        existing.quantityKg = toQuantity(existing.quantityKg.plus(line.quantityKg));
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
      });
    }

    const allocations = [...byInvoice.values()].sort(
      (a, b) => a.invoiceDate.getTime() - b.invoiceDate.getTime(),
    );

    const quantityKg = toQuantity(batch.orderedQuantityKg);
    const soldKg = toQuantity(batch.soldQuantityKg);
    const reservedKg = toQuantity(batch.allocatedQuantityKg);
    const availableKg = toQuantity(batch.availableQuantityKg);

    // Sold or unsold is arithmetic on the allocations, not a label somebody
    // typed. A container is only "sold" when every kilogram of it has gone.
    const saleStatus: LoadingSheetRow['saleStatus'] =
      soldKg.lessThanOrEqualTo('0.001')
        ? 'UNSOLD'
        : soldKg.greaterThanOrEqualTo(quantityKg.minus('0.001'))
          ? 'FULLY_SOLD'
          : 'PARTIALLY_SOLD';

    const names = [...new Set(allocations.map((a) => a.customerName))];
    const consignee =
      names.length === 0
        ? (batch.shipment.customer?.customerName ?? null)
        : names.length === 1
          ? names[0]
          : `${names.length} customers`;

    return {
      batchId: batch.id,
      shipmentId: batch.shipmentId,
      contractId: batch.purchaseContract.id,

      contractDate: batch.purchaseContract.contractDate,
      contractReference: batch.purchaseContract.contractReference,
      contractNumber: batch.purchaseContract.contractNumber,

      exporter: batch.purchaseContract.vendor.vendorName,
      importer: company.name,
      consignee,
      allocations,

      itemName: batch.item.itemName,
      origin: batch.item.originCountry,
      destination:
        batch.shipment.destination ??
        batch.shipment.portOfDischarge ??
        batch.purchaseContract.destination,
      lotNumber: batch.lot.lotNumber,
      batchNumber: batch.batchNumber,
      containerNumber: batch.container?.containerNumber ?? null,
      containers: batch.container ? 1 : batch.shipment.containers,

      quantityKg,
      soldKg,
      reservedKg,
      availableKg,
      bags: batch.orderedBags,

      status: batch.shipment.status,
      documentStatus: batch.shipment.documentStatus,
      shippingLine: batch.shipment.shippingLine?.name ?? null,
      bookingNumber: batch.shipment.bookingNumber,
      billOfLading: batch.shipment.billOfLading,
      etaDate: batch.shipment.etaDate,
      remarks: batch.shipment.notes,

      saleStatus,
      paymentStatus: rollUpPayment(allocations),
    };
  });
}
