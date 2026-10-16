/** The shape of a tenant's starting data, independent of whose it is. */

export type CompanySeed = {
  code: string;
  name: string;
  legalName: string;
  country: string;
  localCurrency: string;
  timezone: string;
  docPrefix: string;
  address: string;
  /** Industry preset (lib/templates.ts). */
  industryTemplate?: string;
  tagline?: string;
  /** Words this company uses; merged over the template's. */
  terminology?: Record<string, string>;
  /** Currencies it offers on money forms. Empty keeps the built-in list. */
  transactionCurrencies?: string[];
  salesCurrencies?: string[];
  defaultSalesCurrency?: string;
  warehouses: Array<{ code: string; name: string; location: string; port?: string; isDefault?: boolean }>;
  cashAccounts: Array<{
    code: string;
    name: string;
    accountType: 'CASH' | 'BANK';
    currency: string;
    openingBalance?: string;
    bankName?: string;
  }>;
};

export type PinStaffSeed = {
  /** Environment variable holding the PIN — PINs are never in source. */
  pinEnv: string;
  nameEnv: string;
  defaultName: string;
  email: string;
  roleCode: string;
  companyCode: string;
};

export type TenantSeed = {
  organization: { id: string; name: string; plan: string; authPolicy: 'PASSWORD' | 'PIN_AND_PASSWORD' };
  companies: CompanySeed[];
  /** Indicative rates to start with, units of the currency per 1 USD. */
  exchangeRates: Array<[currency: string, rate: string]>;
  pinStaff: PinStaffSeed[];
};
