import type { Metadata } from 'next';
import { requirePageAccess, can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { COUNTRIES, countryByName } from '@/lib/countries';
import { TEMPLATE_LIST, BUSINESS_TYPES } from '@/lib/templates';
import { getOnboardingStatus, listAssignableRoles } from '@/lib/services/onboarding';
import { IMPORT_SPECS, IMPORT_KINDS } from '@/lib/import/templates';
import { getBrand } from '@/lib/brand';
import { OnboardingWizard } from '@/app/(app)/onboarding/wizard';

export const metadata: Metadata = { title: 'Set up your company' };
export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const user = await requirePageAccess(PERMISSIONS.SETTINGS_MANAGE);
  const companyId = user.activeCompany.id;
  const [company, warehouses, accounts, roles, rates, postedEntries, taxCodes] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId } }),
    prisma.warehouse.findMany({ where: { companyId }, orderBy: { name: 'asc' }, select: { name: true, location: true } }),
    prisma.cashBankAccount.findMany({ where: { companyId }, orderBy: { name: 'asc' }, select: { name: true, accountType: true, currency: true } }),
    can(user, PERMISSIONS.USERS_MANAGE) ? listAssignableRoles(user) : Promise.resolve([]),
    prisma.exchangeRate.findMany({ where: { OR: [{ companyId }, { companyId: null }] }, select: { quoteCurrency: true } }),
    prisma.journalEntry.count({ where: { companyId } }),
    prisma.taxCode.count({ where: { companyId, treatment: 'STANDARD', status: 'ACTIVE', ratePct: { gt: 0 } } }),
  ]);
  const status = await getOnboardingStatus(companyId);

  const known = countryByName(company.country);
  return (
    <OnboardingWizard
      product={getBrand().name}
      company={{
        name: company.name,
        country: company.country,
        countryCode: known?.code ?? '',
        localCurrency: company.localCurrency,
        timezone: company.timezone,
        businessType: company.businessType,
        industryTemplate: company.industryTemplate,
        unit: ((company.terminology as Record<string, string>)?.unit as string | undefined) ?? 'PCS',
        taxEnabled: company.taxEnabled,
        taxLabel: company.taxLabel,
        hasLogo: Boolean(company.logoUpdatedAt),
        locked: postedEntries > 0,
        pending: status === 'pending',
      }}
      warehouses={warehouses}
      accounts={accounts.map((a) => ({ ...a, accountType: String(a.accountType) }))}
      roles={roles}
      hasRate={new Set(rates.map((r) => r.quoteCurrency)).has(company.localCurrency) || company.localCurrency === 'USD'}
      taxRates={taxCodes}
      canInvite={can(user, PERMISSIONS.USERS_MANAGE)}
      options={{
        countries: COUNTRIES.map((c) => ({ name: c.name, currency: c.currency, timezone: c.timezone, taxLabel: c.taxLabel })),
        templates: TEMPLATE_LIST.map((t) => ({ key: t.key, label: t.label, description: t.description, businessType: t.businessType })),
        businessTypes: BUSINESS_TYPES.map((b) => ({ ...b })),
        imports: IMPORT_KINDS.map((k) => ({ kind: k, label: IMPORT_SPECS[k].label, description: IMPORT_SPECS[k].description })),
      }}
    />
  );
}
