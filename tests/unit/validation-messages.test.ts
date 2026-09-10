import { describe, expect, it } from 'vitest';
import { purchaseContractSchema, salesInvoiceSchema } from '@/lib/validation/trading';
import { fieldErrors } from '@/lib/validation/common';

/**
 * What a person reads when a form will not save.
 *
 * A validator with no message gets Zod's own, and Zod's own is written for a
 * developer: "Too small: expected string to have >=1 characters" reached the
 * user on a blank Coffee field. These assert that every message a form can
 * show is a sentence somebody can act on.
 */

/** Every message a schema produces for a given input. */
function messagesFor(schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } }, value: unknown) {
  const result = schema.safeParse(value);
  if (result.success) return {};
  return fieldErrors(result.error as Parameters<typeof fieldErrors>[0]);
}

/** Anything that reads like Zod talking to a programmer. */
const DEVELOPER_SPEAK = [
  /expected string/i,
  /expected number/i,
  /too small/i,
  /too big/i,
  /invalid_type/i,
  /nan/i,
  />=/,
  /undefined/i,
  /\bnull\b/i,
];

describe('a blank purchase contract', () => {
  const messages = messagesFor(purchaseContractSchema, {
    contractReference: '',
    contractDate: '',
    vendorId: '',
    currency: '',
    rateToUsd: '',
    rateLocalPerUsd: '',
    freightAmount: '',
    otherCharges: '',
    paymentTermDays: '0',
    lines: [{ itemId: '', lotNumber: '', batchNumber: '', quantity: '', unit: 'KG', unitPrice: '' }],
  });

  it('tells the user what to do about the coffee, not what Zod expected', () => {
    // The exact bug: "Too small: expected string to have >=1 characters".
    expect(messages['lines.0.itemId']).toBe('Coffee is required.');
  });

  it('never shows a message written for a developer', () => {
    for (const [field, message] of Object.entries(messages)) {
      for (const pattern of DEVELOPER_SPEAK) {
        expect(message, `${field}: "${message}"`).not.toMatch(pattern);
      }
    }
  });

  it('ends every message as a sentence', () => {
    for (const [field, message] of Object.entries(messages)) {
      expect(message.length, `${field} should say something`).toBeGreaterThan(3);
      expect(message[0], `${field}: "${message}" should start with a capital`).toBe(message[0].toUpperCase());
    }
  });

  it('asks for a lot or a batch, not both', () => {
    // Attached to the lot field so it renders inline where the user is
    // looking, rather than as a detached line-level complaint.
    expect(messages['lines.0.lotNumber']).toMatch(/lot number or a batch number/i);
    // And nothing separately demands the batch, which is the whole point.
    expect(messages['lines.0.batchNumber']).toBeUndefined();
  });

  it('shows one message per field, not three', () => {
    // A blank quantity trips "required", "must be a number" and "must be
    // greater than zero" at once. The user needs the first of those.
    expect(messages['lines.0.quantity']).toBe('Quantity is required.');
    expect(messages['lines.0.unitPrice']).toBe('Price is required.');
  });
});

describe('a blank sales invoice', () => {
  const messages = messagesFor(salesInvoiceSchema, {
    invoiceDate: '',
    customerId: '',
    currency: '',
    rateToUsd: '',
    rateLocalPerUsd: '',
    paymentTermDays: '0',
    lines: [{ batchId: '', warehouseId: '', quantity: '', unit: 'KG', unitPrice: '' }],
  });

  it('names the field rather than describing a string', () => {
    expect(messages['lines.0.batchId']).toBe('Batch is required.');
    expect(messages['lines.0.warehouseId']).toBe('Warehouse is required.');
  });

  it('never shows a message written for a developer', () => {
    for (const [field, message] of Object.entries(messages)) {
      for (const pattern of DEVELOPER_SPEAK) {
        expect(message, `${field}: "${message}"`).not.toMatch(pattern);
      }
    }
  });
});
