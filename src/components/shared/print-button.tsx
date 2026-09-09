'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Print, or save as PDF.
 *
 * The browser's own print dialogue offers "Save as PDF" on every desktop
 * platform, which produces a better document than a server-side renderer would
 * and cannot drift out of step with what is on screen. The print stylesheet
 * strips the navigation and toolbars.
 */
export function PrintButton({ label = 'Print / PDF' }: { label?: string }) {
  return (
    <Button variant="outline" size="sm" onClick={() => window.print()} data-print="hide">
      <Printer />
      {label}
    </Button>
  );
}
