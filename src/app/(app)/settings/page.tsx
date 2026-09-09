import type { Metadata } from 'next';
import { requirePageAccess } from '@/lib/auth/guards';
import { PERMISSIONS, SETTING_KEYS } from '@/lib/constants';
import { getAllSettings } from '@/lib/services/settings';
import { PageHeader } from '@/components/shared/page-header';
import { Callout } from '@/components/ui/feedback';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { DetailRow } from '@/components/shared/stat-card';
import { SettingsClient, type SettingSpec } from '@/app/(app)/settings/settings-client';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

const SPECS: Record<string, { label: string; description: string; kind: SettingSpec['kind'] }> = {
  [SETTING_KEYS.ALLOW_NEGATIVE_STOCK]: {
    label: 'Allow negative stock',
    description:
      'When disabled, a sale that exceeds the available quantity in the selected batch and warehouse is refused. Leave this off unless you are deliberately correcting historical data.',
    kind: 'boolean',
  },
  [SETTING_KEYS.ETA_ALERT_DAYS]: {
    label: 'ETA alert thresholds',
    description:
      'Days before arrival at which an alert is raised for a shipment whose customer still owes money. Comma-separated; 0 means on the day of arrival.',
    kind: 'csv',
  },
  [SETTING_KEYS.DEFAULT_PAYMENT_TERM_DAYS]: {
    label: 'Default payment terms',
    description: 'Pre-filled on new sales invoices, in days.',
    kind: 'number',
  },
};

export default async function SettingsPage() {
  const user = await requirePageAccess(PERMISSIONS.SETTINGS_MANAGE);
  const all = await getAllSettings(user.activeCompany.id);

  const settings: SettingSpec[] = all
    .filter((s) => SPECS[s.key])
    .map((s) => ({
      key: s.key,
      value: s.value,
      scope: s.scope,
      ...SPECS[s.key],
    }));

  const inventory = settings.filter((s) => s.key.startsWith('inventory.'));
  const alerts = settings.filter((s) => s.key.startsWith('alerts.'));
  const trading = settings.filter((s) => s.key.startsWith('sales.') || s.key.startsWith('costing.'));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description={`Applies to ${user.activeCompany.name}. Each company has its own settings.`}
        breadcrumbs={[{ label: 'Administration' }, { label: 'Settings' }]}
      />

      <Callout tone="warning" title="These change how transactions behave">
        Turning on negative stock removes the block that stops staff selling coffee that is not there. Every change is
        recorded in the audit trail.
      </Callout>

      <SettingsClient
        groups={[
          { title: 'Inventory', description: 'Controls on stock movements.', settings: inventory },
          { title: 'Alerts', description: 'When the system raises a warning.', settings: alerts },
          { title: 'Trading defaults', description: 'Values pre-filled on new documents.', settings: trading },
        ].filter((g) => g.settings.length > 0)}
      />

      <Card>
        <CardHeader>
          <CardTitle>Company profile</CardTitle>
          <CardDescription>Changed under Administration → Companies.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl>
            <DetailRow label="Company">{user.activeCompany.name}</DetailRow>
            <DetailRow label="Code">{user.activeCompany.code}</DetailRow>
            <DetailRow label="Local currency">{user.activeCompany.localCurrency}</DetailRow>
            <DetailRow label="Group currency">{user.activeCompany.baseCurrency}</DetailRow>
            <DetailRow label="Timezone">{user.activeCompany.timezone}</DetailRow>
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
