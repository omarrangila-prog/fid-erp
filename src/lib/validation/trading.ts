import { z } from 'zod';
import {
  currencyCode,
  cuid,
  dateString,
  decimalString,
  optionalCuid,
  optionalDateString,
  optionalDecimalString,
  optionalText,
  positiveInt,
  requiredText,
  requiredChoice,
} from '@/lib/validation/common';

/** Purchase, goods receipt, sales and transfer schemas. */

/**
 * A contract line.
 *
 * Lot and batch are optional here and that is deliberate. At contract stage
 * the trade is a quantity of a grade at a price; which physical lot fills it
 * is decided when the supplier loads, often weeks later. Demanding a lot
 * number before the contract could be saved meant people invented one, and an
 * invented lot number is worse than a blank — it follows the coffee into the
 * warehouse and onto the customer's invoice.
 *
 * One of the two becomes mandatory on the goods receipt, where the coffee is
 * physically in front of someone and stock traceability begins.
 */
export const purchaseLineSchema = z.object({
  /** The saved row, when an approved order is corrected. */
  id: optionalCuid,
  itemId: requiredChoice('Coffee'),
  lotNumber: optionalText(60),
  batchNumber: optionalText(60),
  containerNumber: optionalText(40),
  quantity: decimalString('Quantity'),
  unit: z.enum(['KG', 'MT', 'BAG']),
  unitPrice: decimalString('Price', { allowZero: true }),
  bags: positiveInt('Bags').optional(),
  bagWeightKg: optionalDecimalString('Bag weight'),
  taxCodeId: optionalCuid,
  notes: optionalText(300),
});

export const purchaseContractSchema = z.object({
  // Optional. The system already issues a unique FID number; making the
  // user invent a second unique code before they can save is friction for
  // nothing. Left blank it becomes the FID number.
  contractReference: optionalText(60),
  supplierContractNo: optionalText(60),
  contractDate: dateString('Contract date'),
  vendorId: cuid,
  origin: optionalText(120),
  currency: currencyCode,
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  freightAmount: optionalDecimalString('Freight'),
  otherCharges: optionalDecimalString('Other direct charges'),
  incoterm: z.enum(['EXW', 'FCA', 'FOB', 'CFR', 'CIF', 'DAP', 'DDP']).default('FOB'),
  portOfLoading: optionalText(120),
  destination: optionalText(120),
  /**
   * When the supplier expects to be paid, as a date.
   *
   * Not a Net 7 / Net 30 / Net 60 selector: the client does not trade on
   * standard terms and was being made to pick one of three answers none of
   * which was true. Left blank, the contract is simply due on its own date.
   */
  dueDate: optionalDateString,
  /** §1: "Number of Containers, if known" — and often it is not. */
  containers: positiveInt('Number of containers').optional(),
  notes: optionalText(1000),
  lines: z.array(purchaseLineSchema).min(1, 'Add at least one coffee line.'),
  /** Why an approved order was corrected, for the audit log. */
  correctionReason: optionalText(300),
});

/**
 * A goods receipt line.
 *
 * `batchId` says which contract line this quantity belongs to. The lot and
 * batch numbers say what it actually arrived as — and because a line may
 * appear more than once with different numbers, one contract line of 42 MT can
 * land as 21 MT under lot 120229 and 21 MT under lot 120230.
 */
export const goodsReceiptLineSchema = z.object({
  batchId: cuid,
  quantityKg: decimalString('Quantity received'),
  lotNumber: optionalText(60),
  batchNumber: optionalText(60),
  containerNumber: optionalText(40),
  bags: positiveInt('Bags').optional(),
  notes: optionalText(300),
});

/*
 * Note what is *not* here: a rule that one of lot or batch must be present.
 *
 * Whether it is required depends on the batch being received — if the contract
 * already named the lot, asking again is asking the user to retype the
 * purchase order — and this schema cannot see the batch. The rule lives in the
 * goods receipt service, which can, and the form mirrors it so the user is
 * told inline rather than on submit.
 */

