import type { Metadata } from 'next';
import { requireUser } from '@/lib/auth/session';
import { listNotifications } from '@/lib/services/notification';
import { formatDateTime, formatDate } from '@/lib/format';
import { PageHeader } from '@/components/shared/page-header';
import { NotificationsClient, type AlertRow } from '@/app/(app)/notifications/notifications-client';

export const metadata: Metadata = { title: 'Alerts' };
export const dynamic = 'force-dynamic';

/** Alerts point at the record that raised them wherever one exists. */
function hrefFor(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  if (entityType === 'Shipment') return `/shipments/${entityId}`;
  if (entityType === 'SalesInvoice') return `/sales/${entityId}`;
  if (entityType === 'PurchaseContract') return `/purchases/${entityId}`;
  return null;
}

export default async function NotificationsPage() {
  const user = await requireUser();
  const notifications = await listNotifications(user.activeCompany.id, { limit: 200 });

  const rows: AlertRow[] = notifications.map((n) => ({
    id: n.id,
    severity: n.severity,
    title: n.title,
    message: n.message,
    createdAt: formatDateTime(n.createdAt),
    dueAt: n.dueAt ? formatDate(n.dueAt) : null,
    isRead: n.readAt !== null,
    href: hrefFor(n.relatedEntityType, n.relatedEntityId),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Alerts"
        description="Shipments approaching their ETA with money outstanding, overdue invoices, missing bookings and late documents."
        breadcrumbs={[{ label: user.activeCompany.name }, { label: 'Alerts' }]}
      />
      <NotificationsClient rows={rows} />
    </div>
  );
}
