import type { TenantSeed } from '@/lib/seed/types';

/**
 * FID Trading — the first customer, kept as a tenant like any other.
 *
 * This file is FID's configuration, not the product's: nothing outside
 * `src/lib/seed/tenants/` may name them. The ids and codes below must stay
 * exactly as they are — they key the live database.
 */
export const FID_TENANT: TenantSeed = {
  organization: { id: 'org_fid_trading', name: 'FID Trading', plan: 'ENTERPRISE', authPolicy: 'PIN_AND_PASSWORD' },
  exchangeRates: [
    ['AED', '3.67250000'],
    ['MAD', '9.85000000'],
  ],
  pinStaff: [
    {
      pinEnv: 'DUBAI_STAFF_PIN',
      nameEnv: 'DUBAI_STAFF_NAME',
      defaultName: 'Dubai Staff',
      email: 'dubai.staff@fidtrading.local',
      roleCode: 'DATA_ENTRY',
      companyCode: 'FID-DXB',
    },
    {
      pinEnv: 'MOROCCO_STAFF_PIN',
      nameEnv: 'MOROCCO_STAFF_NAME',
      defaultName: 'Morocco Staff',
      email: 'morocco.staff@fidtrading.local',
      roleCode: 'DATA_ENTRY',
      companyCode: 'FID-MA',
    },
  ],
  companies: [
    {
      code: 'FID-DXB',
      name: 'FID Trading L.L.C.',
      legalName: 'FID TRADING L.L.C.',
      country: 'United Arab Emirates',
      localCurrency: 'AED',
      timezone: 'Asia/Dubai',
      docPrefix: 'FID-DXB',
      address: 'Dubai, United Arab Emirates',
      industryTemplate: 'COMMODITY_TRADING',
      tagline: 'Coffee Connects Worlds',
      terminology: { product: 'Coffee' },
      warehouses: [
        { code: 'DXB-JAFZA', name: 'Jebel Ali Free Zone Warehouse', location: 'Jebel Ali, Dubai', port: 'Jebel Ali', isDefault: true },
        { code: 'DXB-BOND', name: 'Port Rashid Bonded Store', location: 'Port Rashid, Dubai', port: 'Port Rashid' },
      ],
      // One cash account per currency. "Cash in Hand" is the drawer; a second
      // petty-cash box for the same currency only gave people two places to
      // put the same note.
      cashAccounts: [
        { code: 'DXB-CASH-AED', name: 'Cash in Hand', accountType: 'CASH', currency: 'AED' },
        { code: 'DXB-CASH-USD', name: 'Cash in Hand (USD)', accountType: 'CASH', currency: 'USD' },
        { code: 'DXB-BANK-AED', name: 'AED Bank Account', accountType: 'BANK', currency: 'AED', bankName: 'Emirates NBD' },
        { code: 'DXB-BANK-USD', name: 'USD Bank Account', accountType: 'BANK', currency: 'USD', bankName: 'Emirates NBD' },
      ],
    },
    {
      code: 'FID-MA',
      name: 'FID Trading International SARL',
      legalName: 'FID TRADING INTERNATIONAL SARL',
      country: 'Morocco',
      localCurrency: 'MAD',
      timezone: 'Africa/Casablanca',
      docPrefix: 'FID-MA',
      address: 'Casablanca, Morocco',
      industryTemplate: 'COMMODITY_TRADING',
      tagline: 'Coffee Connects Worlds',
      terminology: { product: 'Coffee' },
      // Morocco runs two warehouses; stock is tracked separately at each.
      warehouses: [
        { code: 'MA-CASA-A', name: 'Casablanca Warehouse A', location: 'Casablanca', port: 'Casablanca', isDefault: true },
        { code: 'MA-CASA-B', name: 'Ridwan Warehouse', location: 'Casablanca' },
      ],
      cashAccounts: [
        { code: 'MA-CASH-MAD', name: 'Cash in Hand', accountType: 'CASH', currency: 'MAD' },
        { code: 'MA-CASH-USD', name: 'Cash in Hand (USD)', accountType: 'CASH', currency: 'USD' },
        { code: 'MA-BANK-MAD', name: 'MAD Bank Account', accountType: 'BANK', currency: 'MAD', bankName: 'Attijariwafa Bank' },
        { code: 'MA-BANK-USD', name: 'USD Bank Account', accountType: 'BANK', currency: 'USD', bankName: 'Attijariwafa Bank' },
      ],
    },
  ],
};
