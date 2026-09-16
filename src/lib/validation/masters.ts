import { z } from 'zod';
import { currencyCode, optionalDecimalString, optionalText, requiredText } from '@/lib/validation/common';

/** Blank, omitted, or a real address — never a Zod puzzle. */
const optionalEmail = z
  .union([z.literal(''), z.email('Enter a valid email address.')])
  .optional()
  .transform((v) => v || null);

/** Master data schemas. These are shared by the forms and the server actions. */

export const customerSchema = z.object({
  /**
   * Optional, and issued by the system when left blank.
   *
   * Inventing a unique code is not a decision anybody wants to make while
   * adding a customer, and a code somebody invented under pressure is the one
   * that collides next month.
   */
  customerCode: optionalText(40),
  customerName: requiredText('Customer name'),
  country: optionalText(100),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  whatsapp: optionalText(40),
  email: optionalEmail,
  address: optionalText(400),
  primaryCurrency: currencyCode,
  creditLimit: optionalDecimalString('Credit limit'),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const vendorSchema = z.object({
  /** Optional, and issued by the system when left blank. See customerCode. */
  vendorCode: optionalText(40),
  vendorName: requiredText('Supplier name'),
  country: optionalText(100),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  whatsapp: optionalText(40),
  email: optionalEmail,
  address: optionalText(400),
  primaryCurrency: currencyCode,
  bankDetails: optionalText(600),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const coffeeItemSchema = z.object({
  /** Optional SKU. Issued as ITM-0001 when left blank, same as customers. */
  itemCode: optionalText(40),
  itemName: requiredText('Item name'),
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
  /** Optional, and issued as WH-0001 when left blank. See customerCode. */
  code: optionalText(40),
  name: requiredText('Warehouse name'),
  location: optionalText(200),
  country: optionalText(100),
  port: optionalText(120),
  isDefault: z.coerce.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const agentSchema = z.object({
  /** Optional, and issued as AGT-0001 when left blank. See customerCode. */
  agentCode: optionalText(40),
  agentName: requiredText('Agent name'),
  contactPerson: optionalText(120),
  phone: optionalText(40),
  email: optionalEmail,
  commissionPct: optionalDecimalString('Commission'),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const shippingLineSchema = z.object({
  code: optionalText(30),
  name: requiredText('Shipping line name'),
  contactInformation: optionalText(400),
  notes: optionalText(1000),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const portSchema = z.object({
  code: optionalText(20),
  name: requiredText('Port name'),
  country: optionalText(80),
  notes: optionalText(500),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const expenseCategorySchema = z.object({
  code: optionalText(30),
  name: requiredText('Category name'),
  description: optionalText(400),
  kind: z.enum(['SHIPMENT', 'GENERAL']).default('SHIPMENT'),
  capitaliseByDefault: z.coerce.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const cashBankAccountSchema = z.object({
  /** Optional on create; issued as CBA-0001 when left blank. */
  code: optionalText(40),
  name: requiredText('Account name'),
  accountType: z.enum(['CASH', 'PETTY_CASH', 'BANK']),
  currency: currencyCode,
  openingBalance: optionalDecimalString('Opening balance'),
  bankName: optionalText(120),
  accountNumber: optionalText(60),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export type CustomerInput = z.infer<typeof customerSchema>;
export type VendorInput = z.infer<typeof vendorSchema>;
export type CoffeeItemInput = z.infer<typeof coffeeItemSchema>;
export type WarehouseInput = z.infer<typeof warehouseSchema>;
export type AgentInput = z.infer<typeof agentSchema>;
export type ShippingLineInput = z.infer<typeof shippingLineSchema>;
export type ExpenseCategoryInput = z.infer<typeof expenseCategorySchema>;
export type CashBankAccountInput = z.infer<typeof cashBankAccountSchema>;
