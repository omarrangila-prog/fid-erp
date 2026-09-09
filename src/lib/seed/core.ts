import { randomBytes } from 'node:crypto';
import { prisma, transaction } from '@/lib/db';
import { ALL_PERMISSIONS, PERMISSION_DESCRIPTIONS, SYSTEM_ROLES, SETTING_KEYS } from '@/lib/constants';
import { hashPassword, validatePasswordStrength } from '@/lib/auth/password';
import { provisionCompany, createCashBankAccount } from '@/lib/services/chart-of-accounts';

/**
 * Idempotent bootstrap used by both `db:seed` (development) and `db:init`
 * (production). Running it twice changes nothing.
 */

export async function seedPermissions(): Promise<number> {
  for (const code of ALL_PERMISSIONS) {
    const meta = PERMISSION_DESCRIPTIONS[code];
    await prisma.permission.upsert({
      where: { code },
      update: { module: meta.module, description: meta.description },
      create: { code, module: meta.module, description: meta.description },
    });
  }
  return ALL_PERMISSIONS.length;
}

export async function seedRoles(): Promise<number> {
  for (const roleSeed of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleSeed.code },
      update: { name: roleSeed.name, description: roleSeed.description, isSystem: true },
      create: { code: roleSeed.code, name: roleSeed.name, description: roleSeed.description, isSystem: true },
    });

    const permissions = await prisma.permission.findMany({
      where: { code: { in: roleSeed.permissions } },
      select: { id: true },
    });

    // Re-sync rather than append, so removing a permission from the catalogue
    // actually removes it from the role.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true,
    });
  }
  return SYSTEM_ROLES.length;
}

export type CompanySeed = {
  code: string;
  name: string;
  legalName: string;
  country: string;
  localCurrency: string;
  timezone: string;
  docPrefix: string;
  address: string;
  warehouses: Array<{ code: string; name: string; location: string; port?: string; isDefault?: boolean }>;
  cashAccounts: Array<{
    code: string;
    name: string;
    accountType: 'CASH' | 'PETTY_CASH' | 'BANK';
    currency: string;
    openingBalance?: string;
    bankName?: string;
  }>;
};