export const goodsReceiptSchema = z.object({
  purchaseContractId: cuid,
  warehouseId: cuid,
  receiptDate: dateString('Receipt date'),
  reference: optionalText(60),
  notes: optionalText(600),
  lines: z.array(goodsReceiptLineSchema).min(1, 'Add at least one line to receive.'),
});

/** One more container on an approved order. */
export const addContainerSchema = z.object({
  purchaseContractId: cuid,
  itemId: cuid,
  quantityKg: decimalString('Quantity'),
  unitPriceKg: decimalString('Price per KG'),
  bags: positiveInt('Bags').optional(),
  containerNumber: optionalText(40),
  lotNumber: optionalText(60),
  batchNumber: optionalText(60),
  reason: optionalText(300),
});

/** One container corrected on an approved order, before it is received. */
export const editContainerSchema = z.object({
  shipmentId: cuid,
  quantityKg: optionalDecimalString('Quantity'),
  bags: positiveInt('Bags').optional(),
  containerNumber: optionalText(40),
  lotNumber: optionalText(60),
  batchNumber: optionalText(60),
  reason: optionalText(300),
});

/** One ordered line divided into containers, on an approved order. */
export const splitContractLineSchema = z.object({
  purchaseContractId: cuid,
  lineId: cuid,
  parts: z
    .array(z.object({ quantityKg: decimalString('Quantity'), containerNumber: optionalText(40) }))
    .min(2, 'Split into at least two containers.'),
});

/**
 * Receiving container by container: each row names its own warehouse, so
 * three containers landing together can go to two stores in one operation.
 */
export const receiveContainersSchema = z.object({
  purchaseContractId: cuid,
  receiptDate: dateString('Receipt date'),
  reference: optionalText(60),
  notes: optionalText(600),
  lines: z
    .array(goodsReceiptLineSchema.extend({ warehouseId: requiredChoice('Warehouse') }))
    .min(1, 'Tick at least one container to receive.'),
});

export const salesLineSchema = z.object({
  batchId: requiredChoice('Batch'),
  warehouseId: requiredChoice('Warehouse'),
  quantity: decimalString('Quantity'),
  unit: z.enum(['KG', 'MT', 'BAG']),
  unitPrice: decimalString('Price'),
  bags: positiveInt('Bags').optional(),
  taxCodeId: optionalCuid,
  notes: optionalText(300),
});

export const salesInvoiceSchema = z.object({
  invoiceDate: dateString('Invoice date'),
  customerId: cuid,
  shipmentId: optionalCuid,
  currency: currencyCode,
  rateToUsd: decimalString('Exchange rate'),
  rateLocalPerUsd: decimalString('Local exchange rate'),
  /**
   * The date the money is due, chosen from a calendar.
   *
   * The client asked for this directly: an invoice dated the 10th may be due
   * on the 15th, and a cash sale is due the day it is raised. Neither is
   * Net 7, Net 30 or Net 60. Left blank it falls to the invoice date, which is
   * the honest reading of an invoice with no stated terms.
   */
  dueDate: optionalDateString,
  /**
   * Cash or credit, as the client asks for at the bottom of the invoice.
   *
   * A cash sale settles as it is raised — posting it raises the receipt too —
   * so it also has to say which account the money went into.
   */
  paymentType: z.enum(['CASH', 'CREDIT']).default('CREDIT'),
  cashBankAccountId: optionalCuid,
  /** Blank issues the next free number. Typed values stay as entered. */
  invoiceNumber: optionalText(60),
  reference: optionalText(60),
  notes: optionalText(1000),
  lines: z.array(salesLineSchema).min(1, 'Add at least one coffee line.'),
});

export const stockTransferSchema = z.object({
  transferDate: dateString('Transfer date'),
  fromWarehouseId: cuid,
  toWarehouseId: cuid,
  notes: optionalText(600),
  lines: z
    .array(
      z.object({
        batchId: cuid,
        quantityKg: decimalString('Quantity'),
        bags: positiveInt('Bags').optional(),
        notes: optionalText(300),
      }),
    )
    .min(1, 'Add at least one batch to transfer.'),
});

