import { describe, expect, it } from 'vitest';
import {
  customerSchema,
  vendorSchema,
  coffeeItemSchema,
  warehouseSchema,
  agentSchema,
  expenseCategorySchema,
} from '@/lib/validation/masters';
import { expenseSchema, receiptSchema, journalVoucherSchema } from '@/lib/validation/finance';
import { purchaseContractSchema, salesInvoiceSchema } from '@/lib/validation/trading';
import { fieldErrors, formDataToObject } from '@/lib/validation/common';
import { resolveMasterCode } from '@/lib/services/master-code';

/**
 * The JSON/FormData the screens actually post — empty strings, omitted codes,
 * null combobox values — not the tidy objects the service-layer tests invent.
 * Daily “Save does nothing” bugs have been this shape, not the domain math.
 */

const ID = 'cust01abcdefghijk';

function messages(schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) return {};
  return fieldErrors(result.error as Parameters<typeof fieldErrors>[0]);
}

function masterFormData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return formDataToObject(form);
}

describe('customer Save posts the same fields the sheet does', () => {
  it('creates when the code and email are left blank', () => {
    const parsed = customerSchema.parse(
      masterFormData({
        customerName: 'Casablanca Roasters',
        customerCode: '',
        country: '',
        contactPerson: '',
        phone: '',
        whatsapp: '',
        email: '',
        address: '',
        primaryCurrency: 'MAD',
        creditLimit: '',
        notes: '',
        status: 'ACTIVE',
      }),
    );
    expect(parsed.customerName).toBe('Casablanca Roasters');
    expect(parsed.email).toBeNull();
    expect(parsed.creditLimit).toBe('0');
    expect('generate' in resolveMasterCode({ submitted: parsed.customerCode, isCreate: true })).toBe(true);
  });

  it('keeps CUS-0001 when the edit form omits the code field entirely', () => {
    const parsed = customerSchema.parse(
      masterFormData({
        customerName: 'Casablanca Roasters SAS',
        primaryCurrency: 'MAD',
        status: 'ACTIVE',
        creditLimit: '0',
      }),
    );
    expect(
      resolveMasterCode({ submitted: parsed.customerCode, existing: 'CUS-0001', isCreate: false }),
    ).toEqual({ code: 'CUS-0001' });
  });
});

describe('supplier Save posts the same fields the sheet does', () => {
  it('creates when the code and email are left blank', () => {
    const parsed = vendorSchema.parse(
      masterFormData({
        vendorName: 'Fazenda Santa Clara',
        vendorCode: '',
        country: 'Brazil',
        contactPerson: '',
        phone: '',
        whatsapp: '',
        email: '',
        address: '',
        primaryCurrency: 'USD',
        bankDetails: '',
        notes: '',
        status: 'ACTIVE',
      }),
    );
    expect(parsed.vendorName).toBe('Fazenda Santa Clara');
    expect('generate' in resolveMasterCode({ submitted: parsed.vendorCode, isCreate: true })).toBe(true);
  });
});

describe('item, warehouse, agent and expense category Save', () => {
  it('accepts an item with only the fields the item sheet asks for', () => {
    const parsed = coffeeItemSchema.parse(
      masterFormData({
        itemName: 'Brazil Santos NY2',
        itemCode: '',
        coffeeType: 'ARABICA',
        originCountry: 'Brazil',
        region: '',
        farmEstate: '',
        grade: '',
        screenSize: '',
        variety: '',
        process: 'NATURAL',
        cropYear: '',
        moisturePct: '',
        densityGPerL: '',
        packagingType: 'JUTE_BAG',
        bagWeightKg: '60',
        defaultUnit: 'KG',
        description: '',
        notes: '',
        status: 'ACTIVE',
      }),
    );
    expect(parsed.itemName).toBe('Brazil Santos NY2');
    expect(parsed.bagWeightKg).toBe('60');
  });

  it('accepts a warehouse, an agent and an expense category with blank codes', () => {
    expect(
      warehouseSchema.parse(masterFormData({ name: 'Casablanca A', code: '', location: '', country: 'Morocco', port: '', status: 'ACTIVE' }))
        .name,
    ).toBe('Casablanca A');
    expect(
      agentSchema.parse(masterFormData({ agentName: 'Karim', agentCode: '', contactPerson: '', phone: '', email: '', commissionPct: '', notes: '', status: 'ACTIVE' }))
        .agentName,
    ).toBe('Karim');
    expect(
      expenseCategorySchema.parse(
        masterFormData({ name: 'Fumigation', code: '', description: '', kind: 'SHIPMENT', status: 'ACTIVE' }),
      ).name,
    ).toBe('Fumigation');
  });
});