export const COMPANY_SEEDS: CompanySeed[] = [
  {
    code: 'FID-DXB',
    name: 'FID Trading L.L.C.',
    legalName: 'FID TRADING L.L.C.',
    country: 'United Arab Emirates',
    localCurrency: 'AED',
    timezone: 'Asia/Dubai',
    docPrefix: 'FID-DXB',
    address: 'Dubai, United Arab Emirates',
    warehouses: [
      { code: 'DXB-JAFZA', name: 'Jebel Ali Free Zone Warehouse', location: 'Jebel Ali, Dubai', port: 'Jebel Ali', isDefault: true },
      { code: 'DXB-BOND', name: 'Port Rashid Bonded Store', location: 'Port Rashid, Dubai', port: 'Port Rashid' },
    ],
    cashAccounts: [
      { code: 'DXB-CASH-AED', name: 'AED Cash', accountType: 'CASH', currency: 'AED' },
      { code: 'DXB-PETTY-AED', name: 'AED Petty Cash', accountType: 'PETTY_CASH', currency: 'AED' },
      { code: 'DXB-CASH-USD', name: 'USD Cash', accountType: 'CASH', currency: 'USD' },
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
    // Morocco runs two warehouses; stock is tracked separately at each.
    warehouses: [
      { code: 'MA-CASA-A', name: 'Casablanca Warehouse A', location: 'Casablanca', port: 'Casablanca', isDefault: true },
      { code: 'MA-CASA-B', name: 'Casablanca Warehouse B', location: 'Casablanca' },
    ],
    cashAccounts: [
      { code: 'MA-CASH-MAD', name: 'MAD Cash', accountType: 'CASH', currency: 'MAD' },
      { code: 'MA-PETTY-MAD', name: 'MAD Petty Cash', accountType: 'PETTY_CASH', currency: 'MAD' },
      { code: 'MA-CASH-USD', name: 'USD Cash', accountType: 'CASH', currency: 'USD' },
      { code: 'MA-BANK-MAD', name: 'MAD Bank Account', accountType: 'BANK', currency: 'MAD', bankName: 'Attijariwafa Bank' },
      { code: 'MA-BANK-USD', name: 'USD Bank Account', accountType: 'BANK', currency: 'USD', bankName: 'Attijariwafa Bank' },
    ],
  },
];

export async function seedCompanies(): Promise<string[]> {
  const ids: string[] = [];

  for (const seed of COMPANY_SEEDS) {
    const company = await prisma.company.upsert({
      where: { code: seed.code },
      update: {
        name: seed.name,
        legalName: seed.legalName,
        country: seed.country,
        localCurrency: seed.localCurrency,
        timezone: seed.timezone,
        docPrefix: seed.docPrefix,
        address: seed.address,
      },
      create: {
        code: seed.code,
        name: seed.name,
        legalName: seed.legalName,
        country: seed.country,
        localCurrency: seed.localCurrency,
        baseCurrency: 'USD',
        timezone: seed.timezone,
        docPrefix: seed.docPrefix,
        address: seed.address,
      },
    });

    // Provisioning writes the whole chart of accounts in one go; give it room
    // on a slow link, since this runs once per company and never again.
    await transaction((tx) => provisionCompany(tx, company.id), 120_000);

    for (const warehouse of seed.warehouses) {
      const existing = await prisma.warehouse.findFirst({
        where: { companyId: company.id, code: warehouse.code },
      });
      if (!existing) {
        await prisma.warehouse.create({
          data: {
            companyId: company.id,
            code: warehouse.code,
            name: warehouse.name,
            location: warehouse.location,
            country: seed.country,
            port: warehouse.port ?? null,
            isDefault: warehouse.isDefault ?? false,
          },
        });
      }
    }

    for (const account of seed.cashAccounts) {
      const existing = await prisma.cashBankAccount.findFirst({
        where: { companyId: company.id, code: account.code },
      });
      if (!existing) {
        await createCashBankAccount({ companyId: company.id, ...account }, 'system');
      }
    }

    // Defaults chosen conservatively: no negative stock, alerts at 7/3/0 days.
    for (const [key, value] of [
      [SETTING_KEYS.ALLOW_NEGATIVE_STOCK, 'false'],
      [SETTING_KEYS.ETA_ALERT_DAYS, '7,3,0'],
      [SETTING_KEYS.DEFAULT_PAYMENT_TERM_DAYS, '30'],
    ] as const) {
      const existing = await prisma.applicationSetting.findFirst({ where: { companyId: company.id, key } });
      if (!existing) {
        await prisma.applicationSetting.create({ data: { companyId: company.id, key, value } });
      }
    }

    ids.push(company.id);
  }

  return ids;
}

/** Indicative rates seeded so a user is never forced to type one from scratch. */
export async function seedExchangeRates(): Promise<void> {
  const today = new Date();
  const effectiveDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  for (const [quoteCurrency, rate] of [
    ['AED', '3.67250000'],
    ['MAD', '9.85000000'],
  ] as const) {
    const existing = await prisma.exchangeRate.findFirst({
      where: { companyId: null, quoteCurrency, effectiveDate },
    });
    if (!existing) {
      await prisma.exchangeRate.create({ data: { companyId: null, quoteCurrency, rate, effectiveDate } });
    }
  }
}

/**
 * Creates (or repairs) the first Super Admin from environment variables.
 * Credentials are never hard-coded in source.
 */
export async function seedAdminUser(companyIds: string[]): Promise<{ email: string; created: boolean }> {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const name = process.env.INITIAL_ADMIN_NAME ?? 'Ali Raza';
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      'INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be set. Copy .env.example to .env and fill them in.',
    );
  }

  const weakness = validatePasswordStrength(password);
  if (weakness) {
    throw new Error(`INITIAL_ADMIN_PASSWORD is not strong enough: ${weakness}`);
  }

  const superAdminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SUPER_ADMIN' } });
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: existing.id, roleId: superAdminRole.id } },
      update: {},
      create: { userId: existing.id, roleId: superAdminRole.id },
    });
    // Keep the display name in step with the environment: it appears on every
    // document this person approves, so a stale placeholder is not harmless.
    if (existing.name !== name) {
      await prisma.user.update({ where: { id: existing.id }, data: { name } });
    }
    return { email, created: false };
  }

  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: await hashPassword(password),
      isSuperAdmin: true,
      defaultCompanyId: companyIds[0] ?? null,
      roles: { create: { roleId: superAdminRole.id } },
      companies: { create: companyIds.map((companyId) => ({ companyId })) },
    },
  });

  return { email: user.email, created: true };
}