/**
 * Marking a consignment loaded.
 *
 * Everything the purchase order deliberately stopped asking for, asked at the
 * moment it exists. The arrival date and the carrier are required because a
 * consignment marked loaded that cannot say when it lands or who is carrying
 * it tells the loading sheet's reader nothing.
 */
export const markLoadedSchema = z
  .object({
    loadingDate: dateString('Loading date'),
    etaDate: dateString('Estimated arrival'),
    shippingLineId: requiredChoice('Shipping line'),
    bookingNumber: optionalText(60),
    billOfLading: optionalText(60),
    /** Every container on the consignment; "3 containers" means three numbers. */
    containerNumbers: z.array(optionalText(40)).max(40).optional(),
    vesselName: optionalText(120),
    voyageNumber: optionalText(60),
    portOfLoading: optionalText(120),
    portOfDischarge: optionalText(120),
    notes: optionalText(600),
  })
  .superRefine((data, ctx) => {
    const identified =
      Boolean(data.bookingNumber?.trim()) ||
      Boolean(data.billOfLading?.trim()) ||
      (data.containerNumbers ?? []).some((value) => Boolean(value?.trim()));
    if (!identified) {
      ctx.addIssue({
        code: 'custom',
        path: ['bookingNumber'],
        message:
          'Identify the consignment with a booking or B/L number, or with the container numbers. Loaded cannot be recorded without one of those.',
      });
    }
  });

export const shipmentStatusSchema = z.object({
  toStatus: z.enum([
    'CONTRACT_CREATED',
    'AWAITING_LOADING',
    'LOADED',
    'IN_TRANSIT',
    'ARRIVED',
    'CUSTOMS_CLEARING',
    'CLEARED',
    'DELIVERED',
    'CLOSED',
  ]),
  bookingNumber: optionalText(60),
  billOfLading: optionalText(60),
  vesselName: optionalText(120),
  voyageNumber: optionalText(40),
  portOfLoading: optionalText(120),
  portOfDischarge: optionalText(120),
  shippingLineId: optionalCuid,
  etdDate: optionalDateString,
  etaDate: optionalDateString,
  ataDate: optionalDateString,
  loadingDate: optionalDateString,
  clearanceDate: optionalDateString,
  deliveryDate: optionalDateString,
  containers: positiveInt('Containers').optional(),
  notes: optionalText(600),
});

export const shipmentDetailsSchema = z.object({
  customerId: optionalCuid,
  bookingNumber: optionalText(60),
  billOfLading: optionalText(60),
  vesselName: optionalText(120),
  voyageNumber: optionalText(40),
  portOfLoading: optionalText(120),
  portOfDischarge: optionalText(120),
  shippingLineId: optionalCuid,
  etdDate: optionalDateString,
  etaDate: optionalDateString,
  loadingDate: optionalDateString,
  destination: optionalText(120),
  containers: positiveInt('Containers').optional(),
  notes: optionalText(600),
});

export const documentStatusSchema = z.object({
  toStatus: z.enum([
    'DRAFT_PENDING',
    'DRAFT_RECEIVED',
    'UNDER_APPROVAL',
    'APPROVED',
    'ORIGINALS_WITH_SUPPLIER',
    'DISPATCHED',
    'WITH_BANK',
    'WITH_CUSTOMER',
    'COMPLETED',
  ]),
  notes: optionalText(600),
});

export const shipmentContainersSchema = z.object({
  lines: z
    .array(
      z.object({
        batchId: cuid,
        containerNumber: optionalText(40),
      }),
    )
    .min(1, 'Add at least one container line.'),
});

export const reversalSchema = z.object({
  reason: requiredText('Reason', 400),
});