describe('the invoice Save payload', () => {
  const line = {
    batchId: ID,
    warehouseId: ID,
    quantity: '500',
    unit: 'KG' as const,
    unitPrice: '6.00',
    taxCodeId: '',
    notes: '',
  };

  it('accepts a credit invoice the way the form posts it', () => {
    const parsed = salesInvoiceSchema.parse({
      invoiceNumber: '',
      invoiceDate: '2026-09-16',
      customerId: ID,
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      dueDate: undefined,
      paymentType: 'CREDIT',
      cashBankAccountId: '',
      shipmentId: '',
      reference: '',
      notes: '',
      lines: [line],
    });
    expect(parsed.customerId).toBe(ID);
    expect(parsed.paymentType).toBe('CREDIT');
    expect(parsed.cashBankAccountId).toBeNull();
  });

  it('tells the user to choose a customer instead of talking like Zod', () => {
    const msgs = messages(salesInvoiceSchema, {
      invoiceDate: '2026-09-16',
      customerId: '',
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      paymentType: 'CREDIT',
      cashBankAccountId: '',
      shipmentId: '',
      lines: [line],
    });
    expect(msgs.customerId).toMatch(/choose/i);
    expect(msgs.customerId).not.toMatch(/expected string|invalid_type|null/i);
  });
});

describe('Record Payment posts a MAD receipt with only a rate', () => {
  it('accepts the receipt form payload that used to fail as a zero USD equivalent', () => {
    const parsed = receiptSchema.parse({
      receiptDate: '2026-09-16',
      customerId: ID,
      currency: 'MAD',
      amount: '9850',
      rateToUsd: '9.85',
      usdEquivalent: undefined,
      rateLocalPerUsd: '9.85',
      paymentMethod: 'BANK_TRANSFER',
      cashBankAccountId: ID,
      agentId: '',
      cheque: null,
      shipmentId: '',
      reference: '',
      description: '',
      allocations: [{ salesInvoiceId: ID, amount: '9850' }],
    });
    expect(parsed.currency).toBe('MAD');
    expect(parsed.rateToUsd).toBe('9.85');
  });
});

describe('an unpaid expense does not ask for cash', () => {
  it('accepts the expense form payload with an empty paid-from account', () => {
    const parsed = expenseSchema.parse({
      expenseDate: '2026-09-16',
      expenseCategoryId: ID,
      shipmentId: ID,
      purchaseContractId: '',
      containerId: '',
      batchId: '',
      vendorId: '',
      agentId: '',
      payableToAgentId: '',
      currency: 'USD',
      amount: '1000',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      paymentMethod: 'CASH',
      cashBankAccountId: '',
      capitaliseToLandedCost: true,
      kind: 'SHIPMENT',
      reference: '',
      description: 'Agent commission',
    });
    expect(parsed.cashBankAccountId).toBeNull();
    expect(parsed.kind).toBe('SHIPMENT');
  });
});

describe('a purchase order with no lot still saves', () => {
  it('accepts the PO form payload', () => {
    const parsed = purchaseContractSchema.parse({
      contractReference: 'PO-DAILY',
      supplierContractNo: '',
      contractDate: '2026-09-16',
      vendorId: ID,
      origin: '',
      currency: 'USD',
      rateToUsd: '1',
      rateLocalPerUsd: '9.85',
      freightAmount: '0',
      otherCharges: '0',
      incoterm: 'FOB',
      portOfLoading: '',
      destination: '',
      containers: 2,
      dueDate: undefined,
      notes: '',
      lines: [
        {
          itemId: ID,
          lotNumber: '',
          batchNumber: '',
          containerNumber: '',
          quantity: '40000',
          unit: 'KG',
          unitPrice: '4.50',
          bagWeightKg: '60',
          notes: '',
        },
      ],
    });
    expect(parsed.lines[0].lotNumber).toBeNull();
    expect(Number(parsed.lines[0].quantity) * Number(parsed.lines[0].unitPrice)).toBe(180000);
  });
});

describe('journal vouchers in USD and MAD', () => {
  it('accepts a balanced USD voucher and a balanced MAD voucher', () => {
    const line = (currency: string, rate: string, amount: string, direction: 'DEBIT' | 'CREDIT') => ({
      accountId: ID,
      direction,
      currency,
      amount,
      rateToUsd: rate,
      description: '',
      customerId: '',
    });

    expect(
      journalVoucherSchema.parse({
        entryDate: '2026-09-16',
        description: 'Opening receivable USD',
        rateLocalPerUsd: '9.85',
        lines: [line('USD', '1', '500', 'DEBIT'), line('USD', '1', '500', 'CREDIT')],
      }).lines[0].currency,
    ).toBe('USD');

    expect(
      journalVoucherSchema.parse({
        entryDate: '2026-09-16',
        description: 'Opening receivable MAD',
        rateLocalPerUsd: '9.85',
        lines: [line('MAD', '9.85', '10000', 'DEBIT'), line('MAD', '9.85', '10000', 'CREDIT')],
      }).lines[0].currency,
    ).toBe('MAD');
  });
});
