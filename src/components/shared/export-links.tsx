'use client';

import { Download, FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PrintButton } from '@/components/shared/print-button';

/**
 * Take this report away: as a spreadsheet, as plain text, or as a document.
 *
 * All three carry whatever filters the page is showing, so a file and the
 * screen it came from always state the same thing. The server writes both the
 * spreadsheet and the CSV from the same service the page read — the CSV is
 * read back out of the finished workbook, so there is no second definition of
 * the report that could drift from the first.
 *
 * "Print / PDF" opens the browser's print dialogue, where every desktop
 * browser offers Save as PDF. That is a real PDF, laid out by the print
 * stylesheet the client already uses for paper.
 */
export function ExportLinks({
  href,
  csvHref,
  print = true,
}: {
  /** The Excel download, from `exportHref`. */
  href?: string;
  /** The CSV download. Defaults to the Excel link asked for as CSV. */
  csvHref?: string;
  print?: boolean;
}) {
  const csv = csvHref ?? (href ? `${href}${href.includes('?') ? '&' : '?'}format=csv` : undefined);

  return (
    <>
      {href ? (
        <Button asChild variant="outline" size="sm" data-print="hide">
          <a href={href} download>
            <FileSpreadsheet />
            Excel
          </a>
        </Button>
      ) : null}
      {csv ? (
        <Button asChild variant="outline" size="sm" data-print="hide">
          <a href={csv} download>
            <Download />
            CSV
          </a>
        </Button>
      ) : null}
      {print ? <PrintButton /> : null}
    </>
  );
}
