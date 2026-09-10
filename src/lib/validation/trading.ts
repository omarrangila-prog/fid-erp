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

export const purchaseLineSchema = z
  .object({
    itemId: requiredChoice('Coffee'),
    // One or the other. Suppliers label consignments differently, and demanding
    // both only made people invent the missing one.
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
  })
  .refine((line) => Boolean(line.lotNumber?.trim() || line.batchNumber?.trim()), {
    message: 'Please enter either a Lot Number or a Batch Number.',
    path: ['lotNumber'],
  });

export const purchaseContractSchema = z.object({
  contractReference: requiredText('Contract reference', 60),
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
  paymentTermDays: positiveInt('Payment terms'),
  notes: optionalText(1000),
  lines: z.array(purchaseLineSchema).min(1, 'Add at least one coffee line.'),
});

export const goodsReceiptSchema = z.object({
  purchaseContractId: cuid,
  warehouseId: cuid,
  receiptDate: dateString('Receipt date'),
  reference: optionalText(60),
  notes: optionalText(600),
  lines: z
    .array(
      z.object({
        batchId: cuid,
        quantityKg: decimalString('Quantity received'),
        bags: positiveInt('Bags').optional(),
        notes: optionalText(300),
      }),
    )
    .min(1, 'Add at least one batch to receive.'),
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
  paymentTermDays: positiveInt('Payment terms'),
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

export const reversalSchema = z.object({
  reason: requiredText('Reason', 400),
});

export type PurchaseContractFormInput = z.infer<typeof purchaseContractSchema>;
export type GoodsReceiptFormInput = z.infer<typeof goodsReceiptSchema>;
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
