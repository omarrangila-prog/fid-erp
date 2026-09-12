import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Download this report as a real Excel file.
 *
 * The href carries whatever filters the page is showing, so the workbook and
 * the screen state the same thing. There is no client-side work here: the
 * server writes the .xlsx from the same service the page read, which is the
 * only way the two cannot drift apart.
 *
 * Marked `data-print="hide"` so it does not appear on paper — a printed page
 * with a download button on it looks like a mistake.
 */
export function ExcelLink({ href, label = 'Excel' }: { href: string; label?: string }) {
  return (
    <Button asChild variant="outline" size="sm" data-print="hide">
      <a href={href} download>
        <Download />
        {label}
      </a>
    </Button>
  );
}

/** Build an export URL, dropping filters the page is not applying. */
export function exportHref(report: string, filters: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return `/api/export/${report}${suffix ? `?${suffix}` : ''}`;
}