export type PurchaseContractFormInput = z.infer<typeof purchaseContractSchema>;
export type GoodsReceiptFormInput = z.infer<typeof goodsReceiptSchema>;
export type ReceiveContainersFormInput = z.infer<typeof receiveContainersSchema>;
export type SalesInvoiceFormInput = z.infer<typeof salesInvoiceSchema>;
export type StockTransferFormInput = z.infer<typeof stockTransferSchema>;

// ---------------------------------------------------------------------------
// Credit notes, stock counts and tax
// ---------------------------------------------------------------------------

export const creditNoteLineSchema = z
  .object({
    description: requiredText('Description', 300),
    batchId: optionalCuid,
    warehouseId: optionalCuid,
    quantityKg: optionalDecimalString('Quantity'),
    bags: positiveInt('Bags').optional(),
    unitPrice: optionalDecimalString('Unit price'),
    amount: optionalDecimalString('Amount'),
    taxCodeId: optionalCuid,
  })
  .refine(
    (line) => Number(line.amount) > 0 || (Number(line.quantityKg) > 0 && Number(line.unitPrice) > 0),
    'Enter either a quantity and a price, or a flat amount.',
  )
  .refine(
    (line) => !line.batchId || Boolean(line.warehouseId),
    'Choose the warehouse the coffee comes back into.',
  );

export const creditNoteSchema = z
  .object({
    type: z.enum(['CUSTOMER', 'VENDOR']),
    creditDate: dateString('Credit date'),
    customerId: optionalCuid,
    vendorId: optionalCuid,
    salesInvoiceId: optionalCuid,
    purchaseContractId: optionalCuid,
    currency: currencyCode,
    rateToUsd: decimalString('Exchange rate'),
    rateLocalPerUsd: decimalString('Local exchange rate'),
    reason: requiredText('Reason', 400),
    reference: optionalText(60),
    notes: optionalText(1000),
    lines: z.array(creditNoteLineSchema).min(1, 'Add at least one line.'),
  })
  .refine(
    (note) => (note.type === 'CUSTOMER' ? Boolean(note.customerId) : Boolean(note.vendorId)),
    'Choose the customer or supplier the credit belongs to.',
  );

export const stockCountSchema = z.object({
  warehouseId: cuid,
  countDate: dateString('Count date'),
  notes: optionalText(600),
});

export const stockCountLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        batchId: cuid,
        countedKg: decimalString('Counted quantity', { allowZero: true }),
        reason: z.enum(['DAMAGE', 'LOSS', 'COUNT_ADJUSTMENT', 'CORRECTION', 'OTHER']).nullable().optional(),
        notes: optionalText(300),
      }),
    )
    .min(1, 'Record at least one counted quantity.'),
});

export const taxCodeSchema = z.object({
  id: optionalCuid,
  code: requiredText('Code', 12),
  name: requiredText('Name', 120),
  ratePct: optionalDecimalString('Rate'),
  treatment: z.enum(['STANDARD', 'ZERO_RATED', 'EXEMPT', 'OUT_OF_SCOPE', 'REVERSE_CHARGE']),
  appliesTo: z.enum(['SALES', 'PURCHASE', 'BOTH']),
  isDefault: z.coerce.boolean().optional(),
});

export const taxRegistrationSchema = z.object({
  registrationNumber: requiredText('Registration number', 60),
  label: requiredText('Tax name', 12),
  periodMonths: positiveInt('Filing period'),
});

export const taxReturnFilingSchema = z.object({
  from: dateString('Period start'),
  to: dateString('Period end'),
  reference: optionalText(60),
  notes: optionalText(600),
});

export const bankReconciliationSchema = z.object({
  cashBankAccountId: cuid,
  statementDate: dateString('Statement date'),
  statementBalance: decimalString('Statement balance', { allowZero: true }),
});

export type CreditNoteFormInput = z.infer<typeof creditNoteSchema>;
export type StockCountFormInput = z.infer<typeof stockCountSchema>;
export type TaxCodeFormInput = z.infer<typeof taxCodeSchema>;
