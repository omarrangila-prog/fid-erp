import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { prisma } from '@/lib/db';
import { getTaxSettings, taxRegimeFor } from '@/lib/services/tax';
import { PageHeader } from '@/components/shared/page-header';
import { TaxSettingsClient, type TaxCodeRow } from '@/app/(app)/settings/tax/tax-client';

export const metadata: Metadata = { title: 'Tax Settings' };
export const dynamic = 'force-dynamic';

export default async function TaxSettingsPage() {
  const user = await requirePageAccess(PERMISSIONS.SETTINGS_MANAGE);
  const companyId = user.activeCompany.id;

  const [settings, company, codes] = await Promise.all([
    getTaxSettings(companyId),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { country: true, name: true } }),
    prisma.taxCode.findMany({
      where: { companyId, status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { ratePct: 'desc' }, { code: 'asc' }],
    }),
  ]);

  const regime = taxRegimeFor(company.country);

  const rows: TaxCodeRow[] = codes.map((code) => ({
    id: code.id,
    code: code.code,
    name: code.name,
    ratePct: code.ratePct.toString(),
    treatment: code.treatment,
    appliesTo: code.appliesTo,
    isDefault: code.isDefault,
    isSystem: code.isSystem,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tax Settings"
        description={`How ${company.name} charges and reclaims tax.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Settings', href: '/settings' }, { label: 'Tax' }]}
      />

      <TaxSettingsClient
        enabled={settings.enabled}
        label={settings.label}
        registrationNumber={settings.registrationNumber}
        periodMonths={settings.periodMonths}
        suggestedLabel={regime.label}
        suggestedRate={regime.standardRatePct}
        country={company.country}
        codes={rows}
      />
    </div>
  );
}
