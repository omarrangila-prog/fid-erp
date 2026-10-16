import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { resolveFeatures, FEATURES, FEATURE_LABELS } from '@/lib/features';
import { planAllows, planFor } from '@/lib/entitlements';
import { TEMPLATE_LIST, BUSINESS_TYPES, effectiveTerminology } from '@/lib/templates';
import { DEFAULT_TERMS } from '@/lib/terminology';
import { COUNTRIES } from '@/lib/countries';
import { PageHeader } from '@/components/shared/page-header';
import { CompanyProfileClient } from '@/app/(app)/settings/company/company-profile-client';

export const metadata: Metadata = { title: 'Company Profile' };
export const dynamic = 'force-dynamic';

export default async function CompanyProfilePage() {
  const user = await requirePageAccess(PERMISSIONS.SETTINGS_MANAGE);
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: user.activeCompany.id },
    include: { organization: { select: { plan: true } } },
  });
  const plan = company.organization?.plan ?? 'ENTERPRISE';
  const features = resolveFeatures({ ...user.activeCompany, plan });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Company Profile"
        description={`How ${company.name} appears on its documents, which currencies and modules it uses, and the words it likes.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Settings', href: '/settings' }, { label: 'Company profile' }]}
      />
      <CompanyProfileClient
        profile={{
          name: company.name,
          legalName: company.legalName ?? '',
          tradingName: company.tradingName ?? '',
          tagline: company.tagline ?? '',
          address: company.address ?? '',
          phone: company.phone ?? '',
          email: company.email ?? '',
          website: company.website ?? '',
          companyRegistration: company.companyRegistration ?? '',
          dateFormat: company.dateFormat,
          numberLocale: company.numberLocale,
          timezone: company.timezone,
          country: company.country,
          localCurrency: company.localCurrency,
          hasLogo: Boolean(company.logoUpdatedAt),
          logoVersion: company.logoUpdatedAt?.getTime() ?? 0,
        }}
        config={{
          industryTemplate: company.industryTemplate,
          businessType: company.businessType,
          transactionCurrencies: company.transactionCurrencies,
          salesCurrencies: company.salesCurrencies,
          defaultSalesCurrency: company.defaultSalesCurrency ?? '',
          features,
          terminology: effectiveTerminology(company.industryTemplate, company.terminology as Record<string, string>),
          fxCostPolicy: company.fxCostPolicy,
        }}
        options={{
          templates: TEMPLATE_LIST.map((t) => ({ key: t.key, label: t.label, description: t.description })),
          businessTypes: BUSINESS_TYPES.map((b) => ({ ...b })),
          features: FEATURES.map((f) => ({ key: f, ...FEATURE_LABELS[f], allowedByPlan: planAllows(plan, f) })),
          planLabel: planFor(plan).label,
          terms: Object.entries(DEFAULT_TERMS).map(([key, fallback]) => ({ key, fallback })),
          locales: [...new Set(COUNTRIES.map((c) => c.locale))].sort(),
        }}
      />
    </div>
  );
}