/**
 * Staff accounts with quick-entry PINs.
 *
 * Created only when the matching environment variables are set, and the PINs
 * themselves never appear in source — they come from `.env`, which is not in
 * the repository. Each PIN belongs to one person with one company and one role,
 * so the audit trail still names an individual.
 */
export async function seedPinAccounts(): Promise<Array<{ name: string; company: string }>> {
  const created: Array<{ name: string; company: string }> = [];

  const specs = [
    {
      pin: process.env.ADMIN_PIN,
      email: process.env.INITIAL_ADMIN_EMAIL,
      isAdmin: true,
      name: null,
      roleCode: null,
      companyCode: null,
    },
    {
      pin: process.env.DUBAI_STAFF_PIN,
      email: 'dubai.staff@fidtrading.local',
      isAdmin: false,
      name: process.env.DUBAI_STAFF_NAME ?? 'Dubai Staff',
      roleCode: 'DATA_ENTRY',
      companyCode: 'FID-DXB',
    },
    {
      pin: process.env.MOROCCO_STAFF_PIN,
      email: 'morocco.staff@fidtrading.local',
      isAdmin: false,
      name: process.env.MOROCCO_STAFF_NAME ?? 'Morocco Staff',
      roleCode: 'DATA_ENTRY',
      companyCode: 'FID-MA',
    },
  ];

  for (const spec of specs) {
    if (!spec.pin || !spec.email) continue;

    if (spec.isAdmin) {
      const admin = await prisma.user.findUnique({ where: { email: spec.email } });
      if (admin) {
        await prisma.user.update({
          where: { id: admin.id },
          data: { pinHash: await hashPassword(spec.pin), pinSetAt: new Date(), pinFailedAttempts: 0, pinLockedUntil: null },
        });
        created.push({ name: admin.name, company: 'Both companies' });
      }
      continue;
    }

    const company = await prisma.company.findUnique({ where: { code: spec.companyCode! } });
    const role = await prisma.role.findUnique({ where: { code: spec.roleCode! } });
    if (!company || !role) continue;

    // Staff accounts still get a password, generated and never printed: the PIN
    // is the convenience, not the only credential the account possesses.
    const existing = await prisma.user.findUnique({ where: { email: spec.email } });
    if (existing && existing.name !== spec.name) {
      await prisma.user.update({ where: { id: existing.id }, data: { name: spec.name! } });
    }
    const user =
      existing ??
      (await prisma.user.create({
        data: {
          email: spec.email,
          name: spec.name!,
          passwordHash: await hashPassword(randomBytes(24).toString('base64url')),
          isSuperAdmin: false,
          defaultCompanyId: company.id,
          roles: { create: { roleId: role.id } },
          companies: { create: { companyId: company.id } },
        },
      }));

    // Re-point the role on every run. Without this an account created under an
    // earlier, more powerful role would keep it forever, and a tightened role
    // definition would silently not apply to the people it was tightened for.
    await prisma.userRole.deleteMany({ where: { userId: user.id, roleId: { not: role.id } } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });

    // One company, and only one: a Dubai operator must never be able to reach
    // Morocco's books, so any other company access is removed rather than left.
    await prisma.userCompany.deleteMany({ where: { userId: user.id, companyId: { not: company.id } } });
    await prisma.userCompany.upsert({
      where: { userId_companyId: { userId: user.id, companyId: company.id } },
      update: {},
      create: { userId: user.id, companyId: company.id },
    });

    await prisma.user.update({
      where: { id: user.id },
      data: {
        pinHash: await hashPassword(spec.pin),
        pinSetAt: new Date(),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        defaultCompanyId: company.id,
        isSuperAdmin: false,
      },
    });
    created.push({ name: user.name, company: company.name });
  }

  return created;
}

/** Everything a production install needs, and nothing it does not. */
export async function initialiseProduction() {
  const permissions = await seedPermissions();
  const roles = await seedRoles();
  const companyIds = await seedCompanies();
  await seedExchangeRates();
  const admin = await seedAdminUser(companyIds);
  const pinAccounts = await seedPinAccounts();
  return { permissions, roles, companies: companyIds.length, admin, pinAccounts };
}
