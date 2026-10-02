import type { ComponentProps } from 'react';
import { getCurrentUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/guards';
import { PERMISSIONS } from '@/lib/constants';
import { ExportButtons } from '@/components/shared/export-buttons';

/**
 * Excel, CSV and Print for a report — Excel and CSV only for someone allowed
 * to export ("Export reports and lists"), which the download itself checks
 * too. Print stays: it is the page as it already stands on the screen.
 */
export async function ExportLinks(props: ComponentProps<typeof ExportButtons>) {
  const user = await getCurrentUser();
  if (user && can(user, PERMISSIONS.REPORTS_EXPORT)) return <ExportButtons {...props} />;
  return <ExportButtons print={props.print} />;
}
