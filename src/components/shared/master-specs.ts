import type { MasterCreateSpec } from '@/components/shared/master-select';
import {
  quickCreateVendorAction,
  quickCreateCustomerAction,
  quickCreateAgentAction,
  quickCreateWarehouseAction,
  quickCreateCoffeeItemAction,
  quickCreateCashBankAccountAction,
} from '@/server/actions/master-actions';

/**
 * What each master needs before it can be used on a voucher.
 *
 * Deliberately short lists. A quick create is not the master screen: it asks
 * for the few things without which the record would be wrong — a name, and the
 * currency a ledger is kept in — and leaves addresses, terms and bank details
 * to be filled in later on the record itself.
 */

const CURRENCIES = ['USD', 'MAD', 'AED', 'EUR'].map((code) => ({ value: code, label: code }));

export function vendorCreateSpec(
  defaultCurrency: string,
): MasterCreateSpec<{ id: string; name: string; code: string; currency: string }> {
  return {
    label: '+ Add New Supplier',
    title: 'Add new supplier',
    description: 'The name and the currency their account is kept in are enough to record the bill.',
    nameField: 'vendorName',
    fields: [
      { name: 'vendorName', label: 'Supplier name', required: true },
      {
        name: 'primaryCurrency',
        label: 'Account currency',
        kind: 'select',
        required: true,
        options: CURRENCIES,
        defaultValue: defaultCurrency,
        hint: 'The currency this supplier’s balance is stated in.',
      },
      { name: 'country', label: 'Country', hint: 'Optional.' },
      { name: 'phone', label: 'Phone', kind: 'tel', hint: 'Optional.' },
    ],
    action: quickCreateVendorAction,
    toOption: (created) => ({
      value: created.id,
      label: created.name,
      hint: `${created.code} · ${created.currency}`,
      keywords: created.code,
    }),
  };
}

export function customerCreateSpec(
  defaultCurrency: string,
): MasterCreateSpec<{ id: string; name: string; currency: string; paymentTermDays: number }> {
  return {
    label: '+ Add New Customer',
    title: 'Add new customer',
    description: 'The name and the currency their account is kept in are enough to raise the invoice.',
    nameField: 'customerName',
    fields: [
      { name: 'customerName', label: 'Customer name', required: true },
      {
        name: 'primaryCurrency',
        label: 'Account currency',
        kind: 'select',
        required: true,
        options: CURRENCIES,
        defaultValue: defaultCurrency,
        hint: 'The currency this customer’s balance is stated in.',
      },
      { name: 'country', label: 'Country', hint: 'Optional.' },
      { name: 'phone', label: 'Phone', kind: 'tel', hint: 'Optional.' },
    ],
    action: quickCreateCustomerAction,
    toOption: (created) => ({ value: created.id, label: created.name, hint: created.currency }),
  };
}

export function agentCreateSpec(): MasterCreateSpec<{ id: string; agentName: string; agentCode: string }> {
  return {
    label: '+ Add New Agent',
    title: 'Add new agent',
    description: 'The name is enough. They can collect from customers as soon as you save.',
    nameField: 'agentName',
    fields: [
      { name: 'agentName', label: 'Agent name', required: true },
      { name: 'phone', label: 'Phone', kind: 'tel', hint: 'Optional.' },
      { name: 'notes', label: 'Notes', kind: 'textarea', hint: 'Optional.' },
    ],
    action: quickCreateAgentAction,
    toOption: (created) => ({
      value: created.id,
      label: created.agentName,
      hint: created.agentCode,
      keywords: created.agentCode,
    }),
  };
}

export function warehouseCreateSpec(): MasterCreateSpec<{ id: string; name: string; code: string }> {
  return {
    label: '+ Add New Warehouse',
    title: 'Add new warehouse',
    description: 'Stock is held per warehouse, so the place has to exist before coffee can move through it.',
    nameField: 'name',
    fields: [
      { name: 'name', label: 'Warehouse name', required: true },
      { name: 'location', label: 'Location', hint: 'Optional.' },
      { name: 'country', label: 'Country', hint: 'Optional.' },
    ],
    action: quickCreateWarehouseAction,
    toOption: (created) => ({
      value: created.id,
      label: created.name,
      hint: created.code,
      keywords: created.code,
    }),
  };
}

export function coffeeItemCreateSpec(): MasterCreateSpec<{
  id: string;
  name: string;
  code: string;
  originCountry: string;
}> {
  return {
    label: '+ Add New Item',
    title: 'Add new coffee',
    description: 'Enough to put it on the contract. Screen size, moisture and the rest can follow on the item record.',
    nameField: 'itemName',
    fields: [
      { name: 'itemName', label: 'Item name', required: true },
      {
        name: 'coffeeType',
        label: 'Type',
        kind: 'select',
        required: true,
        options: [
          { value: 'ROBUSTA', label: 'Robusta' },
          { value: 'ARABICA', label: 'Arabica' },
          { value: 'BLEND', label: 'Blend' },
        ],
        defaultValue: 'ROBUSTA',
      },
      { name: 'originCountry', label: 'Origin country', required: true },
      { name: 'screenSize', label: 'Screen size', hint: 'Optional.' },
    ],
    action: quickCreateCoffeeItemAction,
    toOption: (created) => ({
      value: created.id,
      label: created.name,
      hint: `${created.code} · ${created.originCountry}`,
      keywords: created.code,
    }),
  };
}

/**
 * Opening a cash drawer or bank account from inside a voucher.
 *
 * The currency is fixed here and cannot be changed once money has moved
 * through the account, so it is asked for plainly rather than defaulted
 * quietly. No opening balance: that is a journal entry with a date, and it
 * belongs on the cash and bank screen.
 */
export function cashBankCreateSpec(
  defaultCurrency: string,
  accountType: 'CASH' | 'BANK' = 'BANK',
): MasterCreateSpec<{ id: string; name: string; code: string; currency: string; accountType: string }> {
  return {
    label: accountType === 'CASH' ? '+ Add New Cash Account' : '+ Add New Bank Account',
    title: accountType === 'CASH' ? 'Add new cash account' : 'Add new bank account',
    description: 'This opens a ledger account too. The currency is fixed once money has moved through it.',
    nameField: 'name',
    fields: [
      { name: 'name', label: 'Account name', required: true },
      {
        name: 'accountType',
        label: 'Kind',
        kind: 'select',
        required: true,
        options: [
          { value: 'BANK', label: 'Bank account' },
          { value: 'CASH', label: 'Cash in hand' },
          { value: 'PETTY_CASH', label: 'Petty cash' },
        ],
        defaultValue: accountType,
      },
      {
        name: 'currency',
        label: 'Currency',
        kind: 'select',
        required: true,
        options: CURRENCIES,
        defaultValue: defaultCurrency,
        hint: 'A drawer holds one currency only.',
      },
      { name: 'bankName', label: 'Bank name', hint: 'Optional.' },
      { name: 'accountNumber', label: 'Account number', hint: 'Optional.' },
    ],
    action: quickCreateCashBankAccountAction,
    toOption: (created) => ({
      value: created.id,
      label: created.name,
      hint: created.currency,
      keywords: `${created.code} ${created.currency}`,
    }),
  };
}
