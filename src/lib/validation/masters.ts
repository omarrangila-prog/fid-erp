import { z } from 'zod';
import { currencyCode, optionalDecimalString, optionalText, positiveInt, requiredText } from '@/lib/validation/common';

/** Master data schemas. These are shared by the forms and the server actions. */

export const customerSchema = z.object({
  customerCode: requiredText('Customer code', 40),
  customerName: requiredText('Customer name'),
  country: optionalText(100),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  whatsapp: optionalText(40),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]).transform((v) => v || null),
  address: optionalText(400),
  primaryCurrency: currencyCode,
  creditLimit: optionalDecimalString('Credit limit'),
  paymentTermDays: positiveInt('Payment terms'),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const vendorSchema = z.object({
  vendorCode: requiredText('Supplier code', 40),
  vendorName: requiredText('Supplier name'),
  country: optionalText(100),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  whatsapp: optionalText(40),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]).transform((v) => v || null),
  address: optionalText(400),
  primaryCurrency: currencyCode,
  paymentTermDays: positiveInt('Payment terms'),
  bankDetails: optionalText(600),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const coffeeItemSchema = z.object({
  itemCode: requiredText('Item code', 40),
  itemName: requiredText('Coffee name'),
  coffeeType: z.enum(['ARABICA', 'ROBUSTA', 'BLEND']),
  originCountry: requiredText('Origin country', 100),
  region: optionalText(120),
  farmEstate: optionalText(160),
  grade: optionalText(60),
  screenSize: optionalText(40),
  variety: optionalText(80),
  process: z.enum(['WASHED', 'NATURAL', 'HONEY', 'WET_HULLED', 'ANAEROBIC', 'OTHER']),
  cropYear: optionalText(20),
  moisturePct: optionalDecimalString('Moisture'),
  densityGPerL: optionalDecimalString('Density'),
  packagingType: z.enum(['JUTE_BAG', 'GRAINPRO', 'VACUUM_PACK', 'BULK', 'OTHER']),
  bagWeightKg: optionalDecimalString('Bag weight'),
  defaultUnit: z.enum(['KG', 'MT', 'BAG']),
  description: optionalText(600),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const warehouseSchema = z.object({
  code: requiredText('Warehouse code', 40),
  name: requiredText('Warehouse name'),
  location: optionalText(200),
  country: optionalText(100),
  port: optionalText(120),
  isDefault: z.coerce.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const agentSchema = z.object({
  agentCode: requiredText('Agent code', 40),
  agentName: requiredText('Agent name'),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]).transform((v) => v || null),
  commissionPct: optionalDecimalString('Commission'),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const shippingLineSchema = z.object({
  code: requiredText('Code', 30),
  name: requiredText('Shipping line name'),
  contactInformation: optionalText(400),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const portSchema = z.object({
  code: requiredText('Code', 12),
  name: requiredText('Port name'),
  country: optionalText(80),
  notes: optionalText(500),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const expenseCategorySchema = z.object({
  code: requiredText('Code', 30),
  name: requiredText('Category name'),
  description: optionalText(400),
  capitaliseByDefault: z.coerce.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const cashBankAccountSchema = z.object({
  code: requiredText('Account code', 40),
  name: requiredText('Account name'),
  accountType: z.enum(['CASH', 'PETTY_CASH', 'BANK']),
  currency: currencyCode,
  openingBalance: optionalDecimalString('Opening balance'),
  bankName: optionalText(120),
  accountNumber: optionalText(60),
});

export type CustomerInput = z.infer<typeof customerSchema>;
export type VendorInput = z.infer<typeof vendorSchema>;
export type CoffeeItemInput = z.infer<typeof coffeeItemSchema>;
export type WarehouseInput = z.infer<typeof warehouseSchema>;
export type AgentInput = z.infer<typeof agentSchema>;
export type ShippingLineInput = z.infer<typeof shippingLineSchema>;
export type ExpenseCategoryInput = z.infer<typeof expenseCategorySchema>;
export type CashBankAccountInput = z.infer<typeof cashBankAccountSchema>;
