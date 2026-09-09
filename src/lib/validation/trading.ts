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
} from '@/lib/validation/common';

/** Purchase, goods receipt, sales and transfer schemas. */

export const purchaseLineSchema = z.object({
  itemId: cuid,
  lotNumber: requiredText('Lot number', 60),
  batchNumber: requiredText('Batch number', 60),
  containerNumber: optionalText(40),
  containerType: z.enum(['FT20', 'FT40', 'FT40HC', 'LCL', 'BULK']).default('FT20'),
  quantity: decimalString('Quantity'),
  unit: z.enum(['KG', 'MT', 'BAG']),
  unitPrice: decimalString('Price', { allowZero: true }),
  bags: positiveInt('Bags').optional(),
  bagWeightKg: optionalDecimalString('Bag weight'),
  notes: optionalText(300),
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
  expectedShipmentDate: optionalDateString,
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
  batchId: cuid,
  warehouseId: cuid,
  quantity: decimalString('Quantity'),
  unit: z.enum(['KG', 'MT', 'BAG']),
  unitPrice: decimalString('Price'),
  bags: positiveInt('Bags').optional(),
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
